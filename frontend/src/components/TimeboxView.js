import React, { useState, useRef, useEffect, useCallback } from 'react';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { useSortable, SortableContext, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import { CSS as DndCSS } from '@dnd-kit/utilities';
import { asSubtaskList } from '../utils/arrays';
import { api } from '../api';
import './TimeboxView.css';

// Sensor that won't activate when the user clicks inside an input/button
class SmartPointerSensor extends PointerSensor {
  static activators = [
    {
      eventName: 'onPointerDown',
      handler: ({ nativeEvent: event }) => {
        const tag = event.target?.tagName;
        if (!event.isPrimary || event.button !== 0 ||
            tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON' || tag === 'SELECT') {
          return false;
        }
        return true;
      },
    },
  ];
}

// ── Constants ───────────────────────────────────────────────────────────────
const PX_PER_HOUR = 64;
const PX_PER_MIN = PX_PER_HOUR / 60;
const OVERFLOW_HOURS = 5; // hours of next-day shown at bottom of grid
const GRID_HOURS = 24 + OVERFLOW_HOURS;
const GRID_HEIGHT = GRID_HOURS * PX_PER_HOUR;
const MAX_GRID_MINS = GRID_HOURS * 60; // 1740
const SNAP = 15; // minutes
const LONG_PRESS_MS = 400; // ms before a touch-hold becomes a drag

// ── Helpers ──────────────────────────────────────────────────────────────────
function parseMinutes(hhmm) {
  if (!hhmm) return 0;
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function formatTime(totalMinutes) {
  const clamped = Math.max(0, Math.min(1439, totalMinutes));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// Like formatTime but allows hours > 23 (for window-end in extended zone)
function formatExtendedTime(totalMinutes) {
  const mins = Math.max(0, totalMinutes);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function timeToY(hhmm) {
  return parseMinutes(hhmm) * PX_PER_MIN;
}

function yToMinutes(y, snap = SNAP) {
  return Math.round(y / PX_PER_MIN / snap) * snap;
}

function snapMinutes(mins, snap = SNAP) {
  return Math.round(mins / snap) * snap;
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return toLocalDateStr(d);
}

// Grid position (in minutes, 0–1740) for a task on a given column date.
// Tasks on the next calendar day (00:00–05:00) appear in the extended area (1440–1740).
function taskGridMinutes(task, date) {
  const mins = parseMinutes(task.scheduled_time);
  if (task.scheduled_date && task.scheduled_date !== date && mins < OVERFLOW_HOURS * 60) {
    return mins + 1440;
  }
  return mins;
}

// Convert a grid minute position to the correct scheduled_time + scheduled_date for storage.
function gridMinsToSchedule(gridMins, date) {
  if (gridMins >= 1440) {
    return { scheduled_time: formatTime(gridMins - 1440), scheduled_date: addDays(date, 1) };
  }
  return { scheduled_time: formatTime(gridMins), scheduled_date: date };
}

// Human-readable time for grid positions that may exceed midnight
function formatGridTime(gridMins) {
  if (gridMins >= 1440) return formatTime(gridMins - 1440) + ' +1';
  return formatTime(gridMins);
}

function getRelativeY(e, el) {
  const rect = el.getBoundingClientRect();
  return e.clientY - rect.top + el.scrollTop;
}

function getPointerY(e) {
  if (e.touches && e.touches.length) return e.touches[0].clientY;
  if (e.changedTouches && e.changedTouches.length) return e.changedTouches[0].clientY;
  return e.clientY;
}

// Whether a task is placed on a specific day's grid (not stale from another day)
function isOnDaysGrid(task, date) {
  if (!task.scheduled_time) return false;
  const nextDay = addDays(date, 1);
  if (task.scheduled_date === date) return true;
  if (!task.scheduled_date && task.due === date) return true;
  if (task.scheduled_date === nextDay && parseMinutes(task.scheduled_time) < OVERFLOW_HOURS * 60) return true;
  return false;
}

// Advance cursor past blocked slots in grid minutes (0–1740) — used by auto-schedule
function advancePastBlockedGrid(cursor, dur, blocked) {
  let c = cursor;
  let changed = true;
  while (changed) {
    changed = false;
    for (const b of blocked) {
      if (c < b.end && c + dur > b.start) { c = b.end; changed = true; }
    }
  }
  return c;
}

// Hop: find nearest free slot (before or after) in grid minutes.

// Push: insert dragged task at desiredStart and cascade-shift overlapping tasks forward.
// otherTasks: [{id, origStart, dur, locked}] — original positions at drag start.
// Returns {[id]: newGridStart} for all otherTasks, or null if a locked task is in the way
// or a pushed task would exceed windowEnd.
function computePushLayout(desiredStart, duration, otherTasks, windowEnd) {
  const sorted = [...otherTasks].sort((a, b) => a.origStart - b.origStart);
  const result = {};
  let cursor = desiredStart + duration;
  for (const t of sorted) {
    if (t.origStart + t.dur <= desiredStart) {
      result[t.id] = t.origStart; // ends before drop point — no conflict
    } else if (t.origStart < cursor) {
      if (t.locked) return null; // can't shift a locked task
      result[t.id] = cursor;
      cursor += t.dur;
    } else {
      result[t.id] = t.origStart; // after cursor — no conflict
    }
  }
  // Reject if any pushed task exceeds the window
  for (const t of sorted) {
    if (result[t.id] !== t.origStart && result[t.id] + t.dur > windowEnd) return null;
  }
  return result;
}

function formatDateLabel(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.floor((d - today) / 86400000);
  const dayName = d.toLocaleDateString('en-US', { weekday: 'short' });
  const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  if (diff === 0) return `Today — ${label}`;
  if (diff === 1) return `Tomorrow — ${label}`;
  return `${dayName} — ${label}`;
}

function toLocalDateStr(d) {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${day}`;
}

function getWeekDates(startOffset = 0) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(today);
    d.setDate(today.getDate() + startOffset + i);
    return toLocalDateStr(d);
  });
}

function useNowMinutes() {
  const [nowMinutes, setNowMinutes] = useState(() => {
    const n = new Date();
    return n.getHours() * 60 + n.getMinutes();
  });
  useEffect(() => {
    const interval = setInterval(() => {
      const n = new Date();
      setNowMinutes(n.getHours() * 60 + n.getMinutes());
    }, 60000);
    return () => clearInterval(interval);
  }, []);
  return nowMinutes;
}

// ── localStorage helpers ──────────────────────────────────────────────────────
function loadDayWindows() {
  try { return JSON.parse(localStorage.getItem('mh_day_windows') || '{}'); }
  catch { return {}; }
}
function saveDayWindows(v) { localStorage.setItem('mh_day_windows', JSON.stringify(v)); }

function loadBlockedTimes() {
  try { return JSON.parse(localStorage.getItem('mh_blocked_times') || '[]'); }
  catch { return []; }
}
function saveBlockedTimes(v) { localStorage.setItem('mh_blocked_times', JSON.stringify(v)); }

function loadMit() {
  try { return JSON.parse(localStorage.getItem('mh_mit_tasks') || '[]'); }
  catch { return []; }
}
function saveMit(ids) { localStorage.setItem('mh_mit_tasks', JSON.stringify([...ids])); }

function loadDismissed(dateStr) {
  try {
    const all = JSON.parse(localStorage.getItem('mh_dismissed') || '{}');
    return new Set(all[dateStr] || []);
  } catch { return new Set(); }
}
function saveDismissed(dateStr, ids) {
  try {
    const all = JSON.parse(localStorage.getItem('mh_dismissed') || '{}');
    all[dateStr] = [...ids];
    // Prune entries older than 30 days
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 30);
    for (const key of Object.keys(all)) {
      if (key < toLocalDateStr(cutoff)) delete all[key];
    }
    localStorage.setItem('mh_dismissed', JSON.stringify(all));
  } catch {}
}

// ── Slot popup (shown after grid drag) ───────────────────────────────────────
function SlotPopup({ slot, date, onAddTask, onBlockTime, onCancel }) {
  const [desc, setDesc] = useState('');
  const [priority, setPriority] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 30);
  }, []);

  const duration = slot.endMin - slot.startMin;

  const handleAddTask = async () => {
    if (!desc.trim()) return;
    const { scheduled_time, scheduled_date } = gridMinsToSchedule(slot.startMin, date);
    await onAddTask({
      description: desc.trim(),
      priority,
      duration,
      scheduled_time,
      scheduled_date,
      due: scheduled_date,
    });
    onCancel();
  };

  const handleBlockTime = () => {
    onBlockTime(slot.startMin, slot.endMin);
    onCancel();
  };

  // Clamp popup to viewport
  const popupTop = Math.min(slot.screenY, window.innerHeight - 220);
  const popupLeft = Math.min(slot.screenX + 12, window.innerWidth - 260);

  return (
    <>
      <div className="slot-popup-backdrop" onClick={onCancel} />
      <div className="slot-popup" style={{ top: popupTop, left: popupLeft }}>
        <div className="slot-popup-time">
          {formatGridTime(slot.startMin)} – {formatGridTime(slot.endMin)}
          <span className="slot-popup-dur">{duration}m</span>
        </div>
        <input
          ref={inputRef}
          className="slot-popup-input"
          placeholder="Task name…"
          value={desc}
          onChange={e => setDesc(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') handleAddTask();
            if (e.key === 'Escape') onCancel();
          }}
        />
        <select
          className="slot-popup-priority"
          value={priority}
          onChange={e => setPriority(e.target.value)}
        >
          <option value="">No priority</option>
          <option value="urgent">Urgent</option>
          <option value="today">Today</option>
          <option value="tomorrow">Tomorrow</option>
          <option value="later">Later</option>
        </select>
        <div className="slot-popup-actions">
          <button
            className="slot-popup-btn slot-popup-btn--task"
            onClick={handleAddTask}
            disabled={!desc.trim()}
          >
            + Add Task
          </button>
          <button className="slot-popup-btn slot-popup-btn--block" onClick={handleBlockTime}>
            Block Time
          </button>
          <button className="slot-popup-btn slot-popup-btn--cancel" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </>
  );
}

// ── TaskEditModal subtask drag row ────────────────────────────────────────────
function SortableModalSubtaskRow({ st, onUpdate, onRemove, onAddNew, shouldFocus, onFocused }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: st.id });
  const inputRef = useRef(null);

  useEffect(() => {
    if (shouldFocus && inputRef.current) {
      inputRef.current.focus();
      onFocused();
    }
  }, [shouldFocus]); // eslint-disable-line

  return (
    <div
      ref={setNodeRef}
      style={{ transform: DndCSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 }}
      className="tef-subtask-row"
    >
      <span className="tef-subtask-drag" {...attributes} {...listeners}>⠿</span>
      <input
        ref={inputRef}
        className="tef-subtask-input"
        value={st.text}
        placeholder="Subtask…"
        onChange={e => onUpdate(st.id, e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.preventDefault(); onAddNew(); }
          if (e.key === 'Backspace' && st.text === '') onRemove(st.id);
        }}
      />
      <button className="tef-subtask-remove" onClick={() => onRemove(st.id)}>✕</button>
    </div>
  );
}

// ── TaskEditModal ─────────────────────────────────────────────────────────────
let _stIdCounter = Date.now();
const newStId = () => `st-${++_stIdCounter}`;

function TaskEditModal({ task, hats, onSave, onClose }) {
  const [editData, setEditData] = useState({
    description: task.description,
    category: task.category || '',
    priority: task.priority || '',
    hat_id: task.hat_id ?? '',
    subtasks: asSubtaskList(task.subtasks).map((s) => ({ ...s })),
  });

  const handleSave = () => {
    onSave(task.id, {
      description: editData.description.trim() || task.description,
      category: editData.category.trim(),
      priority: editData.priority,
      hat_id: editData.hat_id !== '' ? Number(editData.hat_id) : null,
      subtasks: editData.subtasks,
    });
  };

  const [focusId, setFocusId] = useState(null);

  const addSubtask = () => {
    const id = newStId();
    setFocusId(id);
    setEditData(d => ({ ...d, subtasks: [...d.subtasks, { id, text: '', done: false }] }));
  };

  const updateSubtask = (stId, text) =>
    setEditData(d => ({ ...d, subtasks: d.subtasks.map(s => s.id === stId ? { ...s, text } : s) }));

  const removeSubtask = (stId) =>
    setEditData(d => ({ ...d, subtasks: d.subtasks.filter(s => s.id !== stId) }));

  const reorderSubtasks = ({ active, over }) => {
    if (!over || active.id === over.id) return;
    setEditData(d => {
      const oldIdx = d.subtasks.findIndex(s => s.id === active.id);
      const newIdx = d.subtasks.findIndex(s => s.id === over.id);
      return { ...d, subtasks: arrayMove(d.subtasks, oldIdx, newIdx) };
    });
  };

  const subtaskSensors = useSensors(useSensor(SmartPointerSensor, { activationConstraint: { distance: 6 } }));

  return (
    <>
      <div className="tef-backdrop" onClick={onClose} />
      <div className="tef-modal">
        <div className="tef-header">
          <span className="tef-title">Edit Task</span>
          <button className="tef-close" onClick={onClose}>✕</button>
        </div>

        <div className="tef-body">
          <div className="tef-field">
            <label className="tef-label">Description</label>
            <input
              className="tef-input"
              value={editData.description}
              onChange={e => setEditData(d => ({ ...d, description: e.target.value }))}
              onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') onClose(); }}
              autoFocus
            />
          </div>

          <div className="tef-row">
            <div className="tef-field">
              <label className="tef-label">Category</label>
              <input
                className="tef-input"
                value={editData.category}
                onChange={e => setEditData(d => ({ ...d, category: e.target.value }))}
                placeholder="e.g. work"
              />
            </div>
            <div className="tef-field">
              <label className="tef-label">Priority</label>
              <select
                className="tef-select"
                value={editData.priority}
                onChange={e => setEditData(d => ({ ...d, priority: e.target.value }))}
              >
                <option value="">None</option>
                <option value="urgent">Urgent</option>
                <option value="today">Today</option>
                <option value="tomorrow">Tomorrow</option>
                <option value="later">Later</option>
              </select>
            </div>
          </div>

          {hats && hats.length > 0 && (
            <div className="tef-field">
              <label className="tef-label">Hat</label>
              <select
                className="tef-select"
                value={editData.hat_id}
                onChange={e => setEditData(d => ({ ...d, hat_id: e.target.value }))}
              >
                <option value="">No Hat</option>
                {hats.map(h => (
                  <option key={h.id} value={h.id}>{h.emoji} {h.name}</option>
                ))}
              </select>
            </div>
          )}

          <div className="tef-field">
            <label className="tef-label">Subtasks</label>
            <div className="tef-subtasks">
              <DndContext sensors={subtaskSensors} collisionDetection={closestCenter} onDragEnd={reorderSubtasks}>
                <SortableContext items={editData.subtasks.map(s => s.id)} strategy={verticalListSortingStrategy}>
                  {editData.subtasks.map((st, i) => (
                    <SortableModalSubtaskRow
                      key={st.id}
                      st={st}
                      onUpdate={updateSubtask}
                      onRemove={removeSubtask}
                      onAddNew={addSubtask}
                      shouldFocus={focusId === st.id}
                      onFocused={() => setFocusId(null)}
                    />
                  ))}
                </SortableContext>
              </DndContext>
              <button className="tef-subtask-add" onClick={addSubtask}>+ Add subtask</button>
            </div>
          </div>
        </div>

        <div className="tef-footer">
          <button className="tef-btn tef-btn--cancel" onClick={onClose}>Cancel</button>
          <button className="tef-btn tef-btn--save" onClick={handleSave}>Save</button>
        </div>
      </div>
    </>
  );
}

// ── TimeboxDayColumn ─────────────────────────────────────────────────────────
function TimeboxDayColumn({ date, tasks, hats, dayWindow, onWindowChange, blockedTimes, onBlockedTimesChange, mitIds, onToggleMit, onUpdateTask, onAddTask, onApplyTaskUpdates, onMarkDone, isWeekView, onEditTask, dismissedIds, onCalendarDeleteEvent, onPinPomodoro }) {
  const gridRef = useRef(null);
  const wrapperRef = useRef(null);
  const dragRafRef = useRef(null);
  const blockDragRef = useRef(null);
  const [dragging, setDragging] = useState(null);
  const [localTasks, setLocalTasks] = useState(tasks);
  const [localWindow, setLocalWindow] = useState(dayWindow);
  const [blockDrag, setBlockDrag] = useState(null);
  const [pendingSlot, setPendingSlot] = useState(null);
  const [unscheduledOpen, setUnscheduledOpen] = useState(true);
  const [dragOverMins, setDragOverMins] = useState(null);

  // Refs so drag handlers always read the latest state without re-registering listeners
  const localTasksRef = useRef(localTasks);
  const localWindowRef = useRef(localWindow);

  useEffect(() => { setLocalTasks(tasks); }, [tasks]);
  useEffect(() => { setLocalWindow(dayWindow); }, [dayWindow]);
  useEffect(() => { localTasksRef.current = localTasks; }, [localTasks]);
  useEffect(() => { localWindowRef.current = localWindow; }, [localWindow]);

  const todayStr = toLocalDateStr(new Date());
  const nextDay = addDays(date, 1);
  // Tasks that appear ON the grid for this day — including next-day tasks in the overflow area
  const columnTasks = localTasks.filter(t => {
    if (t.scheduled_date === date) return true;
    if (!t.scheduled_date && t.due === date) return true;
    if (t.scheduled_date === nextDay && t.scheduled_time &&
        parseMinutes(t.scheduled_time) < OVERFLOW_HOURS * 60) return true;
    return false;
  });
  const scheduled = columnTasks.filter(t => t.scheduled_time);

  // Task pool inside the column: only for week view (today's column).
  // Day view shows the pool in a sidebar managed by TimeboxView.
  const showTaskPool = isWeekView && date === todayStr;
  const unscheduled = showTaskPool
    ? localTasks.filter(t => !t.scheduled_time)
    : [];

  const windowStart = parseMinutes(localWindow.start);
  const windowEnd = parseMinutes(localWindow.end);

  // Auto-scroll to window start on mount
  useEffect(() => {
    if (wrapperRef.current) {
      wrapperRef.current.scrollTop = Math.max(0, timeToY(localWindow.start) - 40);
    }
  }, []); // eslint-disable-line

  // ── Auto-schedule ──────────────────────────────────────────────────────────
  const handleAutoSchedule = useCallback(async () => {
    const nextDayDate = addDays(date, 1);
    // Exclude tasks already on today's grid, locked, and dismissed
    const pool = localTasks.filter(t =>
      !isOnDaysGrid(t, date) && !t.locked && !(dismissedIds && dismissedIds.has(t.id))
    );
    const ordered = [...pool].sort((a, b) => (a.position ?? 9999) - (b.position ?? 9999));
    // Build blocked list in grid minutes (0–1740) so we can schedule past midnight
    const allBlockedGrid = [
      ...blockedTimes
        .filter(b => b.date === date || b.date === nextDayDate)
        .map(b => {
          const offset = b.date === nextDayDate ? 1440 : 0;
          return { start: parseMinutes(b.start) + offset, end: parseMinutes(b.end) + offset };
        }),
      ...localTasks
        .filter(t => isOnDaysGrid(t, date))
        .map(t => {
          const gs = taskGridMinutes(t, date);
          return { start: gs, end: gs + (t.duration || 30) };
        }),
    ];
    const now = new Date();
    const nowMins = now.getHours() * 60 + now.getMinutes();
    const isToday = date === toLocalDateStr(now);
    let cursor = isToday ? Math.max(windowStart, snapMinutes(nowMins)) : windowStart;
    const updates = [];
    for (const task of ordered) {
      const dur = task.duration || 30;
      const slotStart = advancePastBlockedGrid(cursor, dur, allBlockedGrid);
      if (slotStart + dur > windowEnd) continue;
      const scheduled = gridMinsToSchedule(slotStart, date);
      updates.push({ id: task.id, ...scheduled });
      cursor = slotStart + dur;
      allBlockedGrid.push({ start: slotStart, end: slotStart + dur });
    }
    if (updates.length === 0) return;
    const updatedMap = {};
    updates.forEach(u => { updatedMap[u.id] = u; });
    setLocalTasks(prev => prev.map(t => updatedMap[t.id] ? { ...t, ...updatedMap[t.id] } : t));
    await Promise.all(updates.map(u =>
      api.updateTask(u.id, { scheduled_time: u.scheduled_time, scheduled_date: u.scheduled_date })
    ));
    if (onApplyTaskUpdates) onApplyTaskUpdates(updates);
  }, [localTasks, blockedTimes, date, windowStart, windowEnd, dismissedIds, onApplyTaskUpdates]);

  // ── Task / window drag ─────────────────────────────────────────────────────
  const startPointerDrag = useCallback((type, extra, e) => {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    // extra.startY is used when called from the long-press path (e is null)
    const { startY: explicitY, ...rest } = extra;
    const startY = explicitY !== undefined ? explicitY : getPointerY(e);
    setDragging({ type, startY, ...rest });
  }, []);

  // Long-press drag for touch: hold 400ms without moving to enter drag mode.
  // During the hold window, finger movement is delegated to the grid's scrollTop
  // so scrolling still works even when the finger lands on a task block.
  const handleTaskTouchStart = useCallback((task, gridMins, e) => {
    // Let resize handles and action buttons handle their own touches
    if (e.target.classList.contains('timebox-task-resize-top') ||
        e.target.classList.contains('timebox-task-resize-bottom') ||
        e.target.closest?.('button')) return;

    const touch = e.touches[0];
    const startX = touch.clientX;
    const startY = touch.clientY;
    let prevY = startY;
    const el = e.currentTarget;
    let done = false;
    let scrollMode = false;

    const cleanup = () => {
      if (done) return;
      done = true;
      el.classList.remove('timebox-task--pressing');
      clearTimeout(timer);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
      document.removeEventListener('touchcancel', onEnd);
    };

    const onMove = (me) => {
      if (done) return;
      const t = me.touches[0];
      if (!t) { cleanup(); return; }
      const dy = t.clientY - prevY;
      if (!scrollMode && (Math.abs(t.clientX - startX) > 8 || Math.abs(t.clientY - startY) > 8)) {
        // Movement detected — cancel long press, switch to manual scroll mode
        scrollMode = true;
        clearTimeout(timer);
        el.classList.remove('timebox-task--pressing');
      }
      if (scrollMode && wrapperRef.current) {
        // Manually scroll the grid since touch-action:none blocks native scroll
        wrapperRef.current.scrollTop -= dy;
      }
      prevY = t.clientY;
    };

    const onEnd = cleanup;

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      el.classList.remove('timebox-task--pressing');
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
      document.removeEventListener('touchcancel', onEnd);
      // Compute origTaskPositions at drag-start time (most accurate)
      const origTaskPositions = {};
      localTasksRef.current.forEach(t => {
        if (t.scheduled_time && isOnDaysGrid(t, date))
          origTaskPositions[t.id] = taskGridMinutes(t, date);
      });
      startPointerDrag('task-move', {
        taskId: task.id, origMin: gridMins, duration: task.duration || 30,
        origTaskPositions, startY,
      }, null);
    }, LONG_PRESS_MS);

    el.classList.add('timebox-task--pressing');
    document.addEventListener('touchmove', onMove, { passive: true });
    document.addEventListener('touchend', onEnd, { once: true });
    document.addEventListener('touchcancel', onEnd, { once: true });
  }, [date, startPointerDrag]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e) => {
      const clientY = getPointerY(e);
      if (e.cancelable) e.preventDefault();
      if (dragRafRef.current) cancelAnimationFrame(dragRafRef.current);
      dragRafRef.current = requestAnimationFrame(() => {
        dragRafRef.current = null;
        const deltaY = clientY - dragging.startY;
        const deltaMins = yToMinutes(deltaY);
        const wStart = parseMinutes(localWindowRef.current.start);
        const wEnd = parseMinutes(localWindowRef.current.end);
        if (dragging.type === 'window-start') {
          const newMin = Math.max(0, Math.min(wEnd - 60, snapMinutes(dragging.origMin + deltaMins)));
          const newW = { ...localWindowRef.current, start: formatTime(newMin) };
          localWindowRef.current = newW;
          setLocalWindow(newW);
        } else if (dragging.type === 'window-end') {
          const newMin = Math.max(wStart + 60, Math.min(MAX_GRID_MINS, snapMinutes(dragging.origMin + deltaMins)));
          const newW = { ...localWindowRef.current, end: formatExtendedTime(newMin) };
          localWindowRef.current = newW;
          setLocalWindow(newW);
        } else if (dragging.type === 'task-move') {
          const dur = dragging.duration || 30;
          const rawMin = Math.max(0, Math.min(MAX_GRID_MINS - dur, snapMinutes(dragging.origMin + deltaMins)));
          const wEndMin = parseMinutes(localWindowRef.current.end);
          const otherTasks = Object.entries(dragging.origTaskPositions || {})
            .filter(([id]) => Number(id) !== dragging.taskId)
            .map(([id, origStart]) => {
              const t = localTasksRef.current.find(t => t.id === Number(id));
              return t ? { id: Number(id), origStart, dur: t.duration || 30, locked: Boolean(t.locked) } : null;
            })
            .filter(Boolean);
          const pushResult = computePushLayout(rawMin, dur, otherTasks, wEndMin);
          let finalStart;
          let siblingsMap = {};
          if (pushResult !== null) {
            finalStart = rawMin;
            siblingsMap = pushResult;
          } else {
            // Push failed — follow cursor but clamp so we never overlap a locked task.
            const lockedZones = otherTasks
              .filter(t => t.locked)
              .map(t => ({ start: t.origStart, end: t.origStart + t.dur }));
            let clamped = rawMin;
            for (const zone of lockedZones) {
              if (clamped < zone.end && clamped + dur > zone.start) {
                const beforePos = Math.max(0, zone.start - dur);
                const afterPos = zone.end;
                clamped = Math.abs(rawMin - beforePos) <= Math.abs(rawMin - afterPos)
                  ? beforePos : afterPos;
              }
            }
            finalStart = Math.max(0, Math.min(MAX_GRID_MINS - dur, clamped));
            otherTasks.forEach(t => { siblingsMap[t.id] = t.origStart; });
          }
          setLocalTasks(prev => prev.map(t => {
            if (t.id === dragging.taskId) return { ...t, ...gridMinsToSchedule(finalStart, date) };
            const ns = siblingsMap[t.id];
            return ns !== undefined ? { ...t, ...gridMinsToSchedule(ns, date) } : t;
          }));
        } else if (dragging.type === 'task-resize-bottom') {
          const newEndMin = Math.max(dragging.origMin + SNAP, Math.min(MAX_GRID_MINS, snapMinutes(dragging.origEndMin + deltaMins)));
          const newDur = newEndMin - dragging.origMin;
          setLocalTasks(prev => prev.map(t => t.id === dragging.taskId ? { ...t, duration: newDur } : t));
        } else if (dragging.type === 'task-resize-top') {
          const newStartMin = Math.max(0, Math.min(dragging.origEndMin - SNAP, snapMinutes(dragging.origMin + deltaMins)));
          const newDur = dragging.origEndMin - newStartMin;
          const resized = gridMinsToSchedule(newStartMin, date);
          setLocalTasks(prev => prev.map(t => t.id === dragging.taskId ? { ...t, ...resized, duration: newDur } : t));
        }
      });
    };
    const onUp = async (e) => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onUp);
      if (dragging.type === 'window-start' || dragging.type === 'window-end') {
        onWindowChange(date, localWindowRef.current);
      } else if (dragging.type === 'task-move' || dragging.type === 'task-resize-bottom' || dragging.type === 'task-resize-top') {
        const updated = localTasksRef.current.find(t => t.id === dragging.taskId);
        if (updated) {
          let savedDate = updated.scheduled_date;
          if (isWeekView && dragging.type === 'task-move') {
            const el = document.elementFromPoint(e.clientX, e.clientY);
            const col = el?.closest('[data-date]');
            if (col && col.getAttribute('data-date') !== date) savedDate = col.getAttribute('data-date');
          }
          const allUpdates = [{ id: updated.id, scheduled_time: updated.scheduled_time, scheduled_date: savedDate, duration: updated.duration }];
          // Also save sibling tasks that were pushed during a move
          if (dragging.type === 'task-move' && dragging.origTaskPositions) {
            for (const [idStr, origStart] of Object.entries(dragging.origTaskPositions)) {
              const tid = Number(idStr);
              if (tid === updated.id) continue;
              const t = localTasksRef.current.find(t => t.id === tid);
              if (!t || !t.scheduled_time) continue;
              if (taskGridMinutes(t, date) !== origStart)
                allUpdates.push({ id: t.id, scheduled_time: t.scheduled_time, scheduled_date: t.scheduled_date });
            }
          }
          await Promise.all(allUpdates.map(u => api.updateTask(u.id, u)));
          if (onApplyTaskUpdates) onApplyTaskUpdates(allUpdates);
        }
      }
      setDragging(null);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onUp);
    return () => {
      if (dragRafRef.current) { cancelAnimationFrame(dragRafRef.current); dragRafRef.current = null; }
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onUp);
    };
  }, [dragging, date, onWindowChange, onApplyTaskUpdates, isWeekView]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep ref in sync so onUp can read the latest position without closing over stale state
  useEffect(() => { blockDragRef.current = blockDrag; }, [blockDrag]);

  // ── Grid drag (task or block creation) ───────────────────────────────────
  // Depends only on whether drag is active (not on blockDrag itself) so that
  // setBlockDrag calls inside onMove don't churn event listener registration.
  const isBlockDragging = !!blockDrag;
  useEffect(() => {
    if (!isBlockDragging) return;
    const onMove = (e) => {
      if (!wrapperRef.current) return;
      if (e.cancelable) e.preventDefault();
      const clientY = getPointerY(e);
      const y = getRelativeY({ clientY }, wrapperRef.current);
      const mins = snapMinutes(Math.max(0, Math.min(MAX_GRID_MINS, yToMinutes(y))));
      const screenX = e.touches?.[0]?.clientX ?? e.changedTouches?.[0]?.clientX ?? (blockDragRef.current?.screenX ?? 0);
      const screenY = e.touches?.[0]?.clientY ?? e.changedTouches?.[0]?.clientY ?? (blockDragRef.current?.screenY ?? 0);
      setBlockDrag(prev => prev ? { ...prev, endMin: mins, screenX, screenY } : null);
    };
    const onUp = (e) => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onUp);
      const bd = blockDragRef.current;
      if (bd) {
        const start = Math.min(bd.startMin, bd.endMin);
        const end = Math.max(bd.startMin, bd.endMin);
        if (end - start >= SNAP) {
          const ex = e.changedTouches?.[0]?.clientX ?? e.clientX;
          const ey = e.changedTouches?.[0]?.clientY ?? e.clientY;
          setPendingSlot({
            startMin: start,
            endMin: end,
            screenX: ex,
            screenY: ey,
          });
        }
      }
      setBlockDrag(null);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onUp);
    };
  }, [isBlockDragging]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleGridMouseDown = (e) => {
    if (e.target !== gridRef.current) return;
    if (!wrapperRef.current) return;
    const y = getRelativeY(e, wrapperRef.current);
    const mins = snapMinutes(Math.max(0, Math.min(MAX_GRID_MINS, yToMinutes(y))));
    setBlockDrag({ startMin: mins, endMin: mins, screenX: e.clientX, screenY: e.clientY });
  };


  const handleConfirmBlock = (startMin, endMin) => {
    const next = [...blockedTimes, { date, start: formatTime(startMin), end: formatTime(endMin) }];
    onBlockedTimesChange(next);
  };

  const removeBlocked = (idx) => {
    const next = blockedTimes.filter((_, i) => i !== idx);
    onBlockedTimesChange(next);
  };

  // ── HTML5 drag-from-sidebar handlers ──────────────────────────────────────
  const handleGridDragOver = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!wrapperRef.current) return;
    const y = getRelativeY(e, wrapperRef.current);
    const mins = snapMinutes(Math.max(0, Math.min(MAX_GRID_MINS, yToMinutes(y))));
    setDragOverMins(mins);
  };

  const handleGridDragLeave = () => setDragOverMins(null);

  const handleGridDrop = async (e) => {
    e.preventDefault();
    setDragOverMins(null);
    const taskJson = e.dataTransfer.getData('application/task-json');
    if (!taskJson || !wrapperRef.current) return;
    const task = JSON.parse(taskJson);
    const y = getRelativeY(e, wrapperRef.current);
    const rawMins = snapMinutes(Math.max(0, Math.min(MAX_GRID_MINS - (task.duration || 30), yToMinutes(y))));
    const updates = gridMinsToSchedule(rawMins, date);
    setLocalTasks(prev => {
      const exists = prev.some(t => t.id === task.id);
      if (exists) return prev.map(t => t.id === task.id ? { ...t, ...updates } : t);
      return [...prev, { ...task, ...updates }];
    });
    await onUpdateTask(task.id, updates);
  };

  const handleUnschedule = async (task) => {
    const updates = { scheduled_time: null, scheduled_date: null };
    setLocalTasks(prev => prev.map(t => t.id === task.id ? { ...t, ...updates } : t));
    await onUpdateTask(task.id, updates);
    const hasCalEvent = task.gcal_event_id || task.ms_event_id;
    if (hasCalEvent && onCalendarDeleteEvent) {
      const calName = task.gcal_event_id ? 'Google Calendar' : 'Outlook';
      if (window.confirm(`Also remove this event from ${calName}?`)) {
        await onCalendarDeleteEvent(task.id);
      }
    }
  };

  const handleMarkDone = async (task) => {
    setLocalTasks(prev => prev.filter(t => t.id !== task.id));
    try {
      if (onMarkDone) await onMarkDone(task.id);
    } catch (err) {
      setLocalTasks(prev => [...prev, task]);
    }
  };

  const handleToggleLock = async (task) => {
    const locked = !task.locked;
    setLocalTasks(prev => prev.map(t => t.id === task.id ? { ...t, locked } : t));
    await onUpdateTask(task.id, { locked });
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  const hourLabels = Array.from({ length: GRID_HOURS }, (_, h) => h);
  const dateBlockedForDay = blockedTimes.filter(b => b.date === date);
  const isToday = date === toLocalDateStr(new Date());
  const nowMinutes = useNowMinutes();

  return (
    <div className={`timebox-day-column ${isWeekView ? 'week-col' : ''}`} data-date={date}>
      {/* Column header */}
      <div className={`timebox-col-header ${isToday ? 'today' : ''}`}>
        <div className="timebox-col-date">{formatDateLabel(date)}</div>
        <div className="timebox-col-actions">
          <span className="timebox-mit-count">⭐ {[...mitIds].filter(id => columnTasks.some(t => t.id === id)).length}/3</span>
          <button className="timebox-auto-btn" onClick={handleAutoSchedule} title="Auto-schedule tasks">
            ⚡ Auto
          </button>
        </div>
      </div>

      {/* Grid */}
      <div className="timebox-grid-wrapper" ref={wrapperRef}
        onDragOver={handleGridDragOver}
        onDrop={handleGridDrop}
        onDragLeave={handleGridDragLeave}
      >
        <div className="timebox-grid" ref={gridRef} onMouseDown={handleGridMouseDown}
          style={{ height: GRID_HEIGHT }}>

          {/* Drag-from-sidebar preview */}
          {dragOverMins !== null && (
            <div className="timebox-drag-preview" style={{ top: dragOverMins * PX_PER_MIN, height: 30 * PX_PER_MIN }} />
          )}

          {/* Hour lines + labels (24 normal + 5 next-day overflow) */}
          {hourLabels.map(h => {
            const isOverflow = h >= 24;
            const displayH = isOverflow ? h - 24 : h;
            return (
              <React.Fragment key={h}>
                <div
                  className={`timebox-hour-label${isOverflow ? ' overflow-hour' : ''}`}
                  style={{ top: h * PX_PER_HOUR }}
                >
                  {String(displayH).padStart(2, '0')}
                </div>
                <div className="timebox-hour-line" style={{ top: h * PX_PER_HOUR }} />
                <div className="timebox-halfhour-line" style={{ top: h * PX_PER_HOUR + PX_PER_HOUR / 2 }} />
              </React.Fragment>
            );
          })}

          {/* Inactive overlays — stop at midnight; overflow zone styled separately */}
          <div className="timebox-inactive" style={{ top: 0, height: timeToY(localWindow.start) }} />
          <div className="timebox-inactive" style={{ top: timeToY(localWindow.end), height: Math.max(0, GRID_HEIGHT - timeToY(localWindow.end)) }} />

          {/* Midnight divider + next-day overflow zone */}
          <div className="timebox-nextday-zone" style={{ top: 24 * PX_PER_HOUR, height: OVERFLOW_HOURS * PX_PER_HOUR }} />
          <div className="timebox-midnight-line" style={{ top: 24 * PX_PER_HOUR }}>
            <span className="timebox-midnight-label">↑ {addDays(date, 1).slice(5).replace('-', '/')} ↓</span>
          </div>

          {/* Blocked times */}
          {dateBlockedForDay.map((b, i) => (
            <div
              key={i}
              className="timebox-blocked"
              style={{ top: timeToY(b.start), height: Math.max(8, timeToY(b.end) - timeToY(b.start)) }}
              onClick={() => removeBlocked(blockedTimes.indexOf(b))}
              title="Click to remove blocked time"
            >
              <span className="timebox-blocked-label">Blocked · {b.start}–{b.end}</span>
            </div>
          ))}

          {/* Active drag preview */}
          {blockDrag && blockDrag.endMin !== blockDrag.startMin && (
            <div
              className="timebox-blocked timebox-blocked--preview"
              style={{
                top: Math.min(blockDrag.startMin, blockDrag.endMin) * PX_PER_MIN,
                height: Math.abs(blockDrag.endMin - blockDrag.startMin) * PX_PER_MIN,
              }}
            />
          )}

          {/* Current time indicator */}
          {isToday && (
            <div className="timebox-now-line" style={{ top: nowMinutes * PX_PER_MIN }}>
              <div className="timebox-now-dot" />
            </div>
          )}

          {/* Window bars */}
          <div
            className="window-bar window-bar--start"
            style={{ top: timeToY(localWindow.start) }}
            onMouseDown={(e) => startPointerDrag('window-start', { origMin: parseMinutes(localWindow.start) }, e)}
            onTouchStart={(e) => startPointerDrag('window-start', { origMin: parseMinutes(localWindow.start) }, e)}
          >
            <span className="window-bar-label">▲ {localWindow.start}</span>
          </div>
          <div
            className="window-bar window-bar--end"
            style={{ top: timeToY(localWindow.end) }}
            onMouseDown={(e) => startPointerDrag('window-end', { origMin: parseMinutes(localWindow.end) }, e)}
            onTouchStart={(e) => startPointerDrag('window-end', { origMin: parseMinutes(localWindow.end) }, e)}
          >
            <span className="window-bar-label">▼ {formatGridTime(parseMinutes(localWindow.end))}</span>
          </div>

          {/* Scheduled task blocks */}
          {scheduled.map(task => {
            const isMit = mitIds.has(task.id);
            const isLocked = Boolean(task.locked);
            const gridMins = taskGridMinutes(task, date);
            const taskTop = gridMins * PX_PER_MIN;
            const taskHeight = Math.max(22, (task.duration || 30) * PX_PER_MIN);
            const taskHat = hats?.find(h => h.id === task.hat_id);
            return (
              <div
                key={task.id}
                className={`timebox-task priority-${task.priority || 'none'} ${isMit ? 'mit' : ''} ${isLocked ? 'locked' : ''}`}
                style={{ top: taskTop, height: taskHeight, ...(taskHat?.color ? { borderLeft: `3px solid ${taskHat.color}` } : {}) }}
                onDoubleClick={(e) => { e.stopPropagation(); onEditTask(task); }}
                onMouseDown={(e) => {
                  if (isLocked) return;
                  if (e.target.classList.contains('timebox-task-resize-top') ||
                    e.target.classList.contains('timebox-task-resize-bottom')) return;
                  const origTaskPositions = {};
                  localTasks.forEach(t => {
                    if (t.scheduled_time && isOnDaysGrid(t, date))
                      origTaskPositions[t.id] = taskGridMinutes(t, date);
                  });
                  startPointerDrag('task-move', {
                    taskId: task.id,
                    origMin: gridMins,
                    duration: task.duration || 30,
                    origTaskPositions,
                  }, e);
                }}
                onTouchStart={(e) => {
                  if (isLocked) return;
                  handleTaskTouchStart(task, gridMins, e);
                }}
              >
                <div
                  className="timebox-task-resize-top"
                  onMouseDown={(e) => { if (isLocked) return; startPointerDrag('task-resize-top', {
                    taskId: task.id,
                    origMin: gridMins,
                    origEndMin: gridMins + (task.duration || 30),
                  }, e); }}
                  onTouchStart={(e) => { if (isLocked) return; startPointerDrag('task-resize-top', { taskId: task.id, origMin: gridMins, origEndMin: gridMins + (task.duration || 30) }, e); }}
                />
                <div className="timebox-task-body">
                  <span className="timebox-task-desc">{task.description}</span>
                  <div className="timebox-task-meta">
                    <span className="timebox-task-duration">{task.duration || 30}m</span>
                    <button
                      className="timebox-task-done-btn"
                      onMouseDown={(e) => e.stopPropagation()}
                      onTouchStart={(e) => e.stopPropagation()}
                      onClick={(e) => { e.stopPropagation(); handleMarkDone(task); }}
                      title="Mark as complete"
                    >✓</button>
                    <button
                      className="timebox-task-edit-btn"
                      onMouseDown={(e) => e.stopPropagation()}
                      onTouchStart={(e) => e.stopPropagation()}
                      onClick={(e) => { e.stopPropagation(); onEditTask(task); }}
                      title="Edit task"
                    >✎</button>
                    <button
                      className={`timebox-lock-btn ${isLocked ? 'active' : ''}`}
                      onMouseDown={(e) => e.stopPropagation()}
                      onTouchStart={(e) => e.stopPropagation()}
                      onClick={(e) => { e.stopPropagation(); handleToggleLock(task); }}
                      title={isLocked ? 'Unlock task' : 'Lock task in time'}
                    >{isLocked ? '🔒' : '🔓'}</button>
                    <button
                      className={`timebox-mit-btn ${isMit ? 'active' : ''} ${!isMit && mitIds.size >= 3 ? 'disabled' : ''}`}
                      onMouseDown={(e) => e.stopPropagation()}
                      onTouchStart={(e) => e.stopPropagation()}
                      onClick={(e) => { e.stopPropagation(); onToggleMit(task.id); }}
                      title={isMit ? 'Remove from MIT' : 'Mark as Most Important Task'}
                    >⭐</button>
                    {onPinPomodoro && (
                      <button
                        className="timebox-task-pom-btn"
                        onMouseDown={(e) => e.stopPropagation()}
                        onTouchStart={(e) => e.stopPropagation()}
                        onClick={(e) => { e.stopPropagation(); onPinPomodoro(task); }}
                        title="Start Pomodoro for this task"
                      >🍅</button>
                    )}
                    <button
                      className="timebox-task-unschedule"
                      onMouseDown={(e) => e.stopPropagation()}
                      onTouchStart={(e) => e.stopPropagation()}
                      onClick={(e) => { e.stopPropagation(); handleUnschedule(task); }}
                      title="Remove from schedule"
                    >×</button>
                  </div>
                </div>
                <div
                  className="timebox-task-resize-bottom"
                  onMouseDown={(e) => { if (isLocked) return; startPointerDrag('task-resize-bottom', {
                    taskId: task.id,
                    origMin: gridMins,
                    origEndMin: gridMins + (task.duration || 30),
                  }, e); }}
                  onTouchStart={(e) => { if (isLocked) return; startPointerDrag('task-resize-bottom', { taskId: task.id, origMin: gridMins, origEndMin: gridMins + (task.duration || 30) }, e); }}
                />
              </div>
            );
          })}
        </div>
      </div>

      {/* Slot popup (fixed position, rendered outside scroll container) */}
      {pendingSlot && (
        <SlotPopup
          slot={pendingSlot}
          date={date}
          onAddTask={onAddTask}
          onBlockTime={handleConfirmBlock}
          onCancel={() => setPendingSlot(null)}
        />
      )}


      {/* Task pool — all unscheduled tasks (always shown in day view / today's week col) */}
      {showTaskPool && (
        <div className="timebox-unscheduled">
          <button className="timebox-unscheduled-toggle" onClick={() => setUnscheduledOpen(o => !o)}>
            <span>{unscheduledOpen ? '▾' : '▸'}</span>
            Task Pool
            {unscheduled.length > 0 && (
              <span className="timebox-unscheduled-count">{unscheduled.length}</span>
            )}
          </button>
          {unscheduledOpen && (
            <div className="timebox-unscheduled-list">
              {unscheduled.length === 0 ? (
                <div className="timebox-pool-empty">All tasks are scheduled ✓</div>
              ) : (
                unscheduled.map(task => {
                  const unschedHat = hats?.find(h => h.id === task.hat_id);
                  return (
                  <div key={task.id} className={`timebox-unscheduled-chip priority-${task.priority || 'none'} ${mitIds.has(task.id) ? 'mit' : ''}`}
                    style={unschedHat?.color ? { borderLeft: `3px solid ${unschedHat.color}` } : undefined}>
                    <span className="timebox-chip-desc">{task.description}</span>
                    <span className="timebox-chip-dur">{task.duration || 30}m</span>
                    <button
                      className={`timebox-mit-btn ${mitIds.has(task.id) ? 'active' : ''} ${!mitIds.has(task.id) && mitIds.size >= 3 ? 'disabled' : ''}`}
                      onClick={() => onToggleMit(task.id)}
                      title="Toggle Most Important Task"
                    >⭐</button>
                  </div>
                  );
                })
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── SortablePoolChip ─────────────────────────────────────────────────────────
function SortablePoolChip({ task, hats, mitIds, onDismiss, onEdit, onToggleMit, onScheduleNow }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id });
  const handleRef = useRef(null);
  const lastMouseDownTarget = useRef(null);
  const hat = hats?.find(h => h.id === task.hat_id);
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: DndCSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.4 : 1,
        ...(hat?.color ? { borderLeft: `3px solid ${hat.color}` } : {}),
      }}
      className={`timebox-sidebar-chip priority-${task.priority || 'none'} ${mitIds.has(task.id) ? 'mit' : ''}`}
      draggable
      onMouseDown={(e) => { lastMouseDownTarget.current = e.target; }}
      onDragStart={(e) => {
        if (handleRef.current?.contains(lastMouseDownTarget.current)) {
          e.preventDefault();
          return;
        }
        e.dataTransfer.setData('application/task-json', JSON.stringify(task));
        e.dataTransfer.effectAllowed = 'move';
      }}
      title="Drag onto the grid to schedule"
    >
      <span ref={handleRef} className="timebox-pool-drag-handle" {...attributes} {...listeners} title="Drag to reorder">⠿</span>
      <button className="timebox-chip-dismiss" onClick={(e) => { e.stopPropagation(); onDismiss(task.id); }} title="Remove from today's pool">×</button>
      <span className="timebox-chip-desc">{task.description}</span>
      <div className="timebox-chip-row">
        <span className="timebox-chip-dur">{task.duration || 30}m</span>
        {onScheduleNow && (
          <button
            className="timebox-chip-schedule-btn"
            onMouseDown={(e) => e.stopPropagation()}
            onTouchStart={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onScheduleNow(task); }}
            title="Schedule at next available slot"
          >⚡</button>
        )}
        <button className="timebox-task-edit-btn" onClick={(e) => { e.stopPropagation(); onEdit(task); }} title="Edit task">✎</button>
        <button
          className={`timebox-mit-btn ${mitIds.has(task.id) ? 'active' : ''} ${!mitIds.has(task.id) && mitIds.size >= 3 ? 'disabled' : ''}`}
          onClick={(e) => { e.stopPropagation(); onToggleMit(task.id); }}
          title="Toggle Most Important Task"
        >⭐</button>
      </div>
    </div>
  );
}

// ── TimeboxView (main) ────────────────────────────────────────────────────────
function TimeboxView({ tasks, hats, onUpdate, onAddTask, onApplyTaskUpdates, onMarkDone, maxHistoryDays = 14, onSyncToCalendar, onCalendarDeleteEvent, calendarConnected, onPinPomodoro }) {
  const [subView, setSubView] = useState('day');
  const [dayOffset, setDayOffset] = useState(0);
  const [mitIds, setMitIds] = useState(() => new Set(loadMit()));
  const [dayWindows, setDayWindows] = useState(loadDayWindows);
  const [blockedTimes, setBlockedTimes] = useState(loadBlockedTimes);
  const [weekStartOffset, setWeekStartOffset] = useState(0);
  const [editingTask, setEditingTask] = useState(null);
  const containerRef = useRef(null);
  const [dismissed, setDismissed] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() + 0);
    return loadDismissed(toLocalDateStr(d));
  });
  const [futureTasks, setFutureTasks] = useState(null);
  const poolSensors = useSensors(useSensor(SmartPointerSensor, { activationConstraint: { distance: 6 } }));

  // On mobile, scroll to bring the grid into view when this view first mounts
  useEffect(() => {
    if (!window.matchMedia('(max-width: 700px)').matches) return;
    const grid = containerRef.current?.querySelector('.timebox-grid-wrapper');
    if (!grid) return;
    const rect = grid.getBoundingClientRect();
    if (rect.top > window.innerHeight - 80) {
      grid.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const weekDates = getWeekDates(weekStartOffset);
  const selectedDay = (() => { const d = new Date(); d.setDate(d.getDate() + dayOffset); return toLocalDateStr(d); })();

  const canGoBack = weekStartOffset > -maxHistoryDays;
  const canGoForward = weekStartOffset < 90; // allow up to 90 days forward for everyone

  const goBack = () => setWeekStartOffset(o => Math.max(o - 7, -maxHistoryDays));
  const goForward = () => setWeekStartOffset(o => Math.min(o + 7, 90));
  const goToToday = () => setWeekStartOffset(0);

  const weekRangeLabel = (() => {
    const first = new Date(weekDates[0] + 'T00:00:00');
    const last = new Date(weekDates[6] + 'T00:00:00');
    return `${first.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${last.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
  })();

  const getWindowForDate = (date) =>
    dayWindows[date] || { start: '07:00', end: '24:00' };

  const handleWindowChange = useCallback((date, newWindow) => {
    setDayWindows(prev => {
      const next = { ...prev, [date]: newWindow };
      saveDayWindows(next);
      return next;
    });
  }, []);

  const handleBlockedTimesChange = useCallback((next) => {
    setBlockedTimes(next);
    saveBlockedTimes(next);
  }, []);

  const handleQuickSchedule = useCallback(async (task) => {
    const date = selectedDay;
    const win = dayWindows[date] || { start: '07:00', end: '24:00' };
    const wStart = parseMinutes(win.start);
    const wEnd = parseMinutes(win.end);
    const now = new Date();
    const isToday = date === toLocalDateStr(now);
    const nowMins = now.getHours() * 60 + now.getMinutes();
    const taskSource = (dayOffset > 0 && futureTasks) ? futureTasks : tasks;
    const allBlocked = [
      ...blockedTimes
        .filter(b => b.date === date)
        .map(b => ({ start: parseMinutes(b.start), end: parseMinutes(b.end) })),
      ...taskSource
        .filter(t => isOnDaysGrid(t, date))
        .map(t => { const gs = taskGridMinutes(t, date); return { start: gs, end: gs + (t.duration || 30) }; }),
    ];
    const cursor = isToday ? Math.max(wStart, snapMinutes(nowMins)) : wStart;
    const dur = task.duration || 30;
    const slot = advancePastBlockedGrid(cursor, dur, allBlocked);
    if (slot + dur > wEnd) return;
    const scheduled = gridMinsToSchedule(slot, date);
    await onUpdate(task.id, { scheduled_time: scheduled.scheduled_time, scheduled_date: scheduled.scheduled_date });
  }, [selectedDay, dayWindows, blockedTimes, tasks, futureTasks, dayOffset, onUpdate]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleToggleMit = (taskId) => {
    setMitIds(prev => {
      const next = new Set(prev);
      if (next.has(taskId)) {
        next.delete(taskId);
      } else if (next.size < 3) {
        next.add(taskId);
      }
      saveMit(next);
      return next;
    });
  };


  useEffect(() => {
    const d = new Date(); d.setDate(d.getDate() + dayOffset);
    const dateStr = toLocalDateStr(d);
    setDismissed(loadDismissed(dateStr));
    if (dayOffset > 0) {
      setFutureTasks(null);
      api.getTasksForDate(dateStr).then(setFutureTasks).catch(() => setFutureTasks(null));
    } else {
      setFutureTasks(null);
    }
  }, [dayOffset]);

  const handleDismiss = (taskId) => {
    const d = new Date(); d.setDate(d.getDate() + dayOffset);
    const dateStr = toLocalDateStr(d);
    setDismissed(prev => {
      const next = new Set(prev);
      next.add(taskId);
      saveDismissed(dateStr, next);
      return next;
    });
  };

  const handlePoolDragEnd = useCallback((event) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const taskSource = (dayOffset > 0 && futureTasks) ? futureTasks : tasks;
    const pool = taskSource.filter(t => !isOnDaysGrid(t, selectedDay) && !dismissed.has(t.id));
    const oldIdx = pool.findIndex(t => t.id === active.id);
    const newIdx = pool.findIndex(t => t.id === over.id);
    if (oldIdx === -1 || newIdx === -1) return;
    const reordered = arrayMove(pool, oldIdx, newIdx);
    const posUpdates = reordered.map((t, i) => ({ id: t.id, position: i }));
    if (onApplyTaskUpdates) onApplyTaskUpdates(posUpdates);
    api.reorder(posUpdates).catch(() => {});
  }, [dayOffset, futureTasks, tasks, selectedDay, dismissed, onApplyTaskUpdates]);

  const sharedProps = {
    tasks,
    hats,
    blockedTimes,
    onBlockedTimesChange: handleBlockedTimesChange,
    mitIds,
    onToggleMit: handleToggleMit,
    onUpdateTask: onUpdate,
    onAddTask,
    onApplyTaskUpdates,
    onMarkDone,
    onEditTask: setEditingTask,
    onCalendarDeleteEvent,
    onPinPomodoro,
  };

  return (
    <div className="timebox-container" ref={containerRef}>
      {editingTask && (
        <TaskEditModal
          task={editingTask}
          hats={hats}
          onSave={async (id, data) => {
            await onUpdate(id, data);
            setEditingTask(null);
          }}
          onClose={() => setEditingTask(null)}
        />
      )}
      <div className="timebox-subview-toggle">
        <button className={`timebox-sub-btn ${subView === 'day' ? 'active' : ''}`} onClick={() => setSubView('day')}>Day</button>
        <button className={`timebox-sub-btn ${subView === 'week' ? 'active' : ''}`} onClick={() => setSubView('week')}>Week</button>
        {onSyncToCalendar && (
          <button
            className={`timebox-sub-btn timebox-sync-btn${calendarConnected ? ' connected' : ''}`}
            onClick={onSyncToCalendar}
            title={calendarConnected ? 'Sync scheduled tasks to calendar' : 'Connect a calendar'}
          >
            {calendarConnected ? '📅 Sync' : '📅 Connect'}
          </button>
        )}
      </div>

      {subView === 'day' && (() => {
        return (
        <div className="timebox-day-layout">
          {/* Task pool sidebar — all tasks with no scheduled_time */}
          <aside className="timebox-task-sidebar">
            <div className="timebox-day-nav">
              <button className="timebox-nav-btn" onClick={() => setDayOffset(o => o - 1)}>‹</button>
              <button className="timebox-nav-date-label" onClick={() => setDayOffset(0)} title="Go to today">
                {dayOffset === 0 ? 'Today' : dayOffset === 1 ? 'Tomorrow' : dayOffset === -1 ? 'Yesterday' : formatDateLabel(selectedDay)}
              </button>
              <button className="timebox-nav-btn" onClick={() => setDayOffset(o => o + 1)}>›</button>
            </div>
            <div className="timebox-task-sidebar-hd">Task Pool</div>
            <div className="timebox-task-sidebar-body">
              {(() => {
                const taskSource = (dayOffset > 0 && futureTasks) ? futureTasks : tasks;
                const pool = taskSource.filter(t => !isOnDaysGrid(t, selectedDay) && !dismissed.has(t.id));
                const hasDismissed = taskSource.some(t => !isOnDaysGrid(t, selectedDay) && dismissed.has(t.id));
                if (pool.length === 0 && !hasDismissed) return <div className="timebox-pool-empty">All tasks scheduled ✓</div>;
                if (pool.length === 0) return <div className="timebox-pool-empty">No tasks for today ✓</div>;
                return (
                  <DndContext
                    sensors={poolSensors}
                    collisionDetection={closestCenter}
                    onDragEnd={handlePoolDragEnd}
                  >
                    <SortableContext items={pool.map(t => t.id)} strategy={verticalListSortingStrategy}>
                      {pool.map(task => (
                        <SortablePoolChip
                          key={task.id}
                          task={task}
                          hats={hats}
                          mitIds={mitIds}
                          onDismiss={handleDismiss}
                          onEdit={setEditingTask}
                          onToggleMit={handleToggleMit}
                          onScheduleNow={handleQuickSchedule}
                        />
                      ))}
                    </SortableContext>
                  </DndContext>
                );
              })()}
            </div>
          </aside>
          <TimeboxDayColumn
            {...sharedProps}
            date={selectedDay}
            dayWindow={getWindowForDate(selectedDay)}
            onWindowChange={handleWindowChange}
            isWeekView={false}
            dismissedIds={dismissed}
          />
        </div>
        );
      })()}

      {subView === 'week' && (
        <>
          <div className="timebox-week-nav">
            <button className="timebox-nav-btn" onClick={goBack} disabled={!canGoBack} title={`Go back (max ${maxHistoryDays} days)`}>‹</button>
            <span className="timebox-week-range">{weekRangeLabel}</span>
            {weekStartOffset !== 0 && (
              <button className="timebox-nav-today-btn" onClick={goToToday}>Today</button>
            )}
            <button className="timebox-nav-btn" onClick={goForward} disabled={!canGoForward}>›</button>
          </div>
          <div className="timebox-week-wrapper">
            {weekDates.map(date => (
              <TimeboxDayColumn
                key={date}
                {...sharedProps}
                date={date}
                dayWindow={getWindowForDate(date)}
                onWindowChange={handleWindowChange}
                isWeekView
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export default TimeboxView;
