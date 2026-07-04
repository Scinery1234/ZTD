"""
Tests for natural-language scheduling in the AI hub tools: clean task names +
real calendar slots (scheduled_time / scheduled_date), and clash detection
that makes the model ask the user instead of double-booking.

    python -m pytest tests/test_scheduling.py       # or
    python -m unittest tests.test_scheduling
"""
import os
import tempfile
import unittest
from datetime import datetime, timedelta

_DB_FD, _DB_PATH = tempfile.mkstemp(suffix='.db')
os.close(_DB_FD)
os.environ.setdefault('DATABASE_URL', f'sqlite:///{_DB_PATH}')
os.environ.setdefault('JWT_SECRET_KEY', 'test-secret')

from backend.app import (  # noqa: E402
    app, db, User, Hat, Task, ChatUndo, CoachMemory, check_task_limit,
)
from backend.coaching import CoachingService  # noqa: E402
from backend.ai_chat import TaskChatService  # noqa: E402
from backend import scheduling  # noqa: E402


class SchedulingHelperTests(unittest.TestCase):
    def test_parse_hhmm(self):
        self.assertEqual(scheduling.parse_hhmm('06:00'), '06:00')
        self.assertEqual(scheduling.parse_hhmm('6:05'), '06:05')
        self.assertEqual(scheduling.parse_hhmm('6am'), '06:00')
        self.assertEqual(scheduling.parse_hhmm('6.30 pm'), '18:30')
        self.assertIsNone(scheduling.parse_hhmm(''))
        self.assertIsNone(scheduling.parse_hhmm('25:99'))

    def test_resolve_date_defaults(self):
        now = datetime(2026, 7, 4, 12, 0)
        # Time still ahead today → today
        self.assertEqual(scheduling.resolve_date('', '18:00', now), '2026-07-04')
        # Time already passed → tomorrow
        self.assertEqual(scheduling.resolve_date('', '06:00', now), '2026-07-05')
        # Explicit ISO date wins
        self.assertEqual(scheduling.resolve_date('2026-08-01', '06:00', now), '2026-08-01')
        # Natural language
        self.assertEqual(scheduling.resolve_date('tomorrow', '06:00', now), '2026-07-05')

    def test_parse_duration(self):
        self.assertEqual(scheduling.parse_duration(45), 45)
        self.assertEqual(scheduling.parse_duration('45'), 45)
        self.assertEqual(scheduling.parse_duration('60 min'), 60)
        self.assertIsNone(scheduling.parse_duration(''))
        self.assertIsNone(scheduling.parse_duration(0))


class SchedulingServiceBase(unittest.TestCase):
    def setUp(self):
        self.ctx = app.app_context()
        self.ctx.push()
        db.drop_all()
        db.create_all()
        self.user = User(email='s@example.com', name='S',
                         password_hash='x', tier='pro')
        db.session.add(self.user)
        db.session.commit()
        self.hat = Hat(user_id=self.user.id, name='Main Hat')
        db.session.add(self.hat)
        db.session.commit()
        self.coach = CoachingService(db, Task, Hat, check_task_limit,
                                     CoachMemory=CoachMemory)
        self.chat = TaskChatService(db, Task, Hat, ChatUndo, check_task_limit,
                                    CoachMemory=CoachMemory)
        self.date = (datetime.now() + timedelta(days=1)).strftime('%Y-%m-%d')

    def tearDown(self):
        db.session.remove()
        db.drop_all()
        self.ctx.pop()

    def _existing(self, time='06:00', duration=30):
        t = Task(user_id=self.user.id, description='Existing block',
                 scheduled_time=time, scheduled_date=self.date,
                 duration=duration, position=1)
        db.session.add(t)
        db.session.commit()
        return t


