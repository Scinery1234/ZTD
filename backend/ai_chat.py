"""
AI Chat for task management.

Exposes a Claude tool-use loop that lets a user add, delete, and bulk-modify
their tasks in natural language, plus a per-turn undo stack.

Design notes:
- The model only *proposes* tool calls. Every mutation is executed by the
  handlers in this module against SQLAlchemy, scoped to the authenticated user.
  The model never touches the database directly, so it is the security boundary,
  not the model.
- Each chat turn records the inverse of every mutation it makes (a snapshot)
  into the ChatUndo table, so a single Undo reliably reverts the whole turn.
- This module avoids importing app.py at module load time (no circular import):
  the route in app.py constructs TaskChatService with the model classes and
  helpers it needs.
"""
from __future__ import annotations

import json
import os
from datetime import datetime

try:
    import anthropic
except ImportError:  # SDK optional — feature self-disables when absent
    anthropic = None

import dateparser

try:
    from memory_notes import MEMORY_TOOLS, memory_prompt_block, handle_memory_tool
except ImportError:  # loaded standalone (no backend/ on sys.path)
    import importlib.util as _ilu
    _spec = _ilu.spec_from_file_location(
        'memory_notes', os.path.join(os.path.dirname(__file__), 'memory_notes.py')
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
    _spec2 = _ilu2.spec_from_file_location(
        'scheduling', os.path.join(os.path.dirname(__file__), 'scheduling.py')
    )
    scheduling = _ilu2.module_from_spec(_spec2)
    _spec2.loader.exec_module(scheduling)

try:
    from thread_context import thread_context_block
except ImportError:  # loaded standalone (no backend/ on sys.path)
    import importlib.util as _ilu3
    _spec3 = _ilu3.spec_from_file_location(
        'thread_context', os.path.join(os.path.dirname(__file__), 'thread_context.py')
    )
    _tc = _ilu3.module_from_spec(_spec3)
    _spec3.loader.exec_module(_tc)
    thread_context_block = _tc.thread_context_block

MODEL = "claude-opus-4-8"
MAX_MESSAGE_CHARS = 2000
MAX_HISTORY_TURNS = 12        # client-supplied prior turns to carry into context
MAX_TOOL_ITERATIONS = 8       # safety cap on the agentic loop
MAX_UNDO_ENTRIES = 10         # per-user undo-stack depth

# Fields the model is allowed to set/change on a task (also what undo restores).
_EDITABLE_FIELDS = ("description", "category", "priority", "recurring", "due",
                    "hat_id", "scheduled_time", "scheduled_date", "duration")


def chat_available() -> bool:
    """True when the feature can run (SDK importable + API key configured)."""
    return anthropic is not None and bool(os.getenv("ANTHROPIC_API_KEY"))


def _parse_due(value):
    """Normalize a natural-language due date to YYYY-MM-DD (mirrors the REST route)."""
    text = (value or "").strip()
    if not text:
        return None
    parsed = dateparser.parse(text)
    return parsed.strftime("%Y-%m-%d") if parsed else text


_subtask_seq = 0


def _new_subtask_id():
    """Unique-per-process subtask id (matches the client's `st-*` convention)."""
    global _subtask_seq
    _subtask_seq += 1
    return f"st-ai-{_subtask_seq}"


def _normalize_subtasks(raw):
    """Coerce a stored subtask list into [{id, text, done}] dicts."""
    items = []
    for s in raw or []:
        if isinstance(s, dict):
            items.append({
                "id": s.get("id") or _new_subtask_id(),
                "text": (s.get("text") or "").strip(),
                "done": bool(s.get("done")),
            })
        elif s is not None:
            items.append({"id": _new_subtask_id(), "text": str(s).strip(), "done": False})
    return items


# ---- Tool schemas (strict so inputs validate exactly) ----
TOOLS = [
    {
        "name": "list_tasks",
        "description": (
            "List the user's current active tasks. Call this first whenever the "
            "request refers to existing tasks (e.g. 'delete my shopping tasks', "
            "'make everything due tomorrow urgent') so you can resolve them to "
            "real task ids before modifying or deleting. Returns id, description, "
            "category, priority, recurring, due, hat_id and the calendar slot "
            "(scheduled_time, scheduled_date, duration) for each match."
        ),
        "strict": True,
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Optional case-insensitive substring to match in the description.",
                },
                "category": {"type": "string", "description": "Optional exact category filter."},
                "priority": {
                    "type": "string",
                    "description": "Optional priority filter.",
                    "enum": ["urgent", "today", "tomorrow", "later", ""],
                },
            },
            "required": ["query", "category", "priority"],
            "additionalProperties": False,
        },
    },
    {
        "name": "add_tasks",
        "description": (
            "Create one or more new tasks for the user. Use structured fields; do "
            "not embed @category/!priority/~recurring markers in the description. "
            "If the user named a time of day, keep it OUT of the description and "
            "pass scheduled_time / scheduled_date so the task lands on their "
            "calendar."
        ),
        "strict": True,
        "input_schema": {
            "type": "object",
            "properties": {
                "tasks": {
                    "type": "array",
                    "description": "Tasks to create.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "description": {
                                "type": "string",
                                "description": "Clean task name with no time-of-day phrases.",
                            },
                            "category": {"type": "string"},
                            "priority": {
                                "type": "string",
                                "enum": ["urgent", "today", "tomorrow", "later", ""],
                            },
                            "recurring": {
                                "type": "string",
                                "enum": ["daily", "weekly", "monthly", ""],
                            },
                            "due": {
                                "type": "string",
                                "description": "Natural-language or YYYY-MM-DD due date, or empty.",
                            },
                            "scheduled_time": {
                                "type": "string",
                                "description": "24h HH:MM calendar start time, or empty.",
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
                        },
                        "required": ["description", "category", "priority", "recurring", "due"],
                        "additionalProperties": False,
                    },
                }
            },
            "required": ["tasks"],
            "additionalProperties": False,
        },
    },
    {
        "name": "update_tasks",
        "description": (
            "Bulk-edit existing tasks. Each update targets a task by id and sets "
            "one or more fields. Only include the fields you want to change; omit "
            "the rest. Get ids from list_tasks first."
        ),
        "strict": True,
        "input_schema": {
            "type": "object",
            "properties": {
                "updates": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "id": {"type": "integer"},
                            "description": {"type": "string"},
                            "category": {"type": "string"},
                            "priority": {
                                "type": "string",
                                "enum": ["urgent", "today", "tomorrow", "later", ""],
                            },
                            "recurring": {
                                "type": "string",
                                "enum": ["daily", "weekly", "monthly", ""],
                            },
                            "due": {"type": "string"},
                            "scheduled_time": {
                                "type": "string",
                                "description": "24h HH:MM calendar start time; empty string unschedules.",
                            },
                            "scheduled_date": {
                                "type": "string",
                                "description": "Date for the scheduled time (natural language ok).",
                            },
                            "duration": {
                                "type": "integer",
                                "description": "Length in minutes.",
                            },
                            "allow_clash": {
                                "type": "boolean",
                                "description": "Set true ONLY after the user confirms overlapping an existing scheduled task.",
                            },
                        },
                        "required": ["id"],
                        "additionalProperties": False,
                    },
                }
            },
            "required": ["updates"],
            "additionalProperties": False,
        },
    },
    {
        "name": "delete_tasks",
        "description": "Permanently delete tasks by id. Get ids from list_tasks first.",
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
    {
        "name": "manage_subtasks",
        "description": (
            "Add, rename, check off / uncheck, or remove the subtasks (checklist "
            "items) of a single task. Call list_tasks first to get the task's id "
            "and its current subtasks — each is returned with a 1-based `index`. "
            "Reference existing subtasks by that index for update/remove. Use "
            "empty arrays for the operations you don't need."
        ),
        "strict": True,
        "input_schema": {
            "type": "object",
            "properties": {
                "task_id": {"type": "integer", "description": "Parent task id (from list_tasks)."},
                "add": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "New subtask texts to append.",
                },
                "update": {
                    "type": "array",
                    "description": "Edits to existing subtasks, targeted by 1-based index.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "index": {"type": "integer", "description": "1-based index from list_tasks."},
                            "text": {"type": "string", "description": "New text (omit to keep)."},
                            "done": {"type": "boolean", "description": "Completed state (omit to keep)."},
                        },
                        "required": ["index"],
                        "additionalProperties": False,
                    },
                },
                "remove": {
                    "type": "array",
                    "items": {"type": "integer"},
                    "description": "1-based indices of subtasks to remove.",
                },
            },
            "required": ["task_id", "add", "update", "remove"],
            "additionalProperties": False,
        },
    },
]


