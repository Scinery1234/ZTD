import React from 'react';
import { useAuth } from '../context/AuthContext';
import './Header.css';

const TIER_COLORS = {
  free:    'rgba(148, 163, 184, 0.8)',
  pro:     'linear-gradient(135deg, #667eea, #764ba2)',
  premium: 'linear-gradient(135deg, #f093fb, #f5576c)',
};

const Header = ({ onShowPricing }) => {
  const { user, subscription, logout } = useAuth();
  const tier = subscription?.tier || user?.tier || 'free';
  const atLimit = subscription?.at_limit;

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
