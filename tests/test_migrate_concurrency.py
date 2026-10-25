"""
migrate_db() under concurrent worker boot.

Every gunicorn worker runs migrate_db() as it starts, and they start at the
same instant. db.create_all() inspects the schema and then issues CREATE
TABLE, which is not atomic — so on the deploy that first adds a table, two
workers both find it missing, both create it, and the loser dies with

    UniqueViolation: duplicate key ... "pg_type_typname_nsp_index"

gunicorn treats a worker failing to boot as fatal and shuts the master down,
so the container crash-loops instead of serving. That happened in production
on the deploy that added `time_block`.

The real serialization is a Postgres advisory lock, which these tests can't
exercise on SQLite. What they pin is the behaviour that has to hold either
way: the lock is a no-op on non-Postgres backends, a lost race is survivable
rather than fatal, and migrating twice changes nothing.

Run from the repo root:

    python -m pytest tests/test_migrate_concurrency.py
"""
import os
import tempfile
import unittest

_DB_FD, _DB_PATH = tempfile.mkstemp(suffix='.db')
os.close(_DB_FD)
os.environ['DATABASE_URL'] = f'sqlite:///{_DB_PATH}'
os.environ.setdefault('JWT_SECRET_KEY', 'test-secret')

from sqlalchemy.exc import IntegrityError  # noqa: E402

from backend.app import (  # noqa: E402
    app, db, limiter, migrate_db, _schema_lock, _MIGRATION_LOCK_ID, Task, TimeBlock,
)

limiter.enabled = False


class SchemaLockTests(unittest.TestCase):
    def setUp(self):
        self.ctx = app.app_context()
        self.ctx.push()

    def tearDown(self):
        db.session.remove()
        self.ctx.pop()

    def test_lock_is_a_noop_off_postgres(self):
        """SQLite is single-process, and pg_advisory_lock doesn't exist there —
        entering the lock must not blow up or try to issue it."""
        self.assertNotEqual(db.engine.dialect.name, 'postgresql')
        with _schema_lock():
            pass  # reaching here is the assertion

    def test_lock_is_reentrant_across_sequential_uses(self):
        for _ in range(3):
            with _schema_lock():
                pass

    def test_lock_releases_when_the_body_raises(self):
        """A worker dying mid-migration must not leave the lock held."""
        with self.assertRaises(RuntimeError):
            with _schema_lock():
                raise RuntimeError('worker died')
        with _schema_lock():
            pass

    def test_lock_key_is_stable(self):
        """The key identifies 'ZTD schema migrations' across processes; if it
        ever changed between deploys, two versions would stop excluding each
        other and the race would be back."""
        self.assertEqual(_MIGRATION_LOCK_ID, 0x7A7D0001)


class MigrateDbTests(unittest.TestCase):
    def setUp(self):
        self.ctx = app.app_context()
        self.ctx.push()
        db.session.remove()
        db.drop_all()

    def tearDown(self):
        db.session.remove()
        self.ctx.pop()

    def test_creates_the_schema(self):
        migrate_db()
        from sqlalchemy import inspect as sa_inspect
        tables = set(sa_inspect(db.engine).get_table_names())
        self.assertIn('task', tables)
        self.assertIn('time_block', tables)

    def test_is_idempotent(self):
        """Workers that boot after the first one re-run this; it must be inert."""
        migrate_db()
        migrate_db()
        migrate_db()
        from sqlalchemy import inspect as sa_inspect
        self.assertIn('time_block', sa_inspect(db.engine).get_table_names())

    def test_survives_losing_the_create_race(self):
        """The production failure: another process won CREATE TABLE and ours
        raised. That must be survivable — a worker that dies here takes the
        whole gunicorn master down with it."""
        migrate_db()   # schema already in place, as it would be after the winner

        real_create_all = db.create_all
        calls = {'n': 0}

        def exploding_create_all(*a, **kw):
            calls['n'] += 1
            raise IntegrityError('CREATE TABLE time_block', {},
                                 Exception('duplicate key value violates unique '
                                           'constraint "pg_type_typname_nsp_index"'))

        db.create_all = exploding_create_all
        try:
            migrate_db()   # must not raise
        finally:
            db.create_all = real_create_all

        self.assertEqual(calls['n'], 1)
        # And the session is left usable rather than stuck in a failed transaction.
        self.assertEqual(Task.query.count(), 0)
        self.assertEqual(TimeBlock.query.count(), 0)


if __name__ == '__main__':
    unittest.main()
