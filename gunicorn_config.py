import logging
import os

logger = logging.getLogger("gunicorn.error")


def post_worker_init(_worker) -> None:
    """Run after each worker is forked. Keep wsgi import free of DB I/O."""
    from backend.app import app, db, User
    from backend.bootstrap import ensure_bootstrap_admin

    with app.app_context():
        db.create_all()
        ensure_bootstrap_admin()

        raw = os.environ.get("PREMIUM_USERS") or ""
        for email in [e.strip().lower() for e in raw.split(",") if e.strip()]:
            user = User.query.filter_by(email=email).first()
            if user is None:
                logger.warning("PREMIUM_USERS: no account for %s, skipping.", email)
            elif user.tier != "premium":
                user.tier = "premium"
                db.session.commit()
                logger.info("PREMIUM_USERS: upgraded %s → premium", email)
            else:
                logger.info("PREMIUM_USERS: %s already premium.", email)

    logger.info("Database tables ensured (db.create_all).")
