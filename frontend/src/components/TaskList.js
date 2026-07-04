import React, { useState, useEffect } from 'react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import TaskItem from './TaskItem';
import './TaskList.css';

const PRIORITY_OPTIONS = [
  ['urgent', 'Urgent'],
  ['today', 'Today'],
  ['tomorrow', 'Tomorrow'],
  ['later', 'Later'],
  ['none', 'Clear priority'],
];

const TaskList = ({
  tasks, onUpdate, onDelete, onMarkDone, onUnmarkDone, onReorder,
  onCategoryClick, onPinPomodoro, viewMode, hats,
  onBulkDone, onBulkDelete, onBulkUpdate,
}) => {
  const [editingId, setEditingId] = useState(null);
  const [items, setItems] = useState(tasks);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  React.useEffect(() => {
    setItems(tasks);
  }, [tasks]);

  // Drop selections for tasks that no longer exist (completed/deleted elsewhere).
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const valid = new Set(tasks.map((t) => t.id));
      const next = new Set([...prev].filter((id) => valid.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [tasks]);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const getDragId = (task, index) => task.id ? `task-${task.id}` : `task-idx-${index}`;

  const handleDragEnd = (event) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const oldIndex = items.findIndex((item, idx) => getDragId(item, idx) === active.id);
      const newIndex = items.findIndex((item, idx) => getDragId(item, idx) === over.id);
      const newItems = arrayMove(items, oldIndex, newIndex);
      setItems(newItems);
      if (onReorder) onReorder(newItems);
    }
  };

  // ---- Bulk selection ----
  const bulkEnabled = viewMode === 'active' &&
    Boolean(onBulkDone || onBulkDelete || onBulkUpdate);

  const toggleSelected = (taskId) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  };

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelectedIds(new Set());
  };

  const selectedList = () => items.filter((t) => t.id && selectedIds.has(t.id)).map((t) => t.id);

  const runBulk = async (fn) => {
    const ids = selectedList();
    if (ids.length === 0) return;
    setBulkBusy(true);
    try {
      await fn(ids);
      exitSelectMode();
    } finally {
      setBulkBusy(false);
    }
  };

  const bulkDone = () => runBulk((ids) => onBulkDone(ids));
  const bulkDelete = () => {
    const n = selectedIds.size;
    if (!window.confirm(`Delete ${n} task${n === 1 ? '' : 's'}?`)) return;
    runBulk((ids) => onBulkDelete(ids));
  };
  const bulkPriority = (value) => {
    if (!value) return;
    runBulk((ids) => onBulkUpdate(ids, { priority: value === 'none' ? '' : value }));
  };
  const bulkHat = (value) => {
    if (!value) return;
    runBulk((ids) => onBulkUpdate(ids, { hat_id: value === 'none' ? null : Number(value) }));
  };

  if (tasks.length === 0) {
    return (
      <div className="task-list-empty">
        <p>No tasks found. Add a new task to get started!</p>
      </div>
    );
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext
        items={items.map((task, idx) => getDragId(task, idx))}
        strategy={verticalListSortingStrategy}
      >
        {bulkEnabled && !selectMode && (
          <div className="bulk-toggle-row">
            <button className="bulk-toggle" onClick={() => setSelectMode(true)}>
              ☑ Select
            </button>
          </div>
        )}
        {bulkEnabled && selectMode && (
          <div className="bulk-bar" role="toolbar" aria-label="Bulk actions">
            <span className="bulk-count">{selectedIds.size} selected</span>
            <button
              className="bulk-btn"
              disabled={bulkBusy}
              onClick={() => setSelectedIds(new Set(items.filter((t) => t.id).map((t) => t.id)))}
            >All</button>
            <button
              className="bulk-btn"
              disabled={bulkBusy || selectedIds.size === 0}
              onClick={() => setSelectedIds(new Set())}
            >None</button>
            <span className="bulk-spacer" />
            {onBulkDone && (
              <button
                className="bulk-btn bulk-btn--done"
                disabled={bulkBusy || selectedIds.size === 0}
                onClick={bulkDone}
              >✓ Done</button>
            )}
            {onBulkUpdate && (
              <select
                className="bulk-select"
                value=""
                disabled={bulkBusy || selectedIds.size === 0}
                onChange={(e) => bulkPriority(e.target.value)}
                aria-label="Set priority for selected tasks"
              >
                <option value="">Priority…</option>
                {PRIORITY_OPTIONS.map(([v, label]) => (
                  <option key={v} value={v}>{label}</option>
                ))}
              </select>
            )}
            {onBulkUpdate && hats && hats.length > 0 && (
              <select
                className="bulk-select"
                value=""
                disabled={bulkBusy || selectedIds.size === 0}
                onChange={(e) => bulkHat(e.target.value)}
                aria-label="Move selected tasks to a hat"
              >
                <option value="">Move to…</option>
                {hats.map((h) => (
                  <option key={h.id} value={h.id}>{h.emoji} {h.name}</option>
                ))}
                <option value="none">No hat</option>
              </select>
            )}
            {onBulkDelete && (
              <button
                className="bulk-btn bulk-btn--delete"
                disabled={bulkBusy || selectedIds.size === 0}
                onClick={bulkDelete}
              >🗑 Delete</button>
            )}
            <button className="bulk-btn bulk-btn--cancel" disabled={bulkBusy} onClick={exitSelectMode}>
              ✕ Cancel
            </button>
          </div>
        )}
        <div className={`task-list${selectMode ? ' task-list--selecting' : ''}`}>
          {items.map((task, index) => {
            const dragId = getDragId(task, index);
            const taskId = task.id || index + 1;
            return (
              <TaskItem
                key={dragId}
                id={dragId}
                task={task}
                taskId={taskId}
                isEditing={editingId === taskId}
                onEdit={() => setEditingId(taskId)}
                onCancelEdit={() => setEditingId(null)}
                onUpdate={(updatedData) => {
                  onUpdate(taskId, updatedData);
                  setEditingId(null);
                }}
                onDelete={() => onDelete && onDelete(taskId)}
                onMarkDone={() => onMarkDone && onMarkDone(taskId)}
                onUnmarkDone={() => onUnmarkDone && onUnmarkDone(taskId)}
                onCategoryClick={onCategoryClick}
                onPinPomodoro={onPinPomodoro}
                viewMode={viewMode}
                hats={hats}
                selectMode={selectMode}
                selected={selectedIds.has(task.id)}
                onToggleSelect={() => task.id && toggleSelected(task.id)}
              />
            );
          })}
        </div>
      </SortableContext>
    </DndContext>
  );
};

export default TaskList;