class CoachSchedulingTests(SchedulingServiceBase):
    def test_save_schedules_clean_task(self):
        added = []
        res = self.coach._save_tasks(self.user, self.hat.id, {'tasks': [{
            'description': 'Morning routine: exercise',
            'scheduled_time': '06:00', 'scheduled_date': self.date, 'duration': 45,
        }]}, added)
        self.assertEqual(res['content']['saved_count'], 1)
        t = Task.query.filter_by(user_id=self.user.id).one()
        self.assertEqual(t.description, 'Morning routine: exercise')
        self.assertEqual(t.scheduled_time, '06:00')
        self.assertEqual(t.scheduled_date, self.date)
        self.assertEqual(t.duration, 45)
        # The UI receipt gets the slot too
        self.assertEqual(added[0]['scheduled_time'], '06:00')

    def test_save_reports_clash_and_does_not_save(self):
        self._existing('06:00', 30)
        added = []
        res = self.coach._save_tasks(self.user, self.hat.id, {'tasks': [{
            'description': 'Morning run',
            'scheduled_time': '06:15', 'scheduled_date': self.date,
        }]}, added)
        content = res['content']
        self.assertEqual(content['saved_count'], 0)
        self.assertEqual(len(content['clashes']), 1)
        clash = content['clashes'][0]
        self.assertEqual(clash['conflicts_with'], 'Existing block')
        self.assertEqual(clash['conflict_time'], '06:00–06:30')
        self.assertIn('Ask the user', content['note'])
        self.assertEqual(added, [])
        self.assertEqual(Task.query.filter_by(user_id=self.user.id).count(), 1)

    def test_allow_clash_saves_anyway(self):
        self._existing('06:00', 30)
        added = []
        res = self.coach._save_tasks(self.user, self.hat.id, {'tasks': [{
            'description': 'Morning run',
            'scheduled_time': '06:15', 'scheduled_date': self.date,
            'allow_clash': True,
        }]}, added)
        self.assertEqual(res['content']['saved_count'], 1)
        self.assertEqual(Task.query.filter_by(user_id=self.user.id).count(), 2)

    def test_adjacent_slots_do_not_clash(self):
        self._existing('06:00', 30)
        added = []
        res = self.coach._save_tasks(self.user, self.hat.id, {'tasks': [{
            'description': 'Journal', 'scheduled_time': '06:30',
            'scheduled_date': self.date,
        }]}, added)
        self.assertEqual(res['content']['saved_count'], 1)
        self.assertNotIn('clashes', res['content'])

    def test_unscheduled_saves_unaffected(self):
        self._existing('06:00', 30)
        added = []
        res = self.coach._save_tasks(self.user, self.hat.id, {'tasks': [{
            'description': 'Think about holidays',
        }]}, added)
        self.assertEqual(res['content']['saved_count'], 1)
        t = Task.query.filter_by(description='Think about holidays').one()
        self.assertIsNone(t.scheduled_time)

    def test_prompt_carries_scheduling_guidance(self):
        from backend.coaching import COACHES
        prompt = self.coach._system_prompt(self.user, COACHES['clarity'])
        self.assertIn('SCHEDULING', prompt)
        self.assertIn('allow_clash', prompt)


