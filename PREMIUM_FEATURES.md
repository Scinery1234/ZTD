# ZTD Premium Features Plan

This document outlines the planned premium features for ZTD, informed by the existing
free/pro/premium tier structure and research into top productivity apps (Todoist, TickTick,
Things 3, Notion, Any.do, OmniFocus, Microsoft To Do, Habitica).

---

## Tier Assignment Overview

| Feature | Pro ($9/mo) | Premium ($19/mo) |
|---|---|---|
| Pomodoro Timer | ✓ | ✓ |
| Task Notes & Rich Text | ✓ | ✓ |
| Sub-task Categories & Priorities | ✓ | ✓ |
| Trash / Undo (7-day recovery) | ✓ | ✓ |
| Calendar View | — | ✓ |
| Long-term Archive (30+ day history) | — | ✓ |
| Eisenhower Matrix View | — | ✓ |
| Goal Tracking | — | ✓ |
| AI Smart Scheduling | — | ✓ |
| Focus Mode | — | ✓ |
| Weekly Review Dashboard | — | ✓ |
| Custom Themes | — | ✓ |
| Data Export (CSV / JSON / iCal) | — | ✓ |
| Keyboard Shortcuts | ✓ | ✓ |

---

## Feature Specifications

---

### 1. Pomodoro Timer *(Pro + Premium)*

**Inspiration:** TickTick's built-in Pomodoro is one of its most praised features.

**What it does:**
- Start a 25-minute focus session directly from any task
- Configurable work / short-break / long-break durations (e.g. 25/5/15)
- Browser and push notification when timer ends
- Auto-logs each completed Pomodoro to the task's history
- Daily/weekly Pomodoro count shown on the Stats dashboard
- Session count badge visible on each task card ("🍅 ×3")

**UI placement:** Timer widget in the header (collapsed by default); clicking a task's
tomato icon starts a session pinned to that task.

**Database changes:**
- New `pomodoro_sessions` table: `id`, `user_id`, `task_id`, `started_at`, `duration_secs`,
  `completed` (bool)
- `tasks` table: add `pomodoro_count` (int, default 0)

---

### 2. Task Notes & Rich Text *(Pro + Premium)*

**Inspiration:** Notion, Things 3, OmniFocus all allow per-task notes/descriptions.

**What it does:**
- Each task has an expandable Notes panel below its title
- Supports Markdown formatting (bold, italic, bullet lists, code blocks, links)
- Notes are rendered in read mode and editable in write mode
- Collapsible so the list stays clean
- Character count displayed; soft limit 10 000 chars

**UI placement:** Expand arrow on task card reveals the notes area inline.

**Database changes:**
- `tasks` table: add `notes` (TEXT, nullable)

---

### 3. Sub-task Categories & Priorities *(Pro + Premium)*

**Inspiration:** Todoist nested sub-tasks with individual priorities; OmniFocus project/action hierarchy.

**What it does:**
- Each sub-task inherits the parent's category by default, but can override it
- Each sub-task has its own priority (urgent / today / tomorrow / later)
- Sub-tasks appear with a colour-coded priority dot matching the main task colour scheme
- Filter views apply to sub-tasks (e.g. "show all urgent" includes urgent sub-tasks)
- Progress bar on the parent task: "3 / 5 sub-tasks done"

**Database changes:**
- `subtasks` table (currently stored as JSON blob): migrate to a proper relational table
  with `id`, `parent_task_id`, `description`, `category`, `priority`, `completed`, `order`

---

### 4. Trash & Undo *(Pro + Premium)*

**Inspiration:** Todoist (30-day trash), Any.do (undo snackbar), Gmail-style undo send.

**What it does:**
- Deleting a task moves it to Trash instead of permanent deletion
- Trash retains deleted tasks for **7 days** (Pro) / **30 days** (Premium)
- "Undo" toast notification appears for **5 seconds** after any destructive action
  (delete, complete, bulk-clear) — click to instantly reverse
- Trash view accessible from the sidebar; tasks can be restored or permanently deleted
- Bulk "Empty Trash" button

**Database changes:**
- `tasks` table: add `deleted_at` (DATETIME, nullable) — soft-delete pattern
- Background job (cron / APScheduler) purges trash older than retention window

---

### 5. Calendar View *(Premium only)*

**Inspiration:** TickTick calendar, Google Tasks + Calendar integration, Fantastical.

**What it does:**
- Month / Week / Day views showing tasks by their due date
- Drag a task to a new date to reschedule it
- Tasks with no due date appear in a right-side "Unscheduled" panel; drag onto the
  calendar to assign a date
- Colour coding matches priority (red=urgent, orange=today, etc.)
- Recurring tasks shown on all relevant dates
- Optional two-way sync with Google Calendar (OAuth integration — Phase 2)

**UI placement:** New "Calendar" tab in the main navigation.

**No new database changes** — uses existing `due_date` field.

---

### 6. Long-term Completed Task Archive *(Premium only)*

**Inspiration:** Todoist's activity log, OmniFocus review, Things 3 logbook.

**What it does:**
- Completed tasks are **never deleted** for Premium users — they move to an Archive
- Searchable archive with full-text search across task descriptions and notes
- Filter archive by date range, category, hat (workspace), or tag
- Monthly completion heatmap (GitHub-style) to visualise productivity trends
- Export archive to CSV or JSON

**Free / Pro behaviour:** Completed tasks older than 30 days are permanently deleted on
a nightly job. Premium users are exempt from this purge.

**Database changes:**
- `tasks` table: add `archived_at` (DATETIME, nullable)
- Background job: nightly query marks tasks as archived for premium; deletes for others

---

### 7. Eisenhower Matrix View *(Premium only)*

