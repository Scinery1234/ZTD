"""
Tests for the AI hub's persistent memory (memory_notes.py + endpoints).

Modeled on ChatGPT saved-memories / Claude memory-tool behavior: the model
writes short notes via tools, every conversation gets them injected into the
system prompt, the model can update/delete stale notes, and the user can list
and delete notes over HTTP. No API key needed — the model is scripted.

    python -m pytest tests/test_memory.py        # or
    python -m unittest tests.test_memory
"""
import os
import tempfile
import unittest
from types import SimpleNamespace

_DB_FD, _DB_PATH = tempfile.mkstemp(suffix='.db')
os.close(_DB_FD)
os.environ.setdefault('DATABASE_URL', f'sqlite:///{_DB_PATH}')
os.environ.setdefault('JWT_SECRET_KEY', 'test-secret')

from backend.app import (  # noqa: E402
    app, db, limiter, User, Hat, Task, ChatUndo, CoachMemory, check_task_limit,
)

limiter.enabled = False  # rate limits would trip across the full test suite
from backend.coaching import CoachingService  # noqa: E402
from backend.ai_chat import TaskChatService  # noqa: E402
from backend.memory_notes import MAX_MEMORY_NOTES  # noqa: E402


# ---- scripted fake Anthropic client (same shape as test_ai_chat_loop) ----
def text_block(text):
    return SimpleNamespace(type='text', text=text)


def tool_block(name, tool_input, block_id='toolu_1'):
    return SimpleNamespace(type='tool_use', name=name, input=tool_input, id=block_id)


def tool_response(*blocks):
    return SimpleNamespace(stop_reason='tool_use', content=list(blocks))


def final_response(text='Okay.'):
    return SimpleNamespace(stop_reason='end_turn', content=[text_block(text)])


class FakeMessages:
    def __init__(self, script):
        self.script = list(script)
        self.calls = []

    def create(self, **kwargs):
        kwargs = dict(kwargs)
        kwargs['messages'] = list(kwargs.get('messages') or [])
        self.calls.append(kwargs)
        if self.script:
            return self.script.pop(0)
        return final_response()


class FakeClient:
    def __init__(self, script):
        self.messages = FakeMessages(script)


