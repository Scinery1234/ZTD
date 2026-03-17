import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { api } from '../api';
import './Header.css';

const TIER_COLORS = {
  free:    'rgba(148, 163, 184, 0.8)',
  premium: 'linear-gradient(135deg, #f093fb, #f5576c)',
};

const Header = ({ onShowPricing, isPremium, currentHatId }) => {
  const { user, subscription, logout } = useAuth();
  const tier = subscription?.tier || user?.tier || 'free';
  const atLimit = subscription?.at_limit;
  const [exporting, setExporting] = useState(false);

  const handleExport = async (format) => {
    setExporting(true);
    try {
      const blob = await api.exportTasks(format, currentHatId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ztd_tasks.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert('Export failed: ' + err.message);
    } finally {
      setExporting(false);
    }
  };

  return (
    <header className="header">
      <div className="header-content">
        <div className="header-brand">
          <h1 className="header-title">FocusFlow</h1>
          <p className="header-subtitle">Zen To Done</p>
        </div>

        {user && (
          <div className="header-user">
            <div className="user-info">
              <span className="user-name">{user.name}</span>
              <span
                className="tier-badge"
                style={{ background: TIER_COLORS[tier] || TIER_COLORS.free }}
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
              {isPremium && (
                <div className="export-menu">
                  <button className="header-btn" disabled={exporting} onClick={() => handleExport('json')}>
                    {exporting ? 'Exporting…' : 'Export JSON'}
                  </button>
                  <button className="header-btn" disabled={exporting} onClick={() => handleExport('csv')}>
                    {exporting ? '…' : 'Export CSV'}
                  </button>
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
