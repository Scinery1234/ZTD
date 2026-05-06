"""
Create or update a designated admin / premium account at API startup.
Configure via Railway (or .env) variables — never hard-code secrets in the repo.

To UPGRADE an existing user's tier (no password change):
  BOOTSTRAP_ADMIN_EMAIL=user@example.com
  BOOTSTRAP_ADMIN_TIER=premium

To CREATE a new premium user (or also reset password):
  BOOTSTRAP_ADMIN_EMAIL=user@example.com
  BOOTSTRAP_ADMIN_PASSWORD=min8chars
  BOOTSTRAP_ADMIN_TIER=premium        (optional, defaults to premium)
  BOOTSTRAP_ADMIN_NAME=Display Name   (optional)
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
    if not email:
        return

    from backend.app import Hat, User, app, db, TIERS

    name = (os.environ.get("BOOTSTRAP_ADMIN_NAME") or "").strip() or None
    tier = (os.environ.get("BOOTSTRAP_ADMIN_TIER") or "premium").strip().lower()
    if tier not in TIERS:
        logger.warning("BOOTSTRAP_ADMIN_TIER must be in %s; using premium", list(TIERS))
        tier = "premium"
    password = os.environ.get("BOOTSTRAP_ADMIN_PASSWORD") or ""

    with app.app_context():
        user: Optional[User] = User.query.filter_by(email=email).first()

        if user is not None:
            # Existing user: update tier (and name/password if provided)
            user.tier = tier
            if name:
                user.name = name
            if password and len(password) >= 8:
                user.password_hash = generate_password_hash(password)
            db.session.commit()
            logger.info("Bootstrap: updated %s → tier=%s", email, tier)
            return

        # New user: password required
        if not password or len(password) < 8:
            logger.warning(
                "Bootstrap: user %s not found and BOOTSTRAP_ADMIN_PASSWORD is missing "
                "or too short (min 8 chars) — skipping creation.",
                email,
            )
            return

        user = User(
            email=email,
            name=name or "Admin",
            password_hash=generate_password_hash(password),
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
            user.tier = tier
            if name:
                user.name = name
            db.session.commit()
            logger.info("Bootstrap: updated %s after race (tier=%s)", email, tier)
        else:
            logger.info("Bootstrap: created %s (tier=%s)", email, tier)
