import React, { useState } from 'react';
import { api } from '../api';
import './VerifyBanner.css';

const DISMISS_KEY = 'mh_verify_banner_dismissed';

export default function VerifyBanner() {
  const [dismissed, setDismissed] = useState(() => !!sessionStorage.getItem(DISMISS_KEY));
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);

  if (dismissed) return null;

  const dismiss = () => {
    sessionStorage.setItem(DISMISS_KEY, '1');
    setDismissed(true);
  };

  const resend = async () => {
    setLoading(true);
    try {
      await api.resendVerification();
      setSent(true);
    } catch (err) {
      // If already verified (race), just dismiss
      if (/already verified/i.test(err.message)) { dismiss(); return; }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="verify-banner">
      <span className="verify-banner-icon">✉️</span>
      <span className="verify-banner-text">
        {sent
          ? 'Verification email sent — check your inbox.'
          : 'Please verify your email address to secure your account.'}
      </span>
      {!sent && (
        <button className="verify-banner-btn" onClick={resend} disabled={loading}>
          {loading ? 'Sending…' : 'Resend email'}
        </button>
      )}
      <button className="verify-banner-close" onClick={dismiss} title="Dismiss">×</button>
    </div>
  );
}
