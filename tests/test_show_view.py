"""
show_view — the coach's window management.

Every other tool the model holds reads or writes a task. This one only asks the
client to put a panel in front of the user, which makes two things worth
pinning down: that a valid call produces an intent the client can act on, and
that no call, valid or not, ever touches the database.

Run from the repo root:

    python -m pytest tests/test_show_view.py
"""
import datetime as dt
import os
import tempfile
import unittest
from types import SimpleNamespace

_DB_FD, _DB_PATH = tempfile.mkstemp(suffix='.db')
os.close(_DB_FD)
os.environ['DATABASE_URL'] = f'sqlite:///{_DB_PATH}'
os.environ.setdefault('JWT_SECRET_KEY', 'test-secret')

from backend.app import (  # noqa: E402
    app, db, limiter, User, Hat, Task, ChatUndo, check_task_limit,
)
from backend import ai_chat as _ai_chat  # noqa: E402
from backend.ai_chat import (  # noqa: E402
    SHOW_VIEW_TOOL, VIEWS, MAX_VIEW_TASK_IDS, MAX_VIEW_LABEL_CHARS,
    TaskChatService, handle_show_view,
)
from backend.coaching import CoachingService  # noqa: E402

limiter.enabled = False


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
        return self.script.pop(0) if self.script else final_response()


class FakeClient:
    def __init__(self, script):
        self.messages = FakeMessages(script)


# ── the handler in isolation ─────────────────────────────────────────────────
class HandlerTests(unittest.TestCase):
    def test_minimal_call_records_the_view(self):
        intents = []
        res = handle_show_view({'view': 'tasks'}, intents)
        self.assertFalse(res.get('is_error'))
        self.assertEqual(intents, [{'view': 'tasks'}])

    def test_unknown_view_is_rejected(self):
        intents = []
        res = handle_show_view({'view': 'inbox'}, intents)
        self.assertTrue(res['is_error'])
        self.assertIn('inbox', res['content']['error'])
        self.assertEqual(intents, [])

    def test_missing_view_is_rejected(self):
        self.assertTrue(handle_show_view({}, [])['is_error'])

    def test_natural_language_date_is_resolved(self):
        intents = []
        handle_show_view({'view': 'day', 'date': 'tomorrow'}, intents)
        expected = (dt.date.today() + dt.timedelta(days=1)).strftime('%Y-%m-%d')
        self.assertEqual(intents[0]['date'], expected)

    def test_iso_date_passes_through(self):
        intents = []
        handle_show_view({'view': 'day', 'date': '2026-11-03'}, intents)
        self.assertEqual(intents[0]['date'], '2026-11-03')

    def test_unreadable_date_is_an_error_not_a_guess(self):
        """A date the parser echoes back verbatim would reach the client as a
        bogus 'date' and open the calendar on nothing. Reject it instead."""
        intents = []
        res = handle_show_view({'view': 'day', 'date': 'whenever-ish'}, intents)
        self.assertTrue(res['is_error'])
        self.assertEqual(intents, [])

    def test_date_is_ignored_for_non_day_views(self):
        intents = []
        handle_show_view({'view': 'tasks', 'date': '2026-11-03'}, intents)
        self.assertNotIn('date', intents[0])

    def test_task_ids_are_kept_and_capped(self):
        intents = []
        handle_show_view({'view': 'tasks',
                          'task_ids': list(range(MAX_VIEW_TASK_IDS + 10))}, intents)
        self.assertEqual(len(intents[0]['task_ids']), MAX_VIEW_TASK_IDS)

    def test_non_integer_task_ids_are_dropped(self):
        intents = []
        handle_show_view({'view': 'tasks', 'task_ids': [1, 'two', None, 3]}, intents)
        self.assertEqual(intents[0]['task_ids'], [1, 3])

    def test_empty_task_ids_leave_the_key_out(self):
        intents = []
        handle_show_view({'view': 'goals', 'task_ids': []}, intents)
        self.assertEqual(intents[0], {'view': 'goals'})

    def test_filter_is_kept_for_the_task_list(self):
        intents = []
        handle_show_view({'view': 'tasks',
                          'filter': {'priority': 'urgent', 'due': 'overdue',
                                     'category': '  Work '}}, intents)
        self.assertEqual(intents[0]['filter'],
                         {'priority': 'urgent', 'due': 'overdue', 'category': 'Work'})

    def test_blank_filter_values_are_dropped(self):
        intents = []
        handle_show_view({'view': 'tasks',
                          'filter': {'priority': '', 'category': '   '}}, intents)
        self.assertNotIn('filter', intents[0])

    def test_filter_is_ignored_for_non_task_views(self):
        intents = []
        handle_show_view({'view': 'day', 'filter': {'priority': 'urgent'}}, intents)
        self.assertNotIn('filter', intents[0])

    def test_label_is_trimmed_to_a_button_length(self):
        intents = []
        handle_show_view({'view': 'day', 'label': 'x' * (MAX_VIEW_LABEL_CHARS + 20)},
                         intents)
        self.assertEqual(len(intents[0]['label']), MAX_VIEW_LABEL_CHARS)

    def test_tolerates_no_collector(self):
        """A caller that doesn't collect intents must still get a clean result."""
        res = handle_show_view({'view': 'tasks'}, None)
        self.assertFalse(res.get('is_error'))

    def test_every_declared_view_is_accepted(self):
        for view in VIEWS:
            intents = []
            res = handle_show_view({'view': view}, intents)
            self.assertFalse(res.get('is_error'), view)
            self.assertEqual(intents[0]['view'], view)

    def test_schema_enum_matches_the_handler(self):
        schema_views = SHOW_VIEW_TOOL['input_schema']['properties']['view']['enum']
        self.assertEqual(tuple(schema_views), VIEWS)


