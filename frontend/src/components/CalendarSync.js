import React, { useState, useEffect } from 'react';
import { api } from '../api';
import './CalendarSync.css';

const PROVIDERS = [
  { id: 'google',    label: 'Google Calendar',    icon: '🗓️' },
  { id: 'microsoft', label: 'Microsoft Outlook',  icon: '📧' },
];

export default function CalendarSync({ onClose, onSyncComplete }) {
  const [connections, setConnections] = useState([]);
  const [loadingConns, setLoadingConns] = useState(true);
  const [connecting, setConnecting] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState(null);
  const [disconnecting, setDisconnecting] = useState(null);

  useEffect(() => {
    api.calendarConnections()
      .then(setConnections)
      .catch(() => {})
      .finally(() => setLoadingConns(false));
  }, []);

  const isConnected = (id) => connections.some(c => c.provider === id);

  const connect = async (provider) => {
    setConnecting(provider);
    try {
      const { url } = await api.calendarAuth(provider);
      window.location.href = url;
    } catch (err) {
      alert(err.message || 'Connection failed. Please try again.');
      setConnecting(null);
    }
  };

  const disconnect = async (provider) => {
    const name = provider === 'google' ? 'Google Calendar' : 'Microsoft Outlook';
    if (!window.confirm(`Disconnect ${name}?\n\nCalendar event links will be removed from your tasks, but existing events in ${name} will NOT be deleted.`)) return;
    setDisconnecting(provider);
    try {
      await api.calendarDisconnect(provider);
      setConnections(prev => prev.filter(c => c.provider !== provider));
    } catch (err) {
      alert(err.message || 'Failed to disconnect');
    } finally {
      setDisconnecting(null);
    }
  };

  const syncNow = async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const result = await api.calendarPush(timezone);
      setSyncResult({ pushed: result.pushed, errCount: result.errors?.length || 0 });
      if (onSyncComplete) onSyncComplete(result.tasks || []);
    } catch (err) {
      setSyncResult({ error: err.message || 'Sync failed' });
    } finally {
      setSyncing(false);
    }
  };

  const hasConnections = connections.length > 0;

  return (
    <div className="cal-sync-backdrop" onClick={onClose}>
      <div className="cal-sync-panel" onClick={e => e.stopPropagation()}>
        <div className="cal-sync-header">
          <div className="cal-sync-title-row">
            <span className="cal-sync-icon">📅</span>
            <h3 className="cal-sync-title">Calendar Sync</h3>
            <span className="cal-sync-badge">Premium</span>
          </div>
          <button className="cal-sync-close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <p className="cal-sync-desc">
          Push your scheduled tasks to your calendar as busy blocks. Others will see when you're unavailable — without seeing task details.
        </p>

        <div className="cal-sync-section-label">Connected calendars</div>

        {loadingConns ? (
          <div className="cal-sync-loading">Loading…</div>
        ) : (
          <div className="cal-sync-providers">
            {PROVIDERS.map(p => (
              <div key={p.id} className={`cal-sync-provider-row${isConnected(p.id) ? ' connected' : ''}`}>
                <span className="cal-sync-provider-icon">{p.icon}</span>
                <span className="cal-sync-provider-name">{p.label}</span>
                <div className="cal-sync-provider-status">
                  {isConnected(p.id) ? (
                    <>
                      <span className="cal-sync-status-dot" />
                      <span className="cal-sync-status-text">Connected</span>
                      <button
                        className="cal-sync-btn cal-sync-btn--disconnect"
                        onClick={() => disconnect(p.id)}
                        disabled={disconnecting === p.id}
                      >
                        {disconnecting === p.id ? 'Removing…' : 'Disconnect'}
                      </button>
                    </>
                  ) : (
                    <button
                      className="cal-sync-btn cal-sync-btn--connect"
                      onClick={() => connect(p.id)}
                      disabled={!!connecting}
                    >
                      {connecting === p.id ? 'Redirecting…' : 'Connect'}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {hasConnections && (
          <div className="cal-sync-push-section">
            <button
              className="cal-sync-push-btn"
              onClick={syncNow}
              disabled={syncing}
            >
              {syncing ? 'Syncing…' : 'Sync all scheduled tasks now'}
            </button>
            {syncResult && (
              <p className={`cal-sync-result${syncResult.error ? ' cal-sync-result--error' : ''}`}>
                {syncResult.error
                  ? `Error: ${syncResult.error}`
                  : `Synced ${syncResult.pushed} task${syncResult.pushed !== 1 ? 's' : ''}${syncResult.errCount > 0 ? ` (${syncResult.errCount} failed)` : ' ✓'}`}
              </p>
            )}
          </div>
        )}

        <p className="cal-sync-note">
          Only tasks with a scheduled date and time are synced. All-day events are excluded.
          Your timezone ({Intl.DateTimeFormat().resolvedOptions().timeZone}) is used automatically.
        </p>
      </div>
    </div>
  );
}
