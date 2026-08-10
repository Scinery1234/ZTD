"""
Time blocks — named calendar time that isn't a task.

Blocks show on the timebox grid and auto-schedule routes around them, but never
appear in the task list and never count toward the free-tier task limit. These
tests cover the API, the recurrence rules, and per-occurrence skipping.
"""
import os
import tempfile
import unittest

_DB_FD, _DB_PATH = tempfile.mkstemp(suffix='.db')
os.close(_DB_FD)
os.environ['DATABASE_URL'] = f'sqlite:///{_DB_PATH}'
os.environ.setdefault('JWT_SECRET_KEY', 'test-secret')

from backend.app import app, db, limiter, User, Task, TimeBlock  # noqa: E402

limiter.enabled = False


class BlockTests(unittest.TestCase):
    def setUp(self):
        self.ctx = app.app_context()
        self.ctx.push()
        db.session.remove()
        db.drop_all()
        db.create_all()
        self.client = app.test_client()
        res = self.client.post('/api/auth/register', json={
            'name': 'B', 'email': 'block@example.com', 'password': 'password123',
        })
        self.auth = {'Authorization': f"Bearer {res.get_json()['access_token']}"}
        self.user = User.query.filter_by(email='block@example.com').one()

    def tearDown(self):
        db.session.remove()
        db.drop_all()
        self.ctx.pop()

    def _create(self, **kw):
        body = {'label': 'School run', 'start': '15:00', 'end': '16:00',
                'date': '2026-08-10', 'recurrence': 'none', **kw}
        return self.client.post('/api/blocks', json=body, headers=self.auth)

    # ---- basics ----
    def test_requires_auth(self):
        self.assertEqual(self.client.get('/api/blocks').status_code, 401)

    def test_create_and_list(self):
        res = self._create()
        self.assertEqual(res.status_code, 201)
        body = res.get_json()
        self.assertEqual(body['label'], 'School run')
        self.assertEqual(body['start'], '15:00')
        self.assertEqual(body['recurrence'], 'none')
        listed = self.client.get('/api/blocks', headers=self.auth).get_json()
        self.assertEqual(len(listed), 1)

    def test_blocks_are_not_tasks(self):
        """The whole point: a block must never reach the task list or count
        against the task limit."""
        self._create()
        self.assertEqual(Task.query.filter_by(user_id=self.user.id).count(), 0)
        tasks = self.client.get('/api/tasks', headers=self.auth).get_json()
        self.assertEqual(tasks, [])

    # ---- validation ----
    def test_end_must_follow_start(self):
        res = self._create(start='16:00', end='15:00')
        self.assertEqual(res.status_code, 400)

    def test_bad_time_format_rejected(self):
        self.assertEqual(self._create(start='9am').status_code, 400)

    def test_one_off_needs_a_date(self):
        self.assertEqual(self._create(date=None).status_code, 400)

    def test_weekly_needs_days(self):
        res = self._create(date=None, recurrence='weekly', recur_days=[])
        self.assertEqual(res.status_code, 400)

    def test_unknown_recurrence_rejected(self):
        self.assertEqual(self._create(recurrence='fortnightly').status_code, 400)

    # ---- recurrence ----
    def test_recurring_block_gets_a_start_day(self):
        res = self._create(date=None, recurrence='weekdays', recur_from='2026-08-10')
        self.assertEqual(res.status_code, 201)
        self.assertEqual(res.get_json()['recur_from'], '2026-08-10')

    def test_weekly_stores_days(self):
        res = self._create(date=None, recurrence='weekly',
                           recur_days=[0, 2, 4], recur_from='2026-08-10')
        self.assertEqual(res.get_json()['recur_days'], [0, 2, 4])

    def test_weekday_indexing_is_monday_zero(self):
        """The client expands occurrences using 0=Monday..6=Sunday. Pinning the
        convention here: a 'weekdays' block must cover Mon-Fri, and getting the
        offset wrong shifted it to Tue-Sat."""
        import datetime as _dt
        res = self._create(date=None, recurrence='weekly',
                           recur_days=[0], recur_from='2026-08-10')
        self.assertEqual(res.get_json()['recur_days'], [0])
        # 2026-08-10 is a Monday; Python's weekday() is also Monday=0.
        self.assertEqual(_dt.date(2026, 8, 10).weekday(), 0)

    def test_update_changes_label_and_time(self):
        bid = self._create().get_json()['id']
        res = self.client.put(f'/api/blocks/{bid}',
                              json={'label': 'Gym', 'start': '06:30', 'end': '07:30'},
                              headers=self.auth)
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.get_json()['label'], 'Gym')
        self.assertEqual(res.get_json()['start'], '06:30')

    # ---- deletion ----
    def test_delete_whole_block(self):
        bid = self._create().get_json()['id']
        self.assertEqual(self.client.delete(f'/api/blocks/{bid}', headers=self.auth).status_code, 200)
        self.assertEqual(TimeBlock.query.count(), 0)

    def test_skip_one_occurrence_keeps_the_series(self):
        bid = self._create(date=None, recurrence='weekdays',
                           recur_from='2026-08-10').get_json()['id']
        res = self.client.delete(f'/api/blocks/{bid}?date=2026-08-12', headers=self.auth)
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.get_json()['exceptions'], ['2026-08-12'])
        self.assertEqual(TimeBlock.query.count(), 1)   # series survives

    def test_skip_on_a_one_off_deletes_it(self):
        bid = self._create().get_json()['id']
        self.client.delete(f'/api/blocks/{bid}?date=2026-08-10', headers=self.auth)
        self.assertEqual(TimeBlock.query.count(), 0)

    # ---- scoping ----
    def test_blocks_are_user_scoped(self):
        bid = self._create().get_json()['id']
        res = self.client.post('/api/auth/register', json={
            'name': 'X', 'email': 'other-block@example.com', 'password': 'password123',
        })
        other = {'Authorization': f"Bearer {res.get_json()['access_token']}"}
        self.assertEqual(self.client.get('/api/blocks', headers=other).get_json(), [])
        self.assertEqual(self.client.put(f'/api/blocks/{bid}', json={'label': 'hax'},
                                         headers=other).status_code, 404)
        self.assertEqual(self.client.delete(f'/api/blocks/{bid}', headers=other).status_code, 404)
        self.assertEqual(TimeBlock.query.count(), 1)


if __name__ == '__main__':
    unittest.main()
