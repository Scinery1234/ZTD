"""
Calendar connect when the provider credentials aren't configured.

With MICROSOFT_CLIENT_ID unset the login link is built with no client_id and the
user lands on Microsoft's own error page (AADSTS900144: "The request body must
contain the following parameter: 'client_id'"), which says nothing about what to
fix. The server should say it itself, naming the setting.

    python -m pytest tests/test_calendar_config.py
"""
import os
import tempfile
import unittest

_DB_FD, _DB_PATH = tempfile.mkstemp(suffix='.db')
os.close(_DB_FD)
os.environ['DATABASE_URL'] = f'sqlite:///{_DB_PATH}'
os.environ.setdefault('JWT_SECRET_KEY', 'test-secret')

from backend.app import app, db, limiter, User  # noqa: E402

limiter.enabled = False

VARS = ('MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET',
        'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET')


class CalendarConfigTests(unittest.TestCase):
    def setUp(self):
        self.saved = {k: os.environ.get(k) for k in VARS}
        self.ctx = app.app_context()
        self.ctx.push()
        db.drop_all()
        db.create_all()
        self.client = app.test_client()
        res = self.client.post('/api/auth/register', json={
            'name': 'P', 'email': 'cal@example.com', 'password': 'password123'})
        self.auth = {'Authorization': f"Bearer {res.get_json()['access_token']}"}
        User.query.filter_by(email='cal@example.com').one().tier = 'premium'
        db.session.commit()

    def tearDown(self):
        for k, v in self.saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        db.session.remove()
        db.drop_all()
        self.ctx.pop()

    def _start(self, provider):
        return self.client.post(f'/api/calendar/auth/{provider}', headers=self.auth)

    def _set(self, **kw):
        for k in VARS:
            os.environ.pop(k, None)
        for k, v in kw.items():
            os.environ[k] = v

    def test_missing_microsoft_client_id_says_which_setting(self):
        self._set(MICROSOFT_CLIENT_SECRET='s')
        res = self._start('microsoft')
        self.assertEqual(res.status_code, 503)
        body = res.get_json()
        self.assertIn('MICROSOFT_CLIENT_ID', body['error'])
        self.assertNotIn('MICROSOFT_CLIENT_SECRET', body['error'])
        self.assertTrue(body['not_configured'])

    def test_missing_both_names_both(self):
        self._set()
        err = self._start('microsoft').get_json()['error']
        self.assertIn('MICROSOFT_CLIENT_ID', err)
        self.assertIn('MICROSOFT_CLIENT_SECRET', err)

    def test_blank_or_whitespace_counts_as_missing(self):
        """An empty variable and a pasted space are the same mistake."""
        self._set(MICROSOFT_CLIENT_ID='   ', MICROSOFT_CLIENT_SECRET='')
        self.assertEqual(self._start('microsoft').status_code, 503)

    def test_google_is_checked_the_same_way(self):
        self._set(GOOGLE_CLIENT_SECRET='s')
        res = self._start('google')
        self.assertEqual(res.status_code, 503)
        self.assertIn('GOOGLE_CLIENT_ID', res.get_json()['error'])

    def test_configured_microsoft_still_returns_a_login_url(self):
        self._set(MICROSOFT_CLIENT_ID='11111111-2222-3333-4444-555555555555',
                  MICROSOFT_CLIENT_SECRET='s')
        res = self._start('microsoft')
        self.assertEqual(res.status_code, 200)
        url = res.get_json()['url']
        self.assertIn('login.microsoftonline.com', url)
        self.assertIn('client_id=11111111-2222-3333-4444-555555555555', url)

    def test_one_provider_missing_does_not_block_the_other(self):
        self._set(MICROSOFT_CLIENT_ID='11111111-2222-3333-4444-555555555555',
                  MICROSOFT_CLIENT_SECRET='s')
        self.assertEqual(self._start('google').status_code, 503)
        self.assertEqual(self._start('microsoft').status_code, 200)

    def test_still_requires_premium_before_revealing_config(self):
        User.query.filter_by(email='cal@example.com').one().tier = 'free'
        db.session.commit()
        self._set()
        self.assertEqual(self._start('microsoft').status_code, 403)


if __name__ == '__main__':
    unittest.main()