**Inspiration:** Any.do, Sunsama, and productivity literature (Covey's quadrants).

**What it does:**
- 2×2 grid: Urgent+Important / Not Urgent+Important / Urgent+Not Important / Neither
- Tasks auto-populate based on `priority` and a new `important` boolean flag
- Drag tasks between quadrants to update their classification
- Quick win: "Do First", "Schedule", "Delegate", "Eliminate" labels on each quadrant

**Database changes:**
- `tasks` table: add `important` (bool, default false)

---

### 8. Goal Tracking *(Premium only)*

**Inspiration:** Habitica, Streaks, BeeFocus, OmniFocus projects.

**What it does:**
- Create a **Goal** (e.g. "Launch MVP", "Run a 5K")
- Link any number of tasks to a goal
- Goal page shows: % complete, deadline, linked tasks, notes, milestone markers
- Goals listed in the sidebar alongside Hats
- Weekly email digest summarising goal progress (opt-in)

**Database changes:**
- New `goals` table: `id`, `user_id`, `title`, `description`, `target_date`, `color`,
  `created_at`, `completed_at`
- New `goal_tasks` join table: `goal_id`, `task_id`

---

### 9. AI Smart Scheduling *(Premium only)*

**Inspiration:** Reclaim.ai, Motion, Sunsama "daily planning".

**What it does:**
- "Plan my day" button: AI analyses overdue + urgent + today tasks and suggests an
  ordered schedule for the day
- Auto-assign due dates to undated tasks based on priority and workload
- Uses Claude API (via Anthropic SDK) to generate suggestions — responses shown as
  suggestions the user confirms, never auto-applied
- Pomodoro-aware: estimates sessions needed per task and spreads across available hours

**Implementation:** Serverless function calls Anthropic API; no task data stored externally.

---

### 10. Focus Mode *(Premium only)*

**Inspiration:** Things 3 "Today" widget, Forest app, TickTick focus.

**What it does:**
- Fullscreen distraction-free view showing only the current task + Pomodoro timer
- Hides all other UI elements
- Optional ambient background sounds (lo-fi, rain, white noise) via embedded audio
- Keyboard shortcut to enter/exit: `F` key

**UI placement:** Focus button (⚡) on any task card; also launchable from Pomodoro session.

---

### 11. Weekly Review Dashboard *(Premium only)*

**Inspiration:** GTD weekly review, Todoist Karma, RescueTime reports.

**What it does:**
- Dedicated "Review" page summarising the past 7 days:
  - Tasks completed vs created
  - Overdue tasks needing rescheduling
  - Pomodoro sessions and total focus time
  - Category breakdown pie chart
  - Longest streak of daily completions
- Guided review prompts (ZTD methodology): "What went well?", "What carries over?"
- One-click to reschedule all overdue tasks to "this week"

---

### 12. Custom Themes *(Premium only)*

**Inspiration:** Todoist themes, Notion covers.

**What it does:**
- Choose from preset themes (Dark Mode, Solarised, Midnight, Forest, Ocean)
- Custom accent colour picker (replaces the purple gradient)
- Custom hat/workspace background images (upload or from preset gallery)
- Theme synced across devices

---

### 13. Data Export *(Premium only)*

**What it does:**
- Export all tasks (active + completed + archived) as:
  - **CSV** — for spreadsheets
  - **JSON** — for backup / migration
  - **iCal (.ics)** — import into Google Calendar, Apple Calendar, Outlook
- Triggered from Settings → Export
- Download delivered immediately (< 1 MB) or via email link (larger exports)

---

### 14. Keyboard Shortcuts *(Pro + Premium)*

**Inspiration:** Todoist, Linear, Notion power-user shortcuts.

| Shortcut | Action |
|---|---|
| `N` | New task |
| `E` | Edit selected task |
| `Space` | Complete selected task |
| `Del` | Delete selected task |
| `F` | Enter Focus Mode |
| `P` | Start Pomodoro on selected task |
| `C` | Open Calendar view |
| `/` | Open search |
| `?` | Show shortcut cheat sheet |
| `Cmd/Ctrl + Z` | Undo last action |

---

## Implementation Roadmap

### Phase 1 — Pro tier foundations (next sprint)
1. Task Notes (markdown, inline expand)
2. Sub-task categories & priorities (DB migration)
3. Trash / soft-delete + Undo toast
4. Keyboard shortcuts

### Phase 2 — Pomodoro & Focus
5. Pomodoro timer widget + session logging
6. Focus Mode (fullscreen + ambient sounds)

### Phase 3 — Premium calendar & archive
7. Calendar view (month/week/day + drag-to-reschedule)
8. Long-term archive + heatmap + export

### Phase 4 — Intelligence & analytics
9. Weekly Review Dashboard + goal tracking
10. Eisenhower Matrix view
11. AI Smart Scheduling (Claude API)
12. Custom themes

---

## Competitor Comparison

| Feature | ZTD Pro | ZTD Premium | Todoist Pro | TickTick Premium | Things 3 |
|---|---|---|---|---|---|
| Pomodoro Timer | ✓ | ✓ | — | ✓ | — |
| Task Notes | ✓ | ✓ | ✓ | ✓ | ✓ |
| Calendar view | — | ✓ | ✓ | ✓ | ✓ |
| Trash/Undo | ✓ | ✓ | ✓ | ✓ | ✓ |
| Long-term Archive | — | ✓ | 30 days | — | ✓ |
| AI Scheduling | — | ✓ | — | — | — |
| Eisenhower Matrix | — | ✓ | — | — | — |
| Goal Tracking | — | ✓ | Projects only | — | Areas |
| Price/month | $9 | $19 | $5 | $3.99 | $49.99 one-time |

ZTD's differentiator: **ZTD methodology built-in** + **AI scheduling** at a competitive price.
