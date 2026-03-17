import React, { useState, useEffect, useRef, useCallback } from 'react';
import './PomodoroTimer.css';

const DURATIONS = {
  pomodoro: 25 * 60,
  short: 5 * 60,
  long: 15 * 60,
};

function formatTime(seconds) {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = (seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function getSessionCount(taskId) {
  try {
    const raw = localStorage.getItem(`pomodoro_sessions_${taskId}`);
    return raw ? parseInt(raw, 10) : 0;
  } catch {
    return 0;
  }
}

function incrementSession(taskId) {
  try {
    const count = getSessionCount(taskId) + 1;
    localStorage.setItem(`pomodoro_sessions_${taskId}`, count.toString());
    return count;
  } catch {
    return 0;
  }
}

export default function PomodoroTimer({ tasks }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState('pomodoro');
  const [timeLeft, setTimeLeft] = useState(DURATIONS.pomodoro);
  const [running, setRunning] = useState(false);
  const [pinnedTaskId, setPinnedTaskId] = useState(null);
  const [sessionCount, setSessionCount] = useState(0);
  const intervalRef = useRef(null);

  const pinnedTask = tasks.find((t) => t.id === pinnedTaskId);

  const reset = useCallback((newMode) => {
    clearInterval(intervalRef.current);
    setRunning(false);
    const m = newMode || mode;
    setTimeLeft(DURATIONS[m]);
  }, [mode]);

  const switchMode = (newMode) => {
    setMode(newMode);
    reset(newMode);
    setTimeLeft(DURATIONS[newMode]);
  };

  useEffect(() => {
    if (running) {
      intervalRef.current = setInterval(() => {
        setTimeLeft((prev) => {
          if (prev <= 1) {
            clearInterval(intervalRef.current);
            setRunning(false);
            if (mode === 'pomodoro' && pinnedTaskId) {
              const count = incrementSession(pinnedTaskId);
              setSessionCount(count);
            }
            if (Notification.permission === 'granted') {
              new Notification('FocusFlow', {
                body: mode === 'pomodoro'
                  ? `Pomodoro done!${pinnedTask ? ` "${pinnedTask.description}"` : ''}`
                  : 'Break over — back to work!',
                icon: '/favicon.ico',
              });
            }
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    } else {
      clearInterval(intervalRef.current);
    }
    return () => clearInterval(intervalRef.current);
  }, [running, mode, pinnedTaskId, pinnedTask]);

  useEffect(() => {
    if (pinnedTaskId) {
      setSessionCount(getSessionCount(pinnedTaskId));
    }
  }, [pinnedTaskId]);

  const requestNotificationPermission = () => {
    if (Notification.permission === 'default') {
      Notification.requestPermission();
    }
  };

  const progress = 1 - timeLeft / DURATIONS[mode];
  const circumference = 2 * Math.PI * 40;

  return (
    <>
      {/* Floating trigger button */}
      <button
        className="pomodoro-fab"
        onClick={() => { setOpen((v) => !v); requestNotificationPermission(); }}
        title="Pomodoro Timer"
      >
        🍅
        {running && <span className="pomodoro-fab-indicator" />}
      </button>

      {open && (
        <div className="pomodoro-panel">
          {/* Mode tabs */}
          <div className="pomodoro-modes">
            {['pomodoro', 'short', 'long'].map((m) => (
              <button
                key={m}
                className={`pomodoro-mode-btn ${mode === m ? 'active' : ''}`}
                onClick={() => switchMode(m)}
              >
                {m === 'pomodoro' ? 'Focus' : m === 'short' ? 'Short break' : 'Long break'}
              </button>
            ))}
          </div>

          {/* Timer ring */}
          <div className="pomodoro-ring-wrap">
            <svg className="pomodoro-ring" viewBox="0 0 100 100">
              <circle cx="50" cy="50" r="40" className="pomodoro-ring-bg" />
              <circle
                cx="50" cy="50" r="40"
                className="pomodoro-ring-fill"
                strokeDasharray={circumference}
                strokeDashoffset={circumference * (1 - progress)}
              />
            </svg>
            <div className="pomodoro-time">{formatTime(timeLeft)}</div>
          </div>

          {/* Controls */}
          <div className="pomodoro-controls">
            <button className="pomodoro-btn" onClick={() => setRunning((v) => !v)}>
              {running ? '⏸ Pause' : '▶ Start'}
            </button>
            <button className="pomodoro-btn pomodoro-btn--secondary" onClick={() => reset()}>
              ↺ Reset
            </button>
          </div>

          {/* Task pin */}
          <div className="pomodoro-task-section">
            <label className="pomodoro-task-label">Pinned task</label>
            <select
              className="pomodoro-task-select"
              value={pinnedTaskId || ''}
              onChange={(e) => setPinnedTaskId(e.target.value ? parseInt(e.target.value, 10) : null)}
            >
              <option value="">None</option>
              {tasks.map((t) => (
                <option key={t.id} value={t.id}>{t.description}</option>
              ))}
            </select>
            {pinnedTaskId && sessionCount > 0 && (
              <div className="pomodoro-sessions">
                {'🍅'.repeat(Math.min(sessionCount, 8))}
                {sessionCount > 8 && ` ×${sessionCount}`}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
