"""
AI Coaching Hub for MadeHappen.

Turns MadeHappen's AI addon into a coaching companion: alongside the task
assistant (add/delete/bulk-edit in ai_chat.py), a user can drop into one of
several coaching spaces — CBT, action/motivation, executive-function support,
emotional-charge work, and decision clarity — while staying connected to their
real task list.

Design notes:
- Every coach runs server-side through Claude with the ANTHROPIC_API_KEY that
  lives on the server. The browser never sees the key (the original standalone
  prototype called the Anthropic API directly from the client, which can't ship).
- Coaches are *task-aware*. Each turn we inject a compact snapshot of the user's
  current tasks so the coach can reference what they're carrying, and we expose a
  single `save_tasks` tool so that when a session surfaces a concrete next step or
  commitment, it lands in the user's real MadeHappen list instead of being lost.
- Crisis language is detected server-side on every user turn. When it fires we
  surface crisis resources to the client regardless of what the model says, so
  safety never depends on the model.
- Like ai_chat.py this avoids importing app.py at load time; the route in app.py
  constructs CoachingService with the model classes and helpers it needs.
"""
from __future__ import annotations

import json
import os

try:
    import anthropic
except ImportError:  # SDK optional — feature self-disables when absent
    anthropic = None

try:
    import dateparser
except ImportError:  # pragma: no cover - dateparser ships with the app
    dateparser = None

MODEL = "claude-opus-4-8"
MAX_MESSAGE_CHARS = 4000
MAX_HISTORY_TURNS = 24        # coaching conversations run longer than task edits
MAX_TOOL_ITERATIONS = 4      # coaches rarely need more than one save per turn
MAX_TASKS_IN_CONTEXT = 40    # cap the task snapshot injected into the prompt

# Crisis keywords, mirrored from the original hub. Detection is intentionally
# broad — a false positive just shows help resources, which is harmless.
CRISIS_KEYWORDS = (
    "suicide", "suicidal", "kill myself", "end my life", "want to die",
    "don't want to live", "dont want to live", "self-harm", "self harm",
    "hurt myself", "cut myself", "overdose", "harm myself",
    "not worth living", "better off dead",
)

CRISIS_RESOURCES = [
    {"name": "Lifeline", "number": "13 11 14", "desc": "24/7 crisis support"},
    {"name": "Beyond Blue", "number": "1300 22 4636", "desc": "Mental health support"},
    {"name": "Emergency", "number": "000", "desc": "Immediate danger"},
    {"name": "13YARN", "number": "13 92 76", "desc": "Aboriginal & Torres Strait Islander"},
]

_SAFETY = (
    "\n\nSAFETY: If the user expresses suicidal ideation, self-harm or crisis, "
    "acknowledge them warmly and gently share: Lifeline 13 11 14, Beyond Blue "
    "1300 22 4636, Emergency 000. This tool does not replace professional mental "
    "health care."
)

# Shared guidance that makes every coach aware of the user's MadeHappen tasks.
_TASK_AWARENESS = (
    "\n\nTASK AWARENESS: This user is inside MadeHappen, their to-do app. Their "
    "current tasks are provided below for gentle context — do not read them back "
    "as a list unless it genuinely helps. When the conversation surfaces a "
    "concrete, specific next step, action or commitment the user wants to keep, "
    "call the save_tasks tool so it lands in their real task list and isn't lost. "
    "Save at most a few clear, self-contained tasks; never save vague feelings, "
    "and confirm briefly and warmly in your reply (e.g. \"I've added that to your "
    "list\"). Keep your coaching voice — saving a task is a quiet side-effect, not "
    "the point of the conversation."
)


def coaching_available() -> bool:
    """True when the feature can run (SDK importable + API key configured)."""
    return anthropic is not None and bool(os.getenv("ANTHROPIC_API_KEY"))


def detect_crisis(text: str) -> bool:
    low = (text or "").lower()
    return any(kw in low for kw in CRISIS_KEYWORDS)


