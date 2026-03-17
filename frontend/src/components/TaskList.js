import React, { useState } from 'react';
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

const TaskList = ({ tasks, onUpdate, onDelete, onMarkDone, onReorder, onCategoryClick, onToggleKeyTask, viewMode, isPremium }) => {
  const [editingId, setEditingId] = useState(null);
  const [items, setItems] = useState(tasks);

  React.useEffect(() => {
    setItems(tasks);
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
        <div className="task-list">
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
                onDelete={() => onDelete(taskId)}
                onMarkDone={() => onMarkDone(taskId)}
                onCategoryClick={onCategoryClick}
                onToggleKeyTask={onToggleKeyTask ? () => onToggleKeyTask(taskId) : undefined}
                viewMode={viewMode}
                isPremium={isPremium}
              />
            );
          })}
        </div>
      </SortableContext>
    </DndContext>
  );
};

export default TaskList;
