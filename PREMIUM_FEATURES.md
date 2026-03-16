# ZTD Premium Features Plan

Single premium tier at **$9/month**. Free tier stays at 10 tasks.
All features below are implementable in one day.

---

## Tier Structure (Simplified)

| | Free | Premium |
|---|---|---|
| Active tasks | 10 max | Unlimited |
| Task notes | — | ✓ |
| Sub-task priorities | — | ✓ |
| Pomodoro timer | — | ✓ |
| Trash & Undo | — | ✓ |
| Completed task history | 30 days | Forever |
| Data export | — | ✓ |

---

## Feature Specifications

---

### 1. Task Notes
A plain-text notes field beneath each task description.

**Implementation:**
- Backend: add `notes TEXT` column to `Task` and `DoneTask` models
- Backend: include `notes` in `to_dict()` and accept it in add/edit endpoints
- Frontend: expand arrow on each task card reveals a `<textarea>` that auto-saves on blur
- No new routes needed — piggybacks on existing PUT `/tasks/<id>`

---

### 2. Sub-task Priorities & Categories
Sub-tasks currently store `{id, text, done}`. Extend to `{id, text, done, priority, category}`.

**Implementation:**
- Backend: no schema change — subtasks are a JSON blob; just update the shape written
- Frontend: each sub-task row gets a small priority dropdown (urgent / today / tomorrow / later)
  and an optional category text input
- Filter logic in `TaskFilters` already works on task-level; extend to highlight matching sub-tasks

---

### 3. Pomodoro Timer
A 25-minute countdown widget that can be pinned to any task.

**Implementation:**
- Frontend-only — no backend needed
- New `PomodoroTimer` React component: countdown display, start/pause/reset buttons,
  configurable work/break durations in settings
- Lives in the header (collapsed by default); clicking "🍅" on a task card opens it
  pinned to that task
- Browser `Notification` API fires when timer ends
- Session count stored in `localStorage` (keyed by task id); shown as "🍅 ×3" badge

---

### 4. Trash & Undo (Soft Delete)
Deleted tasks go to Trash for 30 days instead of being permanently removed.

**Implementation:**
- Backend: add `deleted_at DATETIME` column to `Task` model (soft-delete pattern)
- All task list queries add `Task.deleted_at == None` filter
- DELETE `/tasks/<id>` sets `deleted_at = now()` instead of `db.session.delete()`
- New GET `/tasks/trash` returns soft-deleted tasks for the current user
- New POST `/tasks/<id>/restore` clears `deleted_at`
- New DELETE `/tasks/<id>/permanent` hard-deletes
- Background: APScheduler job (already available via Flask) purges trash older than 30 days
- Frontend: new "Trash" view accessible from the sidebar; undo toast on delete (5-second window)

---

### 5. Completed Task History — Forever (vs. 30-day purge for Free)
Free users' completed tasks are purged after 30 days. Premium keeps them forever.

**Implementation:**
- Backend: nightly APScheduler job queries `DoneTask` where
  `completed_at < now - 30 days` AND `user.tier == 'free'` and deletes those rows
- Premium users are simply skipped by that job — no other change needed
- Frontend: completed tasks view already exists; premium users just see older history

---

### 6. Data Export (CSV & JSON)
Download all tasks as a file.

**Implementation:**
- Backend: new GET `/export?format=csv` and `/export?format=json` endpoints
- Queries all active + completed tasks for the user, serialises to CSV (Python `csv` module)
  or JSON and returns as a file download (`Content-Disposition: attachment`)
- Frontend: "Export" button in Settings/profile dropdown with two format options
- No new dependencies needed

---

## What's NOT included (too complex for one day)

- Calendar view (drag-to-reschedule across a calendar grid — multi-day effort)
- AI scheduling (requires careful UX + API integration + testing)
- Goal tracking (new data model + dedicated UI pages)
- Custom themes (CSS variable overrides — doable but low value vs. effort)
- Eisenhower Matrix (doable but needs thought to fit existing priority model)

---

## Implementation Order

1. **Task notes** — smallest change, highest perceived value
2. **Soft-delete / Trash + Undo toast** — safety feature users expect
3. **Completed task retention** — one scheduler query, minimal code
4. **Sub-task priorities** — JSON shape change + small UI additions
5. **Data export** — two new endpoints + one button
6. **Pomodoro timer** — self-contained frontend component, last because it's independent

---

## DB Migration Summary

```
Task:     + notes TEXT          (nullable)
          + deleted_at DATETIME (nullable, null = active)

DoneTask: + notes TEXT          (nullable)
```

All other features are frontend-only or use existing columns.