# ── through the real agentic loops ───────────────────────────────────────────
class LoopTests(unittest.TestCase):
    def setUp(self):
        self.ctx = app.app_context()
        self.ctx.push()
        db.session.remove()
        db.drop_all()
        db.create_all()
        self.user = User(email='v@example.com', name='V',
                         password_hash='x', tier='pro')
        db.session.add(self.user)
        db.session.commit()
        self.hat = Hat(user_id=self.user.id, name='Main Hat')
        db.session.add(self.hat)
        db.session.commit()
        db.session.add(Task(user_id=self.user.id, description='Pay the invoice',
                            priority='urgent', position=1))
        db.session.commit()

    def tearDown(self):
        db.session.remove()
        db.drop_all()
        self.ctx.pop()

    def _assistant(self, script):
        svc = TaskChatService(db, Task, Hat, ChatUndo, check_task_limit)
        svc.client = FakeClient(script)
        return svc

    def _coach(self, script):
        svc = CoachingService(db, Task, Hat, check_task_limit, ChatUndo=ChatUndo)
        svc.client = FakeClient(script)
        return svc

    def test_assistant_returns_the_intent(self):
        svc = self._assistant([
            tool_response(tool_block('show_view', {'view': 'tasks',
                                                   'filter': {'due': 'overdue'},
                                                   'label': 'See the overdue one'})),
            final_response('Have a look if you want.'),
        ])
        res = svc.run(self.user, None, 'what am I behind on?', [])
        self.assertEqual(res['view_intents'],
                         [{'view': 'tasks', 'filter': {'due': 'overdue'},
                           'label': 'See the overdue one'}])

    def test_coach_returns_the_intent(self):
        svc = self._coach([
            tool_response(tool_block('show_view', {'view': 'day',
                                                   'date': '2026-11-05'})),
            final_response('Shall we look at Thursday?'),
        ])
        res = svc.run(self.user, 'guide', 'I need to plan Thursday', [])
        self.assertEqual(res['view_intents'], [{'view': 'day', 'date': '2026-11-05'}])

    def test_showing_a_view_changes_no_tasks(self):
        """The guarantee that makes this tool safe to let the model fire freely."""
        before = [(t.id, t.description, t.priority, t.due) for t in
                  Task.query.filter_by(user_id=self.user.id).all()]
        svc = self._coach([
            tool_response(tool_block('show_view', {'view': 'tasks',
                                                   'task_ids': [before[0][0]]})),
            final_response('There it is.'),
        ])
        res = svc.run(self.user, 'guide', 'show me', [])
        after = [(t.id, t.description, t.priority, t.due) for t in
                 Task.query.filter_by(user_id=self.user.id).all()]
        self.assertEqual(before, after)
        self.assertEqual(res['task_actions'], [])
        self.assertEqual(res['tasks_added'], [])
        self.assertFalse(res['undo_available'])

    def test_a_rejected_view_doesnt_break_the_turn(self):
        """A bad view is handed back as a tool error so the model can recover,
        not raised — the user still gets a reply."""
        svc = self._coach([
            tool_response(tool_block('show_view', {'view': 'nope'})),
            final_response('Sorry, let me just tell you instead.'),
        ])
        res = svc.run(self.user, 'guide', 'show me', [])
        self.assertEqual(res['view_intents'], [])
        self.assertEqual(res['reply'], 'Sorry, let me just tell you instead.')

    def test_every_coach_can_show_a_view(self):
        """Not just the guide — being able to point at the day matters most in
        the coaches that plan."""
        from backend.coaching import COACHES
        for coach_id in COACHES:
            svc = self._coach([
                tool_response(tool_block('show_view', {'view': 'day'})),
                final_response('Okay.'),
            ])
            res = svc.run(self.user, coach_id, 'show me my day', [])
            self.assertEqual(res['view_intents'], [{'view': 'day'}], coach_id)

    def test_tool_is_offered_to_the_model(self):
        svc = self._coach([final_response('Hi.')])
        svc.run(self.user, 'guide', 'hello', [])
        names = [t['name'] for t in svc.client.messages.calls[0]['tools']]
        self.assertIn('show_view', names)

    def test_assistant_is_offered_the_tool_too(self):
        svc = self._assistant([final_response('Hi.')])
        svc.run(self.user, None, 'hello', [])
        names = [t['name'] for t in svc.client.messages.calls[0]['tools']]
        self.assertIn('show_view', names)

    def test_turn_without_show_view_reports_no_intents(self):
        svc = self._assistant([final_response('Nothing to show.')])
        res = svc.run(self.user, None, 'hi', [])
        self.assertEqual(res['view_intents'], [])

    def test_prompt_explains_the_tool(self):
        svc = self._coach([final_response('Hi.')])
        svc.run(self.user, 'guide', 'hello', [])
        self.assertIn('show_view', svc.client.messages.calls[0]['system'])


