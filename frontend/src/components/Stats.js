import React from 'react';
import './Stats.css';

const Stats = ({ tasks, doneTasks }) => {
  const urgentTasks = tasks.filter(t => t.priority === 'urgent').length;
  const todayTasks = tasks.filter(t => t.priority === 'today').length;
  const overdueTasks = tasks.filter(t => {
    if (!t.due) return false;
    const dueDate = new Date(t.due);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return dueDate < today;
  }).length;

  return (
    <div className="stats">
      <div className="stat-card">
        <div className="stat-value">{tasks.length}</div>
        <div className="stat-label">Active Tasks</div>
      </div>
      <div className="stat-card urgent">
        <div className="stat-value">{urgentTasks}</div>
        <div className="stat-label">Urgent</div>
      </div>
      <div className="stat-card today">
        <div className="stat-value">{todayTasks}</div>
        <div className="stat-label">Today</div>
      </div>
      <div className="stat-card overdue">
        <div className="stat-value">{overdueTasks}</div>
        <div className="stat-label">Overdue</div>
      </div>
      <div className="stat-card done">
        <div className="stat-value">{doneTasks.length}</div>
        <div className="stat-label">Completed</div>
      </div>
    </div>
  );
};

export default Stats;
