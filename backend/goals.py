"""
Goal-setting framework for MadeHappen.

Structure: Goal → milestones → tasks.
A goal is a meaningful outcome (max MAX_ACTIVE_GOALS_PER_HAT active per hat)
broken into a few milestones; milestones link to real tasks. Progress is the
share of milestones done — completing the last open task linked to a
milestone ticks the milestone automatically (see mark_task_done in app.py).
Check-ins remain the coaching rhythm layered on top: a cadence the user
chooses, with a one-line note each time.

Two front doors share this module:
- REST routes in app.py (the Goals strip's quick form + checklist), and
- the AI guide coach, which gets the GOAL_TOOLS below so onboarding
  ("what are you working toward?"), milestone planning, and periodic
  check-ins happen in chat.

Like memory_notes.py, this module owns the tool schemas, the prompt block
injected into the guide's system prompt, and the tool handlers; app.py owns
the SQLAlchemy models and passes them in.
"""
from __future__ import annotations

from datetime import datetime

MAX_ACTIVE_GOALS_PER_HAT = 3
MAX_MILESTONES_PER_GOAL = 7
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


def milestone_to_dict(m):
    return {
        "id": m.id,
        "title": m.title,
        "done": bool(m.done),
        "done_at": m.done_at.isoformat() if m.done_at else None,
        "position": m.position or 0,
    }


def goal_progress(goal):
    """Progress = share of milestones done. No milestones → no bar (None)."""
    milestones = list(goal.milestones or [])
    total = len(milestones)
    done = sum(1 for m in milestones if m.done)
    return {
        "done": done,
        "total": total,
        "pct": round(100 * done / total) if total else None,
    }


def goal_to_dict(goal):
    return {
        "id": goal.id,
        "hat_id": goal.hat_id,
        "title": goal.title,
        "why": goal.why or "",
        "target_date": goal.target_date,
        "status": goal.status,
        "milestones": [milestone_to_dict(m) for m in (goal.milestones or [])],
        "progress": goal_progress(goal),
        "checkin_every_days": goal.checkin_every_days or DEFAULT_CHECKIN_DAYS,
        "last_checkin_at": goal.last_checkin_at.isoformat() if goal.last_checkin_at else None,
        "last_checkin_note": goal.last_checkin_note or "",
        "days_since_checkin": days_since_checkin(goal),
        "checkin_due": checkin_due(goal),
        "created_at": goal.created_at.isoformat() if goal.created_at else None,
    }


def add_milestones(db, Milestone, goal, titles):
    """Append milestone rows to a goal, respecting the per-goal cap.
    Returns the number actually added."""
    existing = len(list(goal.milestones or []))
    added = 0
    base_pos = existing
    for title in titles or []:
        text = (str(title) or "").strip()
        if not text or existing + added >= MAX_MILESTONES_PER_GOAL:
            continue
        db.session.add(Milestone(goal_id=goal.id, user_id=goal.user_id,
                                 title=text[:200], position=base_pos + added))
        added += 1
    return added


def active_goal_count(Goal, user_id, hat_id):
    return Goal.query.filter_by(user_id=user_id, hat_id=hat_id, status="active").count()


# ── Guide prompt block ───────────────────────────────────────────────────────

