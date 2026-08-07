"""
Tests for calendar OAuth start + the "API never answers HTML" guarantee.

Background: /api/calendar/auth/google raised ModuleNotFoundError in production
(the OAuth packages were missing from the deployed requirements). Flask served
its default HTML 500 page, and the frontend reported the misleading
"API request reached non-API endpoint" error. Anything under /api must now
serialise to JSON, and a provider that isn't installed/configured must say so.

    python -m pytest tests/test_calendar_endpoints.py
"""
import os
import tempfile
import unittest
from unittest import mock

_DB_FD, _DB_PATH = tempfile.mkstemp(suffix='.db')
os.close(_DB_FD)
os.environ.setdefault('DATABASE_URL', f'sqlite:///{_DB_PATH}')
os.environ.setdefault('JWT_SECRET_KEY', 'test-secret')

from flask_jwt_extended import create_access_token  # noqa: E402

from backend.app import app, db, limiter, User  # noqa: E402

limiter.enabled = False


class CalendarEndpointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with app.app_context():
            db.create_all()
            user = User.query.filter_by(email='cal@test.dev').first()
            if not user:
                user = User(
                    email='cal@test.dev', name='Cal', password_hash='x', tier='premium'
                )
                db.session.add(user)
                db.session.commit()
            cls.user_id = user.id
            cls.token = create_access_token(identity=str(user.id))

    def setUp(self):
        # Unhandled exceptions must reach the error handlers, as in production.
        app.config['PROPAGATE_EXCEPTIONS'] = False
        self.client = app.test_client()
        self.auth = {'Authorization': f'Bearer {self.token}'}

    def tearDown(self):
        app.config['PROPAGATE_EXCEPTIONS'] = None

    # --- API paths always answer JSON ---

    def test_unknown_api_path_is_json_404(self):
        res = self.client.get('/api/does-not-exist')
        self.assertEqual(res.status_code, 404)
        self.assertIn('application/json', res.headers['Content-Type'])
        self.assertIn('error', res.get_json())

    def test_wrong_method_on_api_path_is_json(self):
        res = self.client.delete('/api/health')
        self.assertEqual(res.status_code, 405)
        self.assertIn('application/json', res.headers['Content-Type'])
        self.assertIn('error', res.get_json())

    def test_get_on_post_only_api_path_is_json(self):
        # The SPA catch-all claims every GET; it must still answer JSON here.
        res = self.client.get('/api/calendar/auth/google')
        self.assertIn('application/json', res.headers['Content-Type'])
        self.assertIn(res.status_code, (404, 405))
        self.assertIn('error', res.get_json())

    def test_unhandled_exception_on_api_path_is_json_500(self):
        with mock.patch('backend.app._calendar_provider_ready',
                        side_effect=RuntimeError('boom')):
            res = self.client.post('/api/calendar/auth/google', headers=self.auth)
        self.assertEqual(res.status_code, 500)
        self.assertIn('application/json', res.headers['Content-Type'])
        self.assertEqual(res.get_json()['type'], 'RuntimeError')

    # --- Calendar OAuth start ---

    def test_missing_oauth_package_reports_which_package(self):
        with mock.patch('backend.app._calendar_provider_ready',
                        return_value=(False, [])):
            res = self.client.post('/api/calendar/auth/google', headers=self.auth)
        self.assertEqual(res.status_code, 503)
        body = res.get_json()
        self.assertTrue(body['not_configured'])
        self.assertIn('google-auth-oauthlib', body['error'])

    def test_missing_env_vars_are_named(self):
        with mock.patch('backend.app._calendar_provider_ready',
                        return_value=(True, ['GOOGLE_CLIENT_ID', 'FRONTEND_URL'])):
            res = self.client.post('/api/calendar/auth/google', headers=self.auth)
        self.assertEqual(res.status_code, 503)
        body = res.get_json()
        self.assertTrue(body['not_configured'])
        self.assertIn('GOOGLE_CLIENT_ID', body['error'])
        self.assertIn('FRONTEND_URL', body['error'])

    def test_unknown_provider_rejected(self):
        res = self.client.post('/api/calendar/auth/dropbox', headers=self.auth)
        self.assertEqual(res.status_code, 400)

    def test_configured_google_returns_consent_url(self):
        env = {
            'GOOGLE_CLIENT_ID': 'client-id.apps.googleusercontent.com',
            'GOOGLE_CLIENT_SECRET': 'client-secret',
            'FRONTEND_URL': 'https://app.example.com',
        }
        with mock.patch.dict(os.environ, env, clear=False):
            res = self.client.post('/api/calendar/auth/google', headers=self.auth)
        if res.status_code == 503 and 'not installed' in res.get_json()['error']:
            self.skipTest('google-auth-oauthlib not installed in this environment')
        self.assertEqual(res.status_code, 200)
        url = res.get_json()['url']
        self.assertIn('accounts.google.com', url)
        self.assertIn('calendar.events', url)
        self.assertIn(
            'https%3A%2F%2Fapp.example.com%2Fapi%2Fcalendar%2Fcallback%2Fgoogle', url
        )

    def test_health_reports_calendar_readiness(self):
        res = self.client.get('/api/health')
        self.assertEqual(res.status_code, 200)
        calendar = res.get_json()['calendar']
        self.assertIn('deps_installed', calendar['google'])
        self.assertIn('missing_env', calendar['google'])


if __name__ == '__main__':
    unittest.main()