# ── the API surface the client depends on ────────────────────────────────────
class ThreadResumeTests(unittest.TestCase):
    """The resumed-conversation divider needs to know when you last spoke."""

    def setUp(self):
        self.ctx = app.app_context()
        self.ctx.push()
        db.session.remove()
        db.drop_all()
        db.create_all()
        self.client = app.test_client()
        res = self.client.post('/api/auth/register', json={
            'name': 'R', 'email': 'resume@example.com', 'password': 'password123',
        })
        self.auth = {'Authorization': f"Bearer {res.get_json()['access_token']}"}

    def tearDown(self):
        db.session.remove()
        db.drop_all()
        self.ctx.pop()

    def test_empty_thread_has_no_timestamp(self):
        body = self.client.get('/api/chat/thread/guide', headers=self.auth).get_json()
        self.assertEqual(body['messages'], [])
        self.assertIsNone(body['updated_at'])

    def test_thread_reports_when_it_was_last_written(self):
        from backend.app import append_chat_thread, User as U
        user = U.query.filter_by(email='resume@example.com').one()
        append_chat_thread(user.id, 'guide', [
            {'role': 'user', 'content': 'hi'},
            {'role': 'assistant', 'content': 'hello', 'viewIntents': []},
        ])
        body = self.client.get('/api/chat/thread/guide', headers=self.auth).get_json()
        self.assertEqual(len(body['messages']), 2)
        self.assertIsNotNone(body['updated_at'])

    def test_view_intents_survive_a_reload(self):
        """A 'show me' button must still work after closing the tab."""
        from backend.app import append_chat_thread, User as U
        user = U.query.filter_by(email='resume@example.com').one()
        append_chat_thread(user.id, 'guide', [
            {'role': 'assistant', 'content': 'Have a look.',
             'viewIntents': [{'view': 'day', 'date': '2026-11-05'}]},
        ])
        body = self.client.get('/api/chat/thread/guide', headers=self.auth).get_json()
        self.assertEqual(body['messages'][0]['viewIntents'],
                         [{'view': 'day', 'date': '2026-11-05'}])


if __name__ == '__main__':
    unittest.main()
