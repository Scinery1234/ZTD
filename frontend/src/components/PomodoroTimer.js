import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import './PomodoroTimer.css';

const SESSION_KEY  = 'mh_pomodoro_sessions';
const SETTINGS_KEY = 'mh_pomodoro_durations';
const DEFAULT_DURATIONS = { focus: 25, shortBreak: 5, longBreak: 15 };

function loadSessions() {
  try { return parseInt(localStorage.getItem(SESSION_KEY) || '0', 10); } catch { return 0; }
}
function saveSessions(n) { localStorage.setItem(SESSION_KEY, String(n)); }

function loadDurations() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY));
    if (saved && typeof saved.focus === 'number') return saved;
  } catch {}
  return DEFAULT_DURATIONS;
}
function saveDurations(d) { localStorage.setItem(SETTINGS_KEY, JSON.stringify(d)); }

export default function PomodoroTimer({ pinnedTask, onClose, onClearPin, onSessionComplete }) {
  const { user, subscription } = useAuth();
  const tier = subscription?.tier || user?.tier || 'free';
  const [durations, setDurations] = useState(loadDurations);
  const [modeIdx, setModeIdx]     = useState(0);
  const [secondsLeft, setSeconds] = useState(() => loadDurations().focus * 60);
  const [running, setRunning]     = useState(false);
  const [sessions, setSessions]   = useState(loadSessions);
  const [showSettings, setShowSettings] = useState(false);
  const intervalRef = useRef(null);
  const pinnedTaskRef = useRef(pinnedTask);
  const onSessionCompleteRef = useRef(onSessionComplete);

  useEffect(() => { pinnedTaskRef.current = pinnedTask; }, [pinnedTask]);
  useEffect(() => { onSessionCompleteRef.current = onSessionComplete; }, [onSessionComplete]);

  const modes = [
    { label: 'Focus',       minutes: durations.focus      },
    { label: 'Short Break', minutes: durations.shortBreak },
    { label: 'Long Break',  minutes: durations.longBreak  },
  ];

  const mode = modes[modeIdx];

  const reset = useCallback((idx) => {
    const m = idx !== undefined ? idx : modeIdx;
    const minuteMap = [durations.focus, durations.shortBreak, durations.longBreak];
    clearInterval(intervalRef.current);
    setRunning(false);
    setSeconds(minuteMap[m] * 60);
  }, [modeIdx, durations]);

  const switchMode = (i) => {
    setModeIdx(i);
    reset(i);
  };

  const handleDurationChange = (key, value) => {
    const v = Math.max(1, Math.min(99, parseInt(value) || 1));
    const next = { ...durations, [key]: v };
    setDurations(next);
    saveDurations(next);
    const modeMap = { focus: 0, shortBreak: 1, longBreak: 2 };
    if (!running && modeMap[key] === modeIdx) {
      setSeconds(v * 60);
    }
  };

  useEffect(() => {
    if (!running) return;
    intervalRef.current = setInterval(() => {
      setSeconds(s => {
        if (s <= 1) {
          clearInterval(intervalRef.current);
          setRunning(false);
          if (mode.label === 'Focus') {
            const next = loadSessions() + 1;
            saveSessions(next);
            setSessions(next);
            const task = pinnedTaskRef.current;
            const cb = onSessionCompleteRef.current;
            if (task && cb) cb(task.id);
          }
          if ('Notification' in window && Notification.permission === 'granted') {
            // eslint-disable-next-line no-new
            new Notification('happen', {
              body: `${mode.label} session complete! 🎉`,
              icon: '/favicon.ico',
            });
          }
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(intervalRef.current);
  }, [running, mode.label]);

  const toggle = () => {
    if (!running && 'Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
    setRunning(r => !r);
  };

  const mins = String(Math.floor(secondsLeft / 60)).padStart(2, '0');
  const secs = String(secondsLeft % 60).padStart(2, '0');
  const total = mode.minutes * 60;
  const pct   = ((total - secondsLeft) / total) * 100;
  const circumference = 2 * Math.PI * 44;

  if (tier === 'free') {
    return (
      <div className="pomodoro-widget">
        <div className="pomodoro-header">
          <span className="pomodoro-title">🍅 Pomodoro</span>
          <button className="pomodoro-close" onClick={onClose} title="Close">×</button>
        </div>
        <div className="pomodoro-upgrade">
          <p>The Pomodoro timer is a <strong>Pro</strong> feature.</p>
          <p className="pomodoro-upgrade-sub">Upgrade to unlock focused work sessions with browser notifications.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="pomodoro-widget">
      <div className="pomodoro-header">
        <span className="pomodoro-title">🍅 Pomodoro</span>
        <div className="pomodoro-header-actions">
          <button
            className={`pomodoro-settings-btn${showSettings ? ' active' : ''}`}
            onClick={() => setShowSettings(s => !s)}
            title="Timer settings"
          >⚙</button>
          <button className="pomodoro-close" onClick={onClose} title="Close">×</button>
        </div>
      </div>

      {showSettings && (
        <div className="pomodoro-settings">
          <div className="pomodoro-settings-row">
            <label>Focus</label>
            <input
              type="number" min="1" max="99"
              value={durations.focus}
              onChange={e => handleDurationChange('focus', e.target.value)}
            />
            <span>min</span>
          </div>
          <div className="pomodoro-settings-row">
            <label>Short break</label>
            <input
              type="number" min="1" max="99"
              value={durations.shortBreak}
              onChange={e => handleDurationChange('shortBreak', e.target.value)}
            />
            <span>min</span>
          </div>
          <div className="pomodoro-settings-row">
            <label>Long break</label>
            <input
              type="number" min="1" max="99"
              value={durations.longBreak}
              onChange={e => handleDurationChange('longBreak', e.target.value)}
            />
            <span>min</span>
          </div>
        </div>
      )}

      {!showSettings && (
        <>
          {pinnedTask && (
            <div className="pomodoro-pinned">
              <span className="pomodoro-pinned-label">Working on</span>
              <span className="pomodoro-pinned-task">{pinnedTask.description}</span>
              <button className="pomodoro-unpin" onClick={onClearPin} title="Unpin">×</button>
            </div>
          )}

          <div className="pomodoro-modes">
            {modes.map((m, i) => (
              <button
                key={m.label}
                className={`pomodoro-mode-btn${i === modeIdx ? ' active' : ''}`}
                onClick={() => switchMode(i)}
              >
                {m.label}
              </button>
            ))}
          </div>

          <div className="pomodoro-ring-wrap">
            <svg className="pomodoro-ring" viewBox="0 0 100 100">
              <circle className="pomodoro-ring-bg"   cx="50" cy="50" r="44" />
              <circle
                className="pomodoro-ring-fill"
                cx="50" cy="50" r="44"
                strokeDasharray={circumference}
                strokeDashoffset={circumference * (1 - pct / 100)}
                style={{ transition: running ? 'stroke-dashoffset 1s linear' : 'none' }}
              />
            </svg>
            <div className="pomodoro-time">{mins}:{secs}</div>
            <div className="pomodoro-mode-label">{mode.label}</div>
          </div>

          <div className="pomodoro-controls">
            <button className="pomodoro-ctrl-btn" onClick={() => reset()} title="Reset">↺</button>
            <button className={`pomodoro-play-btn${running ? ' running' : ''}`} onClick={toggle}>
              {running ? '⏸' : '▶'}
            </button>
          </div>

          <div className="pomodoro-sessions">
            <span className="pomodoro-sessions-count">🍅 × {sessions}</span>
            <button
              className="pomodoro-sessions-reset"
              onClick={() => { saveSessions(0); setSessions(0); }}
              title="Reset session count"
            >
              reset
            </button>
          </div>
        </>
      )}
    </div>
  );
}
