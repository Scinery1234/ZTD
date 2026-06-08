import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../hooks/useTheme';
import { api } from '../api';
import './AuthPages.css';

function ForgotPasswordView({ onBack }) {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await api.forgotPassword(email);
      setSent(true);
    } catch (err) {
      setError(err.message || 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  if (sent) {
    return (
      <>
        <div className="auth-info">
          Check your inbox — if an account exists for <strong>{email}</strong>, a reset link is on its way. Check your spam folder too.
        </div>
        <button type="button" className="auth-btn" onClick={onBack}>
          Back to sign in
        </button>
      </>
    );
  }

  return (
    <>
      <h2 className="auth-title">Forgot password?</h2>
      <p className="auth-subtitle">Enter your email and we'll send a reset link</p>

      {error && <div className="auth-error">{error}</div>}

      <form onSubmit={handleSubmit} className="auth-form">
        <div className="auth-field">
          <label>Email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            required
            autoFocus
          />
        </div>
        <button type="submit" className="auth-btn" disabled={loading}>
          {loading ? 'Sending...' : 'Send reset link'}
        </button>
      </form>

      <p className="auth-switch">
        <button type="button" className="auth-link" onClick={onBack}>
          ← Back to sign in
        </button>
      </p>
    </>
  );
}

function LoginPage({ onSwitch, onGuest, onRegister }) {
  const { login } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const [form, setForm] = useState({ email: '', password: '' });
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showForgot, setShowForgot] = useState(false);

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
      <button className="auth-theme-btn" onClick={toggleTheme} title="Toggle theme">
        {theme === 'light' ? '🌙' : '☀️'}
      </button>
      <div className="auth-card">
        <div className="auth-header">
          <h1 className="auth-logo">happen</h1>
          <p className="auth-tagline">make it happen</p>
        </div>

        {showForgot ? (
          <ForgotPasswordView onBack={() => setShowForgot(false)} />
        ) : (
          <>
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

              <div className="auth-row">
                <label className="auth-remember">
                  <input
                    type="checkbox"
                    checked={remember}
                    onChange={e => setRemember(e.target.checked)}
                  />
                  Stay signed in
                </label>
                <button
                  type="button"
                  className="auth-link auth-forgot-link"
                  onClick={() => setShowForgot(true)}
                >
                  Forgot password?
                </button>
              </div>

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

            <p className="auth-legal">
              <a href="/terms.html" target="_blank" rel="noopener noreferrer">Terms</a>
              {' · '}
              <a href="/privacy.html" target="_blank" rel="noopener noreferrer">Privacy</a>
            </p>
          </>
        )}
      </div>
    </div>
  );
}

export default LoginPage;
