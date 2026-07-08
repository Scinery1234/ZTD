import React, { useState, useRef, useEffect } from 'react';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { useSortable, SortableContext, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { asSubtaskList } from '../utils/arrays';
import { useAuth } from '../context/AuthContext';
import './TaskItem.css';

// Sensor that won't start dragging when the user clicks an input or button
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

function SortableSubtaskRow({ st, onUpdate, onRemove, onAddNew, shouldFocus, onFocused }) {
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
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 }}
      className="edit-subtask-row"
    >
      <span className="edit-subtask-drag" {...attributes} {...listeners}>⠿</span>
      <input
        ref={inputRef}
        className="edit-subtask-input"
        value={st.text}
        placeholder="Subtask…"
        onChange={(e) => onUpdate(st.id, e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); onAddNew(); }
          if (e.key === 'Backspace' && st.text === '') onRemove(st.id);
        }}
      />
      <button className="edit-subtask-remove" onClick={() => onRemove(st.id)} type="button">✕</button>
    </div>
  );
}

let subtaskIdCounter = Date.now();
const newSubtaskId = () => `st-${++subtaskIdCounter}`;

const TaskItem = ({
  id,
  task,
  taskId,
  isEditing,
  onEdit,
  onCancelEdit,
  onUpdate,
  onDelete,
  onMarkDone,
  onUnmarkDone,
  onCategoryClick,
  onPinPomodoro,
  viewMode,
  hats,
  selectMode,
  selected,
  onToggleSelect,
}) => {
  const { user, subscription } = useAuth();
  const tier = subscription?.tier || user?.tier || 'free';
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: id || `task-${taskId}` });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const [editData, setEditData] = useState({
    description: task.description,
    category: task.category || '',
    priority: task.priority || '',
    recurring: task.recurring || '',
    due: task.due || '',
    hat_id: task.hat_id ?? '',
    subtasks: asSubtaskList(task.subtasks),
    notes: task.notes || '',
  });
  const [notesExpanded, setNotesExpanded] = useState(false);

  // Local subtask state for view-mode toggling (without a full save)
  const [localSubtasks, setLocalSubtasks] = useState(() => asSubtaskList(task.subtasks));
  const [addingSubtask, setAddingSubtask] = useState(false);
  const [newSubtaskText, setNewSubtaskText] = useState('');

  // Sync local subtasks if task prop changes
  React.useEffect(() => {
    setLocalSubtasks(asSubtaskList(task.subtasks));
  }, [task.subtasks]);

  const getPriorityClass = (priority) => ({
    urgent: 'priority-urgent',
    today: 'priority-today',
    tomorrow: 'priority-tomorrow',
    later: 'priority-later',
  }[priority] || '');

  const formatDate = (dateString) => {
    if (!dateString) return '';
    const date = new Date(dateString + 'T00:00:00');
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  const isOverdue = () => {
    if (!task.due) return false;
    const dueDate = new Date(task.due + 'T00:00:00');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return dueDate < today;
  };

  // ---- Subtask helpers ----
  const toggleSubtaskInView = (stId) => {
    const updated = localSubtasks.map((s) => s.id === stId ? { ...s, done: !s.done } : s);
    setLocalSubtasks(updated);
    onUpdate({ subtasks: updated });
  };

  const addSubtaskInView = () => {
    if (!newSubtaskText.trim()) return;
    const updated = [...localSubtasks, { id: newSubtaskId(), text: newSubtaskText.trim(), done: false }];
    setLocalSubtasks(updated);
    setNewSubtaskText('');
    setAddingSubtask(false);
    onUpdate({ subtasks: updated });
  };

  const handleSave = () => {
    onUpdate(editData);
  };

  // ---- Edit subtask management ----
  const [subtaskFocusId, setSubtaskFocusId] = useState(null);

  const addEditSubtask = () => {
    const id = newSubtaskId();
    setSubtaskFocusId(id);
    setEditData((d) => ({
      ...d,
      subtasks: [...d.subtasks, { id, text: '', done: false }],
    }));
  };

  const updateEditSubtask = (stId, text) => {
    setEditData((d) => ({
      ...d,
      subtasks: d.subtasks.map((s) => s.id === stId ? { ...s, text } : s),
    }));
  };

  const removeEditSubtask = (stId) => {
    setEditData((d) => ({
      ...d,
      subtasks: d.subtasks.filter((s) => s.id !== stId),
    }));
  };

  const reorderEditSubtasks = ({ active, over }) => {
    if (!over || active.id === over.id) return;
    setEditData((d) => {
      const oldIdx = d.subtasks.findIndex(s => s.id === active.id);
      const newIdx = d.subtasks.findIndex(s => s.id === over.id);
      return { ...d, subtasks: arrayMove(d.subtasks, oldIdx, newIdx) };
    });
  };

  const subtaskSensors = useSensors(useSensor(SmartPointerSensor, { activationConstraint: { distance: 6 } }));

  // ---- Edit mode ----
  if (isEditing) {
    return (
      <div className="task-item editing">
        <div className="task-edit-form">
          <div className="edit-section">
            <label className="edit-label">Description</label>
            <input
              type="text"
              value={editData.description}
              onChange={(e) => setEditData({ ...editData, description: e.target.value })}
              className="edit-input"
              placeholder="Task description"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSave();
                else if (e.key === 'Escape') onCancelEdit();
              }}
            />
          </div>

          <div className="edit-section">
            <label className="edit-label">Details</label>
            <div className="edit-fields">
              <div className="edit-field-group">
                <label className="edit-field-label">Category</label>
                <input
                  type="text"
                  value={editData.category}
                  onChange={(e) => setEditData({ ...editData, category: e.target.value })}
                  className="edit-field"
                  placeholder="e.g. work"
                  onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); }}
                />
              </div>
              <div className="edit-field-group">
                <label className="edit-field-label">Priority</label>
                <select
                  value={editData.priority}
                  onChange={(e) => setEditData({ ...editData, priority: e.target.value })}
                  className="edit-field"
                >
                  <option value="">None</option>
                  <option value="urgent">Urgent</option>
                  <option value="today">Today</option>
                  <option value="tomorrow">Tomorrow</option>
                  <option value="later">Later</option>
                </select>
              </div>
              <div className="edit-field-group">
                <label className="edit-field-label">Recurring</label>
                <select
                  value={editData.recurring}
                  onChange={(e) => setEditData({ ...editData, recurring: e.target.value })}
                  className="edit-field"
                >
                  <option value="">None</option>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                </select>
              </div>
              <div className="edit-field-group">
                <label className="edit-field-label">Due Date</label>
                <input
                  type="text"
                  value={editData.due}
                  onChange={(e) => setEditData({ ...editData, due: e.target.value })}
                  className="edit-field"
                  placeholder="tomorrow, next Friday…"
                  onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); }}
                />
              </div>
              {hats && hats.length > 0 && (
                <div className="edit-field-group">
                  <label className="edit-field-label">Hat</label>
                  <select
                    className="edit-field"
                    value={editData.hat_id}
                    onChange={(e) => setEditData({ ...editData, hat_id: e.target.value })}
                  >
                    <option value="">No Hat</option>
                    {hats.map(h => (
                      <option key={h.id} value={h.id}>{h.emoji} {h.name}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          </div>

          {/* Subtasks editor */}
          <div className="edit-section">
            <label className="edit-label">Subtasks</label>
            <div className="edit-subtasks">
              <DndContext sensors={subtaskSensors} collisionDetection={closestCenter} onDragEnd={reorderEditSubtasks}>
                <SortableContext items={editData.subtasks.map(s => s.id)} strategy={verticalListSortingStrategy}>
                  {editData.subtasks.map((st) => (
                    <SortableSubtaskRow
                      key={st.id}
                      st={st}
                      onUpdate={updateEditSubtask}
                      onRemove={removeEditSubtask}
                      onAddNew={addEditSubtask}
                      shouldFocus={subtaskFocusId === st.id}
                      onFocused={() => setSubtaskFocusId(null)}
                    />
                  ))}
                </SortableContext>
              </DndContext>
              <button className="edit-subtask-add" onClick={addEditSubtask} type="button">
                + Add subtask
              </button>
            </div>
          </div>

          {/* Notes (premium only) */}
          {tier === 'premium' ? (
            <div className="edit-section">
              <label className="edit-label">Notes</label>
              <textarea
                className="edit-notes-textarea"
                value={editData.notes}
                onChange={(e) => setEditData({ ...editData, notes: e.target.value })}
                placeholder="Add detailed notes, links, context…"
                rows={4}
              />
            </div>
          ) : (
            <div className="edit-section edit-notes-upgrade">
              <span className="edit-label">Notes</span>
              <span className="edit-notes-upgrade-text">Premium feature — upgrade to add rich notes to tasks</span>
            </div>
          )}

          <div className="edit-actions">
            <span className="edit-hint">Enter to save · Esc to cancel</span>
            <button onClick={onCancelEdit} className="btn-cancel">Cancel</button>
            <button onClick={handleSave} className="btn-save">Save</button>
          </div>
        </div>
      </div>
    );
  }

  // ---- View mode ----
  const doneCount = localSubtasks.filter((s) => s.done).length;
  const totalCount = localSubtasks.length;
  const progress = totalCount > 0 ? (doneCount / totalCount) * 100 : 0;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`task-item ${getPriorityClass(task.priority)} ${isOverdue() ? 'overdue' : ''} ${isDragging ? 'dragging' : ''} ${selectMode && selected ? 'bulk-selected' : ''}`}
      onDoubleClick={() => {
        if (viewMode === 'active' && !selectMode) onEdit();
      }}
      onClick={() => {
        if (selectMode && onToggleSelect) onToggleSelect();
      }}
    >
      <div className="task-content">
        {viewMode === 'active' && selectMode && (
          <input
            type="checkbox"
            className="task-select-box"
            checked={Boolean(selected)}
            onChange={() => onToggleSelect && onToggleSelect()}
            onClick={(e) => e.stopPropagation()}
            aria-label={`Select "${task.description}"`}
          />
        )}
        {viewMode === 'active' && !selectMode && (
          <div className="drag-handle" {...attributes} {...listeners}>
            <span className="drag-icon">⠿</span>
          </div>
        )}

        {viewMode === 'active' && !selectMode && (
          <button
            className="task-done-circle"
            onClick={(e) => { e.stopPropagation(); onMarkDone(); }}
            title="Mark done"
          />
        )}

        <div className="task-main">
          <div className="task-description">{task.description}</div>

          <div className="task-meta">
            {task.category && (
              <span
                className="task-category clickable-category"
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  if (onCategoryClick && viewMode === 'active' && !selectMode) onCategoryClick(task.category);
                }}
                title="Double-click to filter by category"
              >
                {task.category}
              </span>
            )}
            {task.priority && (
              <span className={`task-priority ${getPriorityClass(task.priority)}`}>
                {task.priority}
              </span>
            )}
            {task.recurring && (
              <span className="task-recurring">↺ {task.recurring}</span>
            )}
            {task.milestone_id != null && (
              <span className="task-goal-pill" title="Works toward a goal milestone">🎯</span>
            )}
            {task.due && (
              <span className={`task-due ${isOverdue() ? 'overdue' : ''}`}>
                {isOverdue() ? '⚠ ' : ''}
                {formatDate(task.due)}
              </span>
            )}
            {totalCount > 0 && (
              <span className="subtask-progress-pill">
                {doneCount}/{totalCount}
              </span>
            )}
            {tier === 'premium' && task.pomodoro_count > 0 && (
              <span className="task-pomodoro-pill" title="Focus sessions logged">
                🍅 ×{task.pomodoro_count}
              </span>
            )}
            {task.notes && (
              <button
                className="task-notes-pill"
                onClick={(e) => { e.stopPropagation(); setNotesExpanded(x => !x); }}
                title={notesExpanded ? 'Hide notes' : 'Show notes'}
              >
                📝
              </button>
            )}
          </div>

          {/* Notes preview */}
          {task.notes && notesExpanded && (
            <div className="task-notes-preview">
              {task.notes}
            </div>
          )}

          {/* Subtask checklist */}
          {localSubtasks.length > 0 && (
            <div className="subtask-list">
              {totalCount > 1 && (
                <div className="subtask-progress-bar">
                  <div className="subtask-progress-fill" style={{ width: `${progress}%` }} />
                </div>
              )}
              {localSubtasks.map((st, i) => (
                <label key={st.id ?? i} className={`subtask-item ${st.done ? 'done' : ''}`}>
                  <input
                    type="checkbox"
                    checked={st.done}
                    onChange={() => viewMode === 'active' && !selectMode && toggleSubtaskInView(st.id)}
                    onClick={(e) => e.stopPropagation()}
                    disabled={viewMode !== 'active' || selectMode}
                  />
                  <span className="subtask-text">{st.text}</span>
                </label>
              ))}
            </div>
          )}

          {/* Inline add-subtask (active mode only) */}
          {viewMode === 'active' && addingSubtask && (
            <div className="subtask-add-row" onClick={(e) => e.stopPropagation()}>
              <input
                className="subtask-add-input"
                autoFocus
                value={newSubtaskText}
                onChange={(e) => setNewSubtaskText(e.target.value)}
                placeholder="Subtask…"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addSubtaskInView();
                  if (e.key === 'Escape') { setAddingSubtask(false); setNewSubtaskText(''); }
                }}
              />
              <button className="subtask-add-confirm" onClick={addSubtaskInView}>✓</button>
              <button className="subtask-add-cancel" onClick={() => { setAddingSubtask(false); setNewSubtaskText(''); }}>✕</button>
            </div>
          )}
        </div>

        {viewMode === 'active' && !selectMode && (
          <div className="task-actions">
            {(tier === 'pro' || tier === 'premium') && onPinPomodoro && (
              <button
                className="btn-pomodoro"
                onClick={(e) => { e.stopPropagation(); onPinPomodoro(task); }}
                title="Focus with Pomodoro"
              >🍅</button>
            )}
            <button
              className="btn-subtask"
              onClick={(e) => { e.stopPropagation(); setAddingSubtask(true); }}
              title="Add subtask"
            >+</button>
            <button onClick={(e) => { e.stopPropagation(); onDelete(); }} className="btn-delete" title="Delete">✕</button>
          </div>
        )}
        {viewMode === 'done' && onUnmarkDone && (
          <div className="task-actions">
            <button onClick={(e) => { e.stopPropagation(); onUnmarkDone(); }} className="btn-restore" title="Move back to active">↩</button>
          </div>
        )}
      </div>
    </div>
  );
};

export default TaskItem;
