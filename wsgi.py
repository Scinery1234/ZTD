# Import must stay lightweight: gunicorn loads this before workers are ready;
# table creation is deferred to gunicorn_config.post_worker_init.
from backend.app import app, db  # noqa: F401  — 'db' used by gunicorn_config

__all__ = ("app", "db")