def _parse_due(value):
    text = (value or "").strip()
    if not text or dateparser is None:
        return text or None
    parsed = dateparser.parse(text)
    return parsed.strftime("%Y-%m-%d") if parsed else text


# ── Coach definitions ────────────────────────────────────────────────────────
# Each coach is a system prompt plus a scripted opening line. The prompts are
# ported from the standalone Purposefields hub and extended with task awareness.

_CBT_SYSTEM = (
    "You are a digital CBT coach following a strict 10-step process. You are warm, "
    "person-centred and strengths-based. Label each step: \"**Step N – Title**\". "
    "Only advance after the user confirms readiness. Use the user's own words back "
    "to them.\n"
    "Steps: 1-What's Bothering You, 2-Emotions & Behaviors, 3-Beliefs Behind "
    "Emotions, 4-Challenge Your Beliefs, 5-New Actions & Emotions, 6-Immediate "
    "Actions for Today, 7-Weekly Goals, 8-Review Goals, 9-Gratitude Practice, "
    "10-Self-Love & Reflection.\n"
    "At steps 6 and 7, when concrete actions or weekly goals are agreed, save them "
    "with save_tasks so they become real MadeHappen tasks."
)

_ACTION_SYSTEM = (
    "You are a motivational coach helping people overcome resistance to action. "
    "You are person-centred, grounded in Self-Determination Theory, ACT and "
    "solution-focused therapy. Never give advice or suggestions. Listen, reflect, "
    "and ask one question at a time. Match the user's energy. Be warm, natural and "
    "emotionally intelligent. When the user names a specific action they're ready "
    "to take, offer to keep it and save it with save_tasks."
)

_EXEC_SYSTEM = (
    "You are a gentle, reflective conversational partner for neurodivergent "
    "individuals navigating ADHD, Dyspraxia and fluctuating energy. Never give "
    "advice. Listen, reflect, and ask one thoughtful question at a time. Help the "
    "user externalise thoughts and get tasks out of their head. You are calm and "
    "unhurried, grounded in ACT, CBT and Mindfulness with a Buddhist/Taoist/Yogic "
    "tone. Whenever a task or intention surfaces, quietly capture it with "
    "save_tasks so their mind can let it go."
)

_CHARGE_SYSTEM = (
    "You are 'Reducing the Charge', a therapeutic guide helping the user process "
    "emotional resistance. You integrate ACT, ULH, UFT, Exposure Therapy, CBT and "
    "Mindfulness. You are never directive — you gently invite. Ask one question at "
    "a time, 3-4 lines per prompt. If the user hasn't already given one, begin by "
    "inviting them to rate their emotional charge from 1 to 10. If a small, "
    "grounding next step emerges, you may offer to save it with save_tasks."
)

_CLARITY_SYSTEM = (
    "You are Clarity Compass, a decision-making companion running a 13-phase "
    "process. You draw on Solution-Focused Brief Therapy, ACT and coaching. Never "
    "give advice. Ask ONE question at a time. Label transitions: \"**Phase N – "
    "Name**\".\n"
    "Phase 1 – Ground: life needs, non-negotiables, relevant identity.\n"
    "Phase 2 – Values: top 5 (Authenticity, Balance, Connection, Courage, "
    "Creativity, Freedom, Growth, Gratitude, Health, Honesty, Impact, Integrity, "
    "Joy, Justice, Kindness, Learning, Love, Meaning, Mindfulness, Peace, Purpose, "
    "Resilience, Respect, Security, Service, Trust, Wisdom).\n"
    "Phase 3 – Aspiration: ideal future via the Miracle Question.\n"
    "Phase 4 – Barriers: what's in the way?\n"
    "Phase 5 – Strategy: how to overcome them?\n"
    "Phase 6 – Decision Tooling (optional): a couple of meta-questions.\n"
    "Phase 7 – THE DECISION: the user names the decision. Confirm warmly and "
    "celebrate.\n"
    "Phase 8 – Plan: step-by-step toward the aspiration.\n"
    "Phase 9 – Resistance Check (optional): anything hard to start?\n"
    "Phase 10 – Break It Down (optional): decompose complex steps.\n"
    "Phase 11 – Visualise (optional): walk through the plan mentally.\n"
    "Phase 12 – Schedule: turn first steps into real commitments — save them with "
    "save_tasks.\n"
    "Phase 13 – First Action: what happens right now? Save it with save_tasks."
)

