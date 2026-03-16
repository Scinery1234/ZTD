import React from 'react';
import { useAuth } from '../context/AuthContext';
import './Header.css';

const TIER_COLORS = {
  free: '#94a3b8',
  pro: '#667eea',
  premium: '#f093fb',
};

const Header = ({ onShowPricing }) => {
  const { user, subscription, logout } = useAuth();
  const tier = subscription?.tier || user?.tier || 'free';
  const atLimit = subscription?.at_limit;

  return (
    <header className="header">
      <div className="header-content">
        <h1 className="header-title">FocusFlow</h1>
        <p className="header-subtitle">Zen To Done Task Manager</p>

        {user && (
          <div className="header-user">
            <div className="user-info">
              <span className="user-name">Hi, {user.name}</span>
              <span
                className="tier-badge"
                style={{ background: TIER_COLORS[tier] }}
              >
                {tier.toUpperCase()}
              </span>
              {atLimit && (
                <button className="upgrade-nudge" onClick={onShowPricing}>
                  Task limit reached — Upgrade
                </button>
              )}
            </div>
            <div className="header-actions">
              <button className="header-btn" onClick={onShowPricing}>
                Plans
              </button>
              <button className="header-btn logout-btn" onClick={logout}>
                Sign Out
              </button>
            </div>
          </div>
        )}
      </div>
    </header>
  );
};

export default Header;