class MemoryBase(unittest.TestCase):
    def setUp(self):
        self.ctx = app.app_context()
        self.ctx.push()
        db.drop_all()
        db.create_all()
        self.user = User(email='m@example.com', name='M',
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

    def coach_svc(self, script):
        svc = CoachingService(db, Task, Hat, check_task_limit, CoachMemory=CoachMemory)
        svc.client = FakeClient(script)
        return svc

    def chat_svc(self, script):
        svc = TaskChatService(db, Task, Hat, ChatUndo, check_task_limit,
                              CoachMemory=CoachMemory)
        svc.client = FakeClient(script)
        return svc


class MemoryToolTests(MemoryBase):
    def test_coach_saves_memory_and_next_conversation_sees_it(self):
        # Conversation 1 (CBT): the model saves a note.
        svc1 = self.coach_svc([
            tool_response(tool_block('memory_save', {
                'notes': ['User is preparing for a job interview in late July.'],
            })),
            final_response('I will remember that.'),
        ])
        out = svc1.run(self.user, 'cbt', 'remember my interview is late July', [])
        self.assertEqual(out['reply'], 'I will remember that.')
        note = CoachMemory.query.filter_by(user_id=self.user.id).one()
        self.assertEqual(note.coach_id, 'cbt')
        self.assertIn('job interview', note.content)

        # Conversation 2 — a DIFFERENT coach, fresh history: memory is injected.
        svc2 = self.coach_svc([final_response('Welcome back.')])
        svc2.run(self.user, 'action', 'hello again', [])
        system = svc2.client.messages.calls[0]['system']
        self.assertIn('job interview', system)
        self.assertIn('MEMORY', system)
        self.assertIn('CBT Coach', system)   # provenance label

        # The task assistant shares the same memory store.
        svc3 = self.chat_svc([final_response('Hi!')])
        svc3.run(self.user, None, 'hi', [])
        self.assertIn('job interview', svc3.client.messages.calls[0]['system'])

    def test_model_can_update_and_delete_memory(self):
        note = CoachMemory(user_id=self.user.id, coach_id='cbt', content='Old fact.')
        db.session.add(note)
        db.session.commit()

        svc = self.coach_svc([
            tool_response(tool_block('memory_update', {'id': note.id, 'content': 'New fact.'})),
            final_response('Updated.'),
        ])
        svc.run(self.user, 'cbt', 'actually it changed', [])
        self.assertEqual(CoachMemory.query.get(note.id).content, 'New fact.')

        svc2 = self.coach_svc([
            tool_response(tool_block('memory_delete', {'ids': [note.id]})),
            final_response('Forgotten.'),
        ])
        svc2.run(self.user, 'cbt', 'forget that', [])
        self.assertIsNone(CoachMemory.query.get(note.id))

    def test_memory_is_capped_and_trims_oldest(self):
        for i in range(MAX_MEMORY_NOTES):
            db.session.add(CoachMemory(user_id=self.user.id, content=f'note {i}'))
        db.session.commit()
        first_id = CoachMemory.query.order_by(CoachMemory.id).first().id

        svc = self.coach_svc([
            tool_response(tool_block('memory_save', {'notes': ['the newest note']})),
            final_response('Saved.'),
        ])
        svc.run(self.user, 'exec', 'remember this', [])
        self.assertEqual(CoachMemory.query.filter_by(user_id=self.user.id).count(),
                         MAX_MEMORY_NOTES)
        self.assertIsNone(CoachMemory.query.get(first_id))  # oldest trimmed
        self.assertIsNotNone(CoachMemory.query.filter_by(
            content='the newest note').first())

    def test_memory_tools_are_user_scoped(self):
        other = User(email='o@example.com', name='O', password_hash='x', tier='pro')
        db.session.add(other)
        db.session.commit()
        theirs = CoachMemory(user_id=other.id, content='their secret')
        db.session.add(theirs)
        db.session.commit()

        svc = self.coach_svc([
            tool_response(tool_block('memory_delete', {'ids': [theirs.id]})),
            final_response('Done.'),
        ])
        svc.run(self.user, 'cbt', 'forget it', [])
        self.assertIsNotNone(CoachMemory.query.get(theirs.id))  # untouched

        # And another user's notes never appear in this user's prompt.
        svc2 = self.coach_svc([final_response('Hi.')])
        svc2.run(self.user, 'cbt', 'hi', [])
        self.assertNotIn('their secret', svc2.client.messages.calls[0]['system'])

    def test_assistant_prompt_has_task_snapshot(self):
        db.session.add(Task(user_id=self.user.id, description='Water the plants',
                            priority='today', position=1))
        db.session.commit()
        svc = self.chat_svc([final_response('Hello!')])
        svc.run(self.user, None, 'hello', [])
        system = svc.client.messages.calls[0]['system']
        self.assertIn('Water the plants', system)
        self.assertIn('!today', system)


class MemoryRouteTests(MemoryBase):
    def setUp(self):
        super().setUp()
        self.client = app.test_client()
        res = self.client.post('/api/auth/register', json={
            'name': 'R', 'email': 'mem-route@example.com', 'password': 'password123',
        })
        self.token = res.get_json()['access_token']
        self.auth = {'Authorization': f'Bearer {self.token}'}
        self.route_user = User.query.filter_by(email='mem-route@example.com').one()

    def _seed(self, content, coach_id=''):
        n = CoachMemory(user_id=self.route_user.id, coach_id=coach_id, content=content)
        db.session.add(n)
        db.session.commit()
        return n.id

    def test_requires_auth(self):
        self.assertEqual(self.client.get('/api/coach/memory').status_code, 401)

    def test_list_delete_and_clear(self):
        a = self._seed('Likes morning planning sessions.', 'exec')
        b = self._seed('Working toward a July deadline.', 'cbt')

        res = self.client.get('/api/coach/memory', headers=self.auth)
        self.assertEqual(res.status_code, 200)
        body = res.get_json()
        self.assertEqual({n['id'] for n in body}, {a, b})
        self.assertEqual({n['coach_id'] for n in body}, {'exec', 'cbt'})

        self.assertEqual(
            self.client.delete(f'/api/coach/memory/{a}', headers=self.auth).status_code, 200)
        self.assertEqual(len(self.client.get('/api/coach/memory', headers=self.auth).get_json()), 1)

        res = self.client.delete('/api/coach/memory', headers=self.auth)
        self.assertEqual(res.get_json()['count'], 1)
        self.assertEqual(self.client.get('/api/coach/memory', headers=self.auth).get_json(), [])

    def test_cannot_delete_other_users_memory(self):
        foreign = CoachMemory(user_id=self.user.id, content='not yours')
        db.session.add(foreign)
        db.session.commit()
        res = self.client.delete(f'/api/coach/memory/{foreign.id}', headers=self.auth)
        self.assertEqual(res.status_code, 404)
        self.assertIsNotNone(CoachMemory.query.get(foreign.id))


if __name__ == '__main__':
    unittest.main()
