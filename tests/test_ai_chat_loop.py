"""
Tests for the AI chat agentic loop and the /api/chat HTTP routes.

The Anthropic client is replaced with a scripted fake, so these cover the full
plumbing — tool dispatch, tool_result wiring, undo persistence, HTTP layer —
without any network or API key. Run from the repo root:

    python -m pytest tests/test_ai_chat_loop.py       # or
    python -m unittest tests.test_ai_chat_loop
"""
import json
import os
import sys
import tempfile
import unittest
from types import SimpleNamespace

# Point the app at a throwaway SQLite file before importing it (no-op if
# another test module imported backend.app first — DB is reset per test).
_DB_FD, _DB_PATH = tempfile.mkstemp(suffix='.db')
os.close(_DB_FD)
os.environ.setdefault('DATABASE_URL', f'sqlite:///{_DB_PATH}')
os.environ.setdefault('JWT_SECRET_KEY', 'test-secret')

_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Make `import ai_chat` resolve so backend.app._chat_service reuses the cached
# module and our monkeypatched fake Anthropic client is visible to requests.
sys.path.insert(0, os.path.join(_REPO, 'backend'))

from backend.app import app, db, limiter, User, Hat, Task, ChatUndo, check_task_limit  # noqa: E402

limiter.enabled = False  # rate limits would trip across the full test suite
import ai_chat  # noqa: E402  (backend/ai_chat.py via sys.path)
from ai_chat import TaskChatService, MAX_TOOL_ITERATIONS  # noqa: E402


# ---- Scripted fake Anthropic client ----
def text_block(text):
    return SimpleNamespace(type='text', text=text)


def tool_block(name, tool_input, block_id='toolu_1'):
    return SimpleNamespace(type='tool_use', name=name, input=tool_input, id=block_id)


def tool_response(*blocks):
    return SimpleNamespace(stop_reason='tool_use', content=list(blocks))


def final_response(text='All done!'):
    return SimpleNamespace(stop_reason='end_turn', content=[text_block(text)])


class FakeMessages:
    def __init__(self, script):
        self.script = list(script)
        self.calls = []

    def create(self, **kwargs):
        # Snapshot the messages list — the service appends to it in place
        # across loop iterations, and we assert on per-call state.
        kwargs = dict(kwargs)
        kwargs['messages'] = list(kwargs.get('messages') or [])
        self.calls.append(kwargs)
        if self.script:
            return self.script.pop(0)
        return final_response('Done.')


class FakeClient:
    def __init__(self, script):
        self.messages = FakeMessages(script)


def make_service(script):
    svc = TaskChatService(db, Task, Hat, ChatUndo, check_task_limit)
    svc.client = FakeClient(script)
    return svc


class AIChatLoopTests(unittest.TestCase):
    def setUp(self):
        self.ctx = app.app_context()
        self.ctx.push()
        db.drop_all()
        db.create_all()
        self.user = User(email='loop@example.com', name='L',
                         password_hash='x', tier='pro')
        db.session.add(self.user)
        db.session.commit()
        self.hat = Hat(user_id=self.user.id, name='Main Hat')
        db.session.add(self.hat)
        db.session.commit()

    def tearDown(self):
        db.session.remove()
        db.drop_all()
        self.ctx.pop()

    def test_add_flow_and_undo(self):
        svc = make_service([
            tool_response(tool_block('add_tasks', {'tasks': [
                {'description': 'Buy milk', 'category': 'Shopping',
                 'priority': 'today', 'recurring': '', 'due': ''},
            ]})),
            final_response('Added Buy milk to Shopping.'),
        ])
        result = svc.run(self.user, None, 'add buy milk', [])

        self.assertEqual(result['reply'], 'Added Buy milk to Shopping.')
        self.assertEqual(result['actions'], [{'action': 'added', 'count': 1}])
        self.assertTrue(result['undo_available'])
        task = Task.query.filter_by(user_id=self.user.id).one()
        self.assertEqual(task.description, 'Buy milk')
        self.assertEqual(task.hat_id, self.hat.id)  # defaulted to Main Hat

        out = svc.undo(self.user, result['undo_token'])
        self.assertTrue(out['undone'])
        self.assertEqual(Task.query.filter_by(user_id=self.user.id).count(), 0)

    def test_list_then_bulk_delete(self):
        a = Task(user_id=self.user.id, description='Old A', position=1)
        b = Task(user_id=self.user.id, description='Old B', position=2)
        db.session.add_all([a, b])
        db.session.commit()
        ids = [a.id, b.id]

        svc = make_service([
            tool_response(tool_block('list_tasks', {'query': 'old', 'category': '', 'priority': ''})),
            tool_response(tool_block('delete_tasks', {'ids': ids})),
            final_response('Deleted both old tasks.'),
        ])
        result = svc.run(self.user, None, 'delete my old tasks', [])

        # The list_tasks tool_result fed back to the model contained both tasks
        second_call = svc.client.messages.calls[1]
        listed = json.loads(second_call['messages'][-1]['content'][0]['content'])
        self.assertEqual(listed['count'], 2)

        self.assertEqual(Task.query.filter_by(user_id=self.user.id).count(), 0)
        self.assertEqual(result['actions'], [{'action': 'deleted', 'count': 2}])

        svc.undo(self.user, result['undo_token'])
        restored = {t.description for t in Task.query.filter_by(user_id=self.user.id)}
        self.assertEqual(restored, {'Old A', 'Old B'})

    def test_unknown_tool_recovers(self):
        svc = make_service([
            tool_response(tool_block('made_up_tool', {})),
            final_response('Sorry, I could not do that.'),
        ])
        result = svc.run(self.user, None, 'do something weird', [])
        second_call = svc.client.messages.calls[1]
        tool_result = second_call['messages'][-1]['content'][0]
        self.assertTrue(tool_result['is_error'])
        self.assertEqual(result['reply'], 'Sorry, I could not do that.')
        self.assertFalse(result['undo_available'])

    def test_iteration_cap(self):
        # A model that never stops calling tools must be cut off at the cap.
        svc = make_service([
            tool_response(tool_block('list_tasks', {'query': '', 'category': '', 'priority': ''}))
            for _ in range(MAX_TOOL_ITERATIONS + 5)
        ])
        result = svc.run(self.user, None, 'loop forever', [])
        self.assertEqual(len(svc.client.messages.calls), MAX_TOOL_ITERATIONS)
        self.assertIsNone(result['undo_token'])

    def test_history_is_forwarded(self):
        svc = make_service([final_response('Hi again!')])
        svc.run(self.user, None, 'and now?', [
            {'role': 'user', 'content': 'hello'},
            {'role': 'assistant', 'content': 'hi there'},
        ])
        messages = svc.client.messages.calls[0]['messages']
        self.assertEqual([m['role'] for m in messages], ['user', 'assistant', 'user'])
        self.assertEqual(messages[-1]['content'], 'and now?')


