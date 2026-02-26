import React from 'react';
import './TaskFilters.css';

const TaskFilters = ({
  filter,
  setFilter,
  categories,
  selectedCategory,
  setSelectedCategory,
  selectedPriority,
  setSelectedPriority,
}) => {
  return (
    <div className="task-filters">
      <div className="filter-group">
        <label>Filter by:</label>
        <select
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            if (e.target.value !== 'category') setSelectedCategory('');
            if (e.target.value !== 'priority') setSelectedPriority('');
          }}
          className="filter-select"
        >
          <option value="all">All Tasks</option>
          <option value="category">Category</option>
          <option value="priority">Priority</option>
        </select>
      </div>

      {filter === 'category' && (
        <div className="filter-group">
          <label>Category:</label>
          <select
            value={selectedCategory}
            onChange={(e) => setSelectedCategory(e.target.value)}
            className="filter-select"
          >
            <option value="">All Categories</option>
            {categories.map(cat => (
              <option key={cat} value={cat}>{cat}</option>
            ))}
          </select>
        </div>
      )}

      {filter === 'priority' && (
        <div className="filter-group">
          <label>Priority:</label>
          <select
            value={selectedPriority}
            onChange={(e) => setSelectedPriority(e.target.value)}
            className="filter-select"
          >
            <option value="">All Priorities</option>
            <option value="urgent">Urgent</option>
            <option value="today">Today</option>
            <option value="tomorrow">Tomorrow</option>
            <option value="later">Later</option>
          </select>
        </div>
      )}
    </div>
  );
};

export default TaskFilters;