class AssistantSchedulingTests(SchedulingServiceBase):
    def test_add_tasks_schedules(self):
        ops, actions = [], []
        res = self.chat._add_tasks(self.user, self.hat.id, {'tasks': [{
            'description': 'Exercise', 'category': '', 'priority': '',
            'recurring': '', 'due': '', 'scheduled_time': '06:00',
            'scheduled_date': self.date, 'duration': 45,
        }]}, ops, actions)
        self.assertEqual(res['content']['added_count'], 1)
        t = Task.query.filter_by(user_id=self.user.id).one()
        self.assertEqual((t.scheduled_time, t.scheduled_date, t.duration),
                         ('06:00', self.date, 45))

    def test_add_tasks_clash_blocks(self):
        self._existing('06:00', 30)
        ops, actions = [], []
        res = self.chat._add_tasks(self.user, self.hat.id, {'tasks': [{
            'description': 'Run', 'category': '', 'priority': '',
            'recurring': '', 'due': '', 'scheduled_time': '06:00',
            'scheduled_date': self.date,
        }]}, ops, actions)
        self.assertEqual(res['content']['added_count'], 0)
        self.assertEqual(res['content']['clashes'][0]['conflicts_with'], 'Existing block')

    def test_update_reschedules_and_respects_clash(self):
        blocker = self._existing('09:00', 60)
        t = Task(user_id=self.user.id, description='Floaty task', position=2)
        db.session.add(t)
        db.session.commit()

        # Clash: 09:30 falls inside the 09:00–10:00 block → not applied
        ops, actions = [], []
        res = self.chat._update_tasks(self.user.id, {'updates': [{
            'id': t.id, 'scheduled_time': '09:30', 'scheduled_date': self.date,
        }]}, ops, actions)
        self.assertEqual(res['content']['updated_count'], 0)
        self.assertEqual(len(res['content']['clashes']), 1)
        self.assertIsNone(Task.query.get(t.id).scheduled_time)

        # Free slot applies, and moving the blocker itself is not a self-clash
        # (08:00–09:00 doesn't touch the other task's new 10:00–10:30 slot)
        res2 = self.chat._update_tasks(self.user.id, {'updates': [
            {'id': t.id, 'scheduled_time': '10:00', 'scheduled_date': self.date},
            {'id': blocker.id, 'scheduled_time': '08:00', 'scheduled_date': self.date},
        ]}, ops, actions)
        self.assertEqual(res2['content']['updated_count'], 2)
        self.assertEqual(Task.query.get(t.id).scheduled_time, '10:00')
        self.assertEqual(Task.query.get(blocker.id).scheduled_time, '08:00')

    def test_undo_restores_previous_schedule(self):
        t = Task(user_id=self.user.id, description='Gym',
                 scheduled_time='07:00', scheduled_date=self.date,
                 duration=30, position=1)
        db.session.add(t)
        db.session.commit()
        ops, actions = [], []
        self.chat._update_tasks(self.user.id, {'updates': [{
            'id': t.id, 'scheduled_time': '10:00', 'scheduled_date': self.date,
        }]}, ops, actions)
        self.assertEqual(Task.query.get(t.id).scheduled_time, '10:00')

        token = self.chat._save_undo(self.user.id, ops, actions)
        self.chat.undo(self.user, token)
        self.assertEqual(Task.query.get(t.id).scheduled_time, '07:00')

    def test_undo_of_delete_restores_schedule(self):
        t = Task(user_id=self.user.id, description='Gym',
                 scheduled_time='07:00', scheduled_date=self.date,
                 duration=30, position=1)
        db.session.add(t)
        db.session.commit()
        ops, actions = [], []
        self.chat._delete_tasks(self.user.id, {'ids': [t.id]}, ops, actions)
        token = self.chat._save_undo(self.user.id, ops, actions)
        self.chat.undo(self.user, token)
        restored = Task.query.filter_by(description='Gym').one()
        self.assertEqual(restored.scheduled_time, '07:00')
        self.assertEqual(restored.scheduled_date, self.date)


class CalendarVisibilityTests(SchedulingServiceBase):
    """The chatbot must see planned (calendar-scheduled) tasks."""

    def _gym(self):
        t = Task(user_id=self.user.id, description='Gym session',
                 scheduled_time='07:00', scheduled_date=self.date,
                 duration=45, position=1)
        db.session.add(t)
        db.session.commit()
        return t

    def test_assistant_snapshot_shows_calendar_slot(self):
        self._gym()
        snap = self.chat._task_snapshot(self.user.id)
        self.assertIn('Gym session', snap)
        self.assertIn('⏰ 07:00', snap)
        self.assertIn(f'on {self.date}', snap)
        self.assertIn('(45min)', snap)

    def test_assistant_list_tasks_returns_calendar_fields(self):
        t = self._gym()
        res = self.chat._list_tasks(self.user.id,
                                    {'query': '', 'category': '', 'priority': ''})
        row = next(r for r in res['content']['tasks'] if r['id'] == t.id)
        self.assertEqual(row['scheduled_time'], '07:00')
        self.assertEqual(row['scheduled_date'], self.date)
        self.assertEqual(row['duration'], 45)

    def test_coach_prompt_shows_calendar_slot_and_today(self):
        from backend.coaching import COACHES
        from datetime import datetime as _dt
        self._gym()
        prompt = self.coach._system_prompt(self.user, COACHES['exec'])
        self.assertIn('Gym session', prompt)
        self.assertIn('scheduled: 07:00', prompt)
        self.assertIn(f'on {self.date}', prompt)
        self.assertIn(f"Today is {_dt.today().strftime('%Y-%m-%d')}", prompt)


if __name__ == '__main__':
    unittest.main()
