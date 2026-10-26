"""
Anthropic API key handling.

The SDK sends the environment value verbatim as the x-api-key header. A
trailing newline, a stray space, or the quotes copied along with the key all
reach the API as part of the key and come back as

    401 authentication_error: invalid x-api-key

which reads like a bad key rather than a bad paste — and survives being
"changed", because the next paste through the same dashboard field carries the
same whitespace. These tests pin the cleaning, and pin that the diagnostics
/api/health reports never leak key material.

Run from the repo root:

    python -m pytest tests/test_api_key.py
"""
import os
import tempfile
import unittest

_DB_FD, _DB_PATH = tempfile.mkstemp(suffix='.db')
os.close(_DB_FD)
os.environ['DATABASE_URL'] = f'sqlite:///{_DB_PATH}'
os.environ.setdefault('JWT_SECRET_KEY', 'test-secret')

from backend.app import app, db, limiter  # noqa: E402
from backend import ai_chat  # noqa: E402
from backend import coaching  # noqa: E402

limiter.enabled = False

REAL = 'sk-ant-api03-' + 'x' * 80


class KeyCleaningTests(unittest.TestCase):
    def setUp(self):
        self._saved = os.environ.get('ANTHROPIC_API_KEY')

    def tearDown(self):
        if self._saved is None:
            os.environ.pop('ANTHROPIC_API_KEY', None)
        else:
            os.environ['ANTHROPIC_API_KEY'] = self._saved

    def _set(self, value):
        if value is None:
            os.environ.pop('ANTHROPIC_API_KEY', None)
        else:
            os.environ['ANTHROPIC_API_KEY'] = value

    def test_clean_key_passes_through(self):
        self._set(REAL)
        self.assertEqual(ai_chat.api_key(), REAL)

    def test_trailing_newline_is_stripped(self):
        self._set(REAL + '\n')
        self.assertEqual(ai_chat.api_key(), REAL)

    def test_surrounding_whitespace_is_stripped(self):
        self._set(f'  {REAL}\t\n ')
        self.assertEqual(ai_chat.api_key(), REAL)

    def test_double_quotes_are_stripped(self):
        self._set(f'"{REAL}"')
        self.assertEqual(ai_chat.api_key(), REAL)

    def test_single_quotes_are_stripped(self):
        self._set(f"'{REAL}'")
        self.assertEqual(ai_chat.api_key(), REAL)

    def test_quotes_with_whitespace_outside_and_in(self):
        self._set(f'  " {REAL} "  ')
        self.assertEqual(ai_chat.api_key(), REAL)

    def test_unmatched_quote_is_left_alone(self):
        """A quote on one side only isn't a wrapper — removing it would corrupt
        a key that legitimately contained one."""
        self._set(f'"{REAL}')
        self.assertEqual(ai_chat.api_key(), f'"{REAL}')

    def test_missing_variable_is_none(self):
        self._set(None)
        self.assertIsNone(ai_chat.api_key())

    def test_empty_and_whitespace_only_are_none(self):
        for value in ('', '   ', '\n', '""'):
            self._set(value)
            self.assertIsNone(ai_chat.api_key(), repr(value))

    def test_availability_follows_the_cleaned_key(self):
        """A whitespace-only key must read as 'not configured' rather than
        being sent and rejected."""
        self._set('   ')
        self.assertFalse(ai_chat.chat_available())
        self.assertFalse(coaching.coaching_available())

    def test_coaching_and_chat_agree(self):
        """Both features share one key; they must never disagree about it."""
        for value in (REAL, f'"{REAL}"', REAL + '\n', '  ', None):
            self._set(value)
            self.assertEqual(ai_chat.chat_available(), coaching.coaching_available(),
                             f'disagreed on {value!r}')


class DiagnosticsTests(unittest.TestCase):
    def setUp(self):
        self._saved = os.environ.get('ANTHROPIC_API_KEY')
        self.ctx = app.app_context()
        self.ctx.push()
        db.create_all()
        self.client = app.test_client()

    def tearDown(self):
        if self._saved is None:
            os.environ.pop('ANTHROPIC_API_KEY', None)
        else:
            os.environ['ANTHROPIC_API_KEY'] = self._saved
        db.session.remove()
        self.ctx.pop()

    def _set(self, value):
        if value is None:
            os.environ.pop('ANTHROPIC_API_KEY', None)
        else:
            os.environ['ANTHROPIC_API_KEY'] = value

    def test_reports_a_clean_key(self):
        self._set(REAL)
        d = ai_chat.key_diagnostics()
        self.assertTrue(d['api_key_set'])
        self.assertTrue(d['api_key_prefix_ok'])
        self.assertFalse(d['api_key_had_whitespace'])
        self.assertFalse(d['api_key_had_quotes'])
        self.assertEqual(d['api_key_len'], len(REAL))

    def test_flags_whitespace(self):
        self._set(REAL + '\n')
        d = ai_chat.key_diagnostics()
        self.assertTrue(d['api_key_had_whitespace'])
        self.assertEqual(d['api_key_len'], len(REAL))   # length after cleaning

    def test_flags_quotes(self):
        self._set(f'"{REAL}"')
        d = ai_chat.key_diagnostics()
        self.assertTrue(d['api_key_had_quotes'])
        self.assertEqual(d['api_key_len'], len(REAL))

    def test_flags_a_wrong_looking_prefix(self):
        """A pasted org id or OAuth token is set, non-empty, and still wrong."""
        self._set('not-an-anthropic-key-at-all')
        d = ai_chat.key_diagnostics()
        self.assertTrue(d['api_key_set'])
        self.assertFalse(d['api_key_prefix_ok'])

    def test_missing_key_reports_unset(self):
        self._set(None)
        d = ai_chat.key_diagnostics()
        self.assertFalse(d['api_key_set'])
        self.assertEqual(d['api_key_len'], 0)

    # ---- the public endpoint ----
    def test_health_exposes_diagnostics(self):
        self._set(f'"{REAL}"')
        body = self.client.get('/api/health').get_json()
        self.assertEqual(body['status'], 'ok')
        self.assertTrue(body['ai']['api_key_set'])
        self.assertTrue(body['ai']['api_key_had_quotes'])

    def test_health_never_leaks_the_key(self):
        """This route is unauthenticated — no substring of the key may appear."""
        self._set(REAL)
        raw = self.client.get('/api/health').get_data(as_text=True)
        self.assertNotIn(REAL, raw)
        self.assertNotIn(REAL[8:40], raw)
        self.assertNotIn('sk-ant', raw)

    def test_health_still_answers_when_key_is_missing(self):
        """Railway's healthcheck hits this; it must never depend on AI config."""
        self._set(None)
        res = self.client.get('/api/health')
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.get_json()['status'], 'ok')


if __name__ == '__main__':
    unittest.main()
