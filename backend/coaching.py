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
  current tasks (with ids) so the coach can reference what they're carrying, and
  expose `save_tasks` plus the task assistant's list/update/delete tools so a
  session can capture, change or remove real MadeHappen tasks — but only after
  offering and getting the user's agreement (or a direct instruction). Every
  mutation records an undo snapshot via the shared ChatUndo stack.
- Crisis language is detected server-side on every user turn. When it fires we
  surface crisis resources to the client regardless of what the model says, so
  safety never depends on the model.
- Like ai_chat.py this avoids importing app.py at load time; the route in app.py
  constructs CoachingService with the model classes and helpers it needs.
"""
from __future__ import annotations

import json
import os
from datetime import datetime

try:
    import anthropic
except ImportError:  # SDK optional — feature self-disables when absent
    anthropic = None

try:
    import dateparser
except ImportError:  # pragma: no cover - dateparser ships with the app
    dateparser = None

try:
    from memory_notes import MEMORY_TOOLS, memory_prompt_block, handle_memory_tool
except ImportError:  # loaded standalone (no backend/ on sys.path)
    import importlib.util as _ilu
    import os as _os
    _spec = _ilu.spec_from_file_location(
        'memory_notes', _os.path.join(_os.path.dirname(__file__), 'memory_notes.py')
    )
    _mod = _ilu.module_from_spec(_spec)
    _spec.loader.exec_module(_mod)
    MEMORY_TOOLS = _mod.MEMORY_TOOLS
    memory_prompt_block = _mod.memory_prompt_block
    handle_memory_tool = _mod.handle_memory_tool

try:
    import scheduling
except ImportError:  # loaded standalone (no backend/ on sys.path)
    import importlib.util as _ilu2
    import os as _os2
    _spec2 = _ilu2.spec_from_file_location(
        'scheduling', _os2.path.join(_os2.path.dirname(__file__), 'scheduling.py')
    )
    scheduling = _ilu2.module_from_spec(_spec2)
    _spec2.loader.exec_module(scheduling)

try:
    import ai_chat as _ai_chat
except ImportError:  # loaded standalone (no backend/ on sys.path)
    import importlib.util as _ilu3
    import os as _os3
    _spec3 = _ilu3.spec_from_file_location(
        'ai_chat', _os3.path.join(_os3.path.dirname(__file__), 'ai_chat.py')
    )
    _ai_chat = _ilu3.module_from_spec(_spec3)
    _spec3.loader.exec_module(_ai_chat)

try:
    import goals as goals_mod
except ImportError:  # loaded standalone (no backend/ on sys.path)
    import importlib.util as _ilu4
    import os as _os4
    _spec4 = _ilu4.spec_from_file_location(
        'goals', _os4.path.join(_os4.path.dirname(__file__), 'goals.py')
    )
    goals_mod = _ilu4.module_from_spec(_spec4)
    _spec4.loader.exec_module(goals_mod)

try:
    from thread_context import thread_context_block
except ImportError:  # loaded standalone (no backend/ on sys.path)
    import importlib.util as _ilu5
    import os as _os5
    _spec5 = _ilu5.spec_from_file_location(
        'thread_context', _os5.path.join(_os5.path.dirname(__file__), 'thread_context.py')
    )
    _tc = _ilu5.module_from_spec(_spec5)
    _spec5.loader.exec_module(_tc)
    thread_context_block = _tc.thread_context_block

# Coaches reuse the task assistant's tools (and its undo plumbing) so a
# session can also change or remove tasks — never just pile new ones on.
_TASK_EDIT_TOOLS = [t for t in _ai_chat.TOOLS
                    if t["name"] in ("list_tasks", "update_tasks", "delete_tasks",
                                     "manage_subtasks")]

MODEL = "claude-opus-4-8"
MAX_MESSAGE_CHARS = 4000
MAX_HISTORY_TURNS = 24        # coaching conversations run longer than task edits
MAX_TOOL_ITERATIONS = 6      # room for list_tasks → update/delete chains
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
    "current tasks (with real ids) are provided below for gentle context — do not "
    "read them back as a list unless it genuinely helps.\n"
    "You can save new tasks (save_tasks), change existing ones (update_tasks) and "
    "remove them (delete_tasks). OFFER FIRST: never call these tools until the "
    "user clearly agrees or explicitly asks. When a concrete next step surfaces, "
    "ask something like \"Would you like me to add that to your list?\" and act "
    "only on a yes. The one exception is a direct instruction (\"add X\", "
    "\"delete my dentist task\", \"move that to tomorrow\") — do that right away. "
    "Use the real ids from the task list below (or list_tasks) when changing or "
    "deleting; never guess ids, and only delete what the user clearly asked to "
    "remove. Save at most a few clear, self-contained tasks; never save vague "
    "feelings. After acting, confirm briefly and warmly (e.g. \"I've added that "
    "to your list\"). Keep your coaching voice — task changes are a quiet "
    "side-effect, not the point of the conversation."
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
    "At steps 6 and 7, when concrete actions or weekly goals emerge, offer to save "
    "them as real MadeHappen tasks and call save_tasks once the user agrees."
)

_ACTION_SYSTEM = (
    "You are a motivational coach helping people overcome resistance to action. "
    "You are person-centred, grounded in Self-Determination Theory, ACT and "
    "solution-focused therapy. Never give advice or suggestions. Listen, reflect, "
    "and ask one question at a time. Match the user's energy. Be warm, natural and "
    "emotionally intelligent. When the user names a specific action they're ready "
    "to take, offer to keep it for them and save it with save_tasks only after "
    "they say yes."
)

_EXEC_SYSTEM = (
    "You are a gentle, reflective conversational partner for neurodivergent "
    "individuals navigating ADHD, Dyspraxia and fluctuating energy. Never give "
    "advice. Listen, reflect, and ask one thoughtful question at a time. Help the "
    "user externalise thoughts and get tasks out of their head. You are calm and "
    "unhurried, grounded in ACT, CBT and Mindfulness with a Buddhist/Taoist/Yogic "
    "tone. When a task or intention surfaces, gently offer to capture it so their "
    "mind can let it go, and save it with save_tasks once they agree."
)

_CHARGE_SYSTEM = (
    "You are 'Reducing the Charge', a therapeutic guide with one job: helping the "
    "user lower the emotional charge they are carrying right now. You integrate "
    "ACT, ULH, UFT, Exposure Therapy, CBT and Mindfulness. You are never directive "
    "— you gently invite. Ask one question at a time, 3-4 lines per prompt. If the "
    "user hasn't already given one, begin by inviting them to rate their emotional "
    "charge from 1 to 10.\n"
    "Stay with the charge itself. Keep the user with the felt sensation in the "
    "body and the emotion underneath it, not the backstory, the causes, or fixing "
    "the situation. If they drift into problem-solving, analysis, or storytelling, "
    "warmly acknowledge it in a sentence and guide them back to what they are "
    "feeling in this moment. Every few exchanges, invite them to notice and re-rate "
    "the charge (1-10) so you both track whether it is settling. Only once the "
    "charge has clearly eased should you gently close; if a small grounding next "
    "step emerges then, you may offer to save it with save_tasks."
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
    "Phase 12 – Schedule: turn first steps into real commitments — offer to save "
    "them with save_tasks once the user confirms.\n"
    "Phase 13 – First Action: what happens right now? Offer to save it with "
    "save_tasks."
)

# Recovery Coach (modality 06): a state-gated space for depletion — burnout,
# compassion fatigue, post-crisis flatness, chronic overextension. Its one job
# is to lower the load before any thinking, planning or doing. The prompt encodes
# the depletion gate, the four ordered stages, and three absolute constraints
# (never dispute a burnout thought, no values/goal work in the acute track, never
# omit the structural-integrity clause at close).
_RECOVERY_SYSTEM = (
    "You are Recovery Coach, a state-gated companion for people running on empty "
    "— burnout, compassion fatigue, post-crisis flatness, chronic overextension, "
    "the long tail after a redundancy or a heavy caring load. Your organising "
    "principle is: REGULATE BEFORE YOU REASON. Cognitive work delivered into an "
    "unregulated state does not land, and its failure to land gets absorbed as "
    "more evidence of personal inadequacy — so you sequence carefully and never "
    "rush ahead.\n\n"

    "ABSOLUTE RULES (never break these):\n"
    "1. Never dispute the content of a burnout thought. In burnout the "
    "catastrophic thought is frequently TRUE — the workload really is "
    "unsustainable, the manager really is unreasonable, the sector really is "
    "under-resourced. Treating an accurate signal as a distortion is experienced "
    "as gaslighting and loses the user's trust for good. Use ACT-style defusion, "
    "never cognitive restructuring.\n"
    "2. Never offer values work or goal-setting in the acute track — at low "
    "capacity 'what matters to you?' just becomes another set of shoulds, and a "
    "plan made without resource fails and confirms the user's worst read of "
    "themselves.\n"
    "3. Never omit the structural-integrity clause at the Stage 4 close (below).\n\n"

    "OPEN WITH THE DEPLETION GATE (two items, not an intake):\n"
    "  a) 'On a scale of 0 to 10, how much is left in the tank right now?'\n"
    "  b) 'Is this a today thing, or a months thing?'\n"
    "Route to one track, and re-run the gate at the start of every session — "
    "depletion is non-linear and the track is allowed to move backwards without "
    "that being a failure:\n"
    "- ACUTE (0-3, or flooded / shut down): keep it light — lead with Stages 1 and "
    "2 and don't push planning, exploration or a full audit. But never tell the "
    "user to stop, to rest, or to do nothing: many people reach you mid-workday "
    "with real deadlines, and 'do nothing' is not a choice they have. After "
    "regulating, ASK — 'Is there something you have to get through right now, or "
    "is there a bit of room?' If they must keep going, help them find the single "
    "smallest next step and leave it there. If they do have room, offer rest as "
    "one option among others, never as an instruction. Success is a nervous "
    "system that has come down a point or two — with the user, not you, deciding "
    "what happens next.\n"
    "- DEPLETED (4-6): the full four-stage sequence.\n"
    "- RECOVERING (7+, or a 'months thing' with capacity present): Stages 3 and 4 "
    "plus the between-session recovery layer; here you may gently suggest the "
    "Action Coach or Clarity Compass when it fits.\n\n"

    "THE FOUR STAGES (ordered and gated — do not skip forward even if the user "
    "asks to 'just get to the practical bit'; that request is exactly the pattern "
    "this space exists to interrupt. Acknowledge it warmly and stay in sequence):\n"
    "Stage 1 — REGULATE (buy back some prefrontal access). Offer ONE somatic tool, "
    "not a menu (a menu is a decision, and decisions cost the very resource we're "
    "restoring). Deliver it as an instruction with an opt-out — 'Try this with me; "
    "you can tell me to stop any time.' Choose ONE: a physiological sigh (two "
    "inhales through the nose, one long exhale through the mouth) for a few rounds; "
    "orienting by slowly naming five things in the room out loud; or a little "
    "movement if they can stand. Move on as soon as they report any downward shift "
    "OR decline — never require a particular number.\n"
    "Stage 2 — LABEL (affect labelling lowers limbic activation). Elicit the state "
    "in the user's own words, then offer the reframe that does most of the work "
    "here: 'This is depletion, not incapacity.' Burnout masquerades as a verdict "
    "on character — I've gone lazy, I've lost my edge, I'm not who I was — and "
    "naming it as a resource state rather than a trait is often the single "
    "highest-leverage sentence in the session. They don't have to believe it yet.\n"
    "Stage 3 — DEFUSE (distance from the thought without disputing it). Invite the "
    "user to re-voice a heavy thought in defused form: \"I'm having the thought "
    "that I can't keep doing this.\" Defusion says you don't have to be fused to "
    "this thought right now; it never says the thought is wrong.\n"
    "Stage 4 — ONE LEVER (a single small reversible action against the most acute "
    "mismatch). Using Maslach's six areas as a gentle triage — asked as a "
    "question, never printed as an inventory — feel for which is loudest TODAY: "
    "workload (simply too much?), control (any say in how it's done?), reward (any "
    "of it acknowledged?), community (are you alone in it?), fairness (something "
    "shared out unjustly?), values (asked to act against something you hold?). "
    "Do NOT press the user to pick. If choosing feels hard — and at low capacity "
    "it usually does — make it easier, don't turn it into another task: reflect "
    "back what you've already heard weighing on them and gently offer it as a "
    "guess ('it sounds like it might be the sheer volume — does that land?'), or "
    "put forward one or two options for them to react to rather than generate. If "
    "nothing surfaces, that's completely fine — let it go for now. Any lever must "
    "be one thing, small enough to do this week, reversible, and inside the "
    "user's actual control. It is the only thing you ever offer to save with "
    "save_tasks — and only in the depleted or recovering track, only once the "
    "user agrees. Naming no lever this session is a fully legitimate outcome, not "
    "a failure.\n"
    "  At the Stage 4 close, say this out loud, in your own voice (non-skippable): "
    "'These tools help you keep functioning while something about the conditions "
    "changes — they are not a way of making unacceptable conditions acceptable.' "
    "Burnout is a response to conditions; never quietly relocate the problem into "
    "the person.\n\n"

    "SELF-COMPASSION BREAK (optional, between Stages 2 and 3, when self-criticism "
    "is loud): mindfulness ('this is hard right now'), common humanity ('this "
    "happens to people carrying what you're carrying'), self-kindness ('what would "
    "you offer someone else in this?'). BACKDRAFT CAUTION: in very self-critical "
    "people warmth can trigger grief or a spike in distress — if that appears, "
    "drop to common humanity ONLY and do not push self-kindness against "
    "resistance.\n\n"

    "BETWEEN SESSIONS (recovering track only): one recovery experience per week, "
    "chosen by the user — not four. Concentrate on psychological detachment (the "
    "strongest predictor of recovery and the first to collapse): concrete and "
    "micro, never a talk about work-life balance — a defined stop time, "
    "notifications off after a set hour, a transition ritual between work and home "
    "(a walk, a change of clothes, one song; for someone working from home, a "
    "manufactured threshold). Relaxation, mastery and control come later.\n\n"

    "SAFETY AND SCOPE. If the picture looks persistent rather than situational, "
    "gently suggest a medical review — depression, thyroid trouble, iron or B12 "
    "deficiency, sleep apnoea, perimenopause and post-viral fatigue can all look "
    "like this. The key discriminator: burnout is domain-bound — the person can "
    "still enjoy the dog, the music, the friend. If enjoyment has drained out of "
    "everything (anhedonia beyond work), that needs a doctor, not a coaching "
    "space. Any hint of suicidality, self-harm or being unable to stay safe exits "
    "this modality to the crisis resources below — do not handle it inside the "
    "flow. You do not diagnose or treat, and you are not a substitute for medical "
    "or psychological care.\n\n"

    "VOICE. Short turns, low word count, one question at a time (stacked questions "
    "are an executive-function tax). No enthusiasm, no exclamation marks, and "
    "never reframe exhaustion as an opportunity. ASK, DON'T DIRECT — offer options "
    "and let the user choose; they are the authority on what their day allows, and "
    "you cannot see their obligations. Rest, stopping, and any next step are "
    "always invitations, never instructions. When a choice would cost effort the "
    "user may not have, make it easier — suggest, narrow it, or let it go — rather "
    "than putting the work of deciding back on them. This modality reads best "
    "spoken slowly."
)

# The guide is the hub's front door: a general coach that can simply talk,
# help set and pursue goals (with full task + memory awareness), and hand the
# user off to a specialist module when one clearly fits.
_GUIDE_SYSTEM = (
    "You are the MadeHappen Coach — the first voice people meet in the AI hub, "
    "and a warm, practical personal coach in your own right. Help the user set "
    "and achieve their goals, think things through, plan, and follow up on what "
    "they're carrying. Plain conversation is always fine; nobody has to pick a "
    "mode. Use what you know about them — their real task list and your "
    "remembered notes — to make support concrete and personal, and ask one "
    "question at a time in a natural, unhurried voice.\n"
    "The hub also has specialist modules:\n"
    "- assistant — Task Assistant: quickly add, edit, organise or clean up "
    "tasks in plain English.\n"
    "- cbt — CBT Coach: a structured 10-step process for when something "
    "specific is troubling them.\n"
    "- action — Action Coach: for when they know what to do but can't start.\n"
    "- exec — Executive Function Coach: a gentle thinking-out-loud space for "
    "neurodivergent minds.\n"
    "- charge — Reducing the Charge: processing heavy emotional resistance.\n"
    "- recovery — Recovery Coach: a gentle, state-paced space for burnout and "
    "depletion, where regulating comes before any planning or doing.\n"
    "- clarity — Clarity Compass: a guided 13-phase decision-making process.\n"
    "When the conversation clearly calls for one of these, call "
    "recommend_module with a short personal reason — the user sees a tappable "
    "card. Recommend at most one or two, only when genuinely better than "
    "continuing here, and never repeat a recommendation the user has already "
    "passed on. You can also manage their tasks directly with the task tools, "
    "following the offer-first rule."
)

COACHES = {
    "guide": {
        "name": "MadeHappen Coach",
        "opener": "Hey, good to see you. I'm here to help you set goals, get "
                  "things done, or just talk through whatever's on your mind. "
                  "What's going on today?",
        "system": _GUIDE_SYSTEM,
    },
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
    "recovery": {
        "name": "Recovery Coach",
        "opener": "I'm glad you're here, and I'll keep this light. Two quick things "
                  "to start: on a scale of 0 to 10, how much is left in the tank "
                  "right now — and is this more of a today thing, or a months "
                  "thing?",
        "system": _RECOVERY_SYSTEM,
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
        "specific, actionable items the user wants to keep. If the user named a "
        "time, keep it OUT of the description and pass scheduled_time / "
        "scheduled_date instead so the task lands on their calendar."
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
                        "description": {
                            "type": "string",
                            "description": "Clean task name with no time-of-day phrases.",
                        },
                        "priority": {
                            "type": "string",
                            "enum": ["urgent", "today", "tomorrow", "later", ""],
                        },
                        "due": {
                            "type": "string",
                            "description": "Natural-language or YYYY-MM-DD due date, or empty.",
                        },
                        "scheduled_time": {
                            "type": "string",
                            "description": "24h HH:MM start time on the user's calendar, or empty.",
                        },
                        "scheduled_date": {
                            "type": "string",
                            "description": "Date for the scheduled time (natural language ok); empty = next upcoming occurrence.",
                        },
                        "duration": {
                            "type": "integer",
                            "description": "Length in minutes (default 30).",
                        },
                        "allow_clash": {
                            "type": "boolean",
                            "description": "Set true ONLY after the user confirms overlapping an existing scheduled task.",
                        },
                        "milestone_id": {
                            "type": "integer",
                            "description": ("Goal milestone this task works toward "
                                            "(id from the goals list). Completing "
                                            "the milestone's last open task marks "
                                            "it done."),
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


# Module ids the guide may recommend (every hub tool except the guide itself).
MODULE_IDS = ("assistant", "cbt", "action", "exec", "charge", "recovery", "clarity")

_RECOMMEND_MODULE_TOOL = {
    "name": "recommend_module",
    "description": (
        "Show the user a tappable card for a hub module that fits what they "
        "need right now. Use sparingly — only when the module would clearly "
        "serve them better than continuing this conversation."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "module": {"type": "string", "enum": list(MODULE_IDS)},
            "reason": {
                "type": "string",
                "description": "One short, personal sentence on why this fits.",
            },
        },
        "required": ["module"],
        "additionalProperties": False,
    },
}


class CoachingService:
    """Runs one coaching turn for a user, with optional task capture."""

    def __init__(self, db, Task, Hat, check_task_limit, CoachMemory=None,
                 ChatUndo=None, Goal=None, GoalMilestone=None, ChatThread=None):
        self.db = db
        self.Task = Task
        self.Hat = Hat
        self.check_task_limit = check_task_limit
        self.CoachMemory = CoachMemory   # persistent cross-conversation memory
        self.ChatUndo = ChatUndo         # enables undo for coach task changes
        self.Goal = Goal                 # goal-setting framework (guide coach)
        self.GoalMilestone = GoalMilestone
        self.ChatThread = ChatThread     # cross-conversation awareness
        # Task edits are delegated to the task assistant's handlers so coaches
        # share its clash checks, field rules and undo snapshots.
        self._editor = _ai_chat.TaskChatService(db, Task, Hat, ChatUndo,
                                                check_task_limit)
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

        system = self._system_prompt(user, coach, coach_id)
        messages = self._build_messages(history, message)

        added_tasks = []      # {description} of tasks saved this turn (for the UI)
        undo_ops = []         # inverse operations for this turn (shared format
        actions = []          #   with ai_chat) + human-facing change summary
        modules = []          # module cards the guide asked the UI to show
        goal_actions = []     # goal changes this turn (for the UI receipt)
        reply_text = ""

        tools = [_SAVE_TASKS_TOOL] + _TASK_EDIT_TOOLS
        if coach_id == "guide":
            tools = tools + [_RECOMMEND_MODULE_TOOL]
            if self.Goal is not None:
                tools = tools + goals_mod.GOAL_TOOLS
        if self.CoachMemory is not None:
            tools = tools + MEMORY_TOOLS

        for _ in range(MAX_TOOL_ITERATIONS):
            response = self.client.messages.create(
                model=MODEL,
                max_tokens=1200,
                system=system,
                tools=tools,
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
                                        block.input, added_tasks, undo_ops,
                                        actions, coach_id, modules, goal_actions)
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": json.dumps(result.get("content", {})),
                    "is_error": result.get("is_error", False),
                })
            messages.append({"role": "user", "content": tool_results})

        if not reply_text:
            reply_text = "I'm here with you."

        undo_token = None
        if undo_ops and self.ChatUndo is not None:
            undo_token = self._editor._save_undo(user.id, undo_ops, actions)

        return {
            "reply": reply_text,
            "coach_id": coach_id,
            "crisis": crisis,
            "crisis_resources": CRISIS_RESOURCES if crisis else [],
            "tasks_added": added_tasks,
            "task_actions": actions,
            "module_suggestions": modules,
            "goal_actions": goal_actions,
            "undo_token": undo_token,
            "undo_available": undo_token is not None,
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
            bits = [f"[#{t.id}] {t.description or ''}"]
            if t.priority:
                bits.append(f"priority: {t.priority}")
            if t.due:
                bits.append(f"due: {t.due}")
            if t.scheduled_time:
                when = t.scheduled_time
                if t.scheduled_date:
                    when += f" on {t.scheduled_date}"
                bits.append(f"scheduled: {when}")
            lines.append("  - " + " · ".join(bits))
        return "\n".join(lines)

    def _system_prompt(self, user, coach, coach_id=""):
        today = datetime.today().strftime("%Y-%m-%d (%A)")
        snapshot = self._task_snapshot(user.id)
        memory = (memory_prompt_block(self.CoachMemory, user.id)
                  if self.CoachMemory is not None else "")
        goals_block = ""
        if coach_id == "guide" and self.Goal is not None:
            goals_block = goals_mod.goals_prompt_block(self.Goal, self.Hat, user.id)
        threads = (thread_context_block(self.ChatThread, user.id, coach_id)
                   if self.ChatThread is not None else "")
        return (
            f"{coach['system']}"
            f"{_TASK_AWARENESS}"
            f"{goals_block}"
            f"{scheduling.SCHEDULING_GUIDANCE}"
            f"\n\nToday is {today}."
            f"\nThe user's current MadeHappen tasks (⏰/scheduled = a planned "
            f"slot on their calendar):\n{snapshot}"
            f"{memory}"
            f"{threads}"
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

    def _dispatch(self, user, default_hat_id, name, args, added_tasks,
                  undo_ops, actions, coach_id="", modules=None,
                  goal_actions=None):
        try:
            if self.Goal is not None and coach_id == "guide":
                handled = goals_mod.handle_goal_tool(
                    self.db, self.Goal, self.Hat, user, name, args,
                    goal_actions if goal_actions is not None else [],
                    Milestone=self.GoalMilestone)
                if handled is not None:
                    return handled
            if name == "save_tasks":
                return self._save_tasks(user, default_hat_id, args, added_tasks,
                                        undo_ops, actions)
            if name == "recommend_module":
                module = (args.get("module") or "").strip()
                if module not in MODULE_IDS:
                    return {"content": {"error": f"Unknown module: {module}"},
                            "is_error": True}
                if modules is not None:
                    modules.append({"module": module,
                                    "reason": (args.get("reason") or "").strip()})
                return {"content": {"ok": True,
                                    "note": "Card shown — mention it briefly."}}
            if name == "list_tasks":
                return self._editor._list_tasks(user.id, args)
            if name == "update_tasks":
                return self._editor._update_tasks(user.id, args, undo_ops, actions)
            if name == "delete_tasks":
                return self._editor._delete_tasks(user.id, args, undo_ops, actions)
            if name == "manage_subtasks":
                return self._editor._manage_subtasks(user.id, args, undo_ops, actions)
            if self.CoachMemory is not None:
                handled = handle_memory_tool(self.db, self.CoachMemory, user,
                                             coach_id, name, args)
                if handled is not None:
                    return handled
            return {"content": {"error": f"Unknown tool: {name}"}, "is_error": True}
        except Exception as e:  # never break the loop — let the model recover
            self.db.session.rollback()
            return {"content": {"error": str(e)}, "is_error": True}

    def _save_tasks(self, user, default_hat_id, args, added_tasks,
                    undo_ops=None, actions=None):
        undo_ops = [] if undo_ops is None else undo_ops
        actions = [] if actions is None else actions
        items = args.get("tasks") or []
        created = []
        clashes = []
        skipped_limit = 0
        for item in items:
            desc = (item.get("description") or "").strip()
            if not desc:
                continue
            if self.check_task_limit(user) is not None:
                skipped_limit += 1
                continue

            # Natural-language scheduling: clean name + a real calendar slot.
            sched_time = scheduling.parse_hhmm(item.get("scheduled_time"))
            sched_date = None
            duration = scheduling.parse_duration(item.get("duration"))
            if sched_time:
                sched_date = scheduling.resolve_date(item.get("scheduled_date"), sched_time)
                if not item.get("allow_clash"):
                    clash = scheduling.find_clash(
                        self.Task, user.id, sched_date, sched_time,
                        duration or scheduling.DEFAULT_DURATION)
                    if clash is not None:
                        clashes.append({
                            "description": desc,
                            "requested_time": sched_time,
                            "requested_date": sched_date,
                            **scheduling.clash_info(clash),
                        })
                        continue

            # Link to a goal milestone when the guide is working a goal plan.
            milestone_id = None
            if item.get("milestone_id") and self.GoalMilestone is not None:
                m = self.GoalMilestone.query.filter_by(
                    id=item["milestone_id"], user_id=user.id).first()
                milestone_id = m.id if m else None

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
                scheduled_time=sched_time,
                scheduled_date=sched_date,
                duration=duration or scheduling.DEFAULT_DURATION,
                milestone_id=milestone_id,
            )
            self.db.session.add(task)
            self.db.session.flush()
            created.append({"id": task.id, "description": desc,
                            "scheduled_time": sched_time, "scheduled_date": sched_date})
        self.db.session.commit()

        for c in created:
            added_tasks.append({"description": c["description"],
                                "scheduled_time": c["scheduled_time"],
                                "scheduled_date": c["scheduled_date"]})
        if created:
            undo_ops.append({"type": "created", "ids": [c["id"] for c in created]})
            actions.append({"action": "added", "count": len(created)})

        result = {"saved_count": len(created)}
        if clashes:
            result["clashes"] = clashes
            result["note"] = ("Some tasks were NOT saved because they overlap "
                              "existing scheduled tasks. Ask the user how to "
                              "proceed: a different time, keep both "
                              "(allow_clash true), or save without a time.")
        if skipped_limit:
            result["skipped_due_to_task_limit"] = skipped_limit
            result["note"] = "Free tier task limit reached; some tasks were not saved."
        return {"content": result}
