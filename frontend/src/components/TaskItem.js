import React, { useState } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import './TaskItem.css';

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
  viewMode,
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
  });

  const getPriorityClass = (priority) => {
    const classes = {
      urgent: 'priority-urgent',
      today: 'priority-today',
      tomorrow: 'priority-tomorrow',
      later: 'priority-later',
    };
    return classes[priority] || '';
  };

  const getPriorityLabel = (priority) => {
    if (!priority) return '';
    return priority.charAt(0).toUpperCase() + priority.slice(1);
  };

  const formatDate = (dateString) => {
    if (!dateString) return '';
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  const isOverdue = () => {
    if (!task.due) return false;
    const dueDate = new Date(task.due);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return dueDate < today;
  };

  const handleSave = () => {
    onUpdate(editData);
  };

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
                if (e.key === 'Enter' && e.ctrlKey) {
                  handleSave();
                } else if (e.key === 'Escape') {
                  onCancelEdit();
                }
              }}
            />
          </div>
          
          <div className="edit-section">
            <label className="edit-label">Advanced Options</label>
            <div className="edit-fields">
              <div className="edit-field-group">
                <label className="edit-field-label">Category</label>
                <input
                  type="text"
                  value={editData.category}
                  onChange={(e) => setEditData({ ...editData, category: e.target.value })}
                  className="edit-field"
                  placeholder="e.g., @work"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleSave();
                    }
                  }}
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
                  placeholder="e.g., tomorrow, next Friday"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleSave();
                    }
                  }}
                />
              </div>
            </div>
          </div>
          
          <div className="edit-actions">
            <button onClick={handleSave} className="btn-save">Save</button>
            <button onClick={onCancelEdit} className="btn-cancel">Cancel</button>
            <span className="edit-hint">Press Ctrl+Enter to save, Esc to cancel</span>
          </div>
        </div>
      </div>
    );
  }

  const handleDoubleClick = () => {
    if (viewMode === 'active' && !isEditing) {
      onEdit();
    }
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`task-item ${getPriorityClass(task.priority)} ${isOverdue() ? 'overdue' : ''} ${isDragging ? 'dragging' : ''}`}
      onDoubleClick={handleDoubleClick}
    >
      <div className="task-content">
        {viewMode === 'active' && (
          <div className="drag-handle" {...attributes} {...listeners}>
            <span className="drag-icon">☰</span>
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
                  if (onCategoryClick && viewMode === 'active') {
                    onCategoryClick(task.category);
                  }
                }}
                title="Double-click to view this category"
              >
                @{task.category}
              </span>
            )}
            {task.priority && (
              <span className={`task-priority ${getPriorityClass(task.priority)}`}>
                {getPriorityLabel(task.priority)}
              </span>
            )}
            {task.recurring && (
              <span className="task-recurring">~{task.recurring}</span>
            )}
            {task.due && (
              <span className={`task-due ${isOverdue() ? 'overdue' : ''}`}>
                📅 {formatDate(task.due)}
              </span>
            )}
          </div>
        </div>
        {viewMode === 'active' && (
          <div className="task-actions">
            <button onClick={onEdit} className="btn-edit" title="Edit">
              ✏️
            </button>
            <button onClick={onMarkDone} className="btn-done" title="Mark as done">
              ✓
            </button>
            <button onClick={onDelete} className="btn-delete" title="Delete">
              🗑️
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default TaskItem;
