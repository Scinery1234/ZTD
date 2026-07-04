from flask import Flask, request, jsonify, send_from_directory, Response, redirect
from flask_cors import CORS
from flask_sqlalchemy import SQLAlchemy
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from sqlalchemy import text
from flask_jwt_extended import (
    JWTManager, create_access_token, jwt_required, get_jwt_identity
)
from werkzeug.security import generate_password_hash, check_password_hash
import os
import re
import json
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from datetime import datetime, timedelta
import dateparser
import stripe
import resend
from itsdangerous import URLSafeTimedSerializer, SignatureExpired, BadSignature
from dotenv import load_dotenv
try:
    from emails import verify_html, VERIFY_SUBJECT, welcome_html, WELCOME_SUBJECT
except ImportError:
    # When run as `python -m flask --app backend.app`, backend/ isn't on sys.path
    import importlib.util as _ilu, os as _os
    _spec = _ilu.spec_from_file_location(
        'emails', _os.path.join(_os.path.dirname(__file__), 'emails.py')
    )
    _mod = _ilu.module_from_spec(_spec); _spec.loader.exec_module(_mod)
    verify_html = _mod.verify_html; VERIFY_SUBJECT = _mod.VERIFY_SUBJECT
    welcome_html = _mod.welcome_html; WELCOME_SUBJECT = _mod.WELCOME_SUBJECT

load_dotenv()

# static_folder=None: don't let Flask's built-in /static route shadow the
# React build's /static/* assets, which the SPA catch-all below serves.
app = Flask(__name__, static_folder=None)

# Restrict CORS to the known frontend origin in production
_frontend_origin = os.getenv('FRONTEND_URL')
CORS(app, origins=[_frontend_origin, 'http://localhost:3000'] if _frontend_origin else '*')

# --- Configuration ---

BASE_DIR = os.path.dirname(os.path.abspath(__file__))


def _sqlalchemy_database_uri() -> str:
    """Local dev uses SQLite; use DATABASE_URL (e.g. Railway Postgres) in production."""
    default_sqlite = f"sqlite:///{os.path.join(BASE_DIR, 'ztd.db')}"
    url = os.getenv("DATABASE_URL", default_sqlite)
    # Heroku / Railway: postgres:// is deprecated in SQLAlchemy; normalize to postgresql+psycopg2
    if url.startswith("postgres://"):
        url = "postgresql+psycopg2://" + url.removeprefix("postgres://")
    elif url.startswith("postgresql://") and not url.startswith("postgresql+psycopg2://"):
        url = "postgresql+psycopg2://" + url.removeprefix("postgresql://")
    if url.startswith("postgresql+psycopg2://"):
        parts = urlsplit(url)
        q = dict(parse_qsl(parts.query, keep_blank_values=True))
        ssl = os.getenv("DATABASE_SSLMODE", "require")
        if "sslmode" not in q and ssl and ssl.lower() != "disable":
            q["sslmode"] = ssl
        if q and urlencode(q) != parts.query:
            url = urlunsplit(
                (parts.scheme, parts.netloc, parts.path, urlencode(q), parts.fragment)
            )
    return url


app.config["SQLALCHEMY_DATABASE_URI"] = _sqlalchemy_database_uri()
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.config['JWT_SECRET_KEY'] = os.getenv('JWT_SECRET_KEY', 'dev-secret-change-in-production')
app.config['JWT_ACCESS_TOKEN_EXPIRES'] = timedelta(days=30)

db = SQLAlchemy(app)
jwt = JWTManager(app)

@jwt.expired_token_loader
def expired_token_callback(jwt_header, jwt_payload):
    return jsonify({'error': 'Token has expired', 'token_expired': True}), 401

@jwt.invalid_token_loader
def invalid_token_callback(error):
    return jsonify({'error': 'Invalid token', 'token_expired': True}), 401

@jwt.unauthorized_loader
def missing_token_callback(error):
    return jsonify({'error': 'Authorization required', 'token_expired': True}), 401

stripe.api_key = os.getenv('STRIPE_SECRET_KEY', '')

# --- Rate limiter (in-memory; swap storage_uri for Redis in production) ---
limiter = Limiter(
    get_remote_address,
    app=app,
    default_limits=[],
    storage_uri='memory://',
)

# --- Security headers ---
@app.after_request
def add_security_headers(response):
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['X-Frame-Options'] = 'DENY'
    response.headers['Referrer-Policy'] = 'strict-origin-when-cross-origin'
    response.headers['Permissions-Policy'] = 'geolocation=(), microphone=(), camera=(), payment=()'
    # HSTS only when behind HTTPS proxy (Railway sets X-Forwarded-Proto)
    if request.headers.get('X-Forwarded-Proto') == 'https':
        response.headers['Strict-Transport-Security'] = 'max-age=63072000; includeSubDomains; preload'
    return response

# --- Membership Tiers ---
TIERS = {
    'free':    {'name': 'Free',    'max_tasks': 10,   'price': 0},
    'pro':     {'name': 'Pro',     'max_tasks': None,  'price': 9},
    'premium': {'name': 'Premium', 'max_tasks': None,  'price': 19},
}

TIER_FEATURES = {
    'free':    ['Up to 10 active tasks', 'Basic categories & priorities', 'Drag & drop', '3 Loose Threads', '30-day history'],
    'pro':     ['Unlimited tasks', 'Pomodoro timer', 'Data export (CSV/JSON)', '10 Loose Threads', '90-day task history'],
    'premium': ['Everything in Pro', 'Task notes', 'Advanced analytics dashboard', 'Unlimited Loose Threads', 'Full archive (all history)', 'Priority support'],
}

ARCHIVE_DAYS = {'free': 30, 'pro': 90, 'premium': None}   # None = unlimited
LT_LIMITS    = {'free': 3,  'pro': 10,  'premium': None}   # Loose Threads count limits


