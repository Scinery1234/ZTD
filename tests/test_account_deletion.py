"""
Account deletion (App Store guideline 5.1.1(v)).

An app that lets people create an account must let them delete it from inside
the app, and deletion has to actually remove their data — not just deactivate
the login. These tests pin both halves down.
"""
import os
import tempfile
import unittest

_DB_FD, _DB_PATH = tempfile.mkstemp(suffix='.db')
os.close(_DB_FD)
os.environ['DATABASE_URL'] = f'sqlite:///{_DB_PATH}'
os.environ.setdefault('JWT_SECRET_KEY', 'test-secret')

from backend.app import (  # noqa: E402
    app, db, limiter, User, Hat, Task, DoneTask, Goal, GoalMilestone, ChatUndo,
    ChatThread, CoachMemory, TimeboxDismissed,
)

limiter.enabled = False   # registering per-test would otherwise trip the limiter


class AccountDeletionTests(unittest.TestCase):
    def setUp(self):
        self.ctx = app.app_context()
        self.ctx.push()
        db.session.remove()      # a prior test's session can block drop_all
        db.drop_all()
        db.create_all()
        self.client = app.test_client()
        res = self.client.post('/api/auth/register', json={
            'name': 'D', 'email': 'del@example.com', 'password': 'password123',
        })
        self.assertEqual(res.status_code, 201, f'register failed: {res.get_json()}')
        self.auth = {'Authorization': f"Bearer {res.get_json()['access_token']}"}
        self.user = User.query.filter_by(email='del@example.com').one()

    def tearDown(self):
        db.session.remove()
        db.drop_all()
        self.ctx.pop()

    def _seed(self):
        """Give the account a row in every table that holds user data."""
        hat = Hat.query.filter_by(user_id=self.user.id).first()
        if hat is None:
            hat = Hat(user_id=self.user.id, name='Main Hat')
            db.session.add(hat)
            db.session.commit()
        goal = Goal(user_id=self.user.id, title='A goal')
        db.session.add(goal)
        db.session.commit()
        db.session.add_all([
            Task(user_id=self.user.id, description='a task', position=1),
            DoneTask(user_id=self.user.id, description='done task'),
            GoalMilestone(goal_id=goal.id, user_id=self.user.id, title='m1'),
            ChatUndo(user_id=self.user.id, summary='x', payload='[]'),
            ChatThread(user_id=self.user.id, tool_id='assistant', messages='[]'),
            CoachMemory(user_id=self.user.id, coach_id='guide', content='remembered'),
            TimeboxDismissed(user_id=self.user.id, date='2026-08-07', task_ids='[1]'),
        ])
        db.session.commit()

    def test_requires_auth(self):
        self.assertEqual(self.client.delete('/api/auth/me').status_code, 401)

    def test_wrong_password_rejected(self):
        res = self.client.delete('/api/auth/me', json={'password': 'nope'},
                                 headers=self.auth)
        self.assertEqual(res.status_code, 401)
        self.assertIsNotNone(User.query.filter_by(email='del@example.com').first())

    def test_missing_password_rejected(self):
        res = self.client.delete('/api/auth/me', json={}, headers=self.auth)
        self.assertEqual(res.status_code, 401)
        self.assertIsNotNone(User.query.filter_by(email='del@example.com').first())

    def test_deletes_account_and_all_user_data(self):
        self._seed()
        uid = self.user.id
        res = self.client.delete('/api/auth/me', json={'password': 'password123'},
                                 headers=self.auth)
        self.assertEqual(res.status_code, 200)
        self.assertTrue(res.get_json()['deleted'])

        self.assertIsNone(User.query.get(uid))
        for model in (Hat, Task, DoneTask, Goal, GoalMilestone, ChatUndo,
                      ChatThread, CoachMemory, TimeboxDismissed):
            self.assertEqual(
                model.query.filter_by(user_id=uid).count(), 0,
                f'{model.__name__} rows survived account deletion')

    def test_only_deletes_the_caller(self):
        self._seed()
        other = self.client.post('/api/auth/register', json={
            'name': 'O', 'email': 'keep@example.com', 'password': 'password123',
        })
        keep = User.query.filter_by(email='keep@example.com').one()
        db.session.add(Task(user_id=keep.id, description='theirs', position=1))
        db.session.commit()

        self.client.delete('/api/auth/me', json={'password': 'password123'},
                           headers=self.auth)
        self.assertIsNotNone(User.query.get(keep.id))
        self.assertEqual(Task.query.filter_by(user_id=keep.id).count(), 1)
        self.assertTrue(other.get_json()['access_token'])

    def test_token_is_useless_after_deletion(self):
        self.client.delete('/api/auth/me', json={'password': 'password123'},
                           headers=self.auth)
        # The JWT is still signed correctly but the account behind it is gone.
        self.assertEqual(self.client.get('/api/auth/me', headers=self.auth).status_code, 404)


if __name__ == '__main__':
    unittest.main()
