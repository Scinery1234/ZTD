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

function advancePastBlocked(cursorMin, durationMin, blockedTimes, date) {
  let cursor = cursorMin;
  let changed = true;
  while (changed) {
    changed = false;
    for (const b of blockedTimes) {
      if (b.date !== date) continue;
      const bs = parseMinutes(b.start);
      const be = parseMinutes(b.end);
      if (cursor < be && cursor + durationMin > bs) {
        cursor = be;
        changed = true;
      }
    }
  }
  return cursor;
}

// During drag: if desired position overlaps a locked task, snap to the nearest
// free slot (before or after the locked task), based on raw desired position.
function snapAroundLocked(desiredMin, durationMin, lockedIntervals, date) {
  let result = desiredMin;
  let changed = true;
  while (changed) {
    changed = false;
    for (const b of lockedIntervals) {
      if (b.date !== date) continue;
      const bs = parseMinutes(b.start);
      const be = parseMinutes(b.end);
      if (result < be && result + durationMin > bs) {
        const before = bs - durationMin;
        const after = be;
        result = Math.abs(desiredMin - before) <= Math.abs(desiredMin - after) ? before : after;
        changed = true;
        break;
      }
    }
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
  try { return JSON.parse(localStorage.getItem('ztd_day_windows') || '{}'); }
  catch { return {}; }
}
function saveDayWindows(v) { localStorage.setItem('ztd_day_windows', JSON.stringify(v)); }

function loadBlockedTimes() {
  try { return JSON.parse(localStorage.getItem('ztd_blocked_times') || '[]'); }
  catch { return []; }
}
function saveBlockedTimes(v) { localStorage.setItem('ztd_blocked_times', JSON.stringify(v)); }

function loadMit() {
  try { return JSON.parse(localStorage.getItem('ztd_mit_tasks') || '[]'); }
  catch { return []; }
}
function saveMit(ids) { localStorage.setItem('ztd_mit_tasks', JSON.stringify([...ids])); }

function loadDismissed(dateStr) {
  try {
    const all = JSON.parse(localStorage.getItem('ztd_dismissed') || '{}');
    return new Set(all[dateStr] || []);
  } catch { return new Set(); }
}
function saveDismissed(dateStr, ids) {
  try {
    const all = JSON.parse(localStorage.getItem('ztd_dismissed') || '{}');
    all[dateStr] = [...ids];
    // Prune entries older than 30 days
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 30);
    for (const key of Object.keys(all)) {
      if (key < toLocalDateStr(cutoff)) delete all[key];
    }
    localStorage.setItem('ztd_dismissed', JSON.stringify(all));
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
function TimeboxDayColumn({ date, tasks, hats, dayWindow, onWindowChange, blockedTimes, onBlockedTimesChange, mitIds, onToggleMit, onUpdateTask, onAddTask, onApplyTaskUpdates, isWeekView, onEditTask, dismissedIds }) {
  const gridRef = useRef(null);
  const wrapperRef = useRef(null);
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
    // Mirror the sidebar pool logic: a task is "on today's grid" if it has a
    // scheduled_time placed specifically for today (not a stale date from another day).
    const isOnTodaysGrid = (t) => {
      if (!t.scheduled_time) return false;
      if (t.scheduled_date === date) return true;
      if (!t.scheduled_date && t.due === date) return true;
      if (t.scheduled_date === nextDayDate &&
          parseMinutes(t.scheduled_time) < OVERFLOW_HOURS * 60) return true;
      return false;
    };
    // Exclude tasks already on today's grid, locked, and dismissed
    const pool = localTasks.filter(t =>
      !isOnTodaysGrid(t) && !t.locked && !(dismissedIds && dismissedIds.has(t.id))
    );
    const ordered = [...pool].sort((a, b) => (a.position ?? 9999) - (b.position ?? 9999));
    // Treat all already-scheduled tasks on this date as blocked
    const allBlocked = [
      ...blockedTimes,
      ...localTasks
        .filter(t => t.scheduled_time && t.scheduled_date === date)
        .map(t => ({
          date,
          start: t.scheduled_time,
          end: formatTime(parseMinutes(t.scheduled_time) + (t.duration || 30)),
        })),
    ];
    const now = new Date();
    const nowMins = now.getHours() * 60 + now.getMinutes();
    const isToday = date === toLocalDateStr(now);
    let cursor = isToday ? Math.max(windowStart, snapMinutes(nowMins)) : windowStart;
    const updates = [];
    for (const task of ordered) {
      const dur = task.duration || 30;
      const slotStart = advancePastBlocked(cursor, dur, allBlocked, date);
      if (slotStart + dur > windowEnd) continue;
      updates.push({ id: task.id, scheduled_time: formatTime(slotStart), scheduled_date: date });
      cursor = slotStart + dur;
      allBlocked.push({ date, start: formatTime(slotStart), end: formatTime(slotStart + dur) });
    }
    if (updates.length === 0) return;
    // Apply all to local state immediately — no intermediate renders, no flicker
    const updatedMap = {};
    updates.forEach(u => { updatedMap[u.id] = u; });
    setLocalTasks(prev => prev.map(t => updatedMap[t.id] ? { ...t, ...updatedMap[t.id] } : t));
    // Save all to API in parallel, then sync parent state without an HTTP re-fetch
    await Promise.all(updates.map(u =>
      api.updateTask(u.id, { scheduled_time: u.scheduled_time, scheduled_date: u.scheduled_date })
    ));
    if (onApplyTaskUpdates) onApplyTaskUpdates(updates);
  }, [localTasks, blockedTimes, date, windowStart, windowEnd, dismissedIds, onApplyTaskUpdates]);

  // ── Task / window drag ─────────────────────────────────────────────────────
  const startMouseDrag = useCallback((type, extra, e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging({ type, startY: e.clientY, ...extra });
  }, []);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e) => {
      const deltaY = e.clientY - dragging.startY;
      const deltaMins = yToMinutes(deltaY);
      const wStart = parseMinutes(localWindowRef.current.start);
      const wEnd = parseMinutes(localWindowRef.current.end);
      if (dragging.type === 'window-start') {
        const newMin = Math.max(0, Math.min(wEnd - 60, snapMinutes(dragging.origMin + deltaMins)));
        setLocalWindow(w => ({ ...w, start: formatTime(newMin) }));
      } else if (dragging.type === 'window-end') {
        const newMin = Math.max(wStart + 60, Math.min(MAX_GRID_MINS, snapMinutes(dragging.origMin + deltaMins)));
        setLocalWindow(w => ({ ...w, end: formatExtendedTime(newMin) }));
      } else if (dragging.type === 'task-move') {
        const dur = dragging.duration || 30;
        // Allow dragging anywhere on the 29-hour grid (not clamped to window)
        let newMin = Math.max(0, Math.min(MAX_GRID_MINS - dur, snapMinutes(dragging.origMin + deltaMins)));
        // Hop over locked tasks — snap to nearest free slot (before or after)
        const lockedIntervals = localTasksRef.current
          .filter(t => t.id !== dragging.taskId && t.locked && t.scheduled_time)
          .map(t => ({
            date: t.scheduled_date || date,
            start: t.scheduled_time,
            end: formatTime(parseMinutes(t.scheduled_time) + (t.duration || 30)),
          }));
        if (lockedIntervals.length > 0) {
          newMin = snapAroundLocked(newMin, dur, lockedIntervals, date);
          newMin = Math.max(0, Math.min(MAX_GRID_MINS - dur, newMin));
        }
        const moved = gridMinsToSchedule(newMin, date);
        setLocalTasks(prev => prev.map(t => t.id === dragging.taskId ? { ...t, ...moved } : t));
      } else if (dragging.type === 'task-resize-bottom') {
        // Allow resizing into the next-day area
        const newEndMin = Math.max(dragging.origMin + SNAP, Math.min(MAX_GRID_MINS, snapMinutes(dragging.origEndMin + deltaMins)));
        const newDur = newEndMin - dragging.origMin;
        setLocalTasks(prev => prev.map(t => t.id === dragging.taskId ? { ...t, duration: newDur } : t));
      } else if (dragging.type === 'task-resize-top') {
        const newStartMin = Math.max(0, Math.min(dragging.origEndMin - SNAP, snapMinutes(dragging.origMin + deltaMins)));
        const newDur = dragging.origEndMin - newStartMin;
        const resized = gridMinsToSchedule(newStartMin, date);
        setLocalTasks(prev => prev.map(t => t.id === dragging.taskId ? { ...t, ...resized, duration: newDur } : t));
      }
    };
    const onUp = async (e) => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (dragging.type === 'window-start' || dragging.type === 'window-end') {
        onWindowChange(date, localWindowRef.current);
      } else if (dragging.type === 'task-move' || dragging.type === 'task-resize-bottom' || dragging.type === 'task-resize-top') {
        const updated = localTasksRef.current.find(t => t.id === dragging.taskId);
        if (updated) {
          // scheduled_time/date already set correctly by gridMinsToSchedule during drag.
          // For week-view cross-column drag, override date with the target column.
          let savedDate = updated.scheduled_date;
          if (isWeekView && dragging.type === 'task-move') {
            const el = document.elementFromPoint(e.clientX, e.clientY);
            const col = el?.closest('[data-date]');
            if (col && col.getAttribute('data-date') !== date) {
              savedDate = col.getAttribute('data-date');
            }
          }
          await onUpdateTask(updated.id, {
            scheduled_time: updated.scheduled_time,
            scheduled_date: savedDate,
            duration: updated.duration,
          });
        }
      }
      setDragging(null);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [dragging, date, onWindowChange, onUpdateTask, isWeekView]);

  // ── Grid drag (task or block creation) ───────────────────────────────────
  useEffect(() => {
    if (!blockDrag) return;
    const onMove = (e) => {
      if (!wrapperRef.current) return;
      const y = getRelativeY(e, wrapperRef.current);
      const mins = snapMinutes(Math.max(0, Math.min(MAX_GRID_MINS, yToMinutes(y))));
      setBlockDrag(prev => ({ ...prev, endMin: mins, screenX: e.clientX, screenY: e.clientY }));
    };
    const onUp = (e) => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (blockDrag) {
        const start = Math.min(blockDrag.startMin, blockDrag.endMin);
        const end = Math.max(blockDrag.startMin, blockDrag.endMin);
        if (end - start >= SNAP) {
          // Show popup to choose: add task or block time
          setPendingSlot({
            startMin: start,
            endMin: end,
            screenX: e.clientX,
            screenY: e.clientY,
          });
        }
      }
      setBlockDrag(null);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [blockDrag]);

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
            onMouseDown={(e) => startMouseDrag('window-start', { origMin: parseMinutes(localWindow.start) }, e)}
          >
            <span className="window-bar-label">▲ {localWindow.start}</span>
          </div>
          <div
            className="window-bar window-bar--end"
            style={{ top: timeToY(localWindow.end) }}
            onMouseDown={(e) => startMouseDrag('window-end', { origMin: parseMinutes(localWindow.end) }, e)}
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
                  startMouseDrag('task-move', {
                    taskId: task.id,
                    origMin: gridMins,
                    duration: task.duration || 30,
                  }, e);
                }}
              >
                <div
                  className="timebox-task-resize-top"
                  onMouseDown={(e) => { if (isLocked) return; startMouseDrag('task-resize-top', {
                    taskId: task.id,
                    origMin: gridMins,
                    origEndMin: gridMins + (task.duration || 30),
                  }, e); }}
                />
                <div className="timebox-task-body">
                  <span className="timebox-task-desc">{task.description}</span>
                  <div className="timebox-task-meta">
                    <span className="timebox-task-duration">{task.duration || 30}m</span>
                    <button
                      className="timebox-task-edit-btn"
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => { e.stopPropagation(); onEditTask(task); }}
                      title="Edit task"
                    >✎</button>
                    <button
                      className={`timebox-lock-btn ${isLocked ? 'active' : ''}`}
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => { e.stopPropagation(); handleToggleLock(task); }}
                      title={isLocked ? 'Unlock task' : 'Lock task in time'}
                    >{isLocked ? '🔒' : '🔓'}</button>
                    <button
                      className={`timebox-mit-btn ${isMit ? 'active' : ''} ${!isMit && mitIds.size >= 3 ? 'disabled' : ''}`}
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => { e.stopPropagation(); onToggleMit(task.id); }}
                      title={isMit ? 'Remove from MIT' : 'Mark as Most Important Task'}
                    >⭐</button>
                    <button
                      className="timebox-task-unschedule"
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => { e.stopPropagation(); handleUnschedule(task); }}
                      title="Remove from schedule"
                    >×</button>
                  </div>
                </div>
                <div
                  className="timebox-task-resize-bottom"
                  onMouseDown={(e) => { if (isLocked) return; startMouseDrag('task-resize-bottom', {
                    taskId: task.id,
                    origMin: gridMins,
                    origEndMin: gridMins + (task.duration || 30),
                  }, e); }}
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

