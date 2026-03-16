from flask import Flask, request, jsonify
from flask_cors import CORS
from flask_sqlalchemy import SQLAlchemy
from flask_jwt_extended import (
    JWTManager, create_access_token, jwt_required, get_jwt_identity
)
from werkzeug.security import generate_password_hash, check_password_hash
import os
import re
from datetime import datetime, timedelta
import dateparser
import stripe
from dotenv import load_dotenv

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
    'pro':     {'name': 'Pro',     'max_tasks': None,  'price': 9},
    'premium': {'name': 'Premium', 'max_tasks': None,  'price': 19},
}

TIER_FEATURES = {
    'free':    ['Up to 10 active tasks', 'All categories & priorities', 'Drag & drop reordering'],
    'pro':     ['Unlimited tasks', 'All Free features', 'Recurring tasks', 'Email reminders'],
    'premium': ['Everything in Pro', 'Priority support', 'Advanced analytics', 'Team sharing (coming soon)'],
}


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

    def to_dict(self):
        return {
            'id': self.id,
            'email': self.email,
            'name': self.name,
            'tier': self.tier,
            'tier_name': TIERS[self.tier]['name'],
            'created_at': self.created_at.isoformat(),
        }


class Task(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    description = db.Column(db.String(500), nullable=False)
    category = db.Column(db.String(100), default='')
    priority = db.Column(db.String(50), default='')
    recurring = db.Column(db.String(50), default='')
    due = db.Column(db.String(20), nullable=True)
    position = db.Column(db.Integer, default=0)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    def to_dict(self):
        return {
            'id': self.id,
            'description': self.description,
            'category': self.category or '',
            'priority': self.priority or '',
            'recurring': self.recurring or '',
            'due': self.due,
            'position': self.position,
        }


class DoneTask(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    description = db.Column(db.String(500), nullable=False)
    category = db.Column(db.String(100), default='')
    priority = db.Column(db.String(50), default='')
    recurring = db.Column(db.String(50), default='')
    due = db.Column(db.String(20), nullable=True)
    last_done = db.Column(db.String(20), nullable=True)
    completed_at = db.Column(db.DateTime, default=datetime.utcnow)

    def to_dict(self):
        return {
            'id': self.id,
            'description': self.description,
            'category': self.category or '',
            'priority': self.priority or '',
            'recurring': self.recurring or '',
            'due': self.due,
            'last_done': self.last_done,
            'completed_at': self.completed_at.isoformat(),
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


# === Task Endpoints ===

@app.route('/api/tasks', methods=['GET'])
@jwt_required()
def get_tasks():
    user_id = get_jwt_identity()
    tasks = Task.query.filter_by(user_id=user_id).order_by(Task.position, Task.id).all()
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
                task = Task(user_id=user_id, description=desc, category=cat,
                            priority=prio, recurring=recur, due=due, position=next_pos)
                db.session.add(task)
                all_tasks.append(task)
                next_pos += 1
        else:
            description = data.get('description', '').strip()
            if not description:
                return jsonify({'error': 'Task description is required'}), 400
            task = Task(
                user_id=user_id,
                description=description,
                category=data.get('category', '').strip(),
                priority=data.get('priority', '').strip(),
                recurring=data.get('recurring', '').strip(),
                due=data.get('due', '') or None,
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

    db.session.commit()
    return jsonify(task.to_dict())


@app.route('/api/tasks/<int:task_id>', methods=['DELETE'])
@jwt_required()
def delete_task(task_id):
    user_id = get_jwt_identity()
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
    user_id = get_jwt_identity()
    task = Task.query.filter_by(id=task_id, user_id=user_id).first()
    if not task:
        return jsonify({'error': 'Task not found'}), 404

    done_task = DoneTask(
        user_id=user_id,
        description=task.description,
        category=task.category,
        priority=task.priority,
        recurring=task.recurring,
        due=task.due,
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
    done_tasks = DoneTask.query.filter_by(user_id=user_id).order_by(DoneTask.completed_at.desc()).all()
    return jsonify([t.to_dict() for t in done_tasks])


@app.route('/api/tasks/categories', methods=['GET'])
@jwt_required()
def get_tasks_by_category():
    user_id = get_jwt_identity()
    tasks = Task.query.filter_by(user_id=user_id).order_by(Task.position, Task.id).all()
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
        tasks = Task.query.filter_by(user_id=user_id).order_by(Task.position, Task.id).all()
        return jsonify({'message': 'Tasks reordered successfully', 'tasks': [t.to_dict() for t in tasks]}), 200
    except Exception as e:
        db.session.rollback()
        return jsonify({'error': str(e)}), 500


# === Stripe Endpoints ===

@app.route('/api/stripe/tiers', methods=['GET'])
def get_tiers():
    """Return tier definitions (public endpoint for pricing page)."""
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
    user_id = get_jwt_identity()
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


@app.route('/api/health', methods=['GET'])
def health():
    return jsonify({'status': 'ok'})


if __name__ == '__main__':
    with app.app_context():
        db.create_all()
    app.run(debug=True, port=5001)