COACHES = {
    "cbt": {
        "name": "CBT Coach",
        "opener": "Hi, I'm here with you. We can take this one step at a time. "
                  "What's been on your mind lately?",
        "system": _CBT_SYSTEM,
    },
    "action": {
        "name": "Action Coach",
        "opener": "Hey, I'm here. What's on your mind — what are you wanting to do "
                  "but finding yourself resisting?",
        "system": _ACTION_SYSTEM,
    },
    "exec": {
        "name": "Executive Function Coach",
        "opener": "Hi, I'm here with you. Take a breath — there's no rush. How are "
                  "you feeling right now, in this moment?",
        "system": _EXEC_SYSTEM,
    },
    "charge": {
        "name": "Reducing the Charge",
        "opener": "Welcome. Whenever you're ready: on a scale of 1 to 10, how would "
                  "you rate the emotional charge you're carrying right now?",
        "system": _CHARGE_SYSTEM,
    },
    "clarity": {
        "name": "Clarity Compass",
        "opener": "Hi, I'm glad you're here. Let's find some clarity together — "
                  "shall we begin?",
        "system": _CLARITY_SYSTEM,
    },
}


def coach_openers() -> dict:
    """Public map of coach_id -> scripted opening line (used to seed the UI)."""
    return {cid: c["opener"] for cid, c in COACHES.items()}


# ── save_tasks tool schema ───────────────────────────────────────────────────
_SAVE_TASKS_TOOL = {
    "name": "save_tasks",
    "description": (
        "Save one or more concrete tasks or next steps that came up in the "
        "coaching conversation into the user's MadeHappen task list. Use only for "
        "specific, actionable items the user wants to keep."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "tasks": {
                "type": "array",
                "description": "The tasks to add.",
                "items": {
                    "type": "object",
                    "properties": {
                        "description": {"type": "string"},
                        "priority": {
                            "type": "string",
                            "enum": ["urgent", "today", "tomorrow", "later", ""],
                        },
                        "due": {
                            "type": "string",
                            "description": "Natural-language or YYYY-MM-DD due date, or empty.",
                        },
                    },
                    "required": ["description"],
                    "additionalProperties": False,
                },
            }
        },
        "required": ["tasks"],
        "additionalProperties": False,
    },
}