// ── TimeboxView (main) ────────────────────────────────────────────────────────
function TimeboxView({ tasks, hats, onUpdate, onAddTask, onApplyTaskUpdates, maxHistoryDays = 14 }) {
  const [subView, setSubView] = useState('day');
  const [dayOffset, setDayOffset] = useState(0);
  const [mitIds, setMitIds] = useState(() => new Set(loadMit()));
  const [dayWindows, setDayWindows] = useState(loadDayWindows);
  const [blockedTimes, setBlockedTimes] = useState(loadBlockedTimes);
  const [weekStartOffset, setWeekStartOffset] = useState(0);
  const [editingTask, setEditingTask] = useState(null);
  const [dismissed, setDismissed] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() + 0);
    return loadDismissed(toLocalDateStr(d));
  });
  const [futureTasks, setFutureTasks] = useState(null);

  const weekDates = getWeekDates(weekStartOffset);

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
    dayWindows[date] || { start: '09:00', end: '18:00' };

  const handleWindowChange = (date, newWindow) => {
    const next = { ...dayWindows, [date]: newWindow };
    setDayWindows(next);
    saveDayWindows(next);
  };

  const handleBlockedTimesChange = (next) => {
    setBlockedTimes(next);
    saveBlockedTimes(next);
  };

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
    onEditTask: setEditingTask,
  };

  return (
    <div className="timebox-container">
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
      </div>

      {subView === 'day' && (() => {
        const d = new Date(); d.setDate(d.getDate() + dayOffset);
        const selectedDay = toLocalDateStr(d);
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
                const nextDayStr = addDays(selectedDay, 1);
                // A task is "on today's grid" if it has a scheduled_time AND is placed on today
                const isOnTodaysGrid = (t) => {
                  if (!t.scheduled_time) return false;
                  if (t.scheduled_date === selectedDay) return true;
                  if (!t.scheduled_date && t.due === selectedDay) return true;
                  if (t.scheduled_date === nextDayStr &&
                      parseMinutes(t.scheduled_time) < OVERFLOW_HOURS * 60) return true;
                  return false;
                };
                const pool = taskSource.filter(t => !isOnTodaysGrid(t) && !dismissed.has(t.id));
                const hasDismissed = taskSource.filter(t => !isOnTodaysGrid(t) && dismissed.has(t.id)).length > 0;
                return (
                  <>
                    {pool.length === 0 && !hasDismissed ? (
                      <div className="timebox-pool-empty">All tasks scheduled ✓</div>
                    ) : pool.length === 0 && hasDismissed ? (
                      <div className="timebox-pool-empty">No tasks for today ✓</div>
                    ) : (
                      pool.map(task => {
                        const poolHat = hats.find(h => h.id === task.hat_id);
                        return (
                        <div
                          key={task.id}
                          className={`timebox-sidebar-chip priority-${task.priority || 'none'} ${mitIds.has(task.id) ? 'mit' : ''}`}
                          style={poolHat?.color ? { borderLeft: `3px solid ${poolHat.color}` } : undefined}
                          draggable
                          onDragStart={(e) => {
                            e.dataTransfer.setData('application/task-json', JSON.stringify(task));
                            e.dataTransfer.effectAllowed = 'move';
                          }}
                          title="Drag onto the grid to schedule"
                        >
                          <button
                            className="timebox-chip-dismiss"
                            onClick={(e) => { e.stopPropagation(); handleDismiss(task.id); }}
                            title="Remove from today's pool"
                          >×</button>
                          <span className="timebox-chip-desc">{task.description}</span>
                          <div className="timebox-chip-row">
                            <span className="timebox-chip-dur">{task.duration || 30}m</span>
                            <button
                              className="timebox-task-edit-btn"
                              onClick={(e) => { e.stopPropagation(); setEditingTask(task); }}
                              title="Edit task"
                            >✎</button>
                            <button
                              className={`timebox-mit-btn ${mitIds.has(task.id) ? 'active' : ''} ${!mitIds.has(task.id) && mitIds.size >= 3 ? 'disabled' : ''}`}
                              onClick={(e) => { e.stopPropagation(); handleToggleMit(task.id); }}
                              title="Toggle Most Important Task"
                            >⭐</button>
                          </div>
                        </div>
                        );
                      })
                    )}
                  </>
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