# --- Models ---
class User(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    email = db.Column(db.String(120), unique=True, nullable=False)
    name = db.Column(db.String(100), nullable=False)
    password_hash = db.Column(db.String(200), nullable=False)
    tier = db.Column(db.String(20), default='free')
    stripe_customer_id = db.Column(db.String(100), nullable=True)
    stripe_subscription_id = db.Column(db.String(100), nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    email_verified = db.Column(db.Boolean, default=False)

    tasks = db.relationship('Task', backref='user', lazy=True, cascade='all, delete-orphan')
    done_tasks = db.relationship('DoneTask', backref='user', lazy=True, cascade='all, delete-orphan')
    hats = db.relationship('Hat', backref='user', lazy=True, cascade='all, delete-orphan')

    def to_dict(self):
        return {
            'id': self.id,
            'email': self.email,
            'name': self.name,
            'tier': self.tier,
            'tier_name': TIERS[self.tier]['name'],
            'created_at': self.created_at.isoformat(),
            'email_verified': bool(self.email_verified),
        }


class Hat(db.Model):
    """A workspace / area of life that groups tasks."""
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    name = db.Column(db.String(100), nullable=False)
    emoji = db.Column(db.String(10), default='🎩')
    color = db.Column(db.String(20), default='#667eea')
    position = db.Column(db.Integer, default=0)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    tasks = db.relationship('Task', backref='hat', lazy=True)

    def to_dict(self):
        return {
            'id': self.id,
            'name': self.name,
            'emoji': self.emoji,
            'color': self.color,
            'position': self.position,
        }


class Task(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    hat_id = db.Column(db.Integer, db.ForeignKey('hat.id'), nullable=True)
    description = db.Column(db.String(500), nullable=False)
    category = db.Column(db.String(100), default='')
    priority = db.Column(db.String(50), default='')
    recurring = db.Column(db.String(50), default='')
    due = db.Column(db.String(20), nullable=True)
    position = db.Column(db.Integer, default=0)
    subtasks = db.Column(db.Text, default='[]')   # JSON: [{id, text, done}]
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    duration = db.Column(db.Integer, default=30)           # minutes
    scheduled_time = db.Column(db.String(5), nullable=True)  # HH:MM
    scheduled_date = db.Column(db.String(10), nullable=True) # YYYY-MM-DD
    locked = db.Column(db.Boolean, default=False)            # locked in timebox
    notes = db.Column(db.Text, nullable=True)                # rich notes (premium)
    pomodoro_count = db.Column(db.Integer, default=0)        # focus sessions logged (premium)
    gcal_event_id = db.Column(db.String(200), nullable=True) # Google Calendar event id
    ms_event_id   = db.Column(db.String(200), nullable=True) # Microsoft Outlook event id

    def subtasks_list(self):
        try:
            raw = json.loads(self.subtasks or '[]')
        except Exception:
            return []
        if isinstance(raw, list):
            return raw
        if isinstance(raw, dict):
            return list(raw.values())
        return []

    def to_dict(self):
        return {
            'id': self.id,
            'hat_id': self.hat_id,
            'description': self.description,
            'category': self.category or '',
            'priority': self.priority or '',
            'recurring': self.recurring or '',
            'due': self.due,
            'position': self.position,
            'subtasks': self.subtasks_list(),
            'duration': self.duration if self.duration is not None else 30,
            'scheduled_time': self.scheduled_time,
            'scheduled_date': self.scheduled_date,
            'locked': bool(self.locked),
            'notes': self.notes or '',
            'pomodoro_count': self.pomodoro_count or 0,
            'gcal_event_id': self.gcal_event_id,
            'ms_event_id': self.ms_event_id,
        }


class DoneTask(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    hat_id = db.Column(db.Integer, db.ForeignKey('hat.id'), nullable=True)
    description = db.Column(db.String(500), nullable=False)
    category = db.Column(db.String(100), default='')
    priority = db.Column(db.String(50), default='')
    recurring = db.Column(db.String(50), default='')
    due = db.Column(db.String(20), nullable=True)
    last_done = db.Column(db.String(20), nullable=True)
    subtasks = db.Column(db.Text, default='[]')
    completed_at = db.Column(db.DateTime, default=datetime.utcnow)
    notes = db.Column(db.Text, nullable=True)

    def subtasks_list(self):
        try:
            raw = json.loads(self.subtasks or '[]')
        except Exception:
            return []
        if isinstance(raw, list):
            return raw
        if isinstance(raw, dict):
            return list(raw.values())
        return []

    def to_dict(self):
        return {
            'id': self.id,
            'hat_id': self.hat_id,
            'description': self.description,
            'category': self.category or '',
            'priority': self.priority or '',
            'recurring': self.recurring or '',
            'due': self.due,
            'last_done': self.last_done,
            'subtasks': self.subtasks_list(),
            'completed_at': self.completed_at.isoformat(),
            'notes': self.notes or '',
        }


class CalendarConnection(db.Model):
    """One row per (user, provider) pair. Stores OAuth tokens."""
    __tablename__ = 'calendar_connection'
    id            = db.Column(db.Integer, primary_key=True)
    user_id       = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    provider      = db.Column(db.String(20), nullable=False)   # 'google' | 'microsoft'
    access_token  = db.Column(db.Text, nullable=False)
    refresh_token = db.Column(db.Text, nullable=True)
    expires_at    = db.Column(db.DateTime, nullable=True)
    calendar_id   = db.Column(db.String(200), default='primary')
    __table_args__ = (db.UniqueConstraint('user_id', 'provider', name='uq_cal_user_provider'),)

    def to_dict(self):
        return {
            'provider': self.provider,
            'calendar_id': self.calendar_id,
            'connected': True,
        }


class ChatUndo(db.Model):
    """One per AI-chat turn that mutated tasks. Stores inverse operations so the
    whole turn can be undone as a single unit (per-turn undo stack)."""
    __tablename__ = 'chat_undo'
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    summary = db.Column(db.String(300), default='')
    payload = db.Column(db.Text, default='[]')   # JSON list of inverse ops


class CoachMemory(db.Model):
    """A short durable note the AI hub keeps about a user, shared across the
    task assistant and every coach so conversations pick up where they left
    off. Users can view and delete notes via /api/coach/memory."""
    __tablename__ = 'coach_memory'
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    coach_id = db.Column(db.String(20), default='')   # which tool saved it ('' = assistant)
    content = db.Column(db.String(500), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    def to_dict(self):
        return {
            'id': self.id,
            'coach_id': self.coach_id or '',
            'content': self.content,
            'created_at': self.created_at.isoformat() if self.created_at else None,
        }


# --- Helpers ---
def parse_task_input(input_str):
    pattern = r"(?P<desc>.+?)(?:\s+@(?P<cat>[^!~^]+))?(?:\s*!\s*(?P<prio>urgent|today|tomorrow|later))?(?:\s*~\s*(?P<recur>daily|weekly|monthly))?(?:\s*\^\s*(?P<due>.+))?$"
    match = re.match(pattern, input_str.strip(), re.IGNORECASE)
    if match:
        desc = match.group("desc").strip()
        cat = (match.group("cat") or "").strip()
        prio = (match.group("prio") or "").strip()
        recur = (match.group("recur") or "").strip()
        due_text = (match.group("due") or "").strip()
    else:
        desc, cat, prio, recur, due_text = input_str.strip(), "", "", "", ""

    due = None
    if due_text:
        parsed = dateparser.parse(due_text)
        if parsed:
            due = parsed.strftime("%Y-%m-%d")
    return desc, cat, prio, recur, due


def check_task_limit(user):
    limit = TIERS[user.tier]['max_tasks']
    if limit is None:
        return None
    count = Task.query.filter_by(user_id=user.id).count()
    if count >= limit:
        return {
            'error': f'Task limit reached. The Free tier allows {limit} tasks. Upgrade to Pro for unlimited tasks.',
            'upgrade_required': True,
            'current_tier': user.tier,
        }
    return None


# === Email helpers ===

def _send_email(to: str, subject: str, html: str) -> bool:
    """Send an email via Resend. Returns True on success, False if key not set."""
    key = os.getenv('RESEND_API_KEY', '')
    if not key:
        app.logger.warning('[email] RESEND_API_KEY not set — skipping send to %s', to)
        return False
    resend.api_key = key
    from_addr = os.getenv('RESEND_FROM_EMAIL', 'happen <noreply@happen.app>')
    try:
        resend.Emails.send({'from': from_addr, 'to': [to], 'subject': subject, 'html': html})
        return True
    except Exception as exc:
        app.logger.error('[email] Resend error: %s', exc)
        return False


def _make_signed_token(value: str, salt: str) -> str:
    s = URLSafeTimedSerializer(app.config['JWT_SECRET_KEY'])
    return s.dumps(value, salt=salt)


def _load_signed_token(token: str, salt: str, max_age: int) -> str:
    """Returns the decoded value, or raises SignatureExpired / BadSignature."""
    s = URLSafeTimedSerializer(app.config['JWT_SECRET_KEY'])
    return s.loads(token, salt=salt, max_age=max_age)


# === Calendar helpers ===

def _task_event_times(task, timezone='UTC'):
    """Return (start_dt_str, end_dt_str) as ISO-8601 for a scheduled task."""
    start_min = int(task.scheduled_time.split(':')[0]) * 60 + int(task.scheduled_time.split(':')[1])
    end_min = start_min + (task.duration or 30)
    end_h, end_m = divmod(end_min % (24 * 60), 60)
    # If task bleeds past midnight, clamp to 23:59
    if end_min >= 24 * 60:
        end_h, end_m = 23, 59
    date = task.scheduled_date
    start_dt = f"{date}T{task.scheduled_time}:00"
    end_dt   = f"{date}T{end_h:02d}:{end_m:02d}:00"
    return start_dt, end_dt


# ── Google Calendar ───────────────────────────────────────────────────────────

def _google_credentials(conn):
    from google.oauth2.credentials import Credentials
    from google.auth.transport.requests import Request as GRequest
    creds = Credentials(
        token=conn.access_token,
        refresh_token=conn.refresh_token,
        token_uri='https://oauth2.googleapis.com/token',
        client_id=os.getenv('GOOGLE_CLIENT_ID'),
        client_secret=os.getenv('GOOGLE_CLIENT_SECRET'),
    )
    if creds.expired and creds.refresh_token:
        creds.refresh(GRequest())
        conn.access_token = creds.token
        if creds.expiry:
            conn.expires_at = creds.expiry
        db.session.commit()
    return creds


def _google_push(task, conn, timezone='UTC'):
    from googleapiclient.discovery import build
    svc = build('calendar', 'v3', credentials=_google_credentials(conn), cache_discovery=False)
    start_dt, end_dt = _task_event_times(task, timezone)
    body = {
        'summary': task.description,
        'start':   {'dateTime': start_dt, 'timeZone': timezone},
        'end':     {'dateTime': end_dt,   'timeZone': timezone},
        'status':  'confirmed',
        'transparency': 'opaque',   # shows as "Busy"
    }
    cal = conn.calendar_id or 'primary'
    if task.gcal_event_id:
        try:
            svc.events().update(calendarId=cal, eventId=task.gcal_event_id, body=body).execute()
            return task.gcal_event_id
        except Exception:
            task.gcal_event_id = None  # stale id — fall through to create
    event = svc.events().insert(calendarId=cal, body=body).execute()
    return event['id']


def _google_delete(task, conn):
    from googleapiclient.discovery import build
    from googleapiclient.errors import HttpError
    if not task.gcal_event_id:
        return
    try:
        svc = build('calendar', 'v3', credentials=_google_credentials(conn), cache_discovery=False)
        svc.events().delete(calendarId=conn.calendar_id or 'primary', eventId=task.gcal_event_id).execute()
    except HttpError:
        pass  # already deleted
    task.gcal_event_id = None


# ── Microsoft / Outlook ───────────────────────────────────────────────────────

def _ms_access_token(conn):
    import msal, requests as req
    if conn.expires_at and datetime.utcnow() < conn.expires_at - timedelta(seconds=60):
        return conn.access_token
    authority = 'https://login.microsoftonline.com/common'
    app_ms = msal.ConfidentialClientApplication(
        os.getenv('MICROSOFT_CLIENT_ID'),
        authority=authority,
        client_credential=os.getenv('MICROSOFT_CLIENT_SECRET'),
    )
    result = app_ms.acquire_token_by_refresh_token(
        conn.refresh_token,
        scopes=['https://graph.microsoft.com/Calendars.ReadWrite'],
    )
    if 'access_token' not in result:
        raise RuntimeError(f"MS token refresh failed: {result.get('error_description')}")
    conn.access_token = result['access_token']
    conn.expires_at = datetime.utcnow() + timedelta(seconds=result.get('expires_in', 3600))
    db.session.commit()
    return conn.access_token


def _ms_push(task, conn, timezone='UTC'):
    import requests as req
    token = _ms_access_token(conn)
    headers = {'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'}
    start_dt, end_dt = _task_event_times(task, timezone)
    body = {
        'subject': task.description,
        'start':   {'dateTime': start_dt, 'timeZone': timezone},
        'end':     {'dateTime': end_dt,   'timeZone': timezone},
        'showAs':  'busy',
        'isAllDay': False,
    }
    base = 'https://graph.microsoft.com/v1.0'
    if task.ms_event_id:
        r = req.patch(f'{base}/me/events/{task.ms_event_id}', headers=headers, json=body, timeout=10)
        if r.ok:
            return task.ms_event_id
        task.ms_event_id = None  # stale id — fall through
    r = req.post(f'{base}/me/events', headers=headers, json=body, timeout=10)
    r.raise_for_status()
    return r.json()['id']


def _ms_delete(task, conn):
    import requests as req
    if not task.ms_event_id:
        return
    try:
        token = _ms_access_token(conn)
        headers = {'Authorization': f'Bearer {token}'}
        req.delete(f'https://graph.microsoft.com/v1.0/me/events/{task.ms_event_id}', headers=headers, timeout=10)
    except Exception:
        pass
    task.ms_event_id = None


# === Auth Endpoints ===

@app.route('/api/auth/register', methods=['POST'])
@limiter.limit('5 per minute; 20 per hour')
def register():
    data = request.json
    if not data or not all(k in data for k in ('email', 'password', 'name')):
        return jsonify({'error': 'Email, name, and password are required'}), 400

    email = data['email'].lower().strip()
    if len(data['password']) < 8:
        return jsonify({'error': 'Password must be at least 8 characters'}), 400

    if User.query.filter_by(email=email).first():
        return jsonify({'error': 'An account with this email already exists'}), 409

    user = User(
        email=email,
        name=data['name'].strip(),
        password_hash=generate_password_hash(data['password']),
    )
    db.session.add(user)
    db.session.flush()  # get user.id before commit

    # Create default "Main Hat" for new users
    main_hat = Hat(user_id=user.id, name='Main Hat', emoji='🎩', color='#667eea', position=0)
    db.session.add(main_hat)
    db.session.commit()

    # Send email verification
    frontend_url = os.getenv('FRONTEND_URL', 'http://localhost:3000').rstrip('/')
    verify_token = _make_signed_token(email, 'email-verify')
    verify_url = f"{frontend_url}/app#verify-email?token={verify_token}"
    html = verify_html(user.name, verify_url, frontend_url)
    if not _send_email(email, VERIFY_SUBJECT, html):
        # Dev fallback: print the link so it can be tested without Resend
        print(f'[register] verify URL (set RESEND_API_KEY to email instead): {verify_url}', flush=True)

    access_token = create_access_token(identity=str(user.id))
    return jsonify({'token': access_token, 'access_token': access_token, 'user': user.to_dict()}), 201


@app.route('/api/auth/login', methods=['POST'])
@limiter.limit('10 per minute; 50 per hour')
def login():
    data = request.json
    if not data or not data.get('email') or not data.get('password'):
        return jsonify({'error': 'Email and password are required'}), 400

    email = data['email'].lower().strip()
    user = User.query.filter_by(email=email).first()

    if not user or not check_password_hash(user.password_hash, data['password']):
        return jsonify({'error': 'Invalid email or password'}), 401

    token = create_access_token(identity=str(user.id))
    # Return both keys for compatibility across mixed frontend/backend deploys.
    return jsonify({'token': token, 'access_token': token, 'user': user.to_dict()})


@app.route('/api/auth/forgot-password', methods=['POST'])
@limiter.limit('3 per minute; 10 per hour')
def forgot_password():
    data = request.json or {}
    email = data.get('email', '').lower().strip()
    if not email:
        return jsonify({'error': 'Email is required'}), 400

    user = User.query.filter_by(email=email).first()
    # Always return the same message — don't leak whether the email exists
    if user:
        s = URLSafeTimedSerializer(app.config['JWT_SECRET_KEY'])
        token = s.dumps(email, salt='pw-reset')
        frontend_url = os.getenv('FRONTEND_URL', 'http://localhost:3000').rstrip('/')
        reset_url = f"{frontend_url}/app#reset-password?token={token}"

        resend_key = os.getenv('RESEND_API_KEY', '')
        if resend_key:
            resend.api_key = resend_key
            from_addr = os.getenv('RESEND_FROM_EMAIL', 'happen <noreply@happen.app>')
            try:
                resend.Emails.send({
                    'from': from_addr,
                    'to': [email],
                    'subject': 'Reset your happen password',
                    'html': (
                        f'<p>Hi {user.name},</p>'
                        f'<p>Click the link below to reset your password. '
                        f'The link expires in 1 hour.</p>'
                        f'<p><a href="{reset_url}" style="color:#f97316;font-weight:600">'
                        f'Reset my password</a></p>'
                        f'<p style="color:#888;font-size:13px">If you didn\'t request this, '
                        f'you can safely ignore this email.</p>'
                    ),
                })
            except Exception as exc:
                app.logger.error('Resend error: %s', exc)
        else:
            # Dev fallback: print the link so it can be tested without Resend
            app.logger.warning('[forgot-password] RESEND_API_KEY not set. Reset URL: %s', reset_url)
            print(f'[forgot-password] reset URL: {reset_url}', flush=True)

    return jsonify({'message': 'If an account exists with that email, a reset link has been sent.'}), 200


@app.route('/api/auth/reset-password', methods=['POST'])
@limiter.limit('5 per minute')
def reset_password():
    data = request.json or {}
    token = data.get('token', '').strip()
    new_password = data.get('password', '')

    if not token or not new_password:
        return jsonify({'error': 'Token and new password are required'}), 400
    if len(new_password) < 8:
        return jsonify({'error': 'Password must be at least 8 characters'}), 400

    s = URLSafeTimedSerializer(app.config['JWT_SECRET_KEY'])
    try:
        email = s.loads(token, salt='pw-reset', max_age=3600)  # 1-hour expiry
    except SignatureExpired:
        return jsonify({'error': 'Reset link has expired. Please request a new one.'}), 400
    except BadSignature:
        return jsonify({'error': 'Invalid reset link.'}), 400

    user = User.query.filter_by(email=email).first()
    if not user:
        return jsonify({'error': 'Account not found.'}), 404

    user.password_hash = generate_password_hash(new_password)
    db.session.commit()
    return jsonify({'message': 'Password updated successfully.'}), 200


@app.route('/api/auth/verify-email', methods=['GET'])
def verify_email():
    token = request.args.get('token', '').strip()
    if not token:
        return jsonify({'error': 'Verification token is required'}), 400

    try:
        email = _load_signed_token(token, 'email-verify', max_age=86400)  # 24 h
    except SignatureExpired:
        return jsonify({'error': 'Verification link has expired. Please request a new one.'}), 400
    except BadSignature:
        return jsonify({'error': 'Invalid verification link.'}), 400

    user = User.query.filter_by(email=email).first()
    if not user:
        return jsonify({'error': 'Account not found.'}), 404

    already_verified = bool(user.email_verified)
    if not already_verified:
        user.email_verified = True
        db.session.commit()
        # Send welcome email
        frontend_url = os.getenv('FRONTEND_URL', 'http://localhost:3000').rstrip('/')
        app_url = f"{frontend_url}/app"
        _send_email(email, WELCOME_SUBJECT, welcome_html(user.name, app_url, frontend_url))

    return jsonify({'message': 'Email verified successfully.', 'already_verified': already_verified}), 200


@app.route('/api/auth/resend-verification', methods=['POST'])
@jwt_required()
@limiter.limit('3 per hour')
def resend_verification():
    user_id = int(get_jwt_identity())
    user = db.session.get(User, user_id)
    if not user:
        return jsonify({'error': 'User not found'}), 404
    if user.email_verified:
        return jsonify({'message': 'Email is already verified.'}), 200

    frontend_url = os.getenv('FRONTEND_URL', 'http://localhost:3000').rstrip('/')
    verify_token = _make_signed_token(user.email, 'email-verify')
    verify_url = f"{frontend_url}/app#verify-email?token={verify_token}"
    html = verify_html(user.name, verify_url, frontend_url)
    if not _send_email(user.email, VERIFY_SUBJECT, html):
        print(f'[resend-verification] verify URL: {verify_url}', flush=True)

    return jsonify({'message': 'Verification email sent.'}), 200


@app.route('/api/auth/me', methods=['GET'])
@jwt_required()
def get_me():
    user_id = int(get_jwt_identity())
    user = User.query.get(user_id)
    if not user:
        return jsonify({'error': 'User not found'}), 404
    return jsonify(user.to_dict())


# === Hat Endpoints ===

@app.route('/api/hats', methods=['GET'])
@jwt_required()
def get_hats():
    user_id = int(get_jwt_identity())
    hats = Hat.query.filter_by(user_id=user_id).order_by(Hat.position, Hat.id).all()
    return jsonify([h.to_dict() for h in hats])


@app.route('/api/hats', methods=['POST'])
@jwt_required()
def create_hat():
    user_id = int(get_jwt_identity())
    data = request.json
    if not data or not data.get('name', '').strip():
        return jsonify({'error': 'Hat name is required'}), 400

    max_pos = db.session.query(db.func.max(Hat.position)).filter_by(user_id=user_id).scalar() or 0
    hat = Hat(
        user_id=user_id,
        name=data['name'].strip(),
        emoji=data.get('emoji', '🎩'),
        color=data.get('color', '#667eea'),
        position=max_pos + 1,
    )
    db.session.add(hat)
    db.session.commit()
    return jsonify(hat.to_dict()), 201


@app.route('/api/hats/<int:hat_id>', methods=['PUT'])
@jwt_required()
def update_hat(hat_id):
    user_id = int(get_jwt_identity())
    hat = Hat.query.filter_by(id=hat_id, user_id=user_id).first()
    if not hat:
        return jsonify({'error': 'Hat not found'}), 404

    data = request.json
    if 'name' in data:
        hat.name = data['name'].strip()
    if 'emoji' in data:
        hat.emoji = data['emoji']
    if 'color' in data:
        hat.color = data['color']

    db.session.commit()
    return jsonify(hat.to_dict())


@app.route('/api/hats/<int:hat_id>', methods=['DELETE'])
@jwt_required()
def delete_hat(hat_id):
    user_id = int(get_jwt_identity())
    hat = Hat.query.filter_by(id=hat_id, user_id=user_id).first()
    if not hat:
        return jsonify({'error': 'Hat not found'}), 404

    # Move tasks in this hat to null (no hat) rather than deleting them
    Task.query.filter_by(hat_id=hat_id, user_id=user_id).update({'hat_id': None})
    DoneTask.query.filter_by(hat_id=hat_id, user_id=user_id).update({'hat_id': None})

    db.session.delete(hat)
    db.session.commit()
    return jsonify({'message': 'Hat deleted'})


@app.route('/api/hats/reorder', methods=['POST'])
@jwt_required()
def reorder_hats():
    user_id = int(get_jwt_identity())
    data = request.json
    hat_ids = data.get('hat_ids', [])
    for position, hat_id in enumerate(hat_ids):
        hat = Hat.query.filter_by(id=hat_id, user_id=user_id).first()
        if hat:
            hat.position = position
    db.session.commit()
    hats = Hat.query.filter_by(user_id=user_id).order_by(Hat.position, Hat.id).all()
    return jsonify([h.to_dict() for h in hats])


# === Task Endpoints ===

@app.route('/api/tasks', methods=['GET'])
@jwt_required()
def get_tasks():
    user_id = int(get_jwt_identity())
    hat_id = request.args.get('hat_id', type=int)
    today = datetime.today().strftime("%Y-%m-%d")
    # view_date lets the frontend request tasks visible on a future date (e.g. tomorrow's pool)
    view_date = request.args.get('view_date') or today
    q = Task.query.filter_by(user_id=user_id)
    if hat_id is not None:
        q = q.filter_by(hat_id=hat_id)
    # Hide recurring tasks whose due date is after the requested view date
    q = q.filter(
        db.or_(
            Task.recurring == None,
            Task.recurring == '',
            Task.due == None,
            Task.due <= view_date,
        )
    )
    try:
        tasks = q.order_by(Task.position, Task.id).all()
    except Exception:
        # Schema may be missing new columns — run migration then retry
        db.session.rollback()
        migrate_db()
        tasks = q.order_by(Task.position, Task.id).all()
    return jsonify([t.to_dict() for t in tasks])


@app.route('/api/tasks', methods=['POST'])
@jwt_required()
def add_task():
    try:
        user_id = int(get_jwt_identity())
        user = User.query.get(user_id)
        data = request.json

        if not data:
            return jsonify({'error': 'No data provided'}), 400

        limit_error = check_task_limit(user)
        if limit_error:
            return jsonify(limit_error), 403

        hat_id = data.get('hat_id') or None
        # Validate hat belongs to user
        if hat_id:
            hat = Hat.query.filter_by(id=hat_id, user_id=user_id).first()
            if not hat:
                hat_id = None
        # Default to Main Hat if no hat specified
        if hat_id is None:
            main_hat = Hat.query.filter_by(user_id=user_id, name='Main Hat').first()
            if main_hat:
                hat_id = main_hat.id

        max_pos_q = Task.query.filter_by(user_id=user_id)
        if hat_id:
            max_pos_q = max_pos_q.filter_by(hat_id=hat_id)
        max_pos = db.session.query(db.func.max(Task.position)).filter_by(user_id=user_id).scalar() or 0
        next_pos = max_pos + 1

        input_str = data.get('input', '').strip()
        all_tasks = []

        if input_str:
            tasks_raw = [t.strip() for t in input_str.split(",") if t.strip()]
            for task_raw in tasks_raw:
                desc, cat, prio, recur, due = parse_task_input(task_raw)
                if not desc:
                    continue
                task = Task(user_id=user_id, hat_id=hat_id, description=desc, category=cat,
                            priority=prio, recurring=recur, due=due, position=next_pos)
                db.session.add(task)
                all_tasks.append(task)
                next_pos += 1
        else:
            description = data.get('description', '').strip()
            if not description:
                return jsonify({'error': 'Task description is required'}), 400
            due_raw = (data.get('due', '') or '').strip()
            if due_raw:
                _parsed = dateparser.parse(due_raw)
                due_val = _parsed.strftime("%Y-%m-%d") if _parsed else due_raw
            else:
                due_val = None
            task = Task(
                user_id=user_id,
                hat_id=hat_id,
                description=description,
                category=data.get('category', '').strip(),
                priority=data.get('priority', '').strip(),
                recurring=data.get('recurring', '').strip(),
                due=due_val,
                position=next_pos,
                duration=int(data['duration']) if data.get('duration') else 30,
                scheduled_time=data.get('scheduled_time') or None,
                scheduled_date=data.get('scheduled_date') or None,
                notes=data.get('notes') or None,
            )
            db.session.add(task)
            all_tasks.append(task)

        if not all_tasks:
            return jsonify({'error': 'No valid tasks to add'}), 400

        db.session.commit()
        return jsonify(all_tasks[-1].to_dict()), 201

    except Exception as e:
        db.session.rollback()
        return jsonify({'error': str(e)}), 500


@app.route('/api/tasks/<int:task_id>', methods=['PUT'])
@jwt_required()
def update_task(task_id):
    user_id = int(get_jwt_identity())
    task = Task.query.filter_by(id=task_id, user_id=user_id).first()
    if not task:
        return jsonify({'error': 'Task not found'}), 404

    data = request.json
    if 'description' in data:
        task.description = data['description']
    if 'category' in data:
        task.category = data.get('category', '')
    if 'priority' in data:
        task.priority = data.get('priority', '')
    if 'recurring' in data:
        task.recurring = data.get('recurring', '')
    if 'due' in data:
        due_text = data.get('due', '')
        if due_text:
            parsed = dateparser.parse(due_text)
            task.due = parsed.strftime("%Y-%m-%d") if parsed else due_text
        else:
            task.due = None
    if 'hat_id' in data:
        hat_id = data['hat_id']
        if hat_id:
            hat = Hat.query.filter_by(id=hat_id, user_id=user_id).first()
            task.hat_id = hat.id if hat else None
        else:
            task.hat_id = None
    if 'subtasks' in data:
        task.subtasks = json.dumps(data['subtasks'])
    if 'duration' in data:
        task.duration = int(data['duration']) if data['duration'] else 30
    if 'scheduled_time' in data:
        task.scheduled_time = data['scheduled_time'] or None
    if 'scheduled_date' in data:
        task.scheduled_date = data['scheduled_date'] or None
    if 'locked' in data:
        task.locked = bool(data.get('locked', False))
    if 'notes' in data:
        task.notes = data.get('notes') or None

    db.session.commit()
    return jsonify(task.to_dict())


@app.route('/api/tasks/<int:task_id>', methods=['DELETE'])
@jwt_required()
def delete_task(task_id):
    user_id = int(get_jwt_identity())
    task = Task.query.filter_by(id=task_id, user_id=user_id).first()
    if not task:
        return jsonify({'error': 'Task not found'}), 404

    task_dict = task.to_dict()
    db.session.delete(task)
    db.session.commit()
    return jsonify({'message': 'Task deleted', 'task': task_dict})


@app.route('/api/tasks/<int:task_id>/done', methods=['POST'])
@jwt_required()
def mark_task_done(task_id):
    user_id = int(get_jwt_identity())
    task = Task.query.filter_by(id=task_id, user_id=user_id).first()
    if not task:
        return jsonify({'error': 'Task not found'}), 404

    today = datetime.today().date()

    done_task = DoneTask(
        user_id=user_id,
        hat_id=task.hat_id,
        description=task.description,
        category=task.category,
        priority=task.priority,
        recurring=task.recurring,
        due=task.due,
        subtasks=task.subtasks,
        notes=task.notes,
        last_done=today.strftime("%Y-%m-%d") if task.recurring else None,
    )
    db.session.add(done_task)
    db.session.delete(task)

    # Respawn recurring tasks with next due date, subtasks reset to undone
    if task.recurring:
        if task.recurring == 'daily':
            next_due = today + timedelta(days=1)
        elif task.recurring == 'weekly':
            next_due = today + timedelta(weeks=1)
        elif task.recurring == 'monthly':
            # same day next month
            month = today.month + 1
            year = today.year + (month - 1) // 12
            month = ((month - 1) % 12) + 1
            import calendar
            day = min(today.day, calendar.monthrange(year, month)[1])
            next_due = today.replace(year=year, month=month, day=day)
        else:
            next_due = today + timedelta(days=1)

        # Reset all subtasks to undone
        try:
            subtask_list = json.loads(task.subtasks or '[]')
            reset_subtasks = json.dumps([{**s, 'done': False} for s in subtask_list])
        except Exception:
            reset_subtasks = '[]'

        max_pos = db.session.query(db.func.max(Task.position)).filter_by(user_id=user_id).scalar() or 0
        new_task = Task(
            user_id=user_id,
            hat_id=task.hat_id,
            description=task.description,
            category=task.category,
            priority=task.priority,
            recurring=task.recurring,
            due=next_due.strftime("%Y-%m-%d"),
            subtasks=reset_subtasks,
            duration=task.duration,
            position=max_pos + 1,
        )
        db.session.add(new_task)

    db.session.commit()
    return jsonify(done_task.to_dict())


@app.route('/api/tasks/done/<int:done_task_id>/restore', methods=['POST'])
@jwt_required()
def restore_done_task(done_task_id):
    user_id = int(get_jwt_identity())
    done_task = DoneTask.query.filter_by(id=done_task_id, user_id=user_id).first()
    if not done_task:
        return jsonify({'error': 'Task not found'}), 404

    task = Task(
        user_id=user_id,
        hat_id=done_task.hat_id,
        description=done_task.description,
        category=done_task.category,
        priority=done_task.priority,
        recurring=done_task.recurring,
        due=done_task.due,
        subtasks=done_task.subtasks,
        notes=done_task.notes,
    )
    db.session.add(task)
    db.session.delete(done_task)
    db.session.commit()
    return jsonify(task.to_dict())


@app.route('/api/tasks/done', methods=['GET'])
@jwt_required()
def get_done_tasks():
    user_id = int(get_jwt_identity())
    user = User.query.get(user_id)
    hat_id = request.args.get('hat_id', type=int)
    q = DoneTask.query.filter_by(user_id=user_id)
    if hat_id is not None:
        q = q.filter_by(hat_id=hat_id)
    # Archive gating: limit history by tier
    days = ARCHIVE_DAYS.get(user.tier if user else 'free', 30)
    if days is not None:
        cutoff = datetime.utcnow() - timedelta(days=days)
        q = q.filter(DoneTask.completed_at >= cutoff)
    done_tasks = q.order_by(DoneTask.completed_at.desc()).all()
    return jsonify([t.to_dict() for t in done_tasks])


@app.route('/api/tasks/categories', methods=['GET'])
@jwt_required()
def get_tasks_by_category():
    user_id = int(get_jwt_identity())
    hat_id = request.args.get('hat_id', type=int)
    q = Task.query.filter_by(user_id=user_id)
    if hat_id is not None:
        q = q.filter_by(hat_id=hat_id)
    tasks = q.order_by(Task.position, Task.id).all()
    from collections import defaultdict
    grouped = defaultdict(list)
    for task in tasks:
        category = task.category.strip() if task.category else "Uncategorized"
        grouped[category].append(task.to_dict())
    return jsonify(dict(grouped))


@app.route('/api/tasks/reorder', methods=['POST'])
@jwt_required()
def reorder_tasks():
    try:
        user_id = int(get_jwt_identity())
        data = request.json
        new_tasks = data.get('tasks', [])
        if not new_tasks:
            return jsonify({'error': 'No tasks provided'}), 400

        for position, task_data in enumerate(new_tasks):
            task_id = task_data.get('id')
            if task_id:
                task = Task.query.filter_by(id=task_id, user_id=user_id).first()
                if task:
                    task.position = position

        db.session.commit()
        tasks = Task.query.filter_by(user_id=user_id).order_by(Task.position, Task.id).all()
        return jsonify({'message': 'Tasks reordered successfully', 'tasks': [t.to_dict() for t in tasks]}), 200
    except Exception as e:
        db.session.rollback()
        return jsonify({'error': str(e)}), 500


# === Pomodoro count (premium) ===

@app.route('/api/tasks/<int:task_id>/pomodoro', methods=['POST'])
@jwt_required()
def increment_pomodoro(task_id):
    user_id = int(get_jwt_identity())
    user = db.session.get(User, user_id)
    if not user or user.tier != 'premium':
        return jsonify({'error': 'Premium subscription required'}), 403
    task = Task.query.filter_by(id=task_id, user_id=user_id).first()
    if not task:
        return jsonify({'error': 'Task not found'}), 404
    task.pomodoro_count = (task.pomodoro_count or 0) + 1
    db.session.commit()
    return jsonify({'pomodoro_count': task.pomodoro_count}), 200


# === Analytics Endpoint (premium) ===

@app.route('/api/analytics', methods=['GET'])
@jwt_required()
def get_analytics():
    from collections import defaultdict, Counter

    user_id = int(get_jwt_identity())
    user = User.query.get(user_id)
    if not user or user.tier != 'premium':
        return jsonify({'error': 'Premium required', 'upgrade_required': True}), 403

    today = datetime.utcnow().date()
    thirty_ago = datetime.utcnow() - timedelta(days=30)

    done_all = DoneTask.query.filter_by(user_id=user_id).all()
    done_30  = [d for d in done_all if d.completed_at and d.completed_at >= thirty_ago]
    active   = Task.query.filter_by(user_id=user_id).all()

    # Completions by day (last 30 days)
    by_day = defaultdict(int)
    for dt in done_30:
        by_day[dt.completed_at.date().isoformat()] += 1

    completed_by_day = [
        {'date': (today - timedelta(days=i)).isoformat(),
         'count': by_day.get((today - timedelta(days=i)).isoformat(), 0)}
        for i in range(29, -1, -1)
    ]

    # Category + priority breakdowns
    cat_done    = Counter(d.category or 'Uncategorized' for d in done_all)
    prio_done   = Counter(d.priority or '' for d in done_all)
    cat_active  = Counter(t.category or 'Uncategorized' for t in active)
    prio_active = Counter(t.priority or '' for t in active)

    # Streak (consecutive days ending today)
    streak = 0
    d = today
    while by_day.get(d.isoformat(), 0) > 0:
        streak += 1
        d -= timedelta(days=1)

    # Overdue
    today_str = today.isoformat()
    overdue = sum(1 for t in active if t.due and t.due < today_str)

    return jsonify({
        'total_completed': len(done_all),
        'completed_last_30': len(done_30),
        'completed_by_day': completed_by_day,
        'completed_by_category': dict(cat_done.most_common(10)),
        'active_by_category': dict(cat_active.most_common(10)),
        'completed_by_priority': dict(prio_done),
        'active_by_priority': dict(prio_active),
        'overdue_count': overdue,
        'avg_per_day': round(len(done_30) / 30, 1),
        'streak': streak,
    })


# === Export Endpoint (pro + premium) ===

@app.route('/api/export', methods=['GET'])
@jwt_required()
def export_tasks():
    import csv as csvmod, io as iomod

    user_id = int(get_jwt_identity())
    user = User.query.get(user_id)
    if not user or user.tier not in ('pro', 'premium'):
        return jsonify({'error': 'Pro or Premium required', 'upgrade_required': True}), 403

    fmt = request.args.get('format', 'json').lower()
    active = Task.query.filter_by(user_id=user_id).order_by(Task.position).all()
    done   = DoneTask.query.filter_by(user_id=user_id).order_by(DoneTask.completed_at.desc()).all()
    hats   = {h.id: h.name for h in Hat.query.filter_by(user_id=user_id).all()}

    def task_row(t, status):
        return {
            'status': status,
            'description': t.description,
            'notes': (t.notes or '').replace('\n', ' '),
            'category': t.category or '',
            'priority': t.priority or '',
            'recurring': t.recurring or '',
            'due': t.due or '',
            'hat': hats.get(t.hat_id, ''),
            'created_at': (t.created_at.isoformat() if hasattr(t, 'created_at') and t.created_at else ''),
            'completed_at': (t.completed_at.isoformat() if hasattr(t, 'completed_at') and t.completed_at else ''),
        }

    rows = [task_row(t, 'active') for t in active] + [task_row(t, 'completed') for t in done]

    if fmt == 'csv':
        out = iomod.StringIO()
        if rows:
            writer = csvmod.DictWriter(out, fieldnames=rows[0].keys())
            writer.writeheader()
            writer.writerows(rows)
        return Response(
            out.getvalue(),
            mimetype='text/csv',
            headers={'Content-Disposition': 'attachment; filename=madehappen-export.csv'},
        )
    return Response(
        json.dumps(rows, indent=2),
        mimetype='application/json',
        headers={'Content-Disposition': 'attachment; filename=madehappen-export.json'},
    )


# === Subscription Info (includes archive days) ===

# === Stripe Endpoints ===

@app.route('/api/stripe/tiers', methods=['GET'])
def get_tiers():
    return jsonify({
        tier: {
            'name': TIERS[tier]['name'],
            'price': TIERS[tier]['price'],
            'max_tasks': TIERS[tier]['max_tasks'],
            'features': TIER_FEATURES[tier],
        }
        for tier in TIERS
    })


@app.route('/api/stripe/create-checkout-session', methods=['POST'])
@jwt_required()
def create_checkout_session():
    if not stripe.api_key:
        return jsonify({'error': 'Stripe is not configured on the server. Contact the administrator.'}), 503

    try:
        user_id = int(get_jwt_identity())
        user = User.query.get(user_id)
        data = request.json
        tier = data.get('tier')

        price_map = {
            'pro':     os.getenv('STRIPE_PRO_PRICE_ID'),
            'premium': os.getenv('STRIPE_PREMIUM_PRICE_ID'),
        }
        price_id = price_map.get(tier)
        if not price_id:
            return jsonify({'error': 'Invalid tier selected'}), 400

        if not user.stripe_customer_id:
            customer = stripe.Customer.create(email=user.email, name=user.name)
            user.stripe_customer_id = customer.id
            db.session.commit()

        frontend_url = os.getenv('FRONTEND_URL', 'http://localhost:3000')
        session = stripe.checkout.Session.create(
            customer=user.stripe_customer_id,
            payment_method_types=['card'],
            line_items=[{'price': price_id, 'quantity': 1}],
            mode='subscription',
            success_url=f"{frontend_url}/?upgrade=success",
            cancel_url=f"{frontend_url}/pricing",
            metadata={'user_id': str(user_id), 'tier': tier},
        )
        return jsonify({'url': session.url})

    except stripe.error.StripeError as e:
        return jsonify({'error': str(e)}), 400


@app.route('/api/stripe/webhook', methods=['POST'])
def stripe_webhook():
    if not stripe.api_key:
        return jsonify({'error': 'Stripe not configured'}), 503

    payload = request.get_data()
    sig_header = request.headers.get('Stripe-Signature')
    webhook_secret = os.getenv('STRIPE_WEBHOOK_SECRET')

    try:
        event = stripe.Webhook.construct_event(payload, sig_header, webhook_secret)
    except (ValueError, stripe.error.SignatureVerificationError):
        return jsonify({'error': 'Invalid signature'}), 400

    event_type = event['type']

    if event_type == 'checkout.session.completed':
        session = event['data']['object']
        user_id = session['metadata'].get('user_id')
        tier = session['metadata'].get('tier')
        subscription_id = session.get('subscription')
        if user_id and tier:
            user = User.query.get(int(user_id))
            if user:
                user.tier = tier
                user.stripe_subscription_id = subscription_id
                db.session.commit()

    elif event_type in ('customer.subscription.deleted', 'customer.subscription.paused'):
        subscription = event['data']['object']
        user = User.query.filter_by(stripe_subscription_id=subscription['id']).first()
        if user:
            user.tier = 'free'
            user.stripe_subscription_id = None
            db.session.commit()

    return jsonify({'received': True})


@app.route('/api/stripe/subscription', methods=['GET'])
@jwt_required()
def get_subscription():
    user_id = int(get_jwt_identity())
    user = User.query.get(user_id)
    tier = user.tier
    active_count = Task.query.filter_by(user_id=user_id).count()
    max_tasks = TIERS[tier]['max_tasks']

    result = {
        'tier': tier,
        'tier_name': TIERS[tier]['name'],
        'price': TIERS[tier]['price'],
        'max_tasks': max_tasks,
        'active_task_count': active_count,
        'at_limit': (max_tasks is not None and active_count >= max_tasks),
        'has_subscription': bool(user.stripe_subscription_id),
    }

    if user.stripe_subscription_id and stripe.api_key:
        try:
            sub = stripe.Subscription.retrieve(user.stripe_subscription_id)
            result['subscription_status'] = sub.status
            result['current_period_end'] = sub.current_period_end
        except Exception:
            pass

    return jsonify(result)


_premium_users_applied = False


@app.route('/api/health', methods=['GET'])
def health():
    global _premium_users_applied
    if not _premium_users_applied:
        _premium_users_applied = True
        try:
            raw = os.environ.get("PREMIUM_USERS") or ""
            emails = [e.strip().lower() for e in raw.split(",") if e.strip()]
            print(f"[health/PREMIUM_USERS] env={raw!r}", flush=True)
            for email in emails:
                user = User.query.filter_by(email=email).first()
                if user is None:
                    print(f"[health/PREMIUM_USERS] no account for {email}", flush=True)
                elif user.tier != "premium":
                    user.tier = "premium"
                    db.session.commit()
                    print(f"[health/PREMIUM_USERS] upgraded {email} -> premium", flush=True)
                else:
                    print(f"[health/PREMIUM_USERS] {email} already premium", flush=True)
        except Exception as e:
            print(f"[health/PREMIUM_USERS] error: {e}", flush=True)
    # AI readiness booleans (no secrets) — lets a deployer see at a glance why
    # /api/chat and /api/coach might answer 503 "not configured".
    try:
        import anthropic as _anthropic_probe  # noqa: F401
        sdk_installed = True
    except ImportError:
        sdk_installed = False
    return jsonify({'status': 'ok', 'ai': {
        'sdk_installed': sdk_installed,
        'api_key_set': bool(os.getenv('ANTHROPIC_API_KEY')),
    }})


# === Admin endpoint (no Stripe required) ===
@app.route('/api/admin/set-tier', methods=['POST'])
def admin_set_tier():
    admin_key = os.getenv('ADMIN_SECRET_KEY')
    if not admin_key:
        return jsonify({'error': 'Admin access not configured'}), 403

    data = request.json or {}
    if data.get('admin_key') != admin_key:
        return jsonify({'error': 'Invalid admin key'}), 403

    email = data.get('email', '').strip().lower()
    tier = data.get('tier', 'premium')
    if tier not in TIERS:
        return jsonify({'error': f'Invalid tier. Choose: {list(TIERS.keys())}'}), 400

    user = User.query.filter_by(email=email).first()
    if not user:
        return jsonify({'error': f'No user found with email: {email}'}), 404

    user.tier = tier
    db.session.commit()
    return jsonify({'ok': True, 'email': user.email, 'tier': user.tier})


# === Calendar OAuth & Sync Endpoints (premium) ===

@app.route('/api/calendar/auth/<provider>', methods=['POST'])
@jwt_required()
def calendar_auth_start(provider):
    user_id = int(get_jwt_identity())
    user = db.session.get(User, user_id)
    if not user or user.tier != 'premium':
        return jsonify({'error': 'Premium subscription required'}), 403
    if provider not in ('google', 'microsoft'):
        return jsonify({'error': 'Provider must be google or microsoft'}), 400

    base_url = os.getenv('FRONTEND_URL', 'http://localhost:5001').rstrip('/')
    redirect_uri = f"{base_url}/api/calendar/callback/{provider}"
    state = _make_signed_token(str(user_id), 'cal-oauth-state')

    if provider == 'google':
        from google_auth_oauthlib.flow import Flow
        client_config = {
            'web': {
                'client_id': os.getenv('GOOGLE_CLIENT_ID', ''),
                'client_secret': os.getenv('GOOGLE_CLIENT_SECRET', ''),
                'auth_uri': 'https://accounts.google.com/o/oauth2/auth',
                'token_uri': 'https://oauth2.googleapis.com/token',
                'redirect_uris': [redirect_uri],
            }
        }
        flow = Flow.from_client_config(
            client_config,
            scopes=['https://www.googleapis.com/auth/calendar.events'],
            redirect_uri=redirect_uri,
        )
        auth_url, _ = flow.authorization_url(
            access_type='offline',
            include_granted_scopes='true',
            prompt='consent',
            state=state,
        )
        return jsonify({'url': auth_url})

    import msal
    authority = 'https://login.microsoftonline.com/common'
    app_ms = msal.ConfidentialClientApplication(
        os.getenv('MICROSOFT_CLIENT_ID', ''),
        authority=authority,
        client_credential=os.getenv('MICROSOFT_CLIENT_SECRET', ''),
    )
    auth_url = app_ms.get_authorization_request_url(
        scopes=['https://graph.microsoft.com/Calendars.ReadWrite', 'offline_access'],
        redirect_uri=redirect_uri,
        state=state,
    )
    return jsonify({'url': auth_url})


@app.route('/api/calendar/callback/<provider>', methods=['GET'])
def calendar_auth_callback(provider):
    frontend_url = os.getenv('FRONTEND_URL', 'http://localhost:3000').rstrip('/')
    error_redirect = f"{frontend_url}/app#calendar-connected?error=1"

    code = request.args.get('code')
    state = request.args.get('state', '')

    if not code:
        return redirect(error_redirect)

    try:
        user_id_str = _load_signed_token(state, 'cal-oauth-state', max_age=600)
        user_id = int(user_id_str)
    except Exception:
        return redirect(error_redirect)

    user = db.session.get(User, user_id)
    if not user:
        return redirect(error_redirect)

    base_url = os.getenv('FRONTEND_URL', 'http://localhost:5001').rstrip('/')
    redirect_uri = f"{base_url}/api/calendar/callback/{provider}"

    # Allow insecure transport in dev (Google rejects http:// otherwise)
    if not base_url.startswith('https://'):
        os.environ['OAUTHLIB_INSECURE_TRANSPORT'] = '1'

    try:
        if provider == 'google':
            from google_auth_oauthlib.flow import Flow
            client_config = {
                'web': {
                    'client_id': os.getenv('GOOGLE_CLIENT_ID', ''),
                    'client_secret': os.getenv('GOOGLE_CLIENT_SECRET', ''),
                    'auth_uri': 'https://accounts.google.com/o/oauth2/auth',
                    'token_uri': 'https://oauth2.googleapis.com/token',
                    'redirect_uris': [redirect_uri],
                }
            }
            flow = Flow.from_client_config(
                client_config,
                scopes=['https://www.googleapis.com/auth/calendar.events'],
                redirect_uri=redirect_uri,
            )
            flow.fetch_token(code=code)
            creds = flow.credentials
            conn = CalendarConnection.query.filter_by(user_id=user_id, provider='google').first()
            if not conn:
                conn = CalendarConnection(user_id=user_id, provider='google')
                db.session.add(conn)
            conn.access_token = creds.token
            conn.refresh_token = creds.refresh_token or getattr(conn, 'refresh_token', None) or ''
            conn.expires_at = creds.expiry

        elif provider == 'microsoft':
            import msal
            authority = 'https://login.microsoftonline.com/common'
            app_ms = msal.ConfidentialClientApplication(
                os.getenv('MICROSOFT_CLIENT_ID', ''),
                authority=authority,
                client_credential=os.getenv('MICROSOFT_CLIENT_SECRET', ''),
            )
            result = app_ms.acquire_token_by_authorization_code(
                code=code,
                scopes=['https://graph.microsoft.com/Calendars.ReadWrite', 'offline_access'],
                redirect_uri=redirect_uri,
            )
            if 'access_token' not in result:
                app.logger.error('MS token exchange failed: %s', result.get('error_description'))
                return redirect(error_redirect)
            conn = CalendarConnection.query.filter_by(user_id=user_id, provider='microsoft').first()
            if not conn:
                conn = CalendarConnection(user_id=user_id, provider='microsoft')
                db.session.add(conn)
            conn.access_token = result['access_token']
            conn.refresh_token = result.get('refresh_token', conn.refresh_token if conn.id else '')
            conn.expires_at = datetime.utcnow() + timedelta(seconds=result.get('expires_in', 3600))
        else:
            return redirect(error_redirect)

        db.session.commit()
        return redirect(f"{frontend_url}/app#calendar-connected?provider={provider}")

    except Exception as exc:
        app.logger.error('Calendar auth callback error (%s): %s', provider, exc)
        return redirect(error_redirect)


@app.route('/api/calendar/connections', methods=['GET'])
@jwt_required()
def get_calendar_connections():
    user_id = int(get_jwt_identity())
    connections = CalendarConnection.query.filter_by(user_id=user_id).all()
    return jsonify([c.to_dict() for c in connections])


@app.route('/api/calendar/push', methods=['POST'])
@jwt_required()
def calendar_push():
    user_id = int(get_jwt_identity())
    user = db.session.get(User, user_id)
    if not user or user.tier != 'premium':
        return jsonify({'error': 'Premium subscription required'}), 403

    connections = CalendarConnection.query.filter_by(user_id=user_id).all()
    if not connections:
        return jsonify({'error': 'No calendar connected', 'no_connection': True}), 400

    data = request.json or {}
    timezone = data.get('timezone', 'UTC')
    task_ids = data.get('task_ids')

    q = Task.query.filter_by(user_id=user_id).filter(
        Task.scheduled_date.isnot(None),
        Task.scheduled_time.isnot(None),
    )
    if task_ids:
        q = q.filter(Task.id.in_(task_ids))
    tasks_to_sync = q.all()

    pushed = 0
    errors = []
    for task in tasks_to_sync:
        for conn in connections:
            try:
                if conn.provider == 'google':
                    event_id = _google_push(task, conn, timezone)
                    task.gcal_event_id = event_id
                elif conn.provider == 'microsoft':
                    event_id = _ms_push(task, conn, timezone)
                    task.ms_event_id = event_id
                pushed += 1
            except Exception as exc:
                errors.append({'task_id': task.id, 'provider': conn.provider, 'error': str(exc)})

    db.session.commit()
    return jsonify({'pushed': pushed, 'errors': errors, 'tasks': [t.to_dict() for t in tasks_to_sync]})


@app.route('/api/calendar/disconnect/<provider>', methods=['DELETE'])
@jwt_required()
def calendar_disconnect(provider):
    user_id = int(get_jwt_identity())
    conn = CalendarConnection.query.filter_by(user_id=user_id, provider=provider).first()
    if not conn:
        return jsonify({'error': 'Not connected'}), 404

    if provider == 'google':
        Task.query.filter_by(user_id=user_id).filter(
            Task.gcal_event_id.isnot(None)
        ).update({'gcal_event_id': None})
    elif provider == 'microsoft':
        Task.query.filter_by(user_id=user_id).filter(
            Task.ms_event_id.isnot(None)
        ).update({'ms_event_id': None})

    db.session.delete(conn)
    db.session.commit()
    return jsonify({'message': f'Disconnected {provider}'})


@app.route('/api/calendar/event/<int:task_id>', methods=['DELETE'])
@jwt_required()
def calendar_delete_event(task_id):
    user_id = int(get_jwt_identity())
    task = Task.query.filter_by(id=task_id, user_id=user_id).first()
    if not task:
        return jsonify({'error': 'Task not found'}), 404

    connections = CalendarConnection.query.filter_by(user_id=user_id).all()
    for conn in connections:
        try:
            if conn.provider == 'google' and task.gcal_event_id:
                _google_delete(task, conn)
            elif conn.provider == 'microsoft' and task.ms_event_id:
                _ms_delete(task, conn)
        except Exception:
            pass

    db.session.commit()
    return jsonify({'task': task.to_dict()})


# === AI Chat Endpoints ===

def _chat_service():
    """Build a TaskChatService bound to this app's models/helpers, or None if the
    feature isn't configured (missing SDK or ANTHROPIC_API_KEY)."""
    try:
        from ai_chat import TaskChatService, chat_available
    except ImportError:
        import importlib.util as _ilu
        _spec = _ilu.spec_from_file_location(
            'ai_chat', os.path.join(BASE_DIR, 'ai_chat.py')
        )
        _mod = _ilu.module_from_spec(_spec)
        _spec.loader.exec_module(_mod)
        TaskChatService, chat_available = _mod.TaskChatService, _mod.chat_available
    if not chat_available():
        return None
    return TaskChatService(db, Task, Hat, ChatUndo, check_task_limit,
                           CoachMemory=CoachMemory)


@app.route('/api/chat', methods=['POST'])
@jwt_required()
@limiter.limit('30 per minute')
def ai_chat():
    service = _chat_service()
    if service is None:
        return jsonify({'error': 'AI chat is not configured on this server.',
                        'unavailable': True}), 503

    user_id = int(get_jwt_identity())
    user = User.query.get(user_id)
    if not user:
        return jsonify({'error': 'User not found'}), 404

    data = request.json or {}
    message = (data.get('message') or '').strip()
    if not message:
        return jsonify({'error': 'Message is required'}), 400
    hat_id = data.get('hat_id') or None
    history = data.get('history') or []

    try:
        result = service.run(user, hat_id, message, history)
        return jsonify(result)
    except Exception as e:
        db.session.rollback()
        app.logger.exception('AI chat failed')
        return jsonify({'error': f'AI chat failed: {e}'}), 500


@app.route('/api/chat/undo', methods=['POST'])
@jwt_required()
def ai_chat_undo():
    service = _chat_service()
    if service is None:
        return jsonify({'error': 'AI chat is not configured on this server.',
                        'unavailable': True}), 503

    user_id = int(get_jwt_identity())
    user = User.query.get(user_id)
    if not user:
        return jsonify({'error': 'User not found'}), 404

    data = request.json or {}
    undo_token = data.get('undo_token')
    try:
        result = service.undo(user, undo_token)
        return jsonify(result)
    except Exception as e:
        db.session.rollback()
        app.logger.exception('AI chat undo failed')
        return jsonify({'error': f'Undo failed: {e}'}), 500


# === AI Coaching Hub Endpoints ===

def _coaching_service():
    """Build a CoachingService bound to this app's models/helpers, or None if the
    feature isn't configured (missing SDK or ANTHROPIC_API_KEY)."""
    try:
        from coaching import CoachingService, coaching_available
    except ImportError:
        import importlib.util as _ilu
        _spec = _ilu.spec_from_file_location(
            'coaching', os.path.join(BASE_DIR, 'coaching.py')
        )
        _mod = _ilu.module_from_spec(_spec)
        _spec.loader.exec_module(_mod)
        CoachingService, coaching_available = _mod.CoachingService, _mod.coaching_available
    if not coaching_available():
        return None
    return CoachingService(db, Task, Hat, check_task_limit,
                           CoachMemory=CoachMemory)


@app.route('/api/coach', methods=['POST'])
@jwt_required()
@limiter.limit('30 per minute')
def ai_coach():
    service = _coaching_service()
    if service is None:
        return jsonify({'error': 'AI coaching is not configured on this server.',
                        'unavailable': True}), 503

    user_id = int(get_jwt_identity())
    user = User.query.get(user_id)
    if not user:
        return jsonify({'error': 'User not found'}), 404

    data = request.json or {}
    coach_id = (data.get('coach_id') or '').strip()
    message = (data.get('message') or '').strip()
    if not coach_id:
        return jsonify({'error': 'coach_id is required'}), 400
    if not message:
        return jsonify({'error': 'Message is required'}), 400
    hat_id = data.get('hat_id') or None
    history = data.get('history') or []

    try:
        result = service.run(user, coach_id, message, history, hat_id)
        return jsonify(result)
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    except Exception as e:
        db.session.rollback()
        app.logger.exception('AI coaching failed')
        return jsonify({'error': f'AI coaching failed: {e}'}), 500


# === AI memory (user-visible, user-controlled) ===

@app.route('/api/coach/memory', methods=['GET'])
@jwt_required()
def coach_memory_list():
    user_id = int(get_jwt_identity())
    notes = (CoachMemory.query.filter_by(user_id=user_id)
             .order_by(CoachMemory.created_at.desc(), CoachMemory.id.desc()).all())
    return jsonify([n.to_dict() for n in notes])


@app.route('/api/coach/memory/<int:memory_id>', methods=['DELETE'])
@jwt_required()
def coach_memory_delete(memory_id):
    user_id = int(get_jwt_identity())
    note = CoachMemory.query.filter_by(id=memory_id, user_id=user_id).first()
    if not note:
        return jsonify({'error': 'Memory not found'}), 404
    db.session.delete(note)
    db.session.commit()
    return jsonify({'deleted': True})


@app.route('/api/coach/memory', methods=['DELETE'])
@jwt_required()
def coach_memory_clear():
    user_id = int(get_jwt_identity())
    count = CoachMemory.query.filter_by(user_id=user_id).delete()
    db.session.commit()
    return jsonify({'deleted': True, 'count': count})


def migrate_db():
    # Each statement runs in its own connection/transaction so a "column already
    # exists" failure on one doesn't abort and roll back the others (PostgreSQL
    # marks the whole transaction as aborted on any error).
    with app.app_context():
        db.create_all()   # creates any tables not yet in the DB (safe, idempotent)
        for stmt in [
            'ALTER TABLE task ADD COLUMN duration INTEGER DEFAULT 30',
            'ALTER TABLE task ADD COLUMN scheduled_time VARCHAR(5)',
            'ALTER TABLE task ADD COLUMN scheduled_date VARCHAR(10)',
            'ALTER TABLE task ADD COLUMN locked BOOLEAN DEFAULT FALSE',
            'ALTER TABLE task ADD COLUMN notes TEXT',
            'ALTER TABLE done_task ADD COLUMN notes TEXT',
            'ALTER TABLE task ADD COLUMN pomodoro_count INTEGER DEFAULT 0',
            'ALTER TABLE "user" ADD COLUMN email_verified BOOLEAN DEFAULT FALSE',
            'ALTER TABLE task ADD COLUMN gcal_event_id VARCHAR(200)',
            'ALTER TABLE task ADD COLUMN ms_event_id VARCHAR(200)',
        ]:
            try:
                with db.engine.connect() as conn:
                    conn.execute(text(stmt))
                    conn.commit()
            except Exception:
                pass  # column already exists


_FRONTEND_BUILD = os.path.join(BASE_DIR, '..', 'frontend', 'build')
_HOMEPAGE_DIR   = os.path.join(BASE_DIR, '..', 'homepage')

@app.route('/robots.txt')
def robots_txt():
    return Response(
        'User-agent: *\nAllow: /\nDisallow: /api/\n',
        mimetype='text/plain',
    )

@app.route('/.well-known/security.txt')
def security_txt():
    contact = os.getenv('SECURITY_CONTACT', 'security@madehappen.app')
    canonical = os.getenv('FRONTEND_URL', 'https://madehappen.app')
    body = (
        f'Contact: mailto:{contact}\n'
        f'Canonical: {canonical}/.well-known/security.txt\n'
        'Preferred-Languages: en\n'
    )
    return Response(body, mimetype='text/plain')

@app.route('/')
def serve_homepage():
    return send_from_directory(_HOMEPAGE_DIR, 'index.html')

@app.route('/<path:path>')
def serve_frontend(path):
    # Never serve HTML for API paths — an /api/* URL landing here means the
    # route doesn't exist on this build (e.g. frontend newer than backend).
    if path == 'api' or path.startswith('api/'):
        return jsonify({
            'error': 'Unknown API endpoint. The server may be running an '
                     'older version — check the backend deployment.',
        }), 404
    full = os.path.join(_FRONTEND_BUILD, path)
    if os.path.isfile(full):
        return send_from_directory(_FRONTEND_BUILD, path)
    return send_from_directory(_FRONTEND_BUILD, 'app.html')


if __name__ == '__main__':
    with app.app_context():
        db.create_all()
    migrate_db()
    app.run(debug=True, port=5001)
