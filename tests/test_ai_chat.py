"""
Unit tests for the AI chat task tools and the per-turn undo stack.

These exercise the TaskChatService mutation handlers directly (the same code the
Claude tool-use loop calls), so they need no Anthropic API key — only the Flask /
SQLAlchemy stack. Run from the repo root:

    python -m pytest tests/test_ai_chat.py        # or
    python -m unittest tests.test_ai_chat
"""
import os
import tempfile
import unittest

# Point the app at a throwaway SQLite file before importing it.
_DB_FD, _DB_PATH = tempfile.mkstemp(suffix='.db')
os.close(_DB_FD)
os.environ['DATABASE_URL'] = f'sqlite:///{_DB_PATH}'
os.environ.setdefault('JWT_SECRET_KEY', 'test-secret')

from backend.app import app, db, User, Hat, Task, ChatUndo, check_task_limit  # noqa: E402
from backend.ai_chat import TaskChatService  # noqa: E402


class AIChatToolTests(unittest.TestCase):
    def setUp(self):
        self.ctx = app.app_context()
        self.ctx.push()
        db.create_all()
        self.user = User(email='t@example.com', name='T',
                         password_hash='x', tier='pro')  # pro = unlimited tasks
        db.session.add(self.user)
        db.session.commit()
        self.hat = Hat(user_id=self.user.id, name='Main Hat')
        db.session.add(self.hat)
        db.session.commit()
        self.svc = TaskChatService(db, Task, Hat, ChatUndo, check_task_limit)

    def tearDown(self):
        db.session.remove()
        db.drop_all()
        self.ctx.pop()

    def _add(self, tasks):
        ops, actions = [], []
        res = self.svc._add_tasks(self.user, self.hat.id, {'tasks': tasks}, ops, actions)
        return res, ops, actions

    def test_add_tasks(self):
        res, ops, actions = self._add([
            {'description': 'Buy milk', 'category': 'Shopping',
             'priority': 'today', 'recurring': '', 'due': ''},
            {'description': 'Call dentist', 'category': '',
             'priority': 'urgent', 'recurring': '', 'due': ''},
        ])
        self.assertEqual(res['content']['added_count'], 2)
        self.assertEqual(Task.query.filter_by(user_id=self.user.id).count(), 2)
        self.assertEqual(ops[0]['type'], 'created')
        self.assertEqual(len(ops[0]['ids']), 2)
        self.assertEqual(actions[0], {'action': 'added', 'count': 2})

    def test_list_tasks_filters(self):
        self._add([
            {'description': 'Buy milk', 'category': 'Shopping',
             'priority': 'today', 'recurring': '', 'due': ''},
            {'description': 'Buy eggs', 'category': 'Shopping',
             'priority': 'later', 'recurring': '', 'due': ''},
            {'description': 'Email boss', 'category': 'Work',
             'priority': 'urgent', 'recurring': '', 'due': ''},
        ])
        by_cat = self.svc._list_tasks(self.user.id, {'query': '', 'category': 'Shopping', 'priority': ''})
        self.assertEqual(by_cat['content']['count'], 2)
        by_query = self.svc._list_tasks(self.user.id, {'query': 'milk', 'category': '', 'priority': ''})
        self.assertEqual(by_query['content']['count'], 1)
        self.assertEqual(by_query['content']['tasks'][0]['description'], 'Buy milk')

    def test_update_tasks_and_undo(self):
        _, _, _ = self._add([{'description': 'Plan trip', 'category': '',
                              'priority': 'later', 'recurring': '', 'due': ''}])
        tid = Task.query.filter_by(user_id=self.user.id).first().id

        ops, actions = [], []
        self.svc._update_tasks(self.user.id, {'updates': [{'id': tid, 'priority': 'urgent', 'category': 'Travel'}]},
                               ops, actions)
        t = Task.query.get(tid)
        self.assertEqual(t.priority, 'urgent')
        self.assertEqual(t.category, 'Travel')

        # Persist the inverse and undo the turn → fields restored.
        token = self.svc._save_undo(self.user.id, ops, actions)
        out = self.svc.undo(self.user, token)
        self.assertTrue(out['undone'])
        t = Task.query.get(tid)
        self.assertEqual(t.priority, 'later')
        self.assertEqual(t.category, '')

    def test_delete_tasks_and_undo(self):
        self._add([
            {'description': 'A', 'category': '', 'priority': '', 'recurring': '', 'due': ''},
            {'description': 'B', 'category': '', 'priority': '', 'recurring': '', 'due': ''},
        ])
        ids = [t.id for t in Task.query.filter_by(user_id=self.user.id).all()]

        ops, actions = [], []
        self.svc._delete_tasks(self.user.id, {'ids': ids}, ops, actions)
        self.assertEqual(Task.query.filter_by(user_id=self.user.id).count(), 0)

        token = self.svc._save_undo(self.user.id, ops, actions)
        self.svc.undo(self.user, token)
        # Both tasks come back (with new ids).
        restored = Task.query.filter_by(user_id=self.user.id).all()
        self.assertEqual(len(restored), 2)
        self.assertEqual({t.description for t in restored}, {'A', 'B'})

    def test_add_undo_removes_created(self):
        _, ops, actions = self._add([
            {'description': 'Temp', 'category': '', 'priority': '', 'recurring': '', 'due': ''},
        ])
        token = self.svc._save_undo(self.user.id, ops, actions)
        self.svc.undo(self.user, token)
        self.assertEqual(Task.query.filter_by(user_id=self.user.id).count(), 0)

    def test_undo_nothing(self):
        out = self.svc.undo(self.user)
        self.assertFalse(out['undone'])

    def test_undo_stack_trim(self):
        # More than MAX_UNDO_ENTRIES turns → only the most recent are retained.
        from backend.ai_chat import MAX_UNDO_ENTRIES
        for i in range(MAX_UNDO_ENTRIES + 3):
            _, ops, actions = self._add([
                {'description': f'task{i}', 'category': '', 'priority': '', 'recurring': '', 'due': ''},
            ])
            self.svc._save_undo(self.user.id, ops, actions)
        self.assertEqual(ChatUndo.query.filter_by(user_id=self.user.id).count(), MAX_UNDO_ENTRIES)

    def test_user_scoping(self):
        # A second user can't see or delete the first user's tasks.
        other = User(email='o@example.com', name='O', password_hash='x', tier='pro')
        db.session.add(other)
        db.session.commit()
        self._add([{'description': 'mine', 'category': '', 'priority': '', 'recurring': '', 'due': ''}])
        mine_id = Task.query.filter_by(user_id=self.user.id).first().id

        listed = self.svc._list_tasks(other.id, {'query': '', 'category': '', 'priority': ''})
        self.assertEqual(listed['content']['count'], 0)

        ops, actions = [], []
        self.svc._delete_tasks(other.id, {'ids': [mine_id]}, ops, actions)
        self.assertIsNotNone(Task.query.get(mine_id))  # untouched


if __name__ == '__main__':
    unittest.main()