class CoachingService:
    """Runs one coaching turn for a user, with optional task capture."""

    def __init__(self, db, Task, Hat, check_task_limit):
        self.db = db
        self.Task = Task
        self.Hat = Hat
        self.check_task_limit = check_task_limit
        self.client = anthropic.Anthropic() if anthropic is not None else None

    # ---- public entry point ----
    def run(self, user, coach_id, message, history, hat_id=None):
        """Execute one coaching turn. Returns a JSON-serializable dict."""
        coach = COACHES.get(coach_id)
        if coach is None:
            raise ValueError(f"Unknown coach: {coach_id}")

        crisis = detect_crisis(message)

        hats = (self.Hat.query.filter_by(user_id=user.id)
                .order_by(self.Hat.position, self.Hat.id).all())
        default_hat_id = self._resolve_default_hat(user.id, hat_id, hats)

        system = self._system_prompt(user, coach)
        messages = self._build_messages(history, message)

        added_tasks = []      # {description} of tasks saved this turn (for the UI)
        reply_text = ""

        for _ in range(MAX_TOOL_ITERATIONS):
            response = self.client.messages.create(
                model=MODEL,
                max_tokens=1200,
                system=system,
                tools=[_SAVE_TASKS_TOOL],
                messages=messages,
            )

            text_parts = [b.text for b in response.content if b.type == "text"]
            if text_parts:
                reply_text = "\n".join(text_parts).strip()

            tool_uses = [b for b in response.content if b.type == "tool_use"]
            if response.stop_reason != "tool_use" or not tool_uses:
                break

            messages.append({"role": "assistant", "content": response.content})
            tool_results = []
            for block in tool_uses:
                result = self._dispatch(user, default_hat_id, block.name,
                                        block.input, added_tasks)
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": json.dumps(result.get("content", {})),
                    "is_error": result.get("is_error", False),
                })
            messages.append({"role": "user", "content": tool_results})

        if not reply_text:
            reply_text = "I'm here with you."

        return {
            "reply": reply_text,
            "coach_id": coach_id,
            "crisis": crisis,
            "crisis_resources": CRISIS_RESOURCES if crisis else [],
            "tasks_added": added_tasks,
        }

    # ---- internals ----
    def _resolve_default_hat(self, user_id, hat_id, hats):
        if hat_id:
            hat = next((h for h in hats if h.id == hat_id), None)
            if hat:
                return hat.id
        main = next((h for h in hats if h.name == "Main Hat"), None)
        if main:
            return main.id
        return hats[0].id if hats else None

    def _task_snapshot(self, user_id):
        """A compact, read-only view of the user's active tasks for the prompt."""
        tasks = (self.Task.query.filter_by(user_id=user_id)
                 .order_by(self.Task.position, self.Task.id)
                 .limit(MAX_TASKS_IN_CONTEXT).all())
        if not tasks:
            return "  (no tasks yet)"
        lines = []
        for t in tasks:
            bits = [t.description or ""]
            if t.priority:
                bits.append(f"priority: {t.priority}")
            if t.due:
                bits.append(f"due: {t.due}")
            lines.append("  - " + " · ".join(bits))
        return "\n".join(lines)

    def _system_prompt(self, user, coach):
        snapshot = self._task_snapshot(user.id)
        return (
            f"{coach['system']}"
            f"{_TASK_AWARENESS}"
            f"\n\nThe user's current MadeHappen tasks:\n{snapshot}"
            f"{_SAFETY}"
        )

    def _build_messages(self, history, message):
        messages = []
        if isinstance(history, list):
            for turn in history[-MAX_HISTORY_TURNS:]:
                role = turn.get("role")
                content = turn.get("content")
                if role in ("user", "assistant") and isinstance(content, str) and content.strip():
                    messages.append({"role": role, "content": content[:MAX_MESSAGE_CHARS]})
        messages.append({"role": "user", "content": message[:MAX_MESSAGE_CHARS]})
        # The API requires the first message to be from the user.
        while messages and messages[0]["role"] != "user":
            messages = messages[1:]
        return messages

    def _dispatch(self, user, default_hat_id, name, args, added_tasks):
        try:
            if name == "save_tasks":
                return self._save_tasks(user, default_hat_id, args, added_tasks)
            return {"content": {"error": f"Unknown tool: {name}"}, "is_error": True}
        except Exception as e:  # never break the loop — let the model recover
            self.db.session.rollback()
            return {"content": {"error": str(e)}, "is_error": True}

    def _save_tasks(self, user, default_hat_id, args, added_tasks):
        items = args.get("tasks") or []
        created = []
        skipped_limit = 0
        for item in items:
            desc = (item.get("description") or "").strip()
            if not desc:
                continue
            if self.check_task_limit(user) is not None:
                skipped_limit += 1
                continue
            max_pos = (self.db.session.query(self.db.func.max(self.Task.position))
                       .filter_by(user_id=user.id).scalar() or 0)
            task = self.Task(
                user_id=user.id,
                hat_id=default_hat_id,
                description=desc,
                category="",
                priority=(item.get("priority") or "").strip(),
                recurring="",
                due=_parse_due(item.get("due")),
                position=max_pos + 1,
            )
            self.db.session.add(task)
            self.db.session.flush()
            created.append({"id": task.id, "description": desc})
        self.db.session.commit()

        for c in created:
            added_tasks.append({"description": c["description"]})

        result = {"saved_count": len(created)}
        if skipped_limit:
            result["skipped_due_to_task_limit"] = skipped_limit
            result["note"] = "Free tier task limit reached; some tasks were not saved."
        return {"content": result}
