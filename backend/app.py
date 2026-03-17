from flask import Flask, request, jsonify, Response
from flask_cors import CORS
from flask_sqlalchemy import SQLAlchemy
from flask_jwt_extended import (
    JWTManager, create_access_token, jwt_required, get_jwt_identity
)
from werkzeug.security import generate_password_hash, check_password_hash
import os
import re
import json
import csv
import io
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from datetime import datetime, timedelta, date
import dateparser
import stripe
from dotenv import load_dotenv
from apscheduler.schedulers.background import BackgroundScheduler
import atexit

load_dotenv()

app = Flask(__name__)
CORS(app)

# --- Configuration ---
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
app.config['SQLALCHEMY_DATABASE_URI'] = f"sqlite:///{os.path.join(BASE_DIR, 'ztd.db')}"
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.config['JWT_SECRET_KEY'] = os.getenv('JWT_SECRET_KEY', 'dev-secret-change-in-production')
app.config['JWT_ACCESS_TOKEN_EXPIRES'] = timedelta(days=30)

db = SQLAlchemy(app)
jwt = JWTManager(app)

stripe.api_key = os.getenv('STRIPE_SECRET_KEY', '')

# --- Membership Tiers ---
TIERS = {
    'free':    {'name': 'Free',    'max_tasks': 10,   'price': 0},
    'premium': {'name': 'Premium', 'max_tasks': None,  'price': 6},
}

TIER_FEATURES = {
    'free': [
        'Up to 10 active tasks',
        'All categories & priorities',
        'Drag & drop reordering',
        '30-day completed history',
    ],
    'premium': [
        'Unlimited active tasks',
        'Task notes',
        'Sub-task priorities & categories',
        'Pomodoro timer',
        'Email reminders',
        'My Day / Key Tasks view',
        'Trash & 30-day undo',
        'Unlimited completed history',
        'Data export (CSV & JSON)',
    ],
}


