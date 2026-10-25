import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { api } from '../api';
import { useKeyboardViewport } from '../hooks/useKeyboardViewport';
import {
  Conversation, ConsentGate, CrisisOverlay, MemoryPanel,
  TOOLS, GUIDE_TOOL, isConsentValid, markConsented,
} from './AIHub';
import { blocksForDate } from './TimeboxView';
import './Console.css';

/*
 * Console — the conversation-first shell.
 *
 * The classic shell is a task app with a coach docked beside it. This one
 * inverts that: the conversation IS the home screen, and the task list, day
 * calendar and goals are panels you reach for — from the rail, or because the
 * coach offered one (show_view). Nothing is on screen unless you or the coach
 * asked for it.
 *
 * Two deliberate constraints:
 *
 *  - Panels stay real. A chat transcript is a terrible place to scan forty
 *    tasks, so the panels render the same TaskList / TimeboxView / GoalsStrip
 *    the classic shell uses, at full size. They are passed in as thunks so
 *    they mount on open rather than costing anything while closed.
 *  - Nothing costs a model call on launch. The state bar is computed locally
 *    from tasks already in hand, and the resumed conversation just picks up
 *    the saved transcript. The coach speaks when you speak — or when you tap
 *    "brief me".
 */

const SHELL_TOOL_KEY = 'mh_console_tool';   // which coach you were last in

const PANELS = [
  { id: 'tasks', icon: '✓', label: 'Tasks' },
  { id: 'day',   icon: '▦', label: 'Day' },
  { id: 'goals', icon: '◎', label: 'Goals' },
];

const BRIEF_PROMPT =
  "Give me a short, plain read on where I'm at today — what's actually due, "
  + "anything I've let slip, and one thing worth doing first. "
  + "Keep it to a few lines.";

const ALL_TOOLS = [GUIDE_TOOL, ...TOOLS];

function toolById(id) {
  return ALL_TOOLS.find((t) => t.id === id) || GUIDE_TOOL;
}

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function minutesNow() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function hhmmToMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
}

function prettyTime(hhmm) {
  const mins = hhmmToMinutes(hhmm);
  if (mins == null) return hhmm || '';
  const d = new Date();
  d.setHours(Math.floor(mins / 60), mins % 60, 0, 0);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/**
 * What's on, read straight off data we already have. No request, no model
 * call — this has to be true the instant the app paints.
 */
function readDayState(tasks, blocks) {
  const today = todayStr();
  const now = minutesNow();
  const list = Array.isArray(tasks) ? tasks : [];

  const dueToday = list.filter((t) => t.due === today);
  const overdue = list.filter((t) => t.due && t.due < today);

  // The next thing with a time on it today, task or block alike. The
  // task-placement rule mirrors TimeboxView's (scheduled_date wins, otherwise
  // an untimed-date task sits on its due date) so the bar and the calendar
  // never disagree about what's next.
  const upcoming = [];
  list.forEach((t) => {
    const start = hhmmToMinutes(t.scheduled_time);
    if (start == null) return;
    const onToday = t.scheduled_date
      ? t.scheduled_date === today
      : t.due === today;
    if (onToday) upcoming.push({ start, at: t.scheduled_time, label: t.description });
  });
  blocksForDate(blocks, today).forEach((b) => {
    const start = hhmmToMinutes(b.start);
    if (start != null) {
      upcoming.push({ start, at: b.start, label: b.label || 'Blocked time' });
    }
  });
  upcoming.sort((a, b) => a.start - b.start);
  const next = upcoming.find((u) => u.start >= now) || null;

  return {
    today,
    dueToday: dueToday.length,
    overdue: overdue.length,
    overdueIds: overdue.map((t) => t.id),
    dueTodayIds: dueToday.map((t) => t.id),
    next,
  };
}

// ── State bar ────────────────────────────────────────────────────────────────
// Glanceable, factual, and tappable: every figure opens the panel it came from,
// so the bar doubles as navigation.
function StateBar({ state, toolName, onOpen }) {
  const { dueToday, overdue, next } = state;
  const dateLabel = new Date(`${state.today}T00:00:00`)
    .toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });

  return (
    <div className="con-bar">
      <div className="con-bar__left">
        <span className="con-bar__date">{dateLabel}</span>
        <span className="con-bar__coach" title="Current space">{toolName}</span>
      </div>

      <div className="con-bar__stats">
        <button
          className="con-bar__stat"
          onClick={() => onOpen('tasks', { filter: { due: 'today' }, taskIds: state.dueTodayIds })}
          title="Tasks due today"
        >
          <strong>{dueToday}</strong> due today
        </button>
        {overdue > 0 && (
          <button
            className="con-bar__stat con-bar__stat--warn"
            onClick={() => onOpen('tasks', { filter: { due: 'overdue' }, taskIds: state.overdueIds })}
            title="Overdue tasks"
          >
            <strong>{overdue}</strong> overdue
          </button>
        )}
        <button
          className="con-bar__stat con-bar__stat--next"
          onClick={() => onOpen('day')}
          title="Open the day"
        >
          {next
            ? <>next · <strong>{prettyTime(next.at)}</strong> <span className="con-bar__next-label">{next.label}</span></>
            : <>nothing scheduled</>}
        </button>
      </div>
    </div>
  );
}

