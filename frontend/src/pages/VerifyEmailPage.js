import React, { useState, useEffect } from 'react';
import { useTheme } from '../hooks/useTheme';
import { api } from '../api';
import './AuthPages.css';

function VerifyEmailPage({ token, onGoLogin }) {
  const { theme, toggleTheme } = useTheme();
  const [status, setStatus] = useState('verifying'); // verifying | success | expired | error

  useEffect(() => {
    if (!token) { setStatus('error'); return; }
    api.verifyEmail(token)
      .then(() => setStatus('success'))
      .catch((err) => {
        if (/expired/i.test(err.message)) setStatus('expired');
        else setStatus('error');
      });
  }, [token]);

  const content = {
    verifying: {
      icon: '⏳',
      title: 'Verifying your email…',
      body: 'Just a moment.',
      cta: null,
    },
    success: {
      icon: '✅',
      title: 'Email verified!',
      body: "You're all set. Check your inbox for a welcome email with tips to get started.",
      cta: 'Start using happen →',
    },
    expired: {
      icon: '⏱',
      title: 'Link expired',
      body: 'Verification links are valid for 24 hours. Sign in and request a new one from the banner in the app.',
      cta: 'Go to sign in',
    },
    error: {
      icon: '⚠️',
      title: 'Invalid link',
      body: 'This verification link is invalid or has already been used. Sign in and request a new one if needed.',
      cta: 'Go to sign in',
    },
  }[status];

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

        <div style={{ textAlign: 'center', margin: '8px 0 24px' }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>{content.icon}</div>
          <h2 className="auth-title">{content.title}</h2>
          <p className="auth-subtitle" style={{ maxWidth: 300, margin: '0 auto' }}>{content.body}</p>
        </div>

        {content.cta && (
          <button type="button" className="auth-btn" onClick={onGoLogin}>
            {content.cta}
          </button>
        )}
      </div>
    </div>
  );
}

export default VerifyEmailPage;