def is_premium(user):
    return user.tier == 'premium'


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

    tasks = db.relationship('Task', backref='user', lazy=True, cascade='all, delete-orphan')
    done_tasks = db.relationship('DoneTask', backref='user', lazy=True, cascade='all, delete-orphan')
    hats = db.relationship('Hat', backref='user', lazy=True, cascade='all, delete-orphan')

    def to_dict(self):
        return {
            'id': self.id,
            'email': self.email,
            'name': self.name,
            'tier': self.tier,
            'tier_name': TIERS.get(self.tier, TIERS['free'])['name'],
            'created_at': self.created_at.isoformat(),
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
    subtasks = db.Column(db.Text, default='[]')   # JSON: [{id, text, done, priority?, category?}]
    notes = db.Column(db.Text, default='')
    deleted_at = db.Column(db.DateTime, nullable=True)
    reminder_at = db.Column(db.DateTime, nullable=True)
    reminder_sent = db.Column(db.Boolean, default=False)
    is_key_task = db.Column(db.Boolean, default=False)
    key_task_date = db.Column(db.Date, nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    def subtasks_list(self):
        try:
            return json.loads(self.subtasks or '[]')
        except Exception:
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
            'notes': self.notes or '',
            'deleted_at': self.deleted_at.isoformat() if self.deleted_at else None,
            'reminder_at': self.reminder_at.isoformat() if self.reminder_at else None,
            'is_key_task': bool(self.is_key_task),
            'key_task_date': self.key_task_date.isoformat() if self.key_task_date else None,
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
    notes = db.Column(db.Text, default='')
    completed_at = db.Column(db.DateTime, default=datetime.utcnow)

    def subtasks_list(self):
        try:
            return json.loads(self.subtasks or '[]')
        except Exception:
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
            'notes': self.notes or '',
            'completed_at': self.completed_at.isoformat(),
        }


# --- DB Migration ---
def migrate_db():
    """Add new columns to existing tables if they don't exist."""
    import sqlite3
    db_path = os.path.join(BASE_DIR, 'ztd.db')
    if not os.path.exists(db_path):
        return
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()

    cursor.execute("PRAGMA table_info(task)")
    task_cols = {row[1] for row in cursor.fetchall()}
    task_additions = [
        ("notes", "TEXT DEFAULT ''"),
        ("deleted_at", "DATETIME"),
        ("reminder_at", "DATETIME"),
        ("reminder_sent", "BOOLEAN DEFAULT 0"),
        ("is_key_task", "BOOLEAN DEFAULT 0"),
        ("key_task_date", "DATE"),
    ]
    for col, col_type in task_additions:
        if col not in task_cols:
            cursor.execute(f"ALTER TABLE task ADD COLUMN {col} {col_type}")

    cursor.execute("PRAGMA table_info(done_task)")
    done_cols = {row[1] for row in cursor.fetchall()}
    if 'notes' not in done_cols:
        cursor.execute("ALTER TABLE done_task ADD COLUMN notes TEXT DEFAULT ''")

    conn.commit()
    conn.close()


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
    limit = TIERS.get(user.tier, TIERS['free'])['max_tasks']
    if limit is None:
        return None
    count = Task.query.filter_by(user_id=user.id).filter(Task.deleted_at == None).count()
    if count >= limit:
        return {
            'error': f'Task limit reached. The Free tier allows {limit} tasks. Upgrade to Premium for unlimited tasks.',
            'upgrade_required': True,
            'current_tier': user.tier,
        }
    return None


def send_reminder_email(to_email, to_name, task_description):
    smtp_host = os.getenv('SMTP_HOST')
    smtp_port = int(os.getenv('SMTP_PORT', '587'))
    smtp_user = os.getenv('SMTP_USER')
    smtp_pass = os.getenv('SMTP_PASS')
    smtp_from = os.getenv('SMTP_FROM', smtp_user)

    if not smtp_host or not smtp_user:
        return False

    try:
        msg = MIMEMultipart('alternative')
        msg['Subject'] = f'Reminder: {task_description}'
        msg['From'] = smtp_from
        msg['To'] = to_email

        body_text = f"Hi {to_name},\n\nThis is your reminder for:\n\n  {task_description}\n\nLog in to FocusFlow to complete it.\n"
        body_html = f"""<html><body>
        <p>Hi {to_name},</p>
        <p>This is your reminder for:</p>
        <blockquote style="font-size:1.1em;font-weight:bold;">{task_description}</blockquote>
        <p><a href="{os.getenv('FRONTEND_URL','http://localhost:3000')}">Open FocusFlow</a></p>
        </body></html>"""

        msg.attach(MIMEText(body_text, 'plain'))
        msg.attach(MIMEText(body_html, 'html'))

        with smtplib.SMTP(smtp_host, smtp_port) as server:
            server.starttls()
            server.login(smtp_user, smtp_pass)
            server.sendmail(smtp_from, to_email, msg.as_string())
        return True
    except Exception as e:
        print(f'[email] Failed to send reminder: {e}')
        return False


# --- Scheduler Jobs ---
def job_send_reminders():
    with app.app_context():
        now = datetime.utcnow()
        window = now + timedelta(minutes=1)
        tasks = Task.query.filter(
            Task.reminder_at != None,
            Task.reminder_at <= window,
            Task.reminder_sent == False,
            Task.deleted_at == None,
        ).all()
        for task in tasks:
            user = User.query.get(task.user_id)
            if user and is_premium(user):
                send_reminder_email(user.email, user.name, task.description)
            task.reminder_sent = True
        if tasks:
            db.session.commit()


def job_nightly():
    with app.app_context():
        today = date.today()
        yesterday = today - timedelta(days=1)

        # Clear key task flags from previous days
        Task.query.filter(
            Task.is_key_task == True,
            Task.key_task_date != None,
            Task.key_task_date < today,
        ).update({'is_key_task': False, 'key_task_date': None})

        # Purge trash older than 30 days
        cutoff = datetime.utcnow() - timedelta(days=30)
        Task.query.filter(
            Task.deleted_at != None,
            Task.deleted_at < cutoff,
        ).delete()

        # Purge completed tasks older than 30 days for free users
        free_users = User.query.filter_by(tier='free').all()
        for user in free_users:
            DoneTask.query.filter(
                DoneTask.user_id == user.id,
                DoneTask.completed_at < (datetime.utcnow() - timedelta(days=30)),
            ).delete()

        db.session.commit()


# === Auth Endpoints ===

@app.route('/api/auth/register', methods=['POST'])
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
    db.session.commit()

    token = create_access_token(identity=user.id)
    return jsonify({'token': token, 'user': user.to_dict()}), 201


@app.route('/api/auth/login', methods=['POST'])
def login():
    data = request.json
    if not data or not data.get('email') or not data.get('password'):
        return jsonify({'error': 'Email and password are required'}), 400

    email = data['email'].lower().strip()
    user = User.query.filter_by(email=email).first()

    if not user or not check_password_hash(user.password_hash, data['password']):
        return jsonify({'error': 'Invalid email or password'}), 401

    token = create_access_token(identity=user.id)
    return jsonify({'token': token, 'user': user.to_dict()})


@app.route('/api/auth/me', methods=['GET'])
@jwt_required()
def get_me():
    user_id = get_jwt_identity()
    user = User.query.get(user_id)
    if not user:
        return jsonify({'error': 'User not found'}), 404
    return jsonify(user.to_dict())


# === Hat Endpoints ===

@app.route('/api/hats', methods=['GET'])
@jwt_required()
def get_hats():
    user_id = get_jwt_identity()
    hats = Hat.query.filter_by(user_id=user_id).order_by(Hat.position, Hat.id).all()
    return jsonify([h.to_dict() for h in hats])


@app.route('/api/hats', methods=['POST'])
@jwt_required()
def create_hat():
    user_id = get_jwt_identity()
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
    user_id = get_jwt_identity()
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
    user_id = get_jwt_identity()
    hat = Hat.query.filter_by(id=hat_id, user_id=user_id).first()
    if not hat:
        return jsonify({'error': 'Hat not found'}), 404

    Task.query.filter_by(hat_id=hat_id, user_id=user_id).update({'hat_id': None})
    DoneTask.query.filter_by(hat_id=hat_id, user_id=user_id).update({'hat_id': None})

    db.session.delete(hat)
    db.session.commit()
    return jsonify({'message': 'Hat deleted'})


@app.route('/api/hats/reorder', methods=['POST'])
@jwt_required()
def reorder_hats():
    user_id = get_jwt_identity()
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
    user_id = get_jwt_identity()
    hat_id = request.args.get('hat_id', type=int)
    q = Task.query.filter_by(user_id=user_id).filter(Task.deleted_at == None)
    if hat_id is not None:
        q = q.filter_by(hat_id=hat_id)
    tasks = q.order_by(Task.position, Task.id).all()
    return jsonify([t.to_dict() for t in tasks])


@app.route('/api/tasks', methods=['POST'])
@jwt_required()
def add_task():
    try:
        user_id = get_jwt_identity()
        user = User.query.get(user_id)
        data = request.json

        if not data:
            return jsonify({'error': 'No data provided'}), 400

        limit_error = check_task_limit(user)
        if limit_error:
            return jsonify(limit_error), 403

        hat_id = data.get('hat_id') or None
        if hat_id:
            hat = Hat.query.filter_by(id=hat_id, user_id=user_id).first()
            if not hat:
                hat_id = None

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

            reminder_at = None
            reminder_at_str = data.get('reminder_at', '')
            if reminder_at_str and is_premium(user):
                try:
                    reminder_at = datetime.fromisoformat(reminder_at_str)
                except Exception:
                    pass

            task = Task(
                user_id=user_id,
                hat_id=hat_id,
                description=description,
                category=data.get('category', '').strip(),
                priority=data.get('priority', '').strip(),
                recurring=data.get('recurring', '').strip(),
                due=data.get('due', '') or None,
                notes=data.get('notes', '') if is_premium(user) else '',
                reminder_at=reminder_at,
                position=next_pos,
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
    user_id = get_jwt_identity()
    user = User.query.get(user_id)
    task = Task.query.filter_by(id=task_id, user_id=user_id).filter(Task.deleted_at == None).first()
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
    if 'notes' in data and is_premium(user):
        task.notes = data['notes']
    if 'reminder_at' in data and is_premium(user):
        reminder_at_str = data.get('reminder_at', '')
        if reminder_at_str:
            try:
                task.reminder_at = datetime.fromisoformat(reminder_at_str)
                task.reminder_sent = False
            except Exception:
                pass
        else:
            task.reminder_at = None
            task.reminder_sent = False

    db.session.commit()
    return jsonify(task.to_dict())


@app.route('/api/tasks/<int:task_id>', methods=['DELETE'])
@jwt_required()
def delete_task(task_id):
    user_id = get_jwt_identity()
    user = User.query.get(user_id)
    task = Task.query.filter_by(id=task_id, user_id=user_id).filter(Task.deleted_at == None).first()
    if not task:
        return jsonify({'error': 'Task not found'}), 404

    task_dict = task.to_dict()
    if is_premium(user):
        # Soft delete — moves to trash
        task.deleted_at = datetime.utcnow()
        db.session.commit()
    else:
        db.session.delete(task)
        db.session.commit()
    return jsonify({'message': 'Task deleted', 'task': task_dict})


@app.route('/api/tasks/<int:task_id>/done', methods=['POST'])
@jwt_required()
def mark_task_done(task_id):
    user_id = get_jwt_identity()
    task = Task.query.filter_by(id=task_id, user_id=user_id).filter(Task.deleted_at == None).first()
    if not task:
        return jsonify({'error': 'Task not found'}), 404

    done_task = DoneTask(
        user_id=user_id,
        hat_id=task.hat_id,
        description=task.description,
        category=task.category,
        priority=task.priority,
        recurring=task.recurring,
        due=task.due,
        subtasks=task.subtasks,
        notes=task.notes or '',
        last_done=datetime.today().strftime("%Y-%m-%d") if task.recurring else None,
    )
    db.session.add(done_task)
    db.session.delete(task)
    db.session.commit()
    return jsonify(done_task.to_dict())


@app.route('/api/tasks/done', methods=['GET'])
@jwt_required()
def get_done_tasks():
    user_id = get_jwt_identity()
    hat_id = request.args.get('hat_id', type=int)
    q = DoneTask.query.filter_by(user_id=user_id)
    if hat_id is not None:
        q = q.filter_by(hat_id=hat_id)
    done_tasks = q.order_by(DoneTask.completed_at.desc()).all()
    return jsonify([t.to_dict() for t in done_tasks])


@app.route('/api/tasks/categories', methods=['GET'])
@jwt_required()
def get_tasks_by_category():
    user_id = get_jwt_identity()
    hat_id = request.args.get('hat_id', type=int)
    q = Task.query.filter_by(user_id=user_id).filter(Task.deleted_at == None)
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
        user_id = get_jwt_identity()
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
        tasks = Task.query.filter_by(user_id=user_id).filter(Task.deleted_at == None).order_by(Task.position, Task.id).all()
        return jsonify({'message': 'Tasks reordered successfully', 'tasks': [t.to_dict() for t in tasks]}), 200
    except Exception as e:
        db.session.rollback()
        return jsonify({'error': str(e)}), 500


# === Trash Endpoints (Premium) ===

@app.route('/api/tasks/trash', methods=['GET'])
@jwt_required()
def get_trash():
    user_id = get_jwt_identity()
    user = User.query.get(user_id)
    if not is_premium(user):
        return jsonify({'error': 'Trash requires a Premium subscription'}), 403
    tasks = Task.query.filter_by(user_id=user_id).filter(Task.deleted_at != None).order_by(Task.deleted_at.desc()).all()
    return jsonify([t.to_dict() for t in tasks])


@app.route('/api/tasks/<int:task_id>/restore', methods=['POST'])
@jwt_required()
def restore_task(task_id):
    user_id = get_jwt_identity()
    user = User.query.get(user_id)
    if not is_premium(user):
        return jsonify({'error': 'Restore requires a Premium subscription'}), 403
    task = Task.query.filter_by(id=task_id, user_id=user_id).filter(Task.deleted_at != None).first()
    if not task:
        return jsonify({'error': 'Task not found in trash'}), 404
    task.deleted_at = None
    db.session.commit()
    return jsonify(task.to_dict())


@app.route('/api/tasks/<int:task_id>/permanent', methods=['DELETE'])
@jwt_required()
def permanent_delete_task(task_id):
    user_id = get_jwt_identity()
    user = User.query.get(user_id)
    if not is_premium(user):
        return jsonify({'error': 'Requires a Premium subscription'}), 403
    task = Task.query.filter_by(id=task_id, user_id=user_id).filter(Task.deleted_at != None).first()
    if not task:
        return jsonify({'error': 'Task not found in trash'}), 404
    db.session.delete(task)
    db.session.commit()
    return jsonify({'message': 'Task permanently deleted'})


# === Key Tasks Endpoint (Premium) ===

@app.route('/api/tasks/<int:task_id>/key-task', methods=['PUT'])
@jwt_required()
def toggle_key_task(task_id):
    user_id = get_jwt_identity()
    user = User.query.get(user_id)
    if not is_premium(user):
        return jsonify({'error': 'Key Tasks requires a Premium subscription'}), 403

    task = Task.query.filter_by(id=task_id, user_id=user_id).filter(Task.deleted_at == None).first()
    if not task:
        return jsonify({'error': 'Task not found'}), 404

    today = date.today()

    if task.is_key_task:
        # Remove key task flag
        task.is_key_task = False
        task.key_task_date = None
    else:
        # Check max 3 key tasks per day
        today_count = Task.query.filter_by(
            user_id=user_id, is_key_task=True, key_task_date=today
        ).filter(Task.deleted_at == None).count()
        if today_count >= 3:
            return jsonify({'error': 'You can only have 3 Key Tasks per day'}), 400
        task.is_key_task = True
        task.key_task_date = today

    db.session.commit()
    return jsonify(task.to_dict())


# === Export Endpoint (Premium) ===

@app.route('/api/export', methods=['GET'])
@jwt_required()
def export_tasks():
    user_id = get_jwt_identity()
    user = User.query.get(user_id)
    if not is_premium(user):
        return jsonify({'error': 'Export requires a Premium subscription'}), 403

    fmt = request.args.get('format', 'json').lower()
    hat_id = request.args.get('hat_id', type=int)

    active_q = Task.query.filter_by(user_id=user_id).filter(Task.deleted_at == None)
    done_q = DoneTask.query.filter_by(user_id=user_id)
    if hat_id is not None:
        active_q = active_q.filter_by(hat_id=hat_id)
        done_q = done_q.filter_by(hat_id=hat_id)

    active_tasks = [t.to_dict() for t in active_q.order_by(Task.position).all()]
    done_tasks = [t.to_dict() for t in done_q.order_by(DoneTask.completed_at.desc()).all()]

    if fmt == 'csv':
        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(['status', 'description', 'category', 'priority', 'recurring', 'due', 'notes', 'completed_at'])
        for t in active_tasks:
            writer.writerow(['active', t['description'], t['category'], t['priority'], t['recurring'], t['due'] or '', t['notes'], ''])
        for t in done_tasks:
            writer.writerow(['completed', t['description'], t['category'], t['priority'], t['recurring'], t['due'] or '', t['notes'], t['completed_at']])
        output.seek(0)
        return Response(
            output.getvalue(),
            mimetype='text/csv',
            headers={'Content-Disposition': 'attachment; filename=ztd_tasks.csv'},
        )
    else:
        payload = json.dumps({'active': active_tasks, 'completed': done_tasks}, indent=2)
        return Response(
            payload,
            mimetype='application/json',
            headers={'Content-Disposition': 'attachment; filename=ztd_tasks.json'},
        )


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
        user_id = get_jwt_identity()
        user = User.query.get(user_id)
        data = request.json
        tier = data.get('tier')

        price_map = {
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
        if user_id and tier and tier in TIERS:
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
    user_id = get_jwt_identity()
    user = User.query.get(user_id)
    tier = user.tier if user.tier in TIERS else 'free'
    active_count = Task.query.filter_by(user_id=user_id).filter(Task.deleted_at == None).count()
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


@app.route('/api/health', methods=['GET'])
def health():
    return jsonify({'status': 'ok'})


if __name__ == '__main__':
    with app.app_context():
        migrate_db()
        db.create_all()

    scheduler = BackgroundScheduler()
    scheduler.add_job(job_send_reminders, 'interval', minutes=1)
    scheduler.add_job(job_nightly, 'cron', hour=0, minute=0)
    scheduler.start()
    atexit.register(lambda: scheduler.shutdown())

    app.run(debug=True, port=5001)
