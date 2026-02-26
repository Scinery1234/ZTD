import React, { useState, useEffect } from 'react';
import './TaskForm.css';

const TaskForm = ({ onAdd, categories, defaultCategory, hideCategory }) => {
  const [input, setInput] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState(defaultCategory || '');
  const [priority, setPriority] = useState('');
  const [recurring, setRecurring] = useState('');
  const [due, setDue] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Update category when defaultCategory changes
  useEffect(() => {
    if (defaultCategory) {
      setCategory(defaultCategory);
    }
  }, [defaultCategory]);

  const handleSubmit = (e) => {
    e.preventDefault();
    
    // If using natural language input (CLI style), send that
    if (input.trim()) {
      onAdd({ input: input.trim() });
      setInput('');
      setShowAdvanced(false);
      return;
    }
    
    // Otherwise use structured form
    if (!description.trim()) return;

    onAdd({
      description: description.trim(),
      category: category.trim(),
      priority: priority,
      recurring: recurring,
      due: due.trim() || null,
    });

    // Reset form
    setDescription('');
    setCategory('');
    setPriority('');
    setRecurring('');
    setDue('');
    setShowAdvanced(false);
  };

  const handleKeyDown = (e) => {
    // Allow Enter to submit
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  return (
    <div className="task-form-container">
      <form onSubmit={handleSubmit} className="task-form">
        <div className="form-main">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="What needs to be done? (e.g., email boss @work !urgent ~daily ^tomorrow)"
            className="task-input"
            autoFocus
          />
          <button type="submit" className="add-btn">
            <span className="add-icon">+</span>
            Add Task
          </button>
        </div>

        <div className="input-hint">
          💡 Tip: Use CLI shortcuts - @category !priority ~recurring ^due date (Press Enter to add)
        </div>

        <button
          type="button"
          onClick={() => {
            setShowAdvanced(!showAdvanced);
            if (!showAdvanced) {
              // When opening advanced, copy input to description
              setDescription(input);
            }
          }}
          className="toggle-advanced"
        >
          {showAdvanced ? '▼' : '▶'} Advanced Options
        </button>

        {showAdvanced && (
          <div className="form-advanced">
            {!hideCategory && (
              <div className="form-group">
                <label>Category</label>
                <input
                  type="text"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      // If description exists, submit the task with category
                      if (description.trim()) {
                        let inputStr = description;
                        if (category.trim()) inputStr += ` @${category}`;
                        if (priority) inputStr += ` !${priority}`;
                        if (recurring) inputStr += ` ~${recurring}`;
                        if (due.trim()) inputStr += ` ^${due}`;
                        onAdd({ input: inputStr.trim() });
                        setDescription('');
                        setCategory('');
                        setPriority('');
                        setRecurring('');
                        setDue('');
                        setShowAdvanced(false);
                      } else {
                        // Just lock in the category and close advanced options
                        setShowAdvanced(false);
                      }
                    }
                  }}
                  placeholder="e.g., @work"
                  className="form-input"
                  list="categories"
                  autoFocus={showAdvanced}
                />
                <datalist id="categories">
                  {categories.map(cat => (
                    <option key={cat} value={cat} />
                  ))}
                </datalist>
              </div>
            )}

            <div className="form-group">
              <label>Priority</label>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
                className="form-select"
              >
                <option value="">None</option>
                <option value="urgent">Urgent</option>
                <option value="today">Today</option>
                <option value="tomorrow">Tomorrow</option>
                <option value="later">Later</option>
              </select>
            </div>

            <div className="form-group">
              <label>Recurring</label>
              <select
                value={recurring}
                onChange={(e) => setRecurring(e.target.value)}
                className="form-select"
              >
                <option value="">None</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </select>
            </div>

            <div className="form-group">
              <label>Due Date</label>
              <input
                type="text"
                value={due}
                onChange={(e) => setDue(e.target.value)}
                placeholder="e.g., tomorrow, next Friday"
                className="form-input"
              />
            </div>
          </div>
        )}
      </form>
    </div>
  );
};

export default TaskForm;
