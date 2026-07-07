import logging
import os
import sys

logger = logging.getLogger("gunicorn.error")

# AI turns (/api/chat, /api/coach) run a Claude tool loop that can take well
# over gunicorn's 30s default — workers were being killed mid-request, which
# the UI reported as "The server did not answer in time (30s)".
timeout = 180
graceful_timeout = 30

# Threaded workers keep the app responsive while a request waits on Claude:
# with 2 sync workers, two concurrent AI turns would block everyone else.
worker_class = "gthread"
threads = 8

print("[gunicorn_config] module loaded", file=sys.stderr, flush=True)


def post_worker_init(_worker) -> None:
    """Run after each worker is forked. Keep wsgi import free of DB I/O."""
    print("[gunicorn_config] post_worker_init starting", file=sys.stderr, flush=True)
    from backend.app import app, db, User
    from backend.bootstrap import ensure_bootstrap_admin

    with app.app_context():
        db.create_all()

        # db.create_all() does not add columns to existing tables.
        # Run idempotent ALTER TABLE statements for any columns added
        # after the initial table creation.
        from sqlalchemy import text, inspect as sa_inspect
        insp = sa_inspect(db.engine)
        user_cols = {c["name"] for c in insp.get_columns("user")}
        if "email_verified" not in user_cols:
            db.session.execute(text(
                'ALTER TABLE "user" ADD COLUMN email_verified BOOLEAN DEFAULT FALSE'
            ))
            db.session.commit()
            logger.info("Migration: added email_verified column to user table")

        ensure_bootstrap_admin()

        raw = os.environ.get("PREMIUM_USERS") or ""
        print(f"[PREMIUM_USERS] env var = {raw!r}", file=sys.stderr, flush=True)
        for email in [e.strip().lower() for e in raw.split(",") if e.strip()]:
            user = User.query.filter_by(email=email).first()
            if user is None:
                print(f"[PREMIUM_USERS] no account for {email}, skipping", file=sys.stderr, flush=True)
            elif user.tier != "premium":
                user.tier = "premium"
                db.session.commit()
                print(f"[PREMIUM_USERS] upgraded {email} -> premium", file=sys.stderr, flush=True)
            else:
                print(f"[PREMIUM_USERS] {email} already premium", file=sys.stderr, flush=True)

    logger.info("Database tables ensured (db.create_all).")
    print("[gunicorn_config] post_worker_init complete", file=sys.stderr, flush=True)
