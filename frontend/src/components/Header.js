import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../hooks/useTheme';
import { api } from '../api';
import './Header.css';

const TIER_COLORS = {
  free:    'rgba(148, 163, 184, 0.8)',
  pro:     'linear-gradient(135deg, #f97316, #d97706)',
  premium: 'linear-gradient(135deg, #fbbf24, #f97316)',
};

const Header = ({ onShowPricing, onTogglePomodoro, pomodoroOpen, onShowAnalytics, analyticsActive }) => {
  const { user, subscription, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const tier = subscription?.tier || user?.tier || 'free';
  const atLimit = subscription?.at_limit;
  const [exportOpen, setExportOpen] = useState(false);

  const canExport = tier === 'pro' || tier === 'premium';

  const handleExport = async (format) => {
    setExportOpen(false);
    try {
      await api.exportData(format);
    } catch (err) {
      alert(err.message || 'Export failed. Please try again.');
    }
  };

  return (
    <header className="header">
      <div className="header-content">
        <div className="header-brand">
          <h1 className="header-title">madeHappen</h1>
          <p className="header-subtitle">make it happen</p>
        </div>

        {user && (
          <div className="header-user">
            <div className="user-info">
              <span className="user-name">{user.name}</span>
              <span
                className="tier-badge"
                style={{ background: TIER_COLORS[tier] }}
              >
                {tier}
              </span>
              {atLimit && (
                <button className="upgrade-nudge" onClick={onShowPricing}>
                  Upgrade for more tasks
                </button>
              )}
            </div>
            <div className="header-actions">
              <button
                className="header-btn theme-toggle-btn"
                onClick={toggleTheme}
                title={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
                aria-label="Toggle theme"
              >
                {theme === 'light' ? '🌙' : '☀️'}
              </button>
              {onShowAnalytics && (tier === 'premium') && (
                <button
                  className={`header-btn analytics-toggle-btn${analyticsActive ? ' active' : ''}`}
                  onClick={onShowAnalytics}
                  title="Analytics"
                >
                  📊
                </button>
              )}
              {onTogglePomodoro && (
                <button
                  className={`header-btn pomodoro-toggle-btn${pomodoroOpen ? ' active' : ''}`}
                  onClick={onTogglePomodoro}
                  title="Pomodoro timer"
                >
                  🍅
                </button>
              )}
              {canExport && (
                <div className="export-dropdown">
                  <button
                    className="header-btn"
                    onClick={() => setExportOpen(o => !o)}
                    title="Export tasks"
                  >
                    Export
                  </button>
                  {exportOpen && (
                    <>
                      <div className="export-backdrop" onClick={() => setExportOpen(false)} />
                      <div className="export-menu">
                        <button onClick={() => handleExport('csv')}>CSV</button>
                        <button onClick={() => handleExport('json')}>JSON</button>
                      </div>
                    </>
                  )}
                </div>
              )}
              <button className="header-btn" onClick={onShowPricing}>
                Plans
              </button>
              <button className="header-btn logout-btn" onClick={logout}>
                Sign out
              </button>
            </div>
          </div>
        )}
      </div>
    </header>
  );
};

export default Header;
