"""
Goal-setting framework for MadeHappen.

Goals are first-class objects (not tasks, not chat memory): a short title, a
"why", an optional target date, and a check-in cadence the user chooses.
At most MAX_ACTIVE_GOALS_PER_HAT are active per hat so focus stays narrow.

Two front doors share this module:
- REST routes in app.py (the Goals strip's quick form), and
- the AI guide coach, which gets the GOAL_TOOLS below so onboarding
  ("what are you working toward?") and periodic check-ins happen in chat.

Like memory_notes.py, this module owns the tool schemas, the prompt block
injected into the guide's system prompt, and the tool handlers; app.py owns
the SQLAlchemy model and passes it in.
"""
from __future__ import annotations

from datetime import datetime

MAX_ACTIVE_GOALS_PER_HAT = 3
CHECKIN_CHOICES = (1, 7, 14, 30)     # daily / weekly / fortnightly / monthly
DEFAULT_CHECKIN_DAYS = 7
GOAL_STATUSES = ("active", "achieved", "archived")


def days_since_checkin(goal, now=None):
    now = now or datetime.utcnow()
    last = goal.last_checkin_at or goal.created_at or now
    return max(0, (now - last).days)


def checkin_due(goal, now=None):
    if goal.status != "active":
        return False
    return days_since_checkin(goal, now) >= (goal.checkin_every_days or DEFAULT_CHECKIN_DAYS)


def goal_to_dict(goal):
    return {
        "id": goal.id,
        "hat_id": goal.hat_id,
        "title": goal.title,
        "why": goal.why or "",
        "target_date": goal.target_date,
        "status": goal.status,
        "checkin_every_days": goal.checkin_every_days or DEFAULT_CHECKIN_DAYS,
        "last_checkin_at": goal.last_checkin_at.isoformat() if goal.last_checkin_at else None,
        "last_checkin_note": goal.last_checkin_note or "",
        "days_since_checkin": days_since_checkin(goal),
        "checkin_due": checkin_due(goal),
        "created_at": goal.created_at.isoformat() if goal.created_at else None,
    }


def active_goal_count(Goal, user_id, hat_id):
    return Goal.query.filter_by(user_id=user_id, hat_id=hat_id, status="active").count()


# ── Guide prompt block ───────────────────────────────────────────────────────

GOAL_GUIDANCE = (
    "\n\nGOALS: You are also the user's goal coach. Goals are separate from "
    "tasks — a small number of meaningful outcomes (at most "
    f"{MAX_ACTIVE_GOALS_PER_HAT} active per hat) with a 'why' and a check-in "
    "rhythm the user chooses.\n"
    "- If the user has NO goals yet, once the immediate conversation allows, "
    "warmly offer to set one or two: ask what they're working toward, why it "
    "matters, and what a realistic pace looks like — then save it with "
    "set_goal after they agree.\n"
    "- If any goal below is marked CHECK-IN DUE, open the conversation (or "
    "weave in early) a gentle check-in: how is it going, what moved, what's "
    "in the way? Record it with checkin_goal — including a one-line note — "
    "and offer to turn next steps into tasks.\n"
    "- When a goal is reached, celebrate and mark it achieved with "
    "update_goal. If it no longer fits, offer to archive or rewrite it.\n"
    "- Respect the per-hat limit: if a hat is full, discuss which goal to "
    "replace rather than piling on. Offer first, act on a yes — same as tasks."
)


def goals_prompt_block(Goal, Hat, user_id):
    """Formatted view of the user's goals for the guide's system prompt."""
    goals = (Goal.query.filter_by(user_id=user_id)
             .filter(Goal.status == "active")
             .order_by(Goal.hat_id, Goal.id).all())
    hats = {h.id: h.name for h in Hat.query.filter_by(user_id=user_id).all()}
    if not goals:
        listing = "  (no goals yet — offer to set the first one)"
    else:
        lines = []
        for g in goals:
            bits = [f"[goal #{g.id}] {g.title}"]
            bits.append(f"hat: {hats.get(g.hat_id, 'none')}")
            if g.why:
                bits.append(f"why: {g.why}")
            if g.target_date:
                bits.append(f"target: {g.target_date}")
            bits.append(f"last check-in {days_since_checkin(g)}d ago "
                        f"(every {g.checkin_every_days or DEFAULT_CHECKIN_DAYS}d)")
            if checkin_due(g):
                bits.append("CHECK-IN DUE")
            lines.append("  - " + " · ".join(bits))
        listing = "\n".join(lines)
    return f"{GOAL_GUIDANCE}\n\nThe user's active goals:\n{listing}"


# ── Tool schemas (guide coach only) ──────────────────────────────────────────

