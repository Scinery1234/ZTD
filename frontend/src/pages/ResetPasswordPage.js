import React, { useState } from 'react';
import { useTheme } from '../hooks/useTheme';
import { api } from '../api';
import './AuthPages.css';

function ResetPasswordPage({ token, onGoLogin }) {
  const { theme, toggleTheme } = useTheme();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setLoading(true);
    try {
      await api.resetPassword(token, password);
      setDone(true);
    } catch (err) {
      setError(err.message || 'Something went wrong. Please try again.');
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

        {done ? (
          <>
            <div className="auth-info">
              Password updated! You can now sign in with your new password.
            </div>
            <button type="button" className="auth-btn" onClick={onGoLogin}>
              Sign in
            </button>
          </>
        ) : (
          <>
            <h2 className="auth-title">Set new password</h2>
            <p className="auth-subtitle">Choose a password with at least 8 characters</p>

            {error && <div className="auth-error">{error}</div>}

            <form onSubmit={handleSubmit} className="auth-form">
              <div className="auth-field">
                <label>New password</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 8 characters"
                  required
                  autoFocus
                  minLength={8}
                />
              </div>
              <div className="auth-field">
                <label>Confirm password</label>
                <input
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder="Same password again"
                  required
                />
              </div>
              <button type="submit" className="auth-btn" disabled={loading}>
                {loading ? 'Updating...' : 'Update password'}
              </button>
            </form>

            <p className="auth-switch">
              <button type="button" className="auth-link" onClick={onGoLogin}>
                ← Back to sign in
              </button>
            </p>
          </>
        )}
      </div>
    </div>
  );
}

export default ResetPasswordPage;
