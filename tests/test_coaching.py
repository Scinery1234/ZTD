"""
Unit tests for the AI coaching hub.

These exercise the task-aware pieces of CoachingService directly — the
save_tasks handler, the current-task snapshot injected into the coach's system
prompt, and server-side crisis detection — so they need no Anthropic API key.

Run from the repo root:

    python -m pytest tests/test_coaching.py        # or
    python -m unittest tests.test_coaching
"""
import os
import tempfile
import unittest
from types import SimpleNamespace

# Point the app at a throwaway SQLite file before importing it.
_DB_FD, _DB_PATH = tempfile.mkstemp(suffix='.db')
os.close(_DB_FD)
os.environ['DATABASE_URL'] = f'sqlite:///{_DB_PATH}'
os.environ.setdefault('JWT_SECRET_KEY', 'test-secret')

from backend.app import (  # noqa: E402
    app, db, User, Hat, Task, ChatUndo, ChatThread, check_task_limit,
    append_chat_thread,
)
from backend.ai_chat import TaskChatService  # noqa: E402
from backend.coaching import (  # noqa: E402
    CoachingService, COACHES, MODULE_IDS, detect_crisis, coach_openers,
    _TASK_AWARENESS,
)


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


class CoachingServiceTests(unittest.TestCase):
    def setUp(self):
        self.ctx = app.app_context()
        self.ctx.push()
        db.create_all()
        self.user = User(email='c@example.com', name='C',
                         password_hash='x', tier='pro')  # pro = unlimited tasks
        db.session.add(self.user)
        db.session.commit()
        self.hat = Hat(user_id=self.user.id, name='Main Hat')
        db.session.add(self.hat)
        db.session.commit()
        self.svc = CoachingService(db, Task, Hat, check_task_limit)

    def tearDown(self):
        db.session.remove()
        db.drop_all()
        self.ctx.pop()

    # ---- save_tasks tool ----
    def test_save_tasks_creates_real_tasks(self):
        added = []
        res = self.svc._save_tasks(
            self.user, self.hat.id,
            {'tasks': [
                {'description': 'Email the landlord', 'priority': 'today'},
                {'description': 'Ten-minute walk', 'due': 'tomorrow'},
            ]},
            added,
        )
        self.assertEqual(res['content']['saved_count'], 2)
        self.assertEqual(Task.query.filter_by(user_id=self.user.id).count(), 2)
        self.assertEqual({a['description'] for a in added},
                         {'Email the landlord', 'Ten-minute walk'})
        t = Task.query.filter_by(description='Email the landlord').first()
        self.assertEqual(t.priority, 'today')
        self.assertEqual(t.hat_id, self.hat.id)

    def test_save_tasks_skips_blank_descriptions(self):
        added = []
        res = self.svc._save_tasks(self.user, self.hat.id,
                                   {'tasks': [{'description': '   '}]}, added)
        self.assertEqual(res['content']['saved_count'], 0)
        self.assertEqual(added, [])

    def test_save_tasks_respects_free_tier_limit(self):
        free = User(email='free@example.com', name='F', password_hash='x', tier='free')
        db.session.add(free)
        db.session.commit()
        db.session.add(Hat(user_id=free.id, name='Main Hat'))
        db.session.commit()
        limit = check_task_limit  # sanity: helper is callable
        self.assertTrue(callable(limit))
        # Fill to the free-tier limit, then try to save one more via coaching.
        while check_task_limit(free) is None:
            max_pos = (db.session.query(db.func.max(Task.position))
                       .filter_by(user_id=free.id).scalar() or 0)
            db.session.add(Task(user_id=free.id, description='x', position=max_pos + 1))
            db.session.commit()
        before = Task.query.filter_by(user_id=free.id).count()
        added = []
        res = self.svc._save_tasks(free, None, {'tasks': [{'description': 'one more'}]}, added)
        self.assertEqual(res['content']['saved_count'], 0)
        self.assertIn('skipped_due_to_task_limit', res['content'])
        self.assertEqual(Task.query.filter_by(user_id=free.id).count(), before)

    # ---- task snapshot injected into the coach prompt ----
    def test_task_snapshot_includes_user_tasks(self):
        db.session.add(Task(user_id=self.user.id, description='Pay rent',
                            priority='urgent', due='2026-07-10', position=1))
        db.session.commit()
        snap = self.svc._task_snapshot(self.user.id)
        self.assertIn('Pay rent', snap)
        self.assertIn('urgent', snap)
        self.assertIn('2026-07-10', snap)

    def test_task_snapshot_empty(self):
        self.assertIn('no tasks', self.svc._task_snapshot(self.user.id))

    def test_system_prompt_is_task_aware(self):
        db.session.add(Task(user_id=self.user.id, description='Book dentist', position=1))
        db.session.commit()
        prompt = self.svc._system_prompt(self.user, COACHES['exec'])
        self.assertIn('Book dentist', prompt)
        self.assertIn('save_tasks', prompt)          # tool guidance present
        self.assertIn('Lifeline 13 11 14', prompt)   # safety block present

    # ---- message assembly ----
    def test_build_messages_appends_user_turn_last(self):
        history = [
            {'role': 'assistant', 'content': 'Hello'},
            {'role': 'user', 'content': 'Hi'},
        ]
        msgs = self.svc._build_messages(history, 'I feel stuck')
        self.assertEqual(msgs[0]['role'], 'user')     # API requires user first
        self.assertEqual(msgs[-1]['content'], 'I feel stuck')

    # ---- crisis detection & config ----
    def test_detect_crisis(self):
        self.assertTrue(detect_crisis('I want to die'))
        self.assertTrue(detect_crisis('sometimes I think about self-harm'))
        self.assertFalse(detect_crisis('I am tired and behind on my tasks'))

    def test_run_unknown_coach_raises(self):
        with self.assertRaises(ValueError):
            self.svc.run(self.user, 'not-a-coach', 'hi', [])

    def test_coach_openers_cover_all_coaches(self):
        openers = coach_openers()
        self.assertEqual(set(openers), set(COACHES))
        self.assertTrue(all(openers.values()))

    # ---- offer-first guidance ("adds tasks too prematurely") ----
    def test_task_awareness_is_offer_first(self):
        self.assertIn('OFFER FIRST', _TASK_AWARENESS)
        self.assertIn('update_tasks', _TASK_AWARENESS)
        self.assertIn('delete_tasks', _TASK_AWARENESS)
        # The old eager instruction ("so it lands ... and isn't lost") is gone.
        self.assertNotIn("isn't lost", _TASK_AWARENESS)

    def test_task_snapshot_includes_ids(self):
        t = Task(user_id=self.user.id, description='Pay rent', position=1)
        db.session.add(t)
        db.session.commit()
        snap = self.svc._task_snapshot(self.user.id)
        self.assertIn(f'[#{t.id}]', snap)


