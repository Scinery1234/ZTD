import React, { useState } from 'react';
import './TodayWins.css';

function todayPrefix() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function TodayWins({ doneTasks, onUnmarkDone }) {
  const [open, setOpen] = useState(true);

  const today = todayPrefix();
  const wins = doneTasks.filter(t => t.completed_at && t.completed_at.startsWith(today));

  if (wins.length === 0) {
    return (
      <div className="today-wins today-wins--empty">
        <span className="today-wins-icon">🌅</span>
        <span className="today-wins-empty-text">No tasks completed yet today — go make it happen.</span>
      </div>
    );
  }

  return (
    <div className={`today-wins${open ? ' today-wins--open' : ''}`}>
      <button className="today-wins-header" onClick={() => setOpen(o => !o)}>
        <span className="today-wins-chevron">{open ? '▾' : '▸'}</span>
        <span className="today-wins-check">✓</span>
        <span className="today-wins-title">
          {wins.length} {wins.length === 1 ? 'task' : 'tasks'} completed today
        </span>
      </button>

      {open && (
        <ul className="today-wins-list">
          {wins.map(task => (
            <li key={task.id} className="today-wins-item">
              <span className="today-wins-dot" />
              <span className="today-wins-desc">{task.description}</span>
              {task.category && (
                <span className="today-wins-cat">{task.category}</span>
              )}
              {onUnmarkDone && (
                <button
                  className="today-wins-undo"
                  onClick={() => onUnmarkDone(task.id)}
                  title="Move back to active"
                >↩</button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
