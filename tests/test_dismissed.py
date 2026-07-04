"""
Tests for cross-device timebox pool dismissals (/api/timebox/dismissed).

    python -m pytest tests/test_dismissed.py       # or
    python -m unittest tests.test_dismissed
"""
import os
import tempfile
import unittest

_DB_FD, _DB_PATH = tempfile.mkstemp(suffix='.db')
os.close(_DB_FD)
os.environ.setdefault('DATABASE_URL', f'sqlite:///{_DB_PATH}')
os.environ.setdefault('JWT_SECRET_KEY', 'test-secret')

from backend.app import app, db, limiter  # noqa: E402

limiter.enabled = False


class DismissedRouteTests(unittest.TestCase):
    def setUp(self):
        self.ctx = app.app_context()
        self.ctx.push()
        db.drop_all()
        db.create_all()
        self.client = app.test_client()
        res = self.client.post('/api/auth/register', json={
            'name': 'D', 'email': 'dis@example.com', 'password': 'password123',
        })
        self.auth = {'Authorization': f"Bearer {res.get_json()['access_token']}"}
        res2 = self.client.post('/api/auth/register', json={
            'name': 'D2', 'email': 'dis2@example.com', 'password': 'password123',
        })
        self.auth2 = {'Authorization': f"Bearer {res2.get_json()['access_token']}"}

    def tearDown(self):
        db.session.remove()
        db.drop_all()
        self.ctx.pop()

    def test_requires_auth(self):
        self.assertEqual(self.client.get('/api/timebox/dismissed/2026-07-04').status_code, 401)

    def test_roundtrip_like_two_devices(self):
        # "Desktop" starts empty, dismisses two tasks
        res = self.client.get('/api/timebox/dismissed/2026-07-04', headers=self.auth)
        self.assertEqual(res.get_json()['task_ids'], [])
        put = self.client.put('/api/timebox/dismissed/2026-07-04',
                              json={'task_ids': [4, 9]}, headers=self.auth)
        self.assertEqual(put.status_code, 200)

        # "Mobile" (same account, fresh device) sees them
        res2 = self.client.get('/api/timebox/dismissed/2026-07-04', headers=self.auth)
        self.assertEqual(sorted(res2.get_json()['task_ids']), [4, 9])

        # Different date is independent
        other = self.client.get('/api/timebox/dismissed/2026-07-05', headers=self.auth)
        self.assertEqual(other.get_json()['task_ids'], [])

        # Overwrite replaces
        self.client.put('/api/timebox/dismissed/2026-07-04',
                        json={'task_ids': [4]}, headers=self.auth)
        self.assertEqual(self.client.get('/api/timebox/dismissed/2026-07-04',
                                         headers=self.auth).get_json()['task_ids'], [4])

    def test_user_scoped(self):
        self.client.put('/api/timebox/dismissed/2026-07-04',
                        json={'task_ids': [1, 2]}, headers=self.auth)
        res = self.client.get('/api/timebox/dismissed/2026-07-04', headers=self.auth2)
        self.assertEqual(res.get_json()['task_ids'], [])

    def test_garbage_ids_filtered(self):
        self.client.put('/api/timebox/dismissed/2026-07-04',
                        json={'task_ids': [1, 'nope', None, '7', {}]}, headers=self.auth)
        res = self.client.get('/api/timebox/dismissed/2026-07-04', headers=self.auth)
        self.assertEqual(sorted(res.get_json()['task_ids']), [1, 7])


if __name__ == '__main__':
    unittest.main()