class CoachTaskEditTests(unittest.TestCase):
    """Coaches can modify and delete real tasks (with undo), via a scripted
    model — the fix for 'the chatbot ... cant delete or modify tasks'."""

    def setUp(self):
        self.ctx = app.app_context()
        self.ctx.push()
        db.drop_all()
        db.create_all()
        self.user = User(email='ce@example.com', name='CE',
                         password_hash='x', tier='pro')
        db.session.add(self.user)
        db.session.commit()
        self.hat = Hat(user_id=self.user.id, name='Main Hat')
        db.session.add(self.hat)
        db.session.commit()
        self.task = Task(user_id=self.user.id, description='Book dentist',
                         priority='later', position=1)
        db.session.add(self.task)
        db.session.commit()

    def tearDown(self):
        db.session.remove()
        db.drop_all()
        self.ctx.pop()

    def svc(self, script):
        s = CoachingService(db, Task, Hat, check_task_limit, ChatUndo=ChatUndo)
        s.client = FakeClient(script)
        return s

    def test_coach_tools_include_edit_and_list(self):
        s = self.svc([final_response('Hi.')])
        s.run(self.user, 'exec', 'hello', [])
        names = {t['name'] for t in s.client.messages.calls[0]['tools']}
        self.assertTrue({'save_tasks', 'list_tasks',
                         'update_tasks', 'delete_tasks'} <= names)

    def test_coach_can_update_a_task(self):
        s = self.svc([
            tool_response(tool_block('update_tasks', {
                'updates': [{'id': self.task.id, 'priority': 'urgent'}],
            })),
            final_response('Bumped it to urgent for you.'),
        ])
        out = s.run(self.user, 'exec', 'yes please make the dentist urgent', [])
        self.assertEqual(Task.query.get(self.task.id).priority, 'urgent')
        self.assertEqual(out['task_actions'], [{'action': 'updated', 'count': 1}])
        self.assertTrue(out['undo_available'])

    def test_coach_can_delete_a_task_and_undo_restores_it(self):
        s = self.svc([
            tool_response(tool_block('delete_tasks', {'ids': [self.task.id]})),
            final_response('Gone — one less thing to carry.'),
        ])
        out = s.run(self.user, 'action', 'yes, delete the dentist task', [])
        self.assertIsNone(Task.query.get(self.task.id))
        self.assertEqual(out['task_actions'], [{'action': 'deleted', 'count': 1}])
        self.assertIsNotNone(out['undo_token'])

        # The shared /api/chat/undo path reverts the coach's turn too.
        res = s._editor.undo(self.user, out['undo_token'])
        self.assertTrue(res['undone'])
        self.assertIsNotNone(
            Task.query.filter_by(user_id=self.user.id,
                                 description='Book dentist').first())

    def test_coach_can_list_tasks(self):
        s = self.svc([
            tool_response(tool_block('list_tasks',
                                     {'query': 'dentist', 'category': '', 'priority': ''})),
            final_response('I can see it on your list.'),
        ])
        s.run(self.user, 'clarity', 'is the dentist thing still on my list?', [])
        # The tool result fed back to the model contains the real task.
        tool_result = s.client.messages.calls[1]['messages'][-1]['content'][0]
        self.assertIn('Book dentist', tool_result['content'])

    def test_edit_tools_are_user_scoped(self):
        other = User(email='other@example.com', name='O', password_hash='x', tier='pro')
        db.session.add(other)
        db.session.commit()
        theirs = Task(user_id=other.id, description='Their task', position=1)
        db.session.add(theirs)
        db.session.commit()

        s = self.svc([
            tool_response(tool_block('delete_tasks', {'ids': [theirs.id]})),
            final_response('Done.'),
        ])
        out = s.run(self.user, 'cbt', 'delete it', [])
        self.assertIsNotNone(Task.query.get(theirs.id))   # untouched
        self.assertEqual(out['task_actions'], [])
        self.assertFalse(out['undo_available'])

    def test_guide_coach_exists_with_module_catalogue(self):
        self.assertIn('guide', COACHES)
        system = COACHES['guide']['system']
        for mid in MODULE_IDS:
            self.assertIn(mid, system)
        self.assertIn('recommend_module', system)

    def test_guide_gets_recommend_tool_other_coaches_do_not(self):
        s = self.svc([final_response('Hi.')])
        s.run(self.user, 'guide', 'hello', [])
        names = {t['name'] for t in s.client.messages.calls[0]['tools']}
        self.assertIn('recommend_module', names)
        # Guide still has the full task toolkit
        self.assertTrue({'save_tasks', 'list_tasks',
                         'update_tasks', 'delete_tasks'} <= names)

        s2 = self.svc([final_response('Hi.')])
        s2.run(self.user, 'cbt', 'hello', [])
        names2 = {t['name'] for t in s2.client.messages.calls[0]['tools']}
        self.assertNotIn('recommend_module', names2)

    def test_recommend_module_surfaces_card(self):
        s = self.svc([
            tool_response(tool_block('recommend_module', {
                'module': 'clarity', 'reason': 'A big decision deserves structure.',
            })),
            final_response('Clarity Compass might serve you here.'),
        ])
        out = s.run(self.user, 'guide', "I can't decide whether to move cities", [])
        self.assertEqual(out['module_suggestions'],
                         [{'module': 'clarity',
                           'reason': 'A big decision deserves structure.'}])

    def test_recommend_unknown_module_is_rejected(self):
        s = self.svc([
            tool_response(tool_block('recommend_module', {'module': 'astrology'})),
            final_response('Hmm.'),
        ])
        out = s.run(self.user, 'guide', 'help', [])
        self.assertEqual(out['module_suggestions'], [])

    def test_save_tasks_records_undo(self):
        s = self.svc([
            tool_response(tool_block('save_tasks', {
                'tasks': [{'description': 'Ten-minute walk'}],
            })),
            final_response("I've added that to your list."),
        ])
        out = s.run(self.user, 'exec', 'yes add the walk', [])
        self.assertEqual(out['tasks_added'][0]['description'], 'Ten-minute walk')
        self.assertEqual(out['task_actions'], [{'action': 'added', 'count': 1}])
        self.assertIsNotNone(out['undo_token'])

        res = s._editor.undo(self.user, out['undo_token'])
        self.assertTrue(res['undone'])
        self.assertIsNone(Task.query.filter_by(
            user_id=self.user.id, description='Ten-minute walk').first())