GOAL_GUIDANCE = (
    "\n\nGOALS: You are also the user's goal coach. The structure is "
    "Goal → milestones → tasks: a small number of meaningful outcomes (at "
    f"most {MAX_ACTIVE_GOALS_PER_HAT} active per hat) each broken into 2–5 "
    "milestones, and milestones turned into real tasks. Progress is the "
    "share of milestones done — completing the last open task linked to a "
    "milestone ticks it automatically.\n"
    "- If the user has NO goals yet, once the immediate conversation allows, "
    "warmly offer to set one or two: ask what they're working toward, why it "
    "matters, and what the first few milestones would be — then save it with "
    "set_goal (including milestones) after they agree.\n"
    "- If a goal below has no milestones, offer to break it down together "
    "and add them with update_milestones.\n"
    "- When the user agrees on next steps for a milestone, save them as real "
    "tasks with save_tasks and pass that milestone's id as milestone_id so "
    "completing the tasks moves the goal forward.\n"
    "- If any goal is marked CHECK-IN DUE, open the conversation (or weave "
    "in early) a gentle check-in: what moved, what's in the way? Record it "
    "with checkin_goal (one-line note), tick finished milestones with "
    "update_milestones, and offer to line up the next task.\n"
    "- When every milestone is done — or the outcome is reached — celebrate "
    "and mark the goal achieved with update_goal. If it no longer fits, "
    "offer to archive or rewrite it.\n"
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
            prog = goal_progress(g)
            if prog["total"]:
                bits.append(f"progress: {prog['done']}/{prog['total']} milestones")
            else:
                bits.append("no milestones yet — offer to break it down")
            bits.append(f"last check-in {days_since_checkin(g)}d ago "
                        f"(every {g.checkin_every_days or DEFAULT_CHECKIN_DAYS}d)")
            if checkin_due(g):
                bits.append("CHECK-IN DUE")
            lines.append("  - " + " · ".join(bits))
            for m in (g.milestones or []):
                mark = "✓" if m.done else "○"
                lines.append(f"      {mark} [milestone #{m.id}] {m.title}")
        listing = "\n".join(lines)
    return f"{GOAL_GUIDANCE}\n\nThe user's active goals:\n{listing}"


# ── Tool schemas (guide coach only) ──────────────────────────────────────────

GOAL_TOOLS = [
    {
        "name": "set_goal",
        "description": (
            "Create a goal the user has agreed to, ideally with 2–5 "
            "milestones worked out together. Keep the title short and "
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
                "milestones": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "2–5 ordered milestone titles the user agreed to.",
                },
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
        "name": "update_milestones",
        "description": (
            "Change a goal's milestone checklist: add new milestones, mark "
            "some done or not-done, or remove ones that no longer fit. Use "
            "milestone ids from the goal list."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "goal_id": {"type": "integer"},
                "add": {"type": "array", "items": {"type": "string"},
                        "description": "New milestone titles to append."},
                "complete_ids": {"type": "array", "items": {"type": "integer"},
                                 "description": "Milestone ids to mark done."},
                "reopen_ids": {"type": "array", "items": {"type": "integer"},
                               "description": "Milestone ids to mark not done."},
                "remove_ids": {"type": "array", "items": {"type": "integer"},
                               "description": "Milestone ids to delete."},
            },
            "required": ["goal_id"],
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


def handle_goal_tool(db, Goal, Hat, user, name, args, goal_actions,
                     Milestone=None):
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
        db.session.flush()   # assign id so milestones can reference it
        if Milestone is not None:
            add_milestones(db, Milestone, goal, args.get("milestones"))
        db.session.commit()
        goal_actions.append({"action": "goal_set", "title": goal.title})
        return {"content": {"goal": goal_to_dict(goal)}}

    if name == "update_milestones":
        goal = Goal.query.filter_by(id=args.get("goal_id"), user_id=user.id).first()
        if goal is None:
            return {"content": {"error": "Goal not found."}, "is_error": True}
        if Milestone is None:
            return {"content": {"error": "Milestones unavailable."}, "is_error": True}
        add_milestones(db, Milestone, goal, args.get("add"))
        by_id = {m.id: m for m in (goal.milestones or [])}
        for mid in args.get("complete_ids") or []:
            m = by_id.get(mid)
            if m and not m.done:
                m.done = True
                m.done_at = datetime.utcnow()
        for mid in args.get("reopen_ids") or []:
            m = by_id.get(mid)
            if m:
                m.done = False
                m.done_at = None
        for mid in args.get("remove_ids") or []:
            m = by_id.get(mid)
            if m:
                db.session.delete(m)
        db.session.commit()
        goal_actions.append({"action": "goal_updated", "title": goal.title})
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
