"""
Shared scheduling helpers for the AI hub tools (task assistant + coaches).

When the user mentions a concrete time ("exercise at 6am tomorrow"), the model
passes a clean task name plus scheduled_time / scheduled_date instead of baking
the time into the name. These helpers normalize those values and detect clashes
with tasks already on the user's timebox so the model can ask the user how to
resolve them rather than silently double-booking.
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta

try:
    import dateparser
except ImportError:  # pragma: no cover - dateparser ships with the app
    dateparser = None

try:
    import pytz
except ImportError:  # pragma: no cover - pytz is pinned in requirements.txt
    pytz = None

DEFAULT_DURATION = 30  # minutes, mirrors the Task model default

_HHMM = re.compile(r"^(\d{1,2}):(\d{2})$")


def local_now(tz_name=None):
    """What time it is for the user, as (naive local datetime, canonical tz name).

    The server runs in UTC, so its own clock is wrong for anyone elsewhere: for
    an Australian user it reports yesterday for roughly the first eleven hours
    of every day, and "9am" scheduled "later today" lands on tomorrow. The
    browser knows the real zone and sends its IANA name with each message; this
    turns that into the user's wall-clock time.

    The name is user-controlled and ends up in a prompt, so it is only used if
    it's a zone pytz recognises, and what's returned is pytz's own spelling of
    it — never the raw input. Anything else falls back to UTC, and the second
    value is None so callers can say the zone is a guess instead of pretending.
    """
    if pytz is not None and isinstance(tz_name, str) and tz_name in pytz.all_timezones_set:
        tz = pytz.timezone(tz_name)
        return datetime.now(tz).replace(tzinfo=None), tz.zone
    return datetime.utcnow(), None


def clock_line(now, tz_name=None):
    """The sentence that tells the model when "now" is.

    Always states both the date and the time, and the zone — or says plainly
    that the zone is unknown. Without the time the model can't tell "this
    morning" from "tonight"; without the zone it can't tell whose clock it is.
    """
    stamp = f"{now.strftime('%Y-%m-%d')} ({now.strftime('%A')}) at {now.strftime('%H:%M')}"
    if tz_name:
        offset = pytz.timezone(tz_name).localize(now).strftime("%z") if pytz else ""
        offset = f"UTC{offset[:3]}:{offset[3:]}" if offset else ""
        where = f"{tz_name}{', ' + offset if offset else ''}"
        return (f"The current date and time for the user is {stamp} ({where}). "
                "You always know this — never say you can't tell the date or time. "
                "Resolve 'today', 'tonight', 'tomorrow', 'this afternoon' and "
                "weekday names from it.")
    return (f"The current date and time is {stamp} UTC. The user's timezone is not "
            "known, so their local time may differ by up to a day: if the exact "
            "date or time matters for what they asked, ask what their local time is.")


def parse_hhmm(value):
    """Normalize a time to 'HH:MM' (24h). Accepts '06:00', '6:00', or natural
    language like '6am' / '6.30 pm'. Returns None when there is no time."""
    text = (value or "").strip()
    if not text:
        return None
    m = _HHMM.match(text)
    if m:
        h, mi = int(m.group(1)), int(m.group(2))
        if 0 <= h <= 23 and 0 <= mi <= 59:
            return f"{h:02d}:{mi:02d}"
        return None
    if dateparser is not None:
        parsed = dateparser.parse(text)
        if parsed is not None:
            return parsed.strftime("%H:%M")
    return None


def resolve_date(date_text, time_hhmm, now=None):
    """Resolve a natural-language date to YYYY-MM-DD. With a time but no date,
    schedule for today if the time is still ahead, otherwise tomorrow."""
    now = now or datetime.now()
    text = (date_text or "").strip()
    if text:
        if re.match(r"^\d{4}-\d{2}-\d{2}$", text):
            return text
        if dateparser is not None:
            parsed = dateparser.parse(
                text, settings={"PREFER_DATES_FROM": "future",
                                "RELATIVE_BASE": now})
            if parsed is not None:
                return parsed.strftime("%Y-%m-%d")
        # Unparseable date text — fall through to the default rule.
    if not time_hhmm:
        return None
    h, mi = (int(p) for p in time_hhmm.split(":"))
    if (h, mi) <= (now.hour, now.minute):
        return (now + timedelta(days=1)).strftime("%Y-%m-%d")
    return now.strftime("%Y-%m-%d")


def parse_duration(value):
    """Minutes as int, or None for default. Accepts int, '45', '45 min'."""
    if isinstance(value, (int, float)) and value > 0:
        return int(value)
    text = (str(value or "")).strip()
    m = re.match(r"^(\d+)", text)
    if m and int(m.group(1)) > 0:
        return int(m.group(1))
    return None


def _mins(hhmm):
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def find_clash(Task, user_id, date_str, time_hhmm, duration, exclude_id=None):
    """Return the first already-scheduled task overlapping the proposed window
    on that date, or None. Tasks with no scheduled_time never clash."""
    start = _mins(time_hhmm)
    end = start + (duration or DEFAULT_DURATION)
    q = Task.query.filter(Task.user_id == user_id,
                          Task.scheduled_time.isnot(None))
    for t in q.all():
        if exclude_id is not None and t.id == exclude_id:
            continue
        t_date = t.scheduled_date or t.due
        if t_date != date_str:
            continue
        try:
            ts = _mins(t.scheduled_time)
        except Exception:
            continue
        te = ts + (t.duration or DEFAULT_DURATION)
        if start < te and end > ts:
            return t
    return None


def clash_info(task):
    """Compact description of a clashing task for the model's tool result."""
    dur = task.duration or DEFAULT_DURATION
    start = _mins(task.scheduled_time)
    end = start + dur
    return {
        "conflicts_with": task.description,
        "conflict_time": f"{start // 60:02d}:{start % 60:02d}–{end // 60:02d}:{end % 60:02d}",
        "conflict_date": task.scheduled_date or task.due,
    }


# Prompt guidance shared by the coaches and the task assistant.
SCHEDULING_GUIDANCE = (
    "\n\nSCHEDULING: When the user commits to a specific time ('exercise at "
    "6am', 'call mum tomorrow at 3pm'), do NOT bake the time into the task "
    "name. Pass a clean, time-free name and set scheduled_time (24h HH:MM) "
    "plus scheduled_date (natural language like 'tomorrow' is fine; omit it "
    "to mean the next upcoming occurrence of that time). If the tool reports "
    "a clash with an already-scheduled task, do not force it: tell the user "
    "briefly what it clashes with and ask how to proceed — a different time, "
    "keep both anyway, or leave it unscheduled — then act on their answer "
    "(re-save with allow_clash true only if they explicitly want both)."
)
