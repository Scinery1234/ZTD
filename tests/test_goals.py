"""
Tests for the goal-setting framework (goals.py + /api/goals + guide tools).

Design under test: goals are first-class objects, max 3 active per hat,
each with a 'why' and a user-chosen check-in cadence; the AI guide can set,
update and check in on goals, and its prompt flags overdue check-ins.

    python -m pytest tests/test_goals.py       # or
    python -m unittest tests.test_goals
"""
import os
import tempfile
import unittest
from datetime import datetime, timedelta
from types import SimpleNamespace

_DB_FD, _DB_PATH = tempfile.mkstemp(suffix='.db')
os.close(_DB_FD)
os.environ.setdefault('DATABASE_URL', f'sqlite:///{_DB_PATH}')
os.environ.setdefault('JWT_SECRET_KEY', 'test-secret')

from backend.app import (  # noqa: E402
    app, db, limiter, User, Hat, Task, Goal, GoalMilestone, ChatUndo,
    check_task_limit,
)

limiter.enabled = False
from backend.coaching import CoachingService  # noqa: E402
from backend.goals import (  # noqa: E402
    MAX_ACTIVE_GOALS_PER_HAT, MAX_MILESTONES_PER_GOAL,
)


# ---- scripted fake Anthropic client (same shape as test_coaching) ----
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


class GoalsBase(unittest.TestCase):
    def setUp(self):
        self.ctx = app.app_context()
        self.ctx.push()
        db.drop_all()
        db.create_all()
        self.client = app.test_client()
        res = self.client.post('/api/auth/register', json={
            'name': 'G', 'email': 'goal@example.com', 'password': 'password123',
        })
        self.auth = {'Authorization': f"Bearer {res.get_json()['access_token']}"}
        self.user = User.query.filter_by(email='goal@example.com').one()
        self.hat = Hat.query.filter_by(user_id=self.user.id).first()
        if self.hat is None:
            self.hat = Hat(user_id=self.user.id, name='Main Hat')
            db.session.add(self.hat)
            db.session.commit()

    def tearDown(self):
        db.session.remove()
        db.drop_all()
        self.ctx.pop()


class GoalRouteTests(GoalsBase):
    def _create(self, **kw):
        body = {'title': 'Run a 10k', 'why': 'Health', 'hat_id': self.hat.id,
                'checkin_every_days': 7, **kw}
        return self.client.post('/api/goals', json=body, headers=self.auth)

    def test_requires_auth(self):
        self.assertEqual(self.client.get('/api/goals').status_code, 401)

    def test_create_and_list(self):
        res = self._create(target_date='2026-09-01')
        self.assertEqual(res.status_code, 201)
        g = res.get_json()
        self.assertEqual(g['title'], 'Run a 10k')
        self.assertEqual(g['why'], 'Health')
        self.assertEqual(g['checkin_every_days'], 7)
        self.assertEqual(g['target_date'], '2026-09-01')
        self.assertFalse(g['checkin_due'])   # brand new goal isn't due

        listed = self.client.get('/api/goals', headers=self.auth).get_json()
        self.assertEqual(len(listed), 1)

    def test_limit_three_active_per_hat(self):
        for i in range(MAX_ACTIVE_GOALS_PER_HAT):
            self.assertEqual(self._create(title=f'Goal {i}').status_code, 201)
        res = self._create(title='One too many')
        self.assertEqual(res.status_code, 400)
        self.assertTrue(res.get_json()['limit_reached'])

        # A different hat has its own allowance
        other = Hat(user_id=self.user.id, name='Work')
        db.session.add(other)
        db.session.commit()
        self.assertEqual(self._create(title='Work goal', hat_id=other.id).status_code, 201)

        # Achieving one frees a slot
        gid = self.client.get('/api/goals', headers=self.auth).get_json()[0]['id']
        self.client.put(f'/api/goals/{gid}', json={'status': 'achieved'}, headers=self.auth)
        self.assertEqual(self._create(title='Replacement').status_code, 201)

    def test_checkin_resets_clock_and_stores_note(self):
        gid = self._create().get_json()['id']
        goal = db.session.get(Goal, gid)
        goal.last_checkin_at = datetime.utcnow() - timedelta(days=10)
        db.session.commit()
        self.assertTrue(db.session.get(Goal, gid).to_dict()['checkin_due'])

        res = self.client.post(f'/api/goals/{gid}/checkin',
                               json={'note': 'Two runs this week.'}, headers=self.auth)
        body = res.get_json()
        self.assertFalse(body['checkin_due'])
        self.assertEqual(body['last_checkin_note'], 'Two runs this week.')

    def test_update_and_delete(self):
        gid = self._create().get_json()['id']
        res = self.client.put(f'/api/goals/{gid}',
                              json={'title': 'Run a half marathon',
                                    'checkin_every_days': 14},
                              headers=self.auth)
        self.assertEqual(res.get_json()['title'], 'Run a half marathon')
        self.assertEqual(res.get_json()['checkin_every_days'], 14)

        self.assertEqual(
            self.client.delete(f'/api/goals/{gid}', headers=self.auth).status_code, 200)
        self.assertEqual(self.client.get('/api/goals', headers=self.auth).get_json(), [])

    def test_user_scoped(self):
        gid = self._create().get_json()['id']
        res2 = self.client.post('/api/auth/register', json={
            'name': 'X', 'email': 'other-goal@example.com', 'password': 'password123',
        })
        auth2 = {'Authorization': f"Bearer {res2.get_json()['access_token']}"}
        self.assertEqual(self.client.get('/api/goals', headers=auth2).get_json(), [])
        self.assertEqual(
            self.client.delete(f'/api/goals/{gid}', headers=auth2).status_code, 404)
        self.assertIsNotNone(db.session.get(Goal, gid))


