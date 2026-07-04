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

# Point the app at a throwaway SQLite file before importing it.
_DB_FD, _DB_PATH = tempfile.mkstemp(suffix='.db')
os.close(_DB_FD)
os.environ['DATABASE_URL'] = f'sqlite:///{_DB_PATH}'
os.environ.setdefault('JWT_SECRET_KEY', 'test-secret')

from backend.app import app, db, User, Hat, Task, check_task_limit  # noqa: E402
from backend.coaching import (  # noqa: E402
    CoachingService, COACHES, detect_crisis, coach_openers,
)


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


if __name__ == '__main__':
    unittest.main()
