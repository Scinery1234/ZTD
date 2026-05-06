import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import './AuthPages.css';

function LoginPage({ onSwitch, onGuest, onRegister }) {
  const { login } = useAuth();
  const [form, setForm] = useState({ email: '', password: '' });
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(form.email, form.password, remember);
    } catch (err) {
      setError(err.message || 'Login failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-header">
          <h1 className="auth-logo">FocusFlow</h1>
          <p className="auth-tagline">Zen To Done Task Manager</p>
        </div>

        <h2 className="auth-title">Welcome back</h2>
        <p className="auth-subtitle">Sign in to access your tasks</p>

        {onRegister && (
          <div className="auth-primary-alt">
            <p className="auth-primary-alt-label">New here?</p>
            <button
              type="button"
              className="auth-btn auth-btn--secondary"
              onClick={onRegister}
            >
              Create free account
            </button>
          </div>
        )}

        {error && <div className="auth-error">{error}</div>}

        <form onSubmit={handleSubmit} className="auth-form">
          <div className="auth-field">
            <label>Email</label>
            <input
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              placeholder="you@example.com"
              required
              autoFocus
            />
          </div>

          <div className="auth-field">
            <label>Password</label>
            <input
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              placeholder="Your password"
              required
            />
          </div>

          <label className="auth-remember">
            <input
              type="checkbox"
              checked={remember}
              onChange={e => setRemember(e.target.checked)}
            />
            Stay signed in
          </label>

          <button type="submit" className="auth-btn" disabled={loading}>
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>

        <p className="auth-switch">
          Don't have an account?{' '}
          <button type="button" className="auth-link" onClick={() => onSwitch('register')}>
            Create one for free
          </button>
        </p>

        <div className="auth-divider">or</div>
        <button type="button" className="auth-guest-btn" onClick={onGuest}>
          Continue without account
        </button>
      </div>
    </div>
  );
}

export default LoginPage;