class AIChatRouteTests(unittest.TestCase):
    def setUp(self):
        self.ctx = app.app_context()
        self.ctx.push()
        db.drop_all()
        db.create_all()
        self.client = app.test_client()
        res = self.client.post('/api/auth/register', json={
            'name': 'R', 'email': 'route@example.com', 'password': 'password123',
        })
        self.token = res.get_json()['access_token']
        self.auth = {'Authorization': f'Bearer {self.token}'}
        self._saved_key = os.environ.pop('ANTHROPIC_API_KEY', None)
        self._saved_anthropic = ai_chat.anthropic

    def tearDown(self):
        ai_chat.anthropic = self._saved_anthropic
        if self._saved_key is not None:
            os.environ['ANTHROPIC_API_KEY'] = self._saved_key
        else:
            os.environ.pop('ANTHROPIC_API_KEY', None)
        db.session.remove()
        db.drop_all()
        self.ctx.pop()

    def _enable_fake_model(self, script):
        os.environ['ANTHROPIC_API_KEY'] = 'test-key'
        ai_chat.anthropic = SimpleNamespace(Anthropic=lambda: FakeClient(script))

    def test_requires_auth(self):
        res = self.client.post('/api/chat', json={'message': 'hi'})
        self.assertEqual(res.status_code, 401)

    def test_unconfigured_returns_503(self):
        res = self.client.post('/api/chat', json={'message': 'hi'}, headers=self.auth)
        self.assertEqual(res.status_code, 503)
        self.assertTrue(res.get_json().get('unavailable'))
        res2 = self.client.post('/api/chat/undo', json={}, headers=self.auth)
        self.assertEqual(res2.status_code, 503)

    def test_empty_message_rejected(self):
        self._enable_fake_model([])
        res = self.client.post('/api/chat', json={'message': '  '}, headers=self.auth)
        self.assertEqual(res.status_code, 400)

    def test_full_round_trip_with_undo(self):
        self._enable_fake_model([
            tool_response(tool_block('add_tasks', {'tasks': [
                {'description': 'Call the dentist', 'category': '',
                 'priority': 'urgent', 'recurring': '', 'due': ''},
            ]})),
            final_response('Added "Call the dentist" as urgent.'),
        ])
        res = self.client.post('/api/chat', json={'message': 'remind me to call the dentist'},
                               headers=self.auth)
        self.assertEqual(res.status_code, 200, res.get_data(as_text=True))
        body = res.get_json()
        self.assertIn('dentist', body['reply'])
        self.assertEqual(body['actions'], [{'action': 'added', 'count': 1}])
        self.assertTrue(body['undo_available'])

        tasks = self.client.get('/api/tasks', headers=self.auth).get_json()
        self.assertEqual([t['description'] for t in tasks], ['Call the dentist'])
        self.assertEqual(tasks[0]['priority'], 'urgent')

        undo = self.client.post('/api/chat/undo', json={'undo_token': body['undo_token']},
                                headers=self.auth)
        self.assertEqual(undo.status_code, 200)
        self.assertTrue(undo.get_json()['undone'])
        self.assertEqual(self.client.get('/api/tasks', headers=self.auth).get_json(), [])


if __name__ == '__main__':
    unittest.main()
