import React, { useState, useRef, useEffect, useCallback } from 'react';
import { asSubtaskList } from '../utils/arrays';
import './TimeboxView.css';

// ── Constants ───────────────────────────────────────────────────────────────
const PX_PER_HOUR = 64;
const PX_PER_MIN = PX_PER_HOUR / 60;
const GRID_HEIGHT = 24 * PX_PER_HOUR; // 1536px
const SNAP = 15; // minutes

const PRIORITY_ORDER = { urgent: 0, today: 1, tomorrow: 2, later: 3, '': 4 };

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

function timeToY(hhmm) {
  return parseMinutes(hhmm) * PX_PER_MIN;
}

function yToMinutes(y, snap = SNAP) {
  return Math.round(y / PX_PER_MIN / snap) * snap;
}

function snapMinutes(mins, snap = SNAP) {
  return Math.round(mins / snap) * snap;
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

function seededRandom(seed) {
  const x = Math.sin(seed + 1) * 10000;
  return x - Math.floor(x);
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
    await onAddTask({
      description: desc.trim(),
      priority,
      duration,
      scheduled_time: formatTime(slot.startMin),
      scheduled_date: date,
      due: date,
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
          {formatTime(slot.startMin)} – {formatTime(slot.endMin)}
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

  const addSubtask = () =>
    setEditData(d => ({ ...d, subtasks: [...d.subtasks, { id: newStId(), text: '', done: false }] }));

  const updateSubtask = (stId, text) =>
    setEditData(d => ({ ...d, subtasks: d.subtasks.map(s => s.id === stId ? { ...s, text } : s) }));

  const removeSubtask = (stId) =>
    setEditData(d => ({ ...d, subtasks: d.subtasks.filter(s => s.id !== stId) }));

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
            <div className="tef-subtasks" onDoubleClick={e => { if (e.target === e.currentTarget) addSubtask(); }}>
              {editData.subtasks.map((st, i) => (
                <div key={st.id ?? i} className="tef-subtask-row" onDoubleClick={e => { if (e.target === e.currentTarget) addSubtask(); }}>
                  <input
                    className="tef-subtask-input"
                    value={st.text}
                    placeholder="Subtask…"
                    onChange={e => updateSubtask(st.id, e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') { e.preventDefault(); addSubtask(); }
                      if (e.key === 'Backspace' && st.text === '') removeSubtask(st.id);
                    }}
                    autoFocus={i === editData.subtasks.length - 1 && st.text === ''}
                  />
                  <button className="tef-subtask-remove" onClick={() => removeSubtask(st.id)}>✕</button>
                </div>
              ))}
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
function TimeboxDayColumn({ date, tasks, hats, dayWindow, onWindowChange, blockedTimes, onBlockedTimesChange, mitIds, onToggleMit, onUpdateTask, onAddTask, isWeekView, shuffleSeed, onShuffle }) {
  const gridRef = useRef(null);
  const wrapperRef = useRef(null);
  const [dragging, setDragging] = useState(null);
  const [localTasks, setLocalTasks] = useState(tasks);
  const [localWindow, setLocalWindow] = useState(dayWindow);
  const [blockDrag, setBlockDrag] = useState(null); // { startMin, endMin, screenX, screenY }
  const [pendingSlot, setPendingSlot] = useState(null); // shown after drag ends
  const [unscheduledOpen, setUnscheduledOpen] = useState(true);
  const [editingTask, setEditingTask] = useState(null);

  // Refs so drag handlers always read the latest state without re-registering listeners
  const localTasksRef = useRef(localTasks);
  const localWindowRef = useRef(localWindow);

  useEffect(() => { setLocalTasks(tasks); }, [tasks]);
  useEffect(() => { setLocalWindow(dayWindow); }, [dayWindow]);
  useEffect(() => { localTasksRef.current = localTasks; }, [localTasks]);
  useEffect(() => { localWindowRef.current = localWindow; }, [localWindow]);

  const todayStr = toLocalDateStr(new Date());
  // Tasks that appear ON the grid for this day
  const columnTasks = localTasks.filter(t =>
    t.scheduled_date === date ||
    (!t.scheduled_date && t.due === date)
  );
  const scheduled = columnTasks.filter(t => t.scheduled_time);

  // Task pool: ALL tasks with no scheduled_time, shown in the panel so they can be scheduled.
  // In week view show only in today's column to avoid duplication.
  const showTaskPool = !isWeekView || date === todayStr;
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
    onShuffle();
    const PRIO = PRIORITY_ORDER;
    // Schedule from the full task pool (all unscheduled), not just column-date tasks
    const pool = localTasks.filter(t => !t.scheduled_time);
    let ordered = [...pool].sort((a, b) => (PRIO[a.priority] ?? 4) - (PRIO[b.priority] ?? 4));
    const seed = shuffleSeed + 1;
    for (let i = ordered.length - 1; i > 0; i--) {
      const j = Math.floor(seededRandom(seed + i) * (i + 1));
      [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
    }
    // For today's column, never schedule before the current time
    const now = new Date();
    const nowMins = now.getHours() * 60 + now.getMinutes();
    const isToday = date === toLocalDateStr(now);
    let cursor = isToday ? Math.max(windowStart, snapMinutes(nowMins)) : windowStart;
    const updates = [];
    for (const task of ordered) {
      const dur = task.duration || 30;
      cursor = advancePastBlocked(cursor, dur, blockedTimes, date);
      if (cursor + dur > windowEnd) break;
      updates.push({ id: task.id, scheduled_time: formatTime(cursor), scheduled_date: date });
      cursor += dur;
    }
    const updatedMap = {};
    updates.forEach(u => { updatedMap[u.id] = u; });
    setLocalTasks(prev => prev.map(t => updatedMap[t.id] ? { ...t, ...updatedMap[t.id] } : t));
    await Promise.all(updates.map(u => onUpdateTask(u.id, { scheduled_time: u.scheduled_time, scheduled_date: u.scheduled_date })));
  }, [columnTasks, blockedTimes, date, windowStart, windowEnd, shuffleSeed, onShuffle, onUpdateTask]);

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
        const newMin = Math.max(wStart + 60, Math.min(1439, snapMinutes(dragging.origMin + deltaMins)));
        setLocalWindow(w => ({ ...w, end: formatTime(newMin) }));
      } else if (dragging.type === 'task-move') {
        const newMin = Math.max(wStart, Math.min(wEnd - (dragging.duration || 30), snapMinutes(dragging.origMin + deltaMins)));
        setLocalTasks(prev => prev.map(t => t.id === dragging.taskId ? { ...t, scheduled_time: formatTime(newMin) } : t));
      } else if (dragging.type === 'task-resize-bottom') {
        const newEndMin = Math.max(dragging.origMin + SNAP, Math.min(wEnd, snapMinutes(dragging.origEndMin + deltaMins)));
        const newDur = newEndMin - dragging.origMin;
        setLocalTasks(prev => prev.map(t => t.id === dragging.taskId ? { ...t, duration: newDur } : t));
      } else if (dragging.type === 'task-resize-top') {
        const newStartMin = Math.max(wStart, Math.min(dragging.origEndMin - SNAP, snapMinutes(dragging.origMin + deltaMins)));
        const newDur = dragging.origEndMin - newStartMin;
        setLocalTasks(prev => prev.map(t => t.id === dragging.taskId ? { ...t, scheduled_time: formatTime(newStartMin), duration: newDur } : t));
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
          // Detect cross-day drop by checking which day column is under the cursor
          let targetDate = date;
          if (dragging.type === 'task-move') {
            const el = document.elementFromPoint(e.clientX, e.clientY);
            const col = el?.closest('[data-date]');
            if (col) targetDate = col.getAttribute('data-date');
          }
          await onUpdateTask(updated.id, {
            scheduled_time: updated.scheduled_time,
            scheduled_date: targetDate,
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
  }, [dragging, date, onWindowChange, onUpdateTask]);

  // ── Grid drag (task or block creation) ───────────────────────────────────
  useEffect(() => {
    if (!blockDrag) return;
    const onMove = (e) => {
      if (!wrapperRef.current) return;
      const y = getRelativeY(e, wrapperRef.current);
      const mins = snapMinutes(Math.max(0, Math.min(1439, yToMinutes(y))));
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
    const mins = snapMinutes(Math.max(0, Math.min(1439, yToMinutes(y))));
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

  // ── Render ─────────────────────────────────────────────────────────────────
  const hourLabels = Array.from({ length: 24 }, (_, h) => h);
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
      <div className="timebox-grid-wrapper" ref={wrapperRef}>
        <div className="timebox-grid" ref={gridRef} onMouseDown={handleGridMouseDown}
          style={{ height: GRID_HEIGHT }}>

          {/* Hour lines + labels */}
          {hourLabels.map(h => (
            <React.Fragment key={h}>
              <div className="timebox-hour-label" style={{ top: h * PX_PER_HOUR }}>{String(h).padStart(2, '0')}</div>
              <div className="timebox-hour-line" style={{ top: h * PX_PER_HOUR }} />
              <div className="timebox-halfhour-line" style={{ top: h * PX_PER_HOUR + PX_PER_HOUR / 2 }} />
            </React.Fragment>
          ))}

          {/* Inactive overlays */}
          <div className="timebox-inactive" style={{ top: 0, height: timeToY(localWindow.start) }} />
          <div className="timebox-inactive" style={{ top: timeToY(localWindow.end), height: GRID_HEIGHT - timeToY(localWindow.end) }} />

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
            <span className="window-bar-label">▼ {localWindow.end}</span>
          </div>

          {/* Scheduled task blocks */}
          {scheduled.map(task => {
            const isMit = mitIds.has(task.id);
            const taskTop = timeToY(task.scheduled_time);
            const taskHeight = Math.max(22, (task.duration || 30) * PX_PER_MIN);
            return (
              <div
                key={task.id}
                className={`timebox-task priority-${task.priority || 'none'} ${isMit ? 'mit' : ''}`}
                style={{ top: taskTop, height: taskHeight }}
                onDoubleClick={(e) => { e.stopPropagation(); setEditingTask(task); }}
                onMouseDown={(e) => {
                  if (e.target.classList.contains('timebox-task-resize-top') ||
                    e.target.classList.contains('timebox-task-resize-bottom')) return;
                  startMouseDrag('task-move', {
                    taskId: task.id,
                    origMin: parseMinutes(task.scheduled_time),
                    duration: task.duration || 30,
                  }, e);
                }}
              >
                <div
                  className="timebox-task-resize-top"
                  onMouseDown={(e) => startMouseDrag('task-resize-top', {
                    taskId: task.id,
                    origMin: parseMinutes(task.scheduled_time),
                    origEndMin: parseMinutes(task.scheduled_time) + (task.duration || 30),
                  }, e)}
                />
                <div className="timebox-task-body">
                  <span className="timebox-task-desc">{task.description}</span>
                  <div className="timebox-task-meta">
                    <span className="timebox-task-duration">{task.duration || 30}m</span>
                    <button
                      className={`timebox-mit-btn ${isMit ? 'active' : ''} ${!isMit && mitIds.size >= 3 ? 'disabled' : ''}`}
                      onClick={(e) => { e.stopPropagation(); onToggleMit(task.id); }}
                      title={isMit ? 'Remove from MIT' : 'Mark as Most Important Task'}
                    >⭐</button>
                  </div>
                </div>
                <div
                  className="timebox-task-resize-bottom"
                  onMouseDown={(e) => startMouseDrag('task-resize-bottom', {
                    taskId: task.id,
                    origMin: parseMinutes(task.scheduled_time),
                    origEndMin: parseMinutes(task.scheduled_time) + (task.duration || 30),
                  }, e)}
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

      {/* Task edit modal */}
      {editingTask && (
        <TaskEditModal
          task={editingTask}
          hats={hats}
          onSave={async (id, data) => {
            setLocalTasks(prev => prev.map(t => t.id === id ? { ...t, ...data } : t));
            await onUpdateTask(id, data);
            setEditingTask(null);
          }}
          onClose={() => setEditingTask(null)}
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
                unscheduled.map(task => (
                  <div key={task.id} className={`timebox-unscheduled-chip priority-${task.priority || 'none'} ${mitIds.has(task.id) ? 'mit' : ''}`}>
                    <span className="timebox-chip-desc">{task.description}</span>
                    <span className="timebox-chip-dur">{task.duration || 30}m</span>
                    <button
                      className={`timebox-mit-btn ${mitIds.has(task.id) ? 'active' : ''} ${!mitIds.has(task.id) && mitIds.size >= 3 ? 'disabled' : ''}`}
                      onClick={() => onToggleMit(task.id)}
                      title="Toggle Most Important Task"
                    >⭐</button>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── TimeboxView (main) ────────────────────────────────────────────────────────
function TimeboxView({ tasks, hats, onUpdate, onAddTask, maxHistoryDays = 14 }) {
  const [subView, setSubView] = useState('day');
  const [mitIds, setMitIds] = useState(() => new Set(loadMit()));
  const [dayWindows, setDayWindows] = useState(loadDayWindows);
  const [blockedTimes, setBlockedTimes] = useState(loadBlockedTimes);
  const [shuffleSeed, setShuffleSeed] = useState(0);
  const [weekStartOffset, setWeekStartOffset] = useState(0); // days from today

  const today = toLocalDateStr(new Date());
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

  const handleShuffle = () => setShuffleSeed(s => s + 1);

  const sharedProps = {
    tasks,
    hats,
    blockedTimes,
    onBlockedTimesChange: handleBlockedTimesChange,
    mitIds,
    onToggleMit: handleToggleMit,
    onUpdateTask: onUpdate,
    onAddTask,
    shuffleSeed,
    onShuffle: handleShuffle,
  };

  return (
    <div className="timebox-container">
      <div className="timebox-subview-toggle">
        <button className={`timebox-sub-btn ${subView === 'day' ? 'active' : ''}`} onClick={() => setSubView('day')}>Day</button>
        <button className={`timebox-sub-btn ${subView === 'week' ? 'active' : ''}`} onClick={() => setSubView('week')}>Week</button>
      </div>

      {subView === 'day' && (
        <TimeboxDayColumn
          {...sharedProps}
          date={today}
          dayWindow={getWindowForDate(today)}
          onWindowChange={handleWindowChange}
          isWeekView={false}
        />
      )}

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
