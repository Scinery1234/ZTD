#!/usr/bin/env python3
"""
Create or upgrade a user to the premium tier.

Run from the repository root with DATABASE_URL set, e.g.:
  export DATABASE_URL="postgresql+psycopg2://..."   # or railway run
  python3 backend/ensure_premium_user.py

For a new user, if PREMIUM_USER_PASSWORD is unset, a random password is
generated and printed once.
"""
from __future__ import annotations

import os
import secrets
import sys

# Project root = parent of this file's directory
_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

os.chdir(_ROOT)

from dotenv import load_dotenv
from werkzeug.security import generate_password_hash

load_dotenv()

from backend.app import app, db, User, Hat  # noqa: E402

DEFAULT_EMAIL = "vik.nithy@gmail.com"
DEFAULT_NAME = "Vik"


def main() -> int:
    email = os.environ.get("PREMIUM_USER_EMAIL", DEFAULT_EMAIL).strip().lower()
    name = os.environ.get("PREMIUM_USER_NAME", DEFAULT_NAME).strip() or "User"
    new_password = os.environ.get("PREMIUM_USER_PASSWORD")
    if not new_password:
        new_password = secrets.token_urlsafe(12)

    with app.app_context():
        user = User.query.filter_by(email=email).first()
        if user:
            user.tier = "premium"
            db.session.commit()
            print(f"Updated existing user: {email!r} -> tier 'premium'")
            return 0

        if not os.environ.get("PREMIUM_USER_PASSWORD"):
            print("Creating new user (set PREMIUM_USER_PASSWORD to choose password).")
            print(f"Generated password: {new_password}\n(Store it securely; it will not be shown again.)")
        else:
            print(f"Created new user: {email!r} with the password from PREMIUM_USER_PASSWORD")

        user = User(
            email=email,
            name=name,
            password_hash=generate_password_hash(new_password),
            tier="premium",
        )
        db.session.add(user)
        db.session.flush()
        main_hat = Hat(
            user_id=user.id, name="Main Hat", emoji="🎩", color="#667eea", position=0
        )
        db.session.add(main_hat)
        db.session.commit()
        print(f"Created premium account: {email!r} (id={user.id})")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        raise SystemExit(1)
