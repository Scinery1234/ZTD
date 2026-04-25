"""
Create or update a designated admin / premium test account at API startup.
Configure via Railway (or .env) — never hard-code secrets in the repo.

Required: BOOTSTRAP_ADMIN_EMAIL, BOOTSTRAP_ADMIN_PASSWORD (min 8 characters)
Optional: BOOTSTRAP_ADMIN_NAME (default: Admin), BOOTSTRAP_ADMIN_TIER (default: premium)
"""
from __future__ import annotations

import logging
import os
from typing import Optional

from werkzeug.security import generate_password_hash
from sqlalchemy.exc import IntegrityError

logger = logging.getLogger("gunicorn.error")


def ensure_bootstrap_admin() -> None:
    email = (os.environ.get("BOOTSTRAP_ADMIN_EMAIL") or "").strip().lower()
    password = os.environ.get("BOOTSTRAP_ADMIN_PASSWORD") or ""
    if not email or not password:
        return
    if len(password) < 8:
        logger.warning(
            "BOOTSTRAP_ADMIN_PASSWORD must be at least 8 characters; bootstrap skipped"
        )
        return

    # Late import: needs DB models
    from backend.app import Hat, User, app, db, TIERS

    name = (os.environ.get("BOOTSTRAP_ADMIN_NAME") or "Admin").strip() or "Admin"
    tier = (os.environ.get("BOOTSTRAP_ADMIN_TIER") or "premium").strip().lower()
    if tier not in TIERS:
        logger.warning("BOOTSTRAP_ADMIN_TIER must be in %s; using premium", list(TIERS))
        tier = "premium"

    with app.app_context():
        # Call from a Flask app context (e.g. gunicorn post_worker_init)
        user: Optional[User] = User.query.filter_by(email=email).first()
        ph = generate_password_hash(password)
        if user is None:
            user = User(
                email=email,
                name=name,
                password_hash=ph,
                tier=tier,
            )
            db.session.add(user)
            db.session.flush()
            main_hat = Hat(
                user_id=user.id, name="Main Hat", emoji="🎩", color="#667eea", position=0
            )
            db.session.add(main_hat)
            try:
                db.session.commit()
            except IntegrityError:
                db.session.rollback()
                user = User.query.filter_by(email=email).first()
                if user is None:
                    raise
                user.name = name
                user.password_hash = ph
                user.tier = tier
                db.session.commit()
                logger.info("Bootstrap: updated %s after race (tier=%s)", email, tier)
            else:
                logger.info("Bootstrap: created %s (tier=%s)", email, tier)
        else:
            user.name = name
            user.password_hash = ph
            user.tier = tier
            db.session.commit()
            logger.info("Bootstrap: updated %s (tier=%s)", email, tier)