// ── Panel sheet ──────────────────────────────────────────────────────────────
function PanelSheet({ panel, title, onClose, children }) {
  const ref = useRef(null);

  // Escape closes; focus moves in so keyboard users aren't left behind the sheet.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    ref.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <div className="con-scrim" onClick={onClose} aria-hidden="true" />
      <section
        className={`con-sheet con-sheet--${panel}`}
        role="dialog"
        aria-label={title}
        tabIndex={-1}
        ref={ref}
      >
        <header className="con-sheet__head">
          <span className="con-sheet__grip" aria-hidden="true" />
          <h2 className="con-sheet__title">{title}</h2>
          <button className="con-sheet__close" onClick={onClose} aria-label={`Close ${title}`}>✕</button>
        </header>
        <div className="con-sheet__body">{children}</div>
      </section>
    </>
  );
}

// ── Root ─────────────────────────────────────────────────────────────────────
export default function Console({ hatId, tasks, onTasksChanged, panels, onExitShell }) {
  const [consented, setConsented] = useState(() => isConsentValid());
  const [crisis, setCrisis] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [blocks, setBlocks] = useState([]);

  // Which space you were last in — the app is one long thread, so reopening
  // lands you back where you were rather than at a chooser.
  const [tool, setTool] = useState(() => {
    try { return toolById(localStorage.getItem(SHELL_TOOL_KEY)); } catch { return GUIDE_TOOL; }
  });
  const selectTool = useCallback((t) => {
    setTool(t);
    try { localStorage.setItem(SHELL_TOOL_KEY, t.id); } catch { /* ignore */ }
  }, []);

  // { panel: 'tasks'|'day'|'goals', date?, taskIds?, filter? }
  const [open, setOpen] = useState(null);

  useKeyboardViewport(true);

  useEffect(() => {
    let alive = true;
    api.getBlocks()
      .then((rows) => { if (alive) setBlocks(Array.isArray(rows) ? rows : []); })
      .catch(() => { /* the state bar degrades to tasks-only */ });
    return () => { alive = false; };
  }, []);

  const state = useMemo(() => readDayState(tasks, blocks), [tasks, blocks]);

  // Panels are never restored on load, by design: nothing is on screen unless
  // you or the coach asked for it in this sitting.
  const openPanel = useCallback((panel, opts = {}) => {
    setOpen({ panel, ...opts });
  }, []);
  const closePanel = useCallback(() => setOpen(null), []);

  // A coach's show_view intent, turned into an actual open panel. This is the
  // whole point of the shell: the coach can put the right view in front of you
  // — but only once you've tapped the chip, never on its own.
  const handleNavIntent = useCallback((intent) => {
    if (!intent?.view) return;
    openPanel(intent.view, {
      date: intent.date,
      taskIds: intent.task_ids || intent.taskIds,
      filter: intent.filter,
    });
  }, [openPanel]);

  const acceptConsent = useCallback(() => { markConsented(); setConsented(true); }, []);

  // Body scroll belongs to the conversation; a sheet takes it over while open.
  useEffect(() => {
    if (!open) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  const railTasks = useMemo(() => {
    if (!Array.isArray(tasks)) return [];
    if (hatId == null) return tasks;
    return tasks.filter((t) => t.hat_id === hatId);
  }, [tasks, hatId]);

  const panelTitle = {
    tasks: 'Your tasks',
    day: 'Your day',
    goals: 'Goals',
  };

  if (!consented) {
    return (
      <div className="con" role="main">
        {crisis && <CrisisOverlay onClose={() => setCrisis(false)} />}
        <ConsentGate onAccept={acceptConsent} onCrisis={() => setCrisis(true)} />
      </div>
    );
  }

  const renderPanel = () => {
    if (!open) return null;
    const render = panels?.[open.panel];
    if (typeof render !== 'function') {
      return <div className="con-sheet__empty">This panel isn’t available.</div>;
    }
    return render({ date: open.date, taskIds: open.taskIds, filter: open.filter });
  };

  return (
    <div className={`con${open ? ' con--panel-open' : ''}`} role="main">
      {crisis && <CrisisOverlay onClose={() => setCrisis(false)} />}
      {memoryOpen && <MemoryPanel onClose={() => setMemoryOpen(false)} />}

      <StateBar state={state} toolName={tool.name} onOpen={openPanel} />

      <div className="con-body">
        <div className="con-main">
          <Conversation
            key={tool.id}
            tool={tool}
            hatId={hatId}
            tasks={railTasks}
            onTasksChanged={onTasksChanged}
            onBack={tool.id === GUIDE_TOOL.id ? null : () => selectTool(GUIDE_TOOL)}
            onCrisis={() => setCrisis(true)}
            onSelectModule={selectTool}
            onOpenMemory={() => setMemoryOpen(true)}
            variant="console"
            showRail={false}
            onNavIntent={handleNavIntent}
            briefPrompt={BRIEF_PROMPT}
          />
        </div>

        <nav className="con-rail" aria-label="Panels">
          {PANELS.map((p) => (
            <button
              key={p.id}
              className={`con-rail__btn${open?.panel === p.id ? ' con-rail__btn--on' : ''}`}
              onClick={() => (open?.panel === p.id ? closePanel() : openPanel(p.id))}
              title={p.label}
              aria-pressed={open?.panel === p.id}
            >
              <span className="con-rail__icon" aria-hidden="true">{p.icon}</span>
              <span className="con-rail__label">{p.label}</span>
            </button>
          ))}
          {onExitShell && (
            <button
              className="con-rail__btn con-rail__btn--exit"
              onClick={onExitShell}
              title="Switch back to the classic task-first layout"
            >
              <span className="con-rail__icon" aria-hidden="true">⇄</span>
              <span className="con-rail__label">Classic</span>
            </button>
          )}
        </nav>
      </div>

      {open && (
        <PanelSheet panel={open.panel} title={panelTitle[open.panel] || 'Panel'} onClose={closePanel}>
          {renderPanel()}
        </PanelSheet>
      )}
    </div>
  );
}
