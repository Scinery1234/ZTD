import React from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import TaskList from './TaskList';
import CategoryTaskAdder from './CategoryTaskAdder';
import './CategorySection.css';

const CategorySection = ({ 
  category, 
  tasks, 
  onUpdate, 
  onDelete, 
  onMarkDone, 
  onCategoryClick,
  onAddTask 
}) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: `category-${category}` });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`category-section ${isDragging ? 'dragging' : ''}`}
      data-category={category}
    >
      <div className="category-header">
        <div className="category-drag-handle" {...attributes} {...listeners}>
          <span className="drag-icon">☰</span>
        </div>
        <h2 className="category-title">{category}</h2>
      </div>
      <TaskList
        tasks={tasks}
        onUpdate={onUpdate}
        onDelete={onDelete}
        onMarkDone={onMarkDone}
        onCategoryClick={onCategoryClick}
        viewMode="active"
      />
      <CategoryTaskAdder 
        category={category}
        onAdd={onAddTask}
      />
    </div>
  );
};

export default CategorySection;
