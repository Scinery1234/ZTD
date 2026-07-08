"""
Cross-conversation awareness for the AI hub.

Every tool (the guide, the task assistant, and each coach) keeps its own
saved thread — but they should feel like one team that talks to each other.
This module builds a compact digest of the user's OTHER recent threads that
gets injected into whichever tool is currently speaking, so the CBT coach
knows what was agreed with the guide, the assistant knows what the action
coach is working on, and so on.

Excerpts are trimmed hard (few messages, few hundred chars each) so the
block stays a small fraction of the prompt.
"""
from __future__ import annotations

TOOL_LABELS = {
    "assistant": "Task Assistant",
    "guide": "MadeHappen Coach (main chat)",
    "cbt": "CBT Coach",
    "action": "Action Coach",
    "exec": "Executive Function Coach",
    "charge": "Reducing the Charge",
    "clarity": "Clarity Compass",
}

MAX_THREADS = 7          # newest-first cap on other conversations included
MAX_MSGS_PER_THREAD = 4  # tail messages per conversation
MAX_CHARS_PER_MSG = 240


def thread_context_block(ChatThread, user_id, exclude_tool_id):
    """Digest of the user's other conversations for a tool's system prompt.
    Returns "" when there is nothing to share."""
    threads = (ChatThread.query.filter_by(user_id=user_id)
               .order_by(ChatThread.updated_at.desc())
               .limit(MAX_THREADS + 1).all())
    sections = []
    for t in threads:
        if t.tool_id == exclude_tool_id or len(sections) >= MAX_THREADS:
            continue
        msgs = t.messages_list()[-MAX_MSGS_PER_THREAD:]
        lines = []
        for m in msgs:
            content = (m.get("content") or "").strip().replace("\n", " ")
            if not content:
                continue
            role = "User" if m.get("role") == "user" else "AI"
            lines.append(f"    {role}: {content[:MAX_CHARS_PER_MSG]}")
        if lines:
            label = TOOL_LABELS.get(t.tool_id, t.tool_id)
            sections.append(f"  [{label}]\n" + "\n".join(lines))
    if not sections:
        return ""
    return (
        "\n\nOTHER CONVERSATIONS: The user also talks with the hub's other "
        "spaces — you are one team. Recent excerpts (newest conversation "
        "first) so you stay on the same page. Draw on them naturally when "
        "relevant; don't recap them unprompted or claim those words as your "
        "own:\n" + "\n".join(sections)
    )
