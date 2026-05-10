import logging

logger = logging.getLogger("gunicorn.error")


def post_worker_init(_worker) -> None:
    """Run after each worker is forked. Keep wsgi import free of DB I/O."""
    from backend.app import app, db
    from backend.bootstrap import ensure_bootstrap_admin, ensure_premium_users

    with app.app_context():
        db.create_all()
        ensure_bootstrap_admin()
        ensure_premium_users()
    logger.info("Database tables ensured (db.create_all).")