GOAL_TOOLS = [
    {
        "name": "set_goal",
        "description": (
            "Create a goal the user has agreed to. Keep the title short and "
            "outcome-shaped; capture their own words in 'why'. Fails if the "
            "hat already has the maximum active goals — then discuss which "
            "to replace instead."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "Short outcome, e.g. 'Run a 10k'."},
                "why": {"type": "string", "description": "Why it matters, in the user's words."},
                "hat_id": {"type": "integer", "description": "Hat this goal belongs to."},
                "target_date": {"type": "string", "description": "YYYY-MM-DD target, or empty."},
                "checkin_every_days": {
                    "type": "integer",
                    "enum": list(CHECKIN_CHOICES),
                    "description": "Check-in rhythm the user chose (1/7/14/30 days). Default 7.",
                },
            },
            "required": ["title"],
            "additionalProperties": False,
        },
    },
    {
        "name": "update_goal",
        "description": (
            "Edit a goal by id: retitle, change why/target/cadence/hat, mark "
            "achieved, or archive. Only include fields being changed."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "id": {"type": "integer"},
                "title": {"type": "string"},
                "why": {"type": "string"},
                "hat_id": {"type": "integer"},
                "target_date": {"type": "string"},
                "checkin_every_days": {"type": "integer", "enum": list(CHECKIN_CHOICES)},
                "status": {"type": "string", "enum": list(GOAL_STATUSES)},
            },
            "required": ["id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "checkin_goal",
        "description": (
            "Record a check-in on a goal after reviewing it with the user: "
            "resets the check-in clock and stores a one-line note on how "
            "it's going."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "id": {"type": "integer"},
                "note": {"type": "string", "description": "One line on how the goal is going."},
            },
            "required": ["id"],
            "additionalProperties": False,
        },
    },
]

GOAL_TOOL_NAMES = {t["name"] for t in GOAL_TOOLS}


# ── Tool handlers ────────────────────────────────────────────────────────────

def _valid_hat_id(Hat, user_id, hat_id):
    if not hat_id:
        return None
    hat = Hat.query.filter_by(id=hat_id, user_id=user_id).first()
    return hat.id if hat else None


def handle_goal_tool(db, Goal, Hat, user, name, args, goal_actions):
    """Execute a goal tool for the guide. Returns a result dict, or None if
    the tool name isn't a goal tool."""
    if name not in GOAL_TOOL_NAMES:
        return None

    if name == "set_goal":
        title = (args.get("title") or "").strip()
        if not title:
            return {"content": {"error": "Goal title is required."}, "is_error": True}
        hat_id = _valid_hat_id(Hat, user.id, args.get("hat_id"))
        if active_goal_count(Goal, user.id, hat_id) >= MAX_ACTIVE_GOALS_PER_HAT:
            return {"content": {
                "error": f"This hat already has {MAX_ACTIVE_GOALS_PER_HAT} active goals.",
                "limit_reached": True,
                "note": "Discuss with the user which goal to replace, achieve or archive first.",
            }, "is_error": True}
        cadence = args.get("checkin_every_days")
        goal = Goal(
            user_id=user.id,
            hat_id=hat_id,
            title=title[:200],
            why=(args.get("why") or "").strip()[:500],
            target_date=(args.get("target_date") or "").strip()[:10] or None,
            checkin_every_days=cadence if cadence in CHECKIN_CHOICES else DEFAULT_CHECKIN_DAYS,
        )
        db.session.add(goal)
        db.session.commit()
        goal_actions.append({"action": "goal_set", "title": goal.title})
        return {"content": {"goal": goal_to_dict(goal)}}

    goal = Goal.query.filter_by(id=args.get("id"), user_id=user.id).first()
    if goal is None:
        return {"content": {"error": "Goal not found."}, "is_error": True}

    if name == "update_goal":
        if "title" in args and (args.get("title") or "").strip():
            goal.title = args["title"].strip()[:200]
        if "why" in args:
            goal.why = (args.get("why") or "").strip()[:500]
        if "hat_id" in args:
            new_hat = _valid_hat_id(Hat, user.id, args.get("hat_id"))
            if (new_hat != goal.hat_id and goal.status == "active" and
                    active_goal_count(Goal, user.id, new_hat) >= MAX_ACTIVE_GOALS_PER_HAT):
                return {"content": {"error": "That hat is already at its goal limit.",
                                    "limit_reached": True}, "is_error": True}
            goal.hat_id = new_hat
        if "target_date" in args:
            goal.target_date = (args.get("target_date") or "").strip()[:10] or None
        if args.get("checkin_every_days") in CHECKIN_CHOICES:
            goal.checkin_every_days = args["checkin_every_days"]
        if args.get("status") in GOAL_STATUSES:
            goal.status = args["status"]
            if goal.status == "achieved":
                goal.achieved_at = datetime.utcnow()
                goal_actions.append({"action": "goal_achieved", "title": goal.title})
        db.session.commit()
        if not any(a.get("title") == goal.title and a["action"] == "goal_achieved"
                   for a in goal_actions):
            goal_actions.append({"action": "goal_updated", "title": goal.title})
        return {"content": {"goal": goal_to_dict(goal)}}

    if name == "checkin_goal":
        goal.last_checkin_at = datetime.utcnow()
        goal.last_checkin_note = (args.get("note") or "").strip()[:500]
        db.session.commit()
        goal_actions.append({"action": "goal_checkin", "title": goal.title})
        return {"content": {"goal": goal_to_dict(goal)}}

    return None