class CrossThreadVisibilityTests(unittest.TestCase):
    """Every module (coaches, guide, task assistant) sees excerpts of the
    user's other conversations, but never its own thread re-quoted."""

    def setUp(self):
        self.ctx = app.app_context()
        self.ctx.push()
        db.drop_all()
        db.create_all()
        self.user = User(email='xt@example.com', name='X',
                         password_hash='x', tier='pro')
        db.session.add(self.user)
        db.session.commit()
        self.hat = Hat(user_id=self.user.id, name='Main Hat')
        db.session.add(self.hat)
        db.session.commit()
        # Seed saved threads for three different tools
        append_chat_thread(self.user.id, 'guide', [
            {'role': 'user', 'content': 'My big goal is opening a bakery.'},
            {'role': 'assistant', 'content': 'A bakery — wonderful. What is the first step?'},
        ])
        append_chat_thread(self.user.id, 'cbt', [
            {'role': 'user', 'content': 'I keep catastrophising about money.'},
            {'role': 'assistant', 'content': 'Step 1 — what is bothering you most?'},
        ])
        append_chat_thread(self.user.id, 'assistant', [
            {'role': 'user', 'content': 'add task research commercial ovens'},
            {'role': 'assistant', 'content': 'Added 1 task.'},
        ])

    def tearDown(self):
        db.session.remove()
        db.drop_all()
        self.ctx.pop()

    def coach_svc(self, script):
        s = CoachingService(db, Task, Hat, check_task_limit,
                            ChatUndo=ChatUndo, ChatThread=ChatThread)
        s.client = FakeClient(script)
        return s

    def test_coach_sees_main_chat_and_assistant_but_not_itself(self):
        s = self.coach_svc([final_response('Hi.')])
        s.run(self.user, 'cbt', 'hello', [])
        system = s.client.messages.calls[0]['system']
        self.assertIn('OTHER CONVERSATIONS', system)
        self.assertIn('opening a bakery', system)              # guide (main chat)
        self.assertIn('research commercial ovens', system)     # task assistant
        self.assertIn('MadeHappen Coach (main chat)', system)
        self.assertNotIn('catastrophising', system)            # its own thread

    def test_guide_sees_coach_threads(self):
        s = self.coach_svc([final_response('Hi.')])
        s.run(self.user, 'guide', 'hello', [])
        system = s.client.messages.calls[0]['system']
        self.assertIn('catastrophising', system)               # CBT thread
        self.assertIn('CBT Coach', system)
        self.assertNotIn('opening a bakery', system)           # its own thread

    def test_assistant_sees_coach_and_guide_threads(self):
        s = TaskChatService(db, Task, Hat, ChatUndo, check_task_limit,
                            ChatThread=ChatThread)
        s.client = FakeClient([final_response('Hi!')])
        s.run(self.user, None, 'hi', [])
        system = s.client.messages.calls[0]['system']
        self.assertIn('opening a bakery', system)
        self.assertIn('catastrophising', system)
        self.assertNotIn('research commercial ovens', system)  # its own thread

    def test_no_threads_no_block(self):
        ChatThread.query.delete()
        db.session.commit()
        s = self.coach_svc([final_response('Hi.')])
        s.run(self.user, 'cbt', 'hello', [])
        self.assertNotIn('OTHER CONVERSATIONS',
                         s.client.messages.calls[0]['system'])


if __name__ == '__main__':
    unittest.main()
