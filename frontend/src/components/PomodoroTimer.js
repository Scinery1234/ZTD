import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { track } from '../analytics';
import './PomodoroTimer.css';

const SESSION_KEY  = 'mh_pomodoro_sessions';
const SETTINGS_KEY = 'mh_pomodoro_durations';
const DEFAULT_DURATIONS = {
  focus: 25,
  shortBreak: 5,
  longBreak: 15,
  sessionsBeforeLong: 4,
  autoAdvance: true,
};

function loadSessions() {
  try { return parseInt(localStorage.getItem(SESSION_KEY) || '0', 10); } catch { return 0; }
}
function saveSessions(n) { localStorage.setItem(SESSION_KEY, String(n)); }

function loadDurations() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY));
    if (saved && typeof saved.focus === 'number') return { ...DEFAULT_DURATIONS, ...saved };
  } catch {}
  return { ...DEFAULT_DURATIONS };
}
function saveDurations(d) { localStorage.setItem(SETTINGS_KEY, JSON.stringify(d)); }

export default function PomodoroTimer({ pinnedTask, onClose, onClearPin, onSessionComplete }) {
  const { user, subscription } = useAuth();
  const tier = subscription?.tier || user?.tier || 'free';

  const [durations, setDurations]     = useState(loadDurations);
  const [modeIdx, setModeIdx]         = useState(0);
  const [secondsLeft, setSeconds]     = useState(() => loadDurations().focus * 60);
  const [running, setRunning]         = useState(false);
  const [sessions, setSessions]       = useState(loadSessions);
  const [roundFocus, setRoundFocus]   = useState(0);
  const [manualTitle, setManualTitle] = useState('');
  const [showSettings, setShowSettings] = useState(false);

  const intervalRef           = useRef(null);
  const pinnedTaskRef         = useRef(pinnedTask);
  const onSessionCompleteRef  = useRef(onSessionComplete);
  const durationsRef          = useRef(durations);
  const modeIdxRef            = useRef(modeIdx);
  const roundFocusRef         = useRef(roundFocus);

  useEffect(() => { pinnedTaskRef.current        = pinnedTask;       }, [pinnedTask]);
  useEffect(() => { onSessionCompleteRef.current = onSessionComplete;}, [onSessionComplete]);
  useEffect(() => { durationsRef.current         = durations;        }, [durations]);
  useEffect(() => { modeIdxRef.current           = modeIdx;          }, [modeIdx]);
  useEffect(() => { roundFocusRef.current        = roundFocus;       }, [roundFocus]);

  const MODE_LABELS = ['Focus', 'Short Break', 'Long Break'];

  const modes = [
    { label: 'Focus',       minutes: durations.focus      },
    { label: 'Short Break', minutes: durations.shortBreak },
    { label: 'Long Break',  minutes: durations.longBreak  },
  ];
  const mode = modes[modeIdx];
  const sessionsBeforeLong = durations.sessionsBeforeLong || 4;

  // Switch mode + reset timer (safe to call from anywhere, uses refs internally)
  const switchMode = useCallback((i) => {
    clearInterval(intervalRef.current);
    setRunning(false);
    setModeIdx(i);
    const d = durationsRef.current;
    setSeconds([d.focus, d.shortBreak, d.longBreak][i] * 60);
  }, []);

  const handleSettingChange = (key, value) => {
    if (key === 'autoAdvance') {
      const next = { ...durations, autoAdvance: value };
      setDurations(next);
      saveDurations(next);
      return;
    }
    if (key === 'sessionsBeforeLong') {
      const v = Math.max(1, Math.min(10, parseInt(value) || 1));
      const next = { ...durations, sessionsBeforeLong: v };
      setDurations(next);
      saveDurations(next);
      return;
    }
    const v = Math.max(1, Math.min(99, parseInt(value) || 1));
    const next = { ...durations, [key]: v };
    setDurations(next);
    saveDurations(next);
    // If currently showing this mode and stopped, update the display
    const modeMap = { focus: 0, shortBreak: 1, longBreak: 2 };
    if (!running && modeMap[key] !== undefined && modeMap[key] === modeIdx) {
      setSeconds(v * 60);
    }
  };

  // Main timer tick
  useEffect(() => {
    if (!running) return;
    intervalRef.current = setInterval(() => {
      setSeconds(s => {
        if (s <= 1) {
          clearInterval(intervalRef.current);
          // Defer state updates to outside the setState callback
          setTimeout(() => {
            const d   = durationsRef.current;
            const idx = modeIdxRef.current;
            const label = MODE_LABELS[idx];

            setRunning(false);

            if (label === 'Focus') {
              const next = loadSessions() + 1;
              saveSessions(next);
              setSessions(next);
              const task = pinnedTaskRef.current;
              const cb   = onSessionCompleteRef.current;
              if (task && cb) cb(task.id);

              const newRound = roundFocusRef.current + 1;
              const toLong   = newRound >= (d.sessionsBeforeLong || 4);

              if (d.autoAdvance) {
                if (toLong) {
                  setRoundFocus(0);
                  setModeIdx(2);
                  setSeconds((d.longBreak || 15) * 60);
                } else {
                  setRoundFocus(newRound);
                  setModeIdx(1);
                  setSeconds((d.shortBreak || 5) * 60);
                }
                setTimeout(() => setRunning(true), 300);
              } else {
                setRoundFocus(toLong ? 0 : newRound);
              }
            } else {
              // Break finished → back to Focus
              if (d.autoAdvance) {
                setModeIdx(0);
                setSeconds((d.focus || 25) * 60);
                setTimeout(() => setRunning(true), 300);
              }
            }

            if ('Notification' in window && Notification.permission === 'granted') {
              // eslint-disable-next-line no-new
              new Notification('happen', {
                body: `${label} complete! 🎉`,
                icon: '/favicon.ico',
              });
            }
          }, 0);
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(intervalRef.current);
  }, [running]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = () => {
    if (!running) {
      if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
      }
      track('pomodoro_started');
    }
    setRunning(r => !r);
  };

  const mins = String(Math.floor(secondsLeft / 60)).padStart(2, '0');
  const secs = String(secondsLeft % 60).padStart(2, '0');
  const total = mode.minutes * 60;
  const pct   = total > 0 ? ((total - secondsLeft) / total) * 100 : 0;
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

      {showSettings ? (
        <div className="pomodoro-settings">
          <div className="pomodoro-settings-row">
            <label>Focus</label>
            <input type="number" min="1" max="99" value={durations.focus}
              onChange={e => handleSettingChange('focus', e.target.value)} />
            <span>min</span>
          </div>
          <div className="pomodoro-settings-row">
            <label>Short break</label>
            <input type="number" min="1" max="99" value={durations.shortBreak}
              onChange={e => handleSettingChange('shortBreak', e.target.value)} />
            <span>min</span>
          </div>
          <div className="pomodoro-settings-row">
            <label>Long break</label>
            <input type="number" min="1" max="99" value={durations.longBreak}
              onChange={e => handleSettingChange('longBreak', e.target.value)} />
            <span>min</span>
          </div>
          <div className="pomodoro-settings-divider" />
          <div className="pomodoro-settings-row">
            <label>Sessions → long break</label>
            <input type="number" min="1" max="10"
              value={durations.sessionsBeforeLong || 4}
              onChange={e => handleSettingChange('sessionsBeforeLong', e.target.value)} />
            <span></span>
          </div>
          <div className="pomodoro-settings-row pomodoro-settings-row--toggle">
            <label>Auto-advance</label>
            <button
              className={`pomodoro-toggle-btn${durations.autoAdvance ? ' active' : ''}`}
              onClick={() => handleSettingChange('autoAdvance', !durations.autoAdvance)}
            >
              {durations.autoAdvance ? 'On' : 'Off'}
            </button>
          </div>
        </div>
      ) : (
        <>
          {pinnedTask ? (
            <div className="pomodoro-pinned">
              <span className="pomodoro-pinned-label">Working on</span>
              <span className="pomodoro-pinned-task">{pinnedTask.description}</span>
              <button className="pomodoro-unpin" onClick={onClearPin} title="Unpin">×</button>
            </div>
          ) : (
            <div className="pomodoro-manual-task">
              <input
                className="pomodoro-manual-input"
                placeholder="Working on… (optional)"
                value={manualTitle}
                onChange={e => setManualTitle(e.target.value)}
              />
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
            <button className="pomodoro-ctrl-btn" onClick={() => switchMode(modeIdx)} title="Reset">↺</button>
            <button className={`pomodoro-play-btn${running ? ' running' : ''}`} onClick={toggle}>
              {running ? '⏸' : '▶'}
            </button>
          </div>

          <div className="pomodoro-sessions">
            <span className="pomodoro-sessions-count">🍅 × {sessions}</span>
            <span className="pomodoro-cycle-indicator" title={`Session ${roundFocus + 1} of ${sessionsBeforeLong} before long break`}>
              {roundFocus + 1}/{sessionsBeforeLong}
            </span>
            <button
              className="pomodoro-sessions-reset"
              onClick={() => { saveSessions(0); setSessions(0); setRoundFocus(0); }}
              title="Reset session count"
            >reset</button>
          </div>
        </>
      )}
    </div>
  );
}