class MilestoneTests(GoalsBase):
    """Goal → milestones → tasks: progress and the task→milestone link."""

    def _goal(self, milestones=('Step one', 'Step two')):
        res = self.client.post('/api/goals', json={
            'title': 'Ship the beta', 'hat_id': self.hat.id,
            'milestones': list(milestones),
        }, headers=self.auth)
        return res.get_json()

    def test_create_with_milestones_and_progress(self):
        g = self._goal()
        self.assertEqual([m['title'] for m in g['milestones']],
                         ['Step one', 'Step two'])
        self.assertEqual(g['progress'], {'done': 0, 'total': 2, 'pct': 0})

        # Toggle one done via the route → progress moves
        mid = g['milestones'][0]['id']
        res = self.client.put(f"/api/goals/{g['id']}/milestones/{mid}",
                              json={'done': True}, headers=self.auth)
        self.assertEqual(res.get_json()['progress'], {'done': 1, 'total': 2, 'pct': 50})

    def test_add_and_remove_milestones(self):
        g = self._goal(milestones=[])
        self.assertIsNone(g['progress']['pct'])   # no milestones → no bar
        res = self.client.post(f"/api/goals/{g['id']}/milestones",
                               json={'title': 'First step'}, headers=self.auth)
        self.assertEqual(res.status_code, 201)
        mid = res.get_json()['milestones'][0]['id']
        res2 = self.client.delete(f"/api/goals/{g['id']}/milestones/{mid}",
                                  headers=self.auth)
        self.assertEqual(res2.get_json()['milestones'], [])

    def test_milestone_cap(self):
        g = self._goal(milestones=[f'm{i}' for i in range(MAX_MILESTONES_PER_GOAL + 3)])
        self.assertEqual(len(g['milestones']), MAX_MILESTONES_PER_GOAL)
        res = self.client.post(f"/api/goals/{g['id']}/milestones",
                               json={'title': 'one more'}, headers=self.auth)
        self.assertEqual(res.status_code, 400)
        self.assertTrue(res.get_json()['limit_reached'])

    def test_completing_last_linked_task_ticks_milestone(self):
        g = self._goal()
        mid = g['milestones'][0]['id']
        # Two tasks linked to the same milestone via the tasks API
        t1 = self.client.post('/api/tasks', json={
            'description': 'Write the docs', 'milestone_id': mid,
        }, headers=self.auth).get_json()
        t2 = self.client.post('/api/tasks', json={
            'description': 'Record the demo', 'milestone_id': mid,
        }, headers=self.auth).get_json()
        self.assertEqual(t1['milestone_id'], mid)

        self.client.post(f"/api/tasks/{t1['id']}/done", headers=self.auth)
        self.assertFalse(db.session.get(GoalMilestone, mid).done)  # one task left

        self.client.post(f"/api/tasks/{t2['id']}/done", headers=self.auth)
        m = db.session.get(GoalMilestone, mid)
        self.assertTrue(m.done)                                    # last one ticks it
        goal = db.session.get(Goal, g['id']).to_dict()
        self.assertEqual(goal['progress']['done'], 1)

    def test_milestone_link_is_user_scoped(self):
        g = self._goal()
        mid = g['milestones'][0]['id']
        res2 = self.client.post('/api/auth/register', json={
            'name': 'X', 'email': 'ms-other@example.com', 'password': 'password123',
        })
        auth2 = {'Authorization': f"Bearer {res2.get_json()['access_token']}"}
        # Another user can't link a task to my milestone…
        t = self.client.post('/api/tasks', json={
            'description': 'Sneaky', 'milestone_id': mid,
        }, headers=auth2).get_json()
        self.assertIsNone(t['milestone_id'])
        # …or toggle it
        res = self.client.put(f"/api/goals/{g['id']}/milestones/{mid}",
                              json={'done': True}, headers=auth2)
        self.assertEqual(res.status_code, 404)