class TaskChatService:
    """Runs the chat loop and executes task mutations for one request."""

    def __init__(self, db, Task, Hat, ChatUndo, check_task_limit, CoachMemory=None,
                 ChatThread=None):
        self.db = db
        self.Task = Task
        self.Hat = Hat
        self.ChatUndo = ChatUndo
        self.check_task_limit = check_task_limit
        self.CoachMemory = CoachMemory   # persistent cross-conversation memory
        self.ChatThread = ChatThread     # cross-conversation awareness
        self.client = anthropic.Anthropic() if anthropic is not None else None

    # ---- public entry point ----
    def run(self, user, hat_id, message, history):
        """Execute one chat turn. Returns a JSON-serializable dict."""
        hats = self.Hat.query.filter_by(user_id=user.id).order_by(self.Hat.position, self.Hat.id).all()
        default_hat_id = self._resolve_default_hat(user.id, hat_id, hats)

        system = self._system_prompt(user, hats, default_hat_id)
        messages = self._build_messages(history, message)

        # Accumulators across the agentic loop.
        undo_ops = []      # inverse operations, applied in reverse to undo this turn
        actions = []       # human-facing summary of what changed (for the UI)

        reply_text = ""
        tools = TOOLS if self.CoachMemory is None else TOOLS + MEMORY_TOOLS
        for _ in range(MAX_TOOL_ITERATIONS):
            response = self.client.messages.create(
                model=MODEL,
                max_tokens=4096,
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

            # Preserve the assistant turn (including tool_use blocks) verbatim.
            messages.append({"role": "assistant", "content": response.content})

            tool_results = []
            for block in tool_uses:
                result = self._dispatch(user, default_hat_id, block.name, block.input,
                                        undo_ops, actions)
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": json.dumps(result.get("content", {})),
                    "is_error": result.get("is_error", False),
                })
            messages.append({"role": "user", "content": tool_results})

        undo_token = None
        if undo_ops:
            undo_token = self._save_undo(user.id, undo_ops, actions)

        if not reply_text:
            reply_text = "Done." if actions else "I didn't make any changes."

        return {
            "reply": reply_text,
            "actions": actions,
            "undo_token": undo_token,
            "undo_available": undo_token is not None,
        }

    # ---- undo ----
    def undo(self, user, undo_token=None):
        """Revert the most recent chat turn (or a specific one by id)."""
        q = self.ChatUndo.query.filter_by(user_id=user.id)
        if undo_token is not None:
            entry = q.filter_by(id=undo_token).first()
        else:
            entry = q.order_by(self.ChatUndo.id.desc()).first()
        if not entry:
            return {"undone": False, "message": "Nothing to undo."}

        try:
            ops = json.loads(entry.payload or "[]")
        except Exception:
            ops = []

        # Apply inverses in reverse order so dependent ops unwind cleanly.
        for op in reversed(ops):
            self._apply_inverse(user.id, op)

        summary = entry.summary or "the last change"
        self.db.session.delete(entry)
        self.db.session.commit()
        return {"undone": True, "message": f"Undid {summary}."}

    # ---- internals ----
    def _resolve_default_hat(self, user_id, hat_id, hats):
        if hat_id:
            hat = next((h for h in hats if h.id == hat_id), None)
            if hat:
                return hat.id
        main = next((h for h in hats if h.name == "Main Hat"), None)
        return main.id if main else None

    def _task_snapshot(self, user_id, limit=40):
        """Compact current-task view (with ids) so the assistant starts every
        conversation already aware of the list; list_tasks stays available for
        fresh or filtered reads."""
        q = (self.Task.query.filter_by(user_id=user_id)
             .order_by(self.Task.position, self.Task.id))
        tasks = q.limit(limit + 1).all()
        truncated = len(tasks) > limit
        tasks = tasks[:limit]
        if not tasks:
            return "  (no tasks yet)"
        lines = []
        for t in tasks:
            bits = [f"[#{t.id}] {t.description or ''}"]
            if t.category:
                bits.append(f"@{t.category}")
            if t.priority:
                bits.append(f"!{t.priority}")
            if t.due:
                bits.append(f"due {t.due}")
            if t.scheduled_time:
                when = f"⏰ {t.scheduled_time}"
                if t.scheduled_date:
                    when += f" on {t.scheduled_date}"
                if t.duration:
                    when += f" ({t.duration}min)"
                bits.append(when)
            lines.append("  " + " · ".join(bits))
        if truncated:
            lines.append("  … (more tasks exist — use list_tasks for the full view)")
        return "\n".join(lines)

    def _system_prompt(self, user, hats, default_hat_id):
        today = datetime.today().strftime("%Y-%m-%d (%A)")
        hat_lines = "\n".join(f"  - id {h.id}: {h.name}" for h in hats) or "  (none)"
        snapshot = self._task_snapshot(user.id)
        memory = (memory_prompt_block(self.CoachMemory, user.id)
                  if self.CoachMemory is not None else "")
        threads = (thread_context_block(self.ChatThread, user.id, "assistant")
                   if self.ChatThread is not None else "")
        return (
            "You are the task assistant for MadeHappen, a to-do app. You help the "
            "user add, delete, and bulk-modify their tasks through the provided "
            "tools.\n\n"
            f"Today is {today}.\n"
            "The user's workspaces ('hats') are:\n"
            f"{hat_lines}\n"
            f"New tasks default to hat id {default_hat_id} unless the user clearly "
            "means another hat.\n\n"
            "Guidelines:\n"
            "- When the request refers to existing tasks ('my groceries', "
            "'everything urgent'), call list_tasks first to resolve real ids, then "
            "act. Never guess ids.\n"
            "- Prefer a single bulk tool call over many small ones.\n"
            "- A task can have subtasks (a checklist). Use manage_subtasks to add, "
            "rename, check off, or remove them — call list_tasks first to get the "
            "task id and the subtasks' 1-based indices.\n"
            "- Priority must be one of: urgent, today, tomorrow, later. Recurring "
            "must be one of: daily, weekly, monthly.\n"
            "- Only delete tasks the user clearly asked to delete. If a request is "
            "ambiguous or would affect many tasks unexpectedly, ask a brief "
            "clarifying question instead of acting.\n"
            "- After acting, reply with one short, friendly sentence summarizing "
            "what you changed.\n\n"
            "The user's current tasks (may be truncated — ids are real; ⏰ marks "
            "a planned slot on their calendar):\n"
            f"{snapshot}"
            f"{scheduling.SCHEDULING_GUIDANCE}"
            f"{memory}"
            f"{threads}"
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
        if messages[0]["role"] != "user":
            messages = messages[1:]
        return messages

    def _dispatch(self, user, default_hat_id, name, args, undo_ops, actions):
        try:
            if name == "list_tasks":
                return self._list_tasks(user.id, args)
            if name == "add_tasks":
                return self._add_tasks(user, default_hat_id, args, undo_ops, actions)
            if name == "update_tasks":
                return self._update_tasks(user.id, args, undo_ops, actions)
            if name == "delete_tasks":
                return self._delete_tasks(user.id, args, undo_ops, actions)
            if name == "manage_subtasks":
                return self._manage_subtasks(user.id, args, undo_ops, actions)
            if self.CoachMemory is not None:
                handled = handle_memory_tool(self.db, self.CoachMemory, user,
                                             "assistant", name, args)
                if handled is not None:
                    return handled
            return {"content": {"error": f"Unknown tool: {name}"}, "is_error": True}
        except Exception as e:  # never 500 the loop — let the model recover
            self.db.session.rollback()
            return {"content": {"error": str(e)}, "is_error": True}

    def _valid_hat_id(self, user_id, hat_id, default_hat_id):
        if hat_id:
            hat = self.Hat.query.filter_by(id=hat_id, user_id=user_id).first()
            if hat:
                return hat.id
        return default_hat_id

    def _list_tasks(self, user_id, args):
        q = self.Task.query.filter_by(user_id=user_id)
        category = (args.get("category") or "").strip()
        priority = (args.get("priority") or "").strip()
        if category:
            q = q.filter(self.Task.category == category)
        if priority:
            q = q.filter(self.Task.priority == priority)
        tasks = q.order_by(self.Task.position, self.Task.id).all()
        query = (args.get("query") or "").strip().lower()
        rows = []
        for t in tasks:
            if query and query not in (t.description or "").lower():
                continue
            rows.append({
                "id": t.id,
                "description": t.description,
                "category": t.category or "",
                "priority": t.priority or "",
                "recurring": t.recurring or "",
                "due": t.due,
                "hat_id": t.hat_id,
                "scheduled_time": t.scheduled_time,
                "scheduled_date": t.scheduled_date,
                "duration": t.duration,
                # 1-based indices so manage_subtasks can target them directly.
                "subtasks": [
                    {"index": i + 1, "text": s.get("text", ""), "done": bool(s.get("done"))}
                    for i, s in enumerate(_normalize_subtasks(t.subtasks_list()))
                ],
            })
        return {"content": {"tasks": rows, "count": len(rows)}}

    def _add_tasks(self, user, default_hat_id, args, undo_ops, actions):
        items = args.get("tasks") or []
        created_ids = []
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

            max_pos = (self.db.session.query(self.db.func.max(self.Task.position))
                       .filter_by(user_id=user.id).scalar() or 0)
            task = self.Task(
                user_id=user.id,
                hat_id=self._valid_hat_id(user.id, item.get("hat_id"), default_hat_id),
                description=desc,
                category=(item.get("category") or "").strip(),
                priority=(item.get("priority") or "").strip(),
                recurring=(item.get("recurring") or "").strip(),
                due=_parse_due(item.get("due")),
                position=max_pos + 1,
                scheduled_time=sched_time,
                scheduled_date=sched_date,
                duration=duration or scheduling.DEFAULT_DURATION,
            )
            self.db.session.add(task)
            self.db.session.flush()  # assign id
            created_ids.append(task.id)
        self.db.session.commit()

        if created_ids:
            undo_ops.append({"type": "created", "ids": created_ids})
            actions.append({"action": "added", "count": len(created_ids)})
        result = {"added_ids": created_ids, "added_count": len(created_ids)}
        if clashes:
            result["clashes"] = clashes
            result["note"] = ("Some tasks were NOT added because they overlap "
                              "existing scheduled tasks. Ask the user how to "
                              "proceed: a different time, keep both "
                              "(allow_clash true), or add without a time.")
        if skipped_limit:
            result["skipped_due_to_task_limit"] = skipped_limit
            result["note"] = "Free tier task limit reached; some tasks were not added."
        return {"content": result}

    def _update_tasks(self, user_id, args, undo_ops, actions):
        updates = args.get("updates") or []
        before = []
        changed_ids = []
        clashes = []
        for upd in updates:
            tid = upd.get("id")
            task = self.Task.query.filter_by(id=tid, user_id=user_id).first()
            if not task:
                continue

            # Rescheduling: validate the new slot before touching the task.
            new_time = None
            if "scheduled_time" in upd:
                new_time = scheduling.parse_hhmm(upd.get("scheduled_time"))
                if new_time:
                    duration = (scheduling.parse_duration(upd.get("duration"))
                                or task.duration or scheduling.DEFAULT_DURATION)
                    new_date = scheduling.resolve_date(upd.get("scheduled_date"), new_time)
                    if not upd.get("allow_clash"):
                        clash = scheduling.find_clash(
                            self.Task, user_id, new_date, new_time, duration,
                            exclude_id=task.id)
                        if clash is not None:
                            clashes.append({
                                "description": task.description,
                                "requested_time": new_time,
                                "requested_date": new_date,
                                **scheduling.clash_info(clash),
                            })
                            continue

            before.append(task.to_dict())
            for field in _EDITABLE_FIELDS:
                if field not in upd:
                    continue
                if field == "due":
                    task.due = _parse_due(upd.get("due"))
                elif field == "hat_id":
                    hid = upd.get("hat_id")
                    if hid:
                        hat = self.Hat.query.filter_by(id=hid, user_id=user_id).first()
                        task.hat_id = hat.id if hat else task.hat_id
                    else:
                        task.hat_id = None
                elif field == "scheduled_time":
                    task.scheduled_time = new_time
                    task.scheduled_date = (
                        scheduling.resolve_date(upd.get("scheduled_date"), new_time)
                        if new_time else None)
                elif field == "scheduled_date":
                    pass  # handled with scheduled_time
                elif field == "duration":
                    dur = scheduling.parse_duration(upd.get("duration"))
                    if dur:
                        task.duration = dur
                else:
                    setattr(task, field, (upd.get(field) or "").strip()
                            if field != "description" else (upd.get(field) or task.description))
            changed_ids.append(tid)
        self.db.session.commit()

        if before:
            undo_ops.append({"type": "updated", "before": before})
            actions.append({"action": "updated", "count": len(before)})
        result = {"updated_ids": changed_ids, "updated_count": len(changed_ids)}
        if clashes:
            result["clashes"] = clashes
            result["note"] = ("Some updates were NOT applied because the new "
                              "time overlaps existing scheduled tasks. Ask the "
                              "user how to proceed (different time, keep both "
                              "with allow_clash true, or leave as is).")
        return {"content": result}

    def _delete_tasks(self, user_id, args, undo_ops, actions):
        ids = args.get("ids") or []
        removed = []
        for tid in ids:
            task = self.Task.query.filter_by(id=tid, user_id=user_id).first()
            if not task:
                continue
            removed.append(task.to_dict())
            self.db.session.delete(task)
        self.db.session.commit()

        if removed:
            undo_ops.append({"type": "deleted", "tasks": removed})
            actions.append({"action": "deleted", "count": len(removed)})
        return {"content": {"deleted_count": len(removed)}}

    def _manage_subtasks(self, user_id, args, undo_ops, actions):
        task = self.Task.query.filter_by(id=args.get("task_id"), user_id=user_id).first()
        if not task:
            return {"content": {"error": "Task not found."}, "is_error": True}

        before = task.to_dict()  # full snapshot (includes subtasks) for undo
        items = _normalize_subtasks(task.subtasks_list())
        n = len(items)

        # Apply edits first (no length change), then removals high→low, then adds,
        # so every 1-based index still refers to the original list.
        for upd in (args.get("update") or []):
            idx = upd.get("index")
            if not isinstance(idx, int) or not (1 <= idx <= n):
                continue
            if upd.get("text") is not None and str(upd["text"]).strip():
                items[idx - 1]["text"] = str(upd["text"]).strip()
            if upd.get("done") is not None:
                items[idx - 1]["done"] = bool(upd["done"])

        remove = sorted({i for i in (args.get("remove") or [])
                         if isinstance(i, int) and 1 <= i <= n}, reverse=True)
        for i in remove:
            items.pop(i - 1)

        for txt in (args.get("add") or []):
            text = (str(txt) if txt is not None else "").strip()
            if text:
                items.append({"id": _new_subtask_id(), "text": text, "done": False})

        task.subtasks = json.dumps(items)
        self.db.session.commit()

        undo_ops.append({"type": "updated", "before": [before]})
        actions.append({"action": "updated", "count": 1})
        return {"content": {
            "task_id": task.id,
            "subtask_count": len(items),
            "subtasks": [{"index": i + 1, "text": s["text"], "done": s["done"]}
                         for i, s in enumerate(items)],
        }}

    # ---- undo application ----
    def _apply_inverse(self, user_id, op):
        kind = op.get("type")
        if kind == "created":
            # Undo an add → delete the created tasks.
            for tid in op.get("ids", []):
                task = self.Task.query.filter_by(id=tid, user_id=user_id).first()
                if task:
                    self.db.session.delete(task)
        elif kind == "deleted":
            # Undo a delete → recreate the tasks (new ids).
            for d in op.get("tasks", []):
                self.db.session.add(self._task_from_dict(user_id, d))
        elif kind == "updated":
            # Undo an edit → restore prior field values (recreate if since deleted).
            for d in op.get("before", []):
                task = self.Task.query.filter_by(id=d.get("id"), user_id=user_id).first()
                if task:
                    for field in _EDITABLE_FIELDS:
                        if field in d:
                            setattr(task, field, d[field])
                    # Subtasks live outside _EDITABLE_FIELDS; restore when snapshotted.
                    if "subtasks" in d:
                        task.subtasks = json.dumps(d.get("subtasks") or [])
                else:
                    self.db.session.add(self._task_from_dict(user_id, d))

    def _task_from_dict(self, user_id, d):
        max_pos = (self.db.session.query(self.db.func.max(self.Task.position))
                   .filter_by(user_id=user_id).scalar() or 0)
        return self.Task(
            user_id=user_id,
            hat_id=d.get("hat_id"),
            description=d.get("description", ""),
            category=d.get("category", "") or "",
            priority=d.get("priority", "") or "",
            recurring=d.get("recurring", "") or "",
            due=d.get("due"),
            position=d.get("position") or (max_pos + 1),
            subtasks=json.dumps(d.get("subtasks", [])) if d.get("subtasks") else "[]",
            duration=d.get("duration") or 30,
            scheduled_time=d.get("scheduled_time"),
            scheduled_date=d.get("scheduled_date"),
            notes=d.get("notes") or None,
        )

    def _save_undo(self, user_id, undo_ops, actions):
        summary = self._summarize(actions)
        entry = self.ChatUndo(user_id=user_id, summary=summary, payload=json.dumps(undo_ops))
        self.db.session.add(entry)
        self.db.session.commit()

        # Trim to the most recent MAX_UNDO_ENTRIES per user.
        stale = (self.ChatUndo.query.filter_by(user_id=user_id)
                 .order_by(self.ChatUndo.id.desc())
                 .offset(MAX_UNDO_ENTRIES).all())
        for s in stale:
            self.db.session.delete(s)
        if stale:
            self.db.session.commit()
        return entry.id

    def _summarize(self, actions):
        parts = []
        for a in actions:
            n = a.get("count", 0)
            verb = a.get("action")
            parts.append(f"{verb} {n} task{'s' if n != 1 else ''}")
        return ", ".join(parts) or "no changes"
