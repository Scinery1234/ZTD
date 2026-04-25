import logging

logger = logging.getLogger("gunicorn.error")


def post_worker_init(_worker) -> None:
    """Run after each worker is forked. Keep wsgi import free of DB I/O."""
    from backend.app import app, db

    with app.app_context():
        db.create_all()
    logger.info("Database tables ensured (db.create_all).")