class GuideGoalToolTests(GoalsBase):
    def svc(self, script):
        s = CoachingService(db, Task, Hat, check_task_limit,
                            ChatUndo=ChatUndo, Goal=Goal,
                            GoalMilestone=GoalMilestone)
        s.client = FakeClient(script)
        return s

    def test_guide_gets_goal_tools_other_coaches_do_not(self):
        s = self.svc([final_response('Hi.')])
        s.run(self.user, 'guide', 'hello', [])
        names = {t['name'] for t in s.client.messages.calls[0]['tools']}
        self.assertTrue({'set_goal', 'update_goal', 'checkin_goal'} <= names)

        s2 = self.svc([final_response('Hi.')])
        s2.run(self.user, 'cbt', 'hello', [])
        names2 = {t['name'] for t in s2.client.messages.calls[0]['tools']}
        self.assertFalse(names2 & {'set_goal', 'update_goal', 'checkin_goal'})

    def test_guide_prompt_shows_goals_and_due_flag(self):
        g = Goal(user_id=self.user.id, hat_id=self.hat.id, title='Ship the app',
                 why='Financial freedom', checkin_every_days=7,
                 last_checkin_at=datetime.utcnow() - timedelta(days=9))
        db.session.add(g)
        db.session.commit()

        s = self.svc([final_response('Hi.')])
        s.run(self.user, 'guide', 'hello', [])
        system = s.client.messages.calls[0]['system']
        self.assertIn('Ship the app', system)
        self.assertIn('Financial freedom', system)
        self.assertIn('CHECK-IN DUE', system)
        self.assertIn('GOALS', system)

        # Onboarding nudge when there are no goals
        db.session.delete(g)
        db.session.commit()
        s2 = self.svc([final_response('Hi.')])
        s2.run(self.user, 'guide', 'hello', [])
        self.assertIn('no goals yet', s2.client.messages.calls[0]['system'])

    def test_guide_sets_a_goal_with_milestones(self):
        s = self.svc([
            tool_response(tool_block('set_goal', {
                'title': 'Meditate daily', 'why': 'Calm mind',
                'hat_id': self.hat.id, 'checkin_every_days': 1,
                'milestones': ['One week streak', 'One month streak'],
            })),
            final_response("It's saved — I'll check in each day."),
        ])
        out = s.run(self.user, 'guide', 'yes, set it', [])
        goal = Goal.query.filter_by(user_id=self.user.id).one()
        self.assertEqual(goal.title, 'Meditate daily')
        self.assertEqual(goal.checkin_every_days, 1)
        self.assertEqual([m.title for m in goal.milestones],
                         ['One week streak', 'One month streak'])
        self.assertEqual(out['goal_actions'],
                         [{'action': 'goal_set', 'title': 'Meditate daily'}])

    def test_guide_updates_milestones_and_prompt_shows_them(self):
        g = Goal(user_id=self.user.id, hat_id=self.hat.id, title='Ship it')
        db.session.add(g)
        db.session.flush()
        m = GoalMilestone(goal_id=g.id, user_id=self.user.id, title='Build MVP')
        db.session.add(m)
        db.session.commit()

        s = self.svc([
            tool_response(tool_block('update_milestones', {
                'goal_id': g.id,
                'complete_ids': [m.id],
                'add': ['Get 10 users'],
            })),
            final_response('MVP done — next: ten users.'),
        ])
        s.run(self.user, 'guide', 'the MVP is done!', [])
        db.session.refresh(m)
        self.assertTrue(m.done)
        titles = [x.title for x in db.session.get(Goal, g.id).milestones]
        self.assertIn('Get 10 users', titles)

        # Milestones (with ids and ✓/○) appear in the guide prompt
        s2 = self.svc([final_response('Hi.')])
        s2.run(self.user, 'guide', 'hello', [])
        system = s2.client.messages.calls[0]['system']
        self.assertIn(f'[milestone #{m.id}]', system)
        self.assertIn('Build MVP', system)
        self.assertIn('progress: 1/2 milestones', system)

    def test_guide_saves_task_linked_to_milestone(self):
        g = Goal(user_id=self.user.id, hat_id=self.hat.id, title='Ship it')
        db.session.add(g)
        db.session.flush()
        m = GoalMilestone(goal_id=g.id, user_id=self.user.id, title='Build MVP')
        db.session.add(m)
        db.session.commit()

        s = self.svc([
            tool_response(tool_block('save_tasks', {
                'tasks': [{'description': 'Sketch the landing page',
                           'milestone_id': m.id}],
            })),
            final_response("Added — it counts toward 'Build MVP'."),
        ])
        s.run(self.user, 'guide', 'yes add that task', [])
        task = Task.query.filter_by(user_id=self.user.id).one()
        self.assertEqual(task.milestone_id, m.id)

    def test_guide_respects_goal_limit(self):
        for i in range(MAX_ACTIVE_GOALS_PER_HAT):
            db.session.add(Goal(user_id=self.user.id, hat_id=self.hat.id,
                                title=f'g{i}'))
        db.session.commit()
        s = self.svc([
            tool_response(tool_block('set_goal', {'title': 'Fourth goal',
                                                  'hat_id': self.hat.id})),
            final_response('That hat is full — shall we retire one first?'),
        ])
        out = s.run(self.user, 'guide', 'add another goal', [])
        self.assertEqual(Goal.query.filter_by(user_id=self.user.id).count(),
                         MAX_ACTIVE_GOALS_PER_HAT)
        self.assertEqual(out['goal_actions'], [])
        # The model was told about the limit so it can discuss replacements
        tool_result = s.client.messages.calls[1]['messages'][-1]['content'][0]
        self.assertIn('limit_reached', tool_result['content'])

    def test_guide_checkin_and_achieve(self):
        g = Goal(user_id=self.user.id, hat_id=self.hat.id, title='Ship it',
                 last_checkin_at=datetime.utcnow() - timedelta(days=8))
        db.session.add(g)
        db.session.commit()

        s = self.svc([
            tool_response(tool_block('checkin_goal', {
                'id': g.id, 'note': 'Beta out to five users.',
            })),
            final_response('Love that progress.'),
        ])
        out = s.run(self.user, 'guide', 'going well actually', [])
        db.session.refresh(g)
        self.assertEqual(g.last_checkin_note, 'Beta out to five users.')
        self.assertFalse(g.to_dict()['checkin_due'])
        self.assertEqual(out['goal_actions'][0]['action'], 'goal_checkin')

        s2 = self.svc([
            tool_response(tool_block('update_goal', {'id': g.id, 'status': 'achieved'})),
            final_response('Huge — congratulations!'),
        ])
        out2 = s2.run(self.user, 'guide', 'we shipped!', [])
        db.session.refresh(g)
        self.assertEqual(g.status, 'achieved')
        self.assertIsNotNone(g.achieved_at)
        self.assertEqual(out2['goal_actions'][0]['action'], 'goal_achieved')

    def test_goal_tools_are_user_scoped(self):
        other = User(email='o-goal@example.com', name='O', password_hash='x', tier='pro')
        db.session.add(other)
        db.session.commit()
        theirs = Goal(user_id=other.id, title='Their goal')
        db.session.add(theirs)
        db.session.commit()

        s = self.svc([
            tool_response(tool_block('update_goal', {'id': theirs.id,
                                                     'status': 'archived'})),
            final_response('Done.'),
        ])
        s.run(self.user, 'guide', 'archive it', [])
        db.session.refresh(theirs)
        self.assertEqual(theirs.status, 'active')   # untouched


if __name__ == '__main__':
    unittest.main()
