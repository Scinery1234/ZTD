"""
Tests for saved chats (ChatThread): every successful /api/chat and /api/coach
turn is persisted server-side per tool, GET /api/chat/thread/<tool> resumes it,
and DELETE starts fresh. The model is scripted — no API key needed.

    python -m pytest tests/test_chat_threads.py       # or
    python -m unittest tests.test_chat_threads
"""
import os
import sys
import tempfile
import unittest
from types import SimpleNamespace

_DB_FD, _DB_PATH = tempfile.mkstemp(suffix='.db')
os.close(_DB_FD)
os.environ.setdefault('DATABASE_URL', f'sqlite:///{_DB_PATH}')
os.environ.setdefault('JWT_SECRET_KEY', 'test-secret')

_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(_REPO, 'backend'))

from backend.app import (  # noqa: E402
    app, db, limiter, ChatThread, MAX_THREAD_MESSAGES, append_chat_thread, User,
)

limiter.enabled = False  # rate limits would trip across the full test suite

import ai_chat  # noqa: E402
import coaching  # noqa: E402


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

    def create(self, **kwargs):
        if self.script:
            return self.script.pop(0)
        return final_response()


class FakeClient:
    def __init__(self, script):
        self.messages = FakeMessages(script)


class ChatThreadTests(unittest.TestCase):
    def setUp(self):
        self.ctx = app.app_context()
        self.ctx.push()
        db.drop_all()
        db.create_all()
        self.client = app.test_client()
        res = self.client.post('/api/auth/register', json={
            'name': 'T', 'email': 'thread@example.com', 'password': 'password123',
        })
        self.token = res.get_json()['access_token']
        self.auth = {'Authorization': f'Bearer {self.token}'}
        self.user = User.query.filter_by(email='thread@example.com').one()
        os.environ['ANTHROPIC_API_KEY'] = 'test-key'
        self._chat_anthropic = ai_chat.anthropic
        self._coach_anthropic = coaching.anthropic

    def tearDown(self):
        ai_chat.anthropic = self._chat_anthropic
        coaching.anthropic = self._coach_anthropic
        os.environ.pop('ANTHROPIC_API_KEY', None)
        db.session.remove()
        db.drop_all()
        self.ctx.pop()

    def _fake_chat(self, script):
        ai_chat.anthropic = SimpleNamespace(Anthropic=lambda: FakeClient(script))

    def _fake_coach(self, script):
        coaching.anthropic = SimpleNamespace(Anthropic=lambda: FakeClient(script))

    def test_empty_thread(self):
        res = self.client.get('/api/chat/thread/assistant', headers=self.auth)
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.get_json()['messages'], [])

    def test_chat_turn_is_persisted_and_resumable(self):
        self._fake_chat([final_response('Nothing to do!')])
        res = self.client.post('/api/chat', json={'message': 'hello there'},
                               headers=self.auth)
        self.assertEqual(res.status_code, 200)

        saved = self.client.get('/api/chat/thread/assistant',
                                headers=self.auth).get_json()['messages']
        self.assertEqual([m['role'] for m in saved], ['user', 'assistant'])
        self.assertEqual(saved[0]['content'], 'hello there')
        self.assertEqual(saved[1]['content'], 'Nothing to do!')

        # A second turn appends — the thread accumulates across "sessions".
        self._fake_chat([final_response('Still here.')])
        self.client.post('/api/chat', json={'message': 'are you there?'},
                         headers=self.auth)
        saved = self.client.get('/api/chat/thread/assistant',
                                headers=self.auth).get_json()['messages']
        self.assertEqual(len(saved), 4)
        self.assertEqual(saved[-1]['content'], 'Still here.')

    def test_coach_turn_is_persisted_separately_per_tool(self):
        self._fake_coach([final_response('Let us begin.')])
        res = self.client.post('/api/coach', json={
            'coach_id': 'cbt', 'message': 'I feel stuck',
        }, headers=self.auth)
        self.assertEqual(res.status_code, 200, res.get_data(as_text=True))

        cbt = self.client.get('/api/chat/thread/cbt', headers=self.auth).get_json()
        self.assertEqual(len(cbt['messages']), 2)
        self.assertEqual(cbt['messages'][1]['content'], 'Let us begin.')
        # Other tools are untouched.
        other = self.client.get('/api/chat/thread/action', headers=self.auth).get_json()
        self.assertEqual(other['messages'], [])

    def test_undo_token_and_actions_survive_in_thread(self):
        self._fake_chat([
            tool_response(tool_block('add_tasks', {'tasks': [
                {'description': 'Call mum', 'category': '', 'priority': '',
                 'recurring': '', 'due': ''},
            ]})),
            final_response('Added.'),
        ])
        self.client.post('/api/chat', json={'message': 'add call mum'}, headers=self.auth)
        saved = self.client.get('/api/chat/thread/assistant',
                                headers=self.auth).get_json()['messages']
        assistant = saved[-1]
        self.assertEqual(assistant['actions'], [{'action': 'added', 'count': 1}])
        self.assertIsNotNone(assistant['undo_token'])

    def test_start_fresh_clears_only_that_tool(self):
        append_chat_thread(self.user.id, 'cbt', [{'role': 'user', 'content': 'a'}])
        append_chat_thread(self.user.id, 'assistant', [{'role': 'user', 'content': 'b'}])
        res = self.client.delete('/api/chat/thread/cbt', headers=self.auth)
        self.assertTrue(res.get_json()['cleared'])
        self.assertEqual(self.client.get('/api/chat/thread/cbt',
                                         headers=self.auth).get_json()['messages'], [])
        self.assertEqual(len(self.client.get('/api/chat/thread/assistant',
                                             headers=self.auth).get_json()['messages']), 1)

    def test_thread_is_capped(self):
        for i in range(MAX_THREAD_MESSAGES + 30):
            append_chat_thread(self.user.id, 'exec', [{'role': 'user', 'content': f'm{i}'}])
        thread = ChatThread.query.filter_by(user_id=self.user.id, tool_id='exec').one()
        msgs = thread.messages_list()
        self.assertEqual(len(msgs), MAX_THREAD_MESSAGES)
        self.assertEqual(msgs[0]['content'], 'm30')   # oldest trimmed
        self.assertEqual(msgs[-1]['content'], f'm{MAX_THREAD_MESSAGES + 29}')

    def test_threads_are_user_scoped(self):
        other = User(email='other-thread@example.com', name='O',
                     password_hash='x', tier='pro')
        db.session.add(other)
        db.session.commit()
        append_chat_thread(other.id, 'assistant', [{'role': 'user', 'content': 'secret'}])
        mine = self.client.get('/api/chat/thread/assistant', headers=self.auth).get_json()
        self.assertEqual(mine['messages'], [])

    def test_requires_auth(self):
        self.assertEqual(self.client.get('/api/chat/thread/assistant').status_code, 401)


if __name__ == '__main__':
    unittest.main()
