import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { api } from '../api';
import { asArray } from '../utils/arrays';
import AIHub from '../components/AIHub';
import './CoachApp.css';

/*
 * CoachApp — the AI Coaching Hub as a standalone product, served at /coach.
 *
 * Same accounts and task list as the main app (shared AuthContext + JWT), but
 * with its own sign-in screen and a full-page hub instead of the floating
 * panel. Users who sign in here are also signed in to the task app and
 * vice versa.
 */

function CoachAuth() {
  const { login, register } = useAuth();
  const [mode, setMode] = useState('login'); // 'login' | 'register' | 'forgot'
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setNotice('');
    setBusy(true);
    try {
      if (mode === 'login') {
        await login(form.email, form.password, true);
      } else if (mode === 'register') {
        await register(form.name, form.email, form.password);
      } else {
        await api.forgotPassword(form.email);
        setNotice(`If an account exists for ${form.email}, a reset link is on its way.`);
      }
    } catch (err) {
      setError(err.message || 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const switchMode = (m) => { setMode(m); setError(''); setNotice(''); };

  return (
    <div className="coach-auth">
      <div className="coach-auth__card">
        <div className="coach-auth__brand">
          <span className="coach-auth__logo">🧭</span>
          <h1>AI Coach</h1>
          <p>Coaching, resilience & focus — by MadeHappen</p>
        </div>

        <h2 className="coach-auth__title">
          {mode === 'login' && 'Welcome back'}
          {mode === 'register' && 'Create your account'}
          {mode === 'forgot' && 'Reset your password'}
        </h2>

        {error && <div className="coach-auth__error">{error}</div>}
        {notice && <div className="coach-auth__notice">{notice}</div>}

        <form onSubmit={submit} className="coach-auth__form">
          {mode === 'register' && (
            <label>
              Name
              <input type="text" value={form.name} onChange={set('name')}
                placeholder="Your name" required autoFocus />
            </label>
          )}
          <label>
            Email
            <input type="email" value={form.email} onChange={set('email')}
              placeholder="you@example.com" required autoFocus={mode !== 'register'} />
          </label>
          {mode !== 'forgot' && (
            <label>
              Password
              <input type="password" value={form.password} onChange={set('password')}
                placeholder={mode === 'register' ? 'At least 8 characters' : 'Your password'} required />
            </label>
          )}
          <button type="submit" className="coach-auth__btn" disabled={busy}>
            {busy ? 'One moment…'
              : mode === 'login' ? 'Sign in'
              : mode === 'register' ? 'Create account'
              : 'Send reset link'}
          </button>
        </form>

        <div className="coach-auth__links">
          {mode === 'login' && (
            <>
              <button type="button" onClick={() => switchMode('register')}>New here? Create a free account</button>
              <button type="button" onClick={() => switchMode('forgot')}>Forgot password?</button>
            </>
          )}
          {mode !== 'login' && (
            <button type="button" onClick={() => switchMode('login')}>← Back to sign in</button>
          )}
        </div>

        <p className="coach-auth__legal">
          One account for the coach and the{' '}
          <a href="/app">MadeHappen task app</a>.{' '}
          <a href="/terms.html" target="_blank" rel="noopener noreferrer">Terms</a>
          {' · '}
          <a href="/privacy.html" target="_blank" rel="noopener noreferrer">Privacy</a>
        </p>
      </div>
    </div>
  );
}

export default function CoachApp() {
  const { user, loading, logout } = useAuth();
  const [tasks, setTasks] = useState([]);

  const fetchTasks = useCallback(async () => {
    try {
      setTasks(asArray(await api.getTasks()));
    } catch (err) {
      console.error('Error fetching tasks:', err);
    }
  }, []);

  useEffect(() => {
    if (user) fetchTasks();
  }, [user, fetchTasks]);

  if (loading) {
    return (
      <div className="coach-app">
        <div className="coach-loading">Loading…</div>
      </div>
    );
  }

  if (!user) return <CoachAuth />;

  return (
    <div className="coach-app">
      <header className="coach-topbar">
        <span className="coach-topbar__brand">
          <span className="coach-topbar__logo">🧭</span>
          AI Coach
          <span className="coach-topbar__by">by MadeHappen</span>
        </span>
        <span className="coach-topbar__actions">
          <a className="coach-topbar__link" href="/app">Open task app</a>
          <button className="coach-topbar__signout" onClick={logout}>Sign out</button>
        </span>
      </header>
      <main className="coach-main">
        <AIHub standalone hatId={null} tasks={tasks} onTasksChanged={fetchTasks} />
      </main>
    </div>
  );
}
