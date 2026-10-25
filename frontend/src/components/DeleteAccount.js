import React, { useState } from 'react';
import { api } from '../api';
import './DeleteAccount.css';

/**
 * Permanent account deletion.
 *
 * The App Store requires (guideline 5.1.1(v)) that an app which creates
 * accounts also lets people delete them from inside the app — not a support
 * email, not "contact us". Deliberately friction-heavy: the user types DELETE
 * and confirms their password, because this cannot be undone.
 */
const CONFIRM_WORD = 'DELETE';

export default function DeleteAccount({ onDeleted }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const close = () => {
    setOpen(false);
    setPassword('');
    setConfirmText('');
    setError('');
  };

  const ready = password.length > 0 && confirmText.trim().toUpperCase() === CONFIRM_WORD;

  const submit = async (e) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError('');
    try {
      await api.deleteAccount(password);
      onDeleted?.();                  // clears the session and returns to sign-in
    } catch (err) {
      setError(err.message || 'Could not delete the account.');
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button className="danger-link" onClick={() => setOpen(true)}>
        Delete my account
      </button>
    );
  }

  return (
    <div className="del-overlay" role="dialog" aria-modal="true" aria-label="Delete account">
      <form className="del-card" onSubmit={submit}>
        <h2 className="del-title">Delete your account?</h2>
        <p className="del-body">
          This permanently deletes your account and everything in it — tasks,
          completed history, hats, goals, notes and coaching conversations.
          <strong> It cannot be undone.</strong>
        </p>

        <label className="del-label" htmlFor="del-pw">Confirm your password</label>
        <input
          id="del-pw"
          type="password"
          className="del-input"
          value={password}
          autoComplete="current-password"
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy}
        />

        <label className="del-label" htmlFor="del-word">
          Type <strong>{CONFIRM_WORD}</strong> to confirm
        </label>
        <input
          id="del-word"
          type="text"
          className="del-input"
          value={confirmText}
          autoCapitalize="characters"
          autoCorrect="off"
          onChange={(e) => setConfirmText(e.target.value)}
          disabled={busy}
        />

        {error && <div className="del-error">{error}</div>}

        <div className="del-actions">
          <button type="button" className="del-btn" onClick={close} disabled={busy}>
            Keep my account
          </button>
          <button type="submit" className="del-btn del-btn--danger" disabled={!ready || busy}>
            {busy ? 'Deleting…' : 'Delete for ever'}
          </button>
        </div>
      </form>
    </div>
  );
}
