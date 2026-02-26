import React, { useState } from 'react';
import './CategoryTaskAdder.css';

const CategoryTaskAdder = ({ category, onAdd }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [input, setInput] = useState('');
  const [priority, setPriority] = useState('');
  const [recurring, setRecurring] = useState('');
  const [due, setDue] = useState('');

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!input.trim()) return;

    let taskInput = input.trim();
    if (priority) taskInput += ` !${priority}`;
    if (recurring) taskInput += ` ~${recurring}`;
    if (due.trim()) taskInput += ` ^${due.trim()}`;
    taskInput += ` @${category}`;

    onAdd({ input: taskInput });
    
    // Reset form
    setInput('');
    setPriority('');
    setRecurring('');
    setDue('');
    setIsOpen(false);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !isOpen) {
      setIsOpen(true);
    } else if (e.key === 'Enter' && isOpen) {
      handleSubmit(e);
    } else if (e.key === 'Escape') {
      setIsOpen(false);
      setInput('');
    }
  };

  if (!isOpen) {
    return (
      <button 
        className="category-add-btn"
        onClick={() => setIsOpen(true)}
        onKeyDown={handleKeyDown}
      >
        + Add Task
      </button>
    );
  }

  return (
    <div className="category-add-form">
      <form onSubmit={handleSubmit} className="category-task-form">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Task description..."
          className="category-task-input"
          autoFocus
        />
        <div className="category-form-options">
          <select
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
            className="category-form-select"
          >
            <option value="">Priority</option>
            <option value="urgent">Urgent</option>
            <option value="today">Today</option>
            <option value="tomorrow">Tomorrow</option>
            <option value="later">Later</option>
          </select>
          <select
            value={recurring}
            onChange={(e) => setRecurring(e.target.value)}
            className="category-form-select"
          >
            <option value="">Recurring</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </select>
          <input
            type="text"
            value={due}
            onChange={(e) => setDue(e.target.value)}
            placeholder="Due date"
            className="category-form-input"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                handleSubmit(e);
              }
            }}
          />
        </div>
        <div className="category-form-actions">
          <button type="submit" className="category-save-btn">Add</button>
          <button 
            type="button" 
            onClick={() => {
              setIsOpen(false);
              setInput('');
              setPriority('');
              setRecurring('');
              setDue('');
            }}
            className="category-cancel-btn"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
};

export default CategoryTaskAdder;
