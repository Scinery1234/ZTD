import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import './AuthPages.css';

function RegisterPage({ onSwitch, onGuest }) {
  const { register } = useAuth();
  const [form, setForm] = useState({ name: '', email: '', password: '', confirm: '' });
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setInfo('');

    const name = form.name.trim();
    const email = form.email.trim();
    const password = form.password;
    const confirm = form.confirm;

    if (!name) {
      setError('Name is required.');
      return;
    }
    if (!email) {
      setError('Email is required.');
      return;
    }
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      setError('Please enter a valid email address.');
      return;
    }

    if (!password) {
      setError('Password is required.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }

    setLoading(true);
    setInfo('Creating your account…');
    try {
      await Promise.race([
        register(name, email, password),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Registration timed out. Please try again.')), 20000)
        ),
      ]);
      setInfo('Account created! Redirecting…');
    } catch (err) {
      setError(err.message || 'Registration failed. Please try again.');
      setInfo('');
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

        <h2 className="auth-title">Create your account</h2>
        <p className="auth-subtitle">Free forever — no credit card required</p>

        {error && <div className="auth-error">{error}</div>}
        {info && !error && <div className="auth-info">{info}</div>}

        <form onSubmit={handleSubmit} className="auth-form" noValidate>
          <div className="auth-field">
            <label>Name</label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Your name"
              required
              autoFocus
            />
          </div>

          <div className="auth-field">
            <label>Email</label>
            <input
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              placeholder="you@example.com"
              required
            />
          </div>

          <div className="auth-field">
            <label>Password</label>
            <input
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              placeholder="At least 8 characters"
              required
            />
          </div>

          <div className="auth-field">
            <label>Confirm Password</label>
            <input
              type="password"
              value={form.confirm}
              onChange={(e) => setForm({ ...form, confirm: e.target.value })}
              placeholder="Repeat your password"
              required
            />
          </div>

          <button type="submit" className="auth-btn" disabled={loading}>
            {loading ? 'Creating account...' : 'Create Free Account'}
          </button>
        </form>

        <p className="auth-switch">
          Already have an account?{' '}
          <button type="button" className="auth-link" onClick={() => onSwitch('login')}>
            Sign in
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

export default RegisterPage;
