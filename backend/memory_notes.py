"""
Persistent memory notes for the AI hub, modeled on how ChatGPT ("saved
memories" / the bio tool) and Claude (the memory tool) handle memory:

- The MODEL writes memory, mid-conversation, through explicit tools
  (memory_save / memory_update / memory_delete) — mirroring OpenAI's bio tool
  and Claude's create/str_replace/delete memory commands.
- Notes are short, dated, third-person facts ("User is preparing for ...").
- EVERY conversation (any coach, the task assistant, any session) gets the
  full note list injected into the system prompt — the equivalent of
  ChatGPT's "Model Set Context" block — so continuity works across and
  between conversations without retrieval infrastructure.
- The model curates: guidance tells it to update or delete notes that have
  become stale, exactly like Claude's memory-tool prompting.
- The user stays in control: notes are listed and deletable via
  /api/coach/memory and the hub's Memory panel.

This module is shared by coaching.py and ai_chat.py. It holds no Flask/DB
imports of its own — callers pass in `db` and the CoachMemory model class.
"""
from __future__ import annotations

from datetime import datetime

MAX_MEMORY_NOTES = 40      # per user; oldest are trimmed when exceeded
NOTE_MAX_CHARS = 500

# Human labels for note provenance shown to the model and in the UI.
SOURCE_LABELS = {
    "": "Task Assistant",
    "assistant": "Task Assistant",
    "cbt": "CBT Coach",
    "action": "Action Coach",
    "exec": "Executive Function Coach",
    "charge": "Reducing the Charge",
    "clarity": "Clarity Compass",
}

MEMORY_TOOLS = [
    {
        "name": "memory_save",
        "description": (
            "Save one or more short, durable notes to your persistent memory "
            "about this user. Memory is shared across every coach and the task "
            "assistant, and across all future conversations. Write each note in "
            "third person, one self-contained fact per note (e.g. \"User is "
            "preparing for a job interview at the end of July.\"). Always save "
            "when the user explicitly asks you to remember something."
        ),
        "strict": True,
        "input_schema": {
            "type": "object",
            "properties": {
                "notes": {
                    "type": "array",
                    "description": "Notes to remember.",
                    "items": {"type": "string"},
                }
            },
            "required": ["notes"],
            "additionalProperties": False,
        },
    },
    {
        "name": "memory_update",
        "description": (
            "Rewrite an existing memory note that has become outdated or "
            "imprecise. Reference the note's id from the memory list in your "
            "context."
        ),
        "strict": True,
        "input_schema": {
            "type": "object",
            "properties": {
                "id": {"type": "integer", "description": "The note id to rewrite."},
                "content": {"type": "string", "description": "The new note text."},
            },
            "required": ["id", "content"],
            "additionalProperties": False,
        },
    },
    {
        "name": "memory_delete",
        "description": (
            "Delete memory notes that are wrong, stale, or that the user asks "
            "you to forget. Reference note ids from the memory list in your "
            "context."
        ),
        "strict": True,
        "input_schema": {
            "type": "object",
            "properties": {
                "ids": {"type": "array", "items": {"type": "integer"}},
            },
            "required": ["ids"],
            "additionalProperties": False,
        },
    },
]

MEMORY_GUIDANCE = (
    "\n\nMEMORY: You have persistent memory that carries across all "
    "conversations with this user — every coach and the task assistant share "
    "it. Your saved notes appear below; consult them before responding and "
    "use them naturally for continuity (reference what you know when it "
    "helps; never recite the list or announce that you are using memory).\n"
    "- Save (memory_save): durable, useful facts — ongoing goals and "
    "projects, preferences, life context, recurring themes, approaches that "
    "helped, commitments made. Third person, one fact per note. Always save "
    "when the user says something like 'remember that...'.\n"
    "- Curate (memory_update / memory_delete): when a note is outdated, "
    "rewrite it; when it is wrong or the user asks you to forget something, "
    "delete it and confirm briefly.\n"
    "- Do NOT save: passing moods, one-off details, anything the user asks "
    "you not to keep, or sensitive disclosures (health, crisis content) "
    "unless the user explicitly asks you to remember them."
)


def memory_snapshot(CoachMemory, user_id):
    """The 'Model Set Context'-style block injected into the system prompt."""
    notes = (CoachMemory.query.filter_by(user_id=user_id)
             .order_by(CoachMemory.created_at, CoachMemory.id).all())
    if not notes:
        return "  (no saved memories yet)"
    lines = []
    for n in notes:
        date = n.created_at.strftime("%Y-%m-%d") if n.created_at else ""
        src = SOURCE_LABELS.get(n.coach_id or "", n.coach_id or "")
        lines.append(f"  [#{n.id} · {date} · {src}] {n.content}")
    return "\n".join(lines)


def memory_prompt_block(CoachMemory, user_id):
    return (
        f"{MEMORY_GUIDANCE}\n\nSaved memories (oldest first):\n"
        f"{memory_snapshot(CoachMemory, user_id)}"
    )


def handle_memory_tool(db, CoachMemory, user, source_id, name, args):
    """Execute a memory tool call. Returns a result dict, or None if `name`
    isn't a memory tool (so callers can fall through to their own tools)."""
    if name == "memory_save":
        return _save(db, CoachMemory, user, source_id, args)
    if name == "memory_update":
        return _update(db, CoachMemory, user, args)
    if name == "memory_delete":
        return _delete(db, CoachMemory, user, args)
    return None


def _save(db, CoachMemory, user, source_id, args):
    notes = [(_n or "").strip()[:NOTE_MAX_CHARS] for _n in (args.get("notes") or [])]
    notes = [n for n in notes if n]
    saved_ids = []
    for content in notes:
        row = CoachMemory(user_id=user.id, coach_id=(source_id or ""),
                          content=content, created_at=datetime.utcnow())
        db.session.add(row)
        db.session.flush()
        saved_ids.append(row.id)

    # Keep the store bounded: trim the oldest notes beyond the cap.
    trimmed = []
    overflow = (CoachMemory.query.filter_by(user_id=user.id)
                .order_by(CoachMemory.created_at.desc(), CoachMemory.id.desc())
                .offset(MAX_MEMORY_NOTES).all())
    for old in overflow:
        trimmed.append(old.id)
        db.session.delete(old)
    db.session.commit()

    result = {"saved_ids": saved_ids, "saved_count": len(saved_ids)}
    if trimmed:
        result["trimmed_oldest_ids"] = trimmed
        result["note"] = ("Memory is at capacity; the oldest notes were removed. "
                          "Prefer memory_update / memory_delete to keep it current.")
    return {"content": result}


def _update(db, CoachMemory, user, args):
    row = CoachMemory.query.filter_by(id=args.get("id"), user_id=user.id).first()
    if not row:
        return {"content": {"error": "No such memory note."}, "is_error": True}
    content = (args.get("content") or "").strip()[:NOTE_MAX_CHARS]
    if not content:
        return {"content": {"error": "New content is empty."}, "is_error": True}
    row.content = content
    db.session.commit()
    return {"content": {"updated_id": row.id}}


def _delete(db, CoachMemory, user, args):
    deleted = []
    for mid in (args.get("ids") or []):
        row = CoachMemory.query.filter_by(id=mid, user_id=user.id).first()
        if row:
            deleted.append(row.id)
            db.session.delete(row)
    db.session.commit()
    return {"content": {"deleted_ids": deleted, "deleted_count": len(deleted)}}
