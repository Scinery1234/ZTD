import React, { useState } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import './TaskItem.css';

let subtaskIdCounter = Date.now();
const newSubtaskId = () => `st-${++subtaskIdCounter}`;

const SUBTASK_PRIORITIES = ['', 'urgent', 'today', 'tomorrow', 'later'];

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
  onCategoryClick,
  onToggleKeyTask,
  viewMode,
  isPremium,
}) => {
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
    subtasks: task.subtasks ? [...task.subtasks] : [],
    notes: task.notes || '',
    reminder_at: task.reminder_at ? task.reminder_at.slice(0, 16) : '',
  });

  // Local subtask state for view-mode toggling (without a full save)
  const [localSubtasks, setLocalSubtasks] = useState(task.subtasks || []);
  const [addingSubtask, setAddingSubtask] = useState(false);
  const [newSubtaskText, setNewSubtaskText] = useState('');
  const [showNotes, setShowNotes] = useState(false);
  const [notesValue, setNotesValue] = useState(task.notes || '');

  // Sync local state if task prop changes
  React.useEffect(() => {
    setLocalSubtasks(task.subtasks || []);
  }, [task.subtasks]);

  React.useEffect(() => {
    setNotesValue(task.notes || '');
  }, [task.notes]);

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

  const handleNotesBlur = () => {
    if (notesValue !== task.notes) {
      onUpdate({ notes: notesValue });
    }
  };

  // ---- Edit subtask management ----
  const addEditSubtask = () => {
    setEditData((d) => ({
      ...d,
      subtasks: [...d.subtasks, { id: newSubtaskId(), text: '', done: false, priority: '', category: '' }],
    }));
  };

  const updateEditSubtask = (stId, field, value) => {
    setEditData((d) => ({
      ...d,
      subtasks: d.subtasks.map((s) => s.id === stId ? { ...s, [field]: value } : s),
    }));
  };

  const removeEditSubtask = (stId) => {
    setEditData((d) => ({
      ...d,
      subtasks: d.subtasks.filter((s) => s.id !== stId),
    }));
  };

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
              {isPremium && (
                <div className="edit-field-group">
                  <label className="edit-field-label">Remind me at</label>
                  <input
                    type="datetime-local"
                    value={editData.reminder_at}
                    onChange={(e) => setEditData({ ...editData, reminder_at: e.target.value })}
                    className="edit-field"
                  />
                </div>
              )}
            </div>
          </div>

          {isPremium && (
            <div className="edit-section">
              <label className="edit-label">Notes</label>
              <textarea
                className="edit-notes"
                value={editData.notes}
                onChange={(e) => setEditData({ ...editData, notes: e.target.value })}
                placeholder="Add notes, links, context…"
                rows={3}
              />
            </div>
          )}

          {/* Subtasks editor */}
          <div className="edit-section">
            <label className="edit-label">Subtasks</label>
            <div className="edit-subtasks">
              {editData.subtasks.map((st, i) => (
                <div key={st.id} className="edit-subtask-row">
                  <span className="edit-subtask-bullet">·</span>
                  <input
                    className="edit-subtask-input"
                    value={st.text}
                    placeholder="Subtask…"
                    onChange={(e) => updateEditSubtask(st.id, 'text', e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); addEditSubtask(); }
                      if (e.key === 'Backspace' && st.text === '') removeEditSubtask(st.id);
                    }}
                    autoFocus={i === editData.subtasks.length - 1 && st.text === ''}
                  />
                  {isPremium && (
                    <>
                      <select
                        className="edit-subtask-priority"
                        value={st.priority || ''}
                        onChange={(e) => updateEditSubtask(st.id, 'priority', e.target.value)}
                        title="Subtask priority"
                      >
                        {SUBTASK_PRIORITIES.map((p) => (
                          <option key={p} value={p}>{p || 'No priority'}</option>
                        ))}
                      </select>
                      <input
                        className="edit-subtask-category"
                        value={st.category || ''}
                        onChange={(e) => updateEditSubtask(st.id, 'category', e.target.value)}
                        placeholder="category"
                        title="Subtask category"
                      />
                    </>
                  )}
                  <button
                    className="edit-subtask-remove"
                    onClick={() => removeEditSubtask(st.id)}
                    type="button"
                  >✕</button>
                </div>
              ))}
              <button className="edit-subtask-add" onClick={addEditSubtask} type="button">
                + Add subtask
              </button>
            </div>
          </div>

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
      className={`task-item ${getPriorityClass(task.priority)} ${isOverdue() ? 'overdue' : ''} ${isDragging ? 'dragging' : ''} ${task.is_key_task ? 'key-task' : ''}`}
      onDoubleClick={() => {
        if (viewMode === 'active') onEdit();
      }}
    >
      <div className="task-content">
        {viewMode === 'active' && (
          <div className="drag-handle" {...attributes} {...listeners}>
            <span className="drag-icon">⠿</span>
          </div>
        )}

        <div className="task-main">
          <div className="task-description">{task.description}</div>

          <div className="task-meta">
            {task.category && (
              <span
                className="task-category clickable-category"
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  if (onCategoryClick && viewMode === 'active') onCategoryClick(task.category);
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
            {task.due && (
              <span className={`task-due ${isOverdue() ? 'overdue' : ''}`}>
                {isOverdue() ? '⚠ ' : ''}
                {formatDate(task.due)}
              </span>
            )}
            {task.reminder_at && (
              <span className="task-reminder" title={`Reminder: ${new Date(task.reminder_at).toLocaleString()}`}>
                🔔
              </span>
            )}
            {totalCount > 0 && (
              <span className="subtask-progress-pill">
                {doneCount}/{totalCount}
              </span>
            )}
          </div>

          {/* Subtask checklist */}
          {localSubtasks.length > 0 && (
            <div className="subtask-list">
              {totalCount > 1 && (
                <div className="subtask-progress-bar">
                  <div className="subtask-progress-fill" style={{ width: `${progress}%` }} />
                </div>
              )}
              {localSubtasks.map((st) => (
                <label key={st.id} className={`subtask-item ${st.done ? 'done' : ''}`}>
                  <input
                    type="checkbox"
                    checked={st.done}
                    onChange={() => viewMode === 'active' && toggleSubtaskInView(st.id)}
                    onClick={(e) => e.stopPropagation()}
                    disabled={viewMode !== 'active'}
                  />
                  <span className="subtask-text">{st.text}</span>
                  {st.priority && (
                    <span className={`subtask-priority-badge ${getPriorityClass(st.priority)}`}>{st.priority}</span>
                  )}
                  {st.category && (
                    <span className="subtask-category-badge">{st.category}</span>
                  )}
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

          {/* Notes panel (Premium) */}
          {isPremium && viewMode === 'active' && (
            <div className="notes-section">
              <button
                className="notes-toggle"
                onClick={(e) => { e.stopPropagation(); setShowNotes((v) => !v); }}
                title="Toggle notes"
              >
                {showNotes ? '▾' : '▸'} Notes{notesValue ? ' ●' : ''}
              </button>
              {showNotes && (
                <textarea
                  className="notes-textarea"
                  value={notesValue}
                  onChange={(e) => setNotesValue(e.target.value)}
                  onBlur={handleNotesBlur}
                  onClick={(e) => e.stopPropagation()}
                  placeholder="Add notes, links, context…"
                  rows={3}
                />
              )}
            </div>
          )}
        </div>

        {viewMode === 'active' && (
          <div className="task-actions">
            {isPremium && onToggleKeyTask && (
              <button
                className={`btn-key-task ${task.is_key_task ? 'active' : ''}`}
                onClick={(e) => { e.stopPropagation(); onToggleKeyTask(); }}
                title={task.is_key_task ? 'Remove from Key Tasks' : 'Add to Key Tasks'}
              >★</button>
            )}
            <button
              className="btn-subtask"
              onClick={(e) => { e.stopPropagation(); setAddingSubtask(true); }}
              title="Add subtask"
            >+</button>
            <button onClick={(e) => { e.stopPropagation(); onMarkDone(); }} className="btn-done" title="Mark done">✓</button>
            <button onClick={(e) => { e.stopPropagation(); onDelete(); }} className="btn-delete" title="Delete">✕</button>
          </div>
        )}
      </div>
    </div>
  );
};

export default TaskItem;
