# ZTD Premium Features Plan

**Strategy:** Compete with Todoist ($5/mo), Any.do ($7.99/mo), and TickTick ($3.99/mo)
on premium features, not on the free tier.

**Price: $6/month** — undercuts Any.do, matches Todoist on price but beats it on features,
justifies the premium over TickTick through the ZTD methodology angle.

---

## Tier Structure

| | Free | Premium ($6/mo) |
|---|---|---|
| Active tasks | 10 max | Unlimited |
| Task notes | — | ✓ |
| Sub-task priorities & categories | — | ✓ |
| Pomodoro timer | — | ✓ |
| Email reminders | — | ✓ |
| My Day / MITs view | — | ✓ |
| Trash & 30-day undo | — | ✓ |
| Completed task history | 30 days | Forever |
| Data export (CSV / JSON) | — | ✓ |

---

## How This Beats Each Competitor

| Feature | ZTD Premium | Todoist $5 | Any.do $7.99 | TickTick $3.99 |
|---|---|---|---|---|
| Pomodoro | ✓ | — | — | ✓ |
| Task notes | ✓ Rich text | Comments only | — | Comments only |
| Sub-task priorities | ✓ | — | — | — |
| Email reminders | ✓ | ✓ | ✓ | ✓ |
| My Day / MITs | ✓ | — | ✓ | — |
| Forever history | ✓ | Activity log | — | — |
| Trash / undo | ✓ | ✓ | — | — |
| Data export | ✓ | — | — | — |
| ZTD methodology | ✓ | — | — | — |
| **Price** | **$6/mo** | $5/mo | $7.99/mo | $3.99/mo |

---

## Feature Specifications

---

### 1. Task Notes
A rich-text notes field beneath each task description.

**Implementation:**
- Backend: add `notes TEXT` column to `Task` and `DoneTask` models
- Include `notes` in `to_dict()` and accept it in add/edit endpoints (no new routes)
- Frontend: expand arrow on task card reveals a `<textarea>` that auto-saves on blur

---

### 2. Sub-task Priorities & Categories
Sub-tasks currently store `{id, text, done}`. Extend to `{id, text, done, priority, category}`.

**Implementation:**
- Backend: no schema change — subtasks are a JSON blob; just update the shape written
- Frontend: each sub-task row gets a small priority dropdown and optional category input
- Parent task card shows a progress bar: "3 / 5 done"

---

### 3. Pomodoro Timer
A 25-minute countdown widget pinned to any task.

**Implementation:**
- Frontend-only — no backend needed
- New `PomodoroTimer` React component: countdown, start/pause/reset, configurable durations
- Lives in the header (collapsed); clicking "🍅" on a task card opens it pinned to that task
- Browser Notification API fires when timer ends (tab must be open — acceptable limitation)
- Session count in `localStorage` per task id; shown as "🍅 ×3" badge on card

---

### 4. Email Reminders
Send an email when a task's due date/time is approaching.

**Why email over push:** Works on all devices including iOS without a native app.
Every competitor supports this; its absence is a dealbreaker for paying users.

**Implementation:**
- Backend: add `reminder_at DATETIME` column to `Task`; accept it in add/edit endpoints
- APScheduler job runs every minute, queries tasks where
  `reminder_at <= now + 1 min` AND `reminder_sent == False`, sends email, sets flag
- Add `reminder_sent BOOLEAN` column to `Task` to prevent duplicate sends
- Email via **Resend** (free tier: 3,000 emails/mo) or SendGrid — one dependency added
- Frontend: datetime picker in task form labelled "Remind me at"; premium gate shown to free users

---

### 5. My Day / MITs (Most Important Tasks)
A dedicated daily planning view — ZTD's methodology in action.

**What it does:**
- Premium users can flag up to 3 tasks per day as MITs (Most Important Tasks)
- "My Day" view shows only MITs + tasks due today, in a clean focused layout
- Each morning, MITs reset (yesterday's flags clear); prompts user to pick today's 3
- MIT badge (⭐) shown on task cards throughout the app

**Why this beats competitors:** Any.do has a basic "My Day"; Todoist and TickTick don't.
ZTD's version is tied to the ZTD methodology, making it more intentional.

**Implementation:**
- Backend: add `is_mit BOOLEAN` (default False) and `mit_date DATE` to `Task`
- New PUT `/tasks/<id>/mit` endpoint toggles MIT status; enforces max 3 per day
- Frontend: new "My Day" tab in navigation; MIT star button on each task card
- Nightly APScheduler job clears `is_mit` flags from the previous day

---

### 6. Trash & Undo (Soft Delete)
Deleted tasks go to Trash for 30 days instead of being permanently removed.

**Implementation:**
- Backend: add `deleted_at DATETIME` to `Task` (soft-delete pattern)
- All task queries add `Task.deleted_at == None` filter
- DELETE `/tasks/<id>` sets `deleted_at = now()` instead of hard delete
- New GET `/tasks/trash`, POST `/tasks/<id>/restore`, DELETE `/tasks/<id>/permanent`
- APScheduler purges trash older than 30 days nightly
- Frontend: "Trash" view in sidebar; undo toast for 5 seconds after any delete

---

### 7. Completed Task History — Forever
Free users' completed tasks purged after 30 days. Premium keeps them forever.

**Implementation:**
- Nightly APScheduler job deletes `DoneTask` where
  `completed_at < now - 30 days` AND `user.tier == 'free'`
- Premium users skipped — no other change needed
- Frontend: completed view already exists; premium users simply see older entries

---

### 8. Data Export (CSV & JSON)
Download all tasks as a file.

**Implementation:**
- Backend: GET `/export?format=csv` and `/export?format=json`
- Queries active + completed tasks, returns as file download
- No new dependencies (Python `csv` module is stdlib)
- Frontend: "Export" button in profile/settings dropdown

---

## What's NOT Included (Too Complex for One Day)

- Calendar view — drag-to-reschedule grid is a multi-day UI effort
- Location-based reminders — requires mobile app
- File attachments — requires file storage (S3 etc.)
- AI scheduling — needs careful UX design to avoid feeling gimmicky

---

## Implementation Order

1. **Task notes** — smallest change, immediate perceived value
2. **Trash / soft-delete + undo toast** — safety feature users expect before paying
3. **Completed task retention** — one scheduler query, minimal code
4. **Sub-task priorities** — JSON shape change + small UI additions
5. **Data export** — two new endpoints + one button
6. **My Day / MITs** — new view + MIT toggle
7. **Email reminders** — new column + scheduler job + email dependency
8. **Pomodoro timer** — self-contained frontend component

---

## DB Migration Summary

```
Task:     + notes TEXT               (nullable)
          + deleted_at DATETIME      (nullable — null means active)
          + reminder_at DATETIME     (nullable)
          + reminder_sent BOOLEAN    (default False)
          + is_mit BOOLEAN           (default False)
          + mit_date DATE            (nullable)

DoneTask: + notes TEXT               (nullable)
```
