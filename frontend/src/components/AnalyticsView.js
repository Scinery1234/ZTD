import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { api } from '../api';
import './AnalyticsView.css';

const PRIORITY_LABELS = { urgent: 'Urgent', today: 'Today', tomorrow: 'Tomorrow', later: 'Later', '': 'None' };
const PRIORITY_COLORS = { urgent: '#f87171', today: '#fbbf24', tomorrow: '#60a5fa', later: '#94a3b8', '': '#64748b' };

function BarRows({ entries, maxVal, colors }) {
  return (
    <div className="av-bars">
      {entries.map(([label, count]) => (
        <div key={label} className="av-bar-row">
          <div className="av-bar-label">{label || 'None'}</div>
          <div className="av-bar-track">
            <div
              className="av-bar-fill"
              style={{
                width: `${maxVal > 0 ? (count / maxVal) * 100 : 0}%`,
                background: colors?.[label],
              }}
            />
          </div>
          <div className="av-bar-count">{count}</div>
        </div>
      ))}
    </div>
  );
}

export default function AnalyticsView({ onShowPricing }) {
  const { subscription, user } = useAuth();
  const tier = subscription?.tier || user?.tier || 'free';
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');

  useEffect(() => {
    if (tier !== 'premium') { setLoading(false); return; }
    api.getAnalytics()
      .then(d  => { setData(d); setLoading(false); })
      .catch(e => { setError(e.message || 'Failed to load analytics'); setLoading(false); });
  }, [tier]);

  if (tier !== 'premium') {
    return (
      <div className="av-upgrade">
        <div className="av-upgrade-icon">📊</div>
        <h2 className="av-upgrade-title">Advanced Analytics</h2>
        <p className="av-upgrade-body">
          Unlock deep productivity insights — completion trends, category and priority breakdowns,
          streak tracking, and more.
        </p>
        <button className="av-upgrade-btn" onClick={onShowPricing}>Upgrade to Premium</button>
      </div>
    );
  }

  if (loading) return <div className="av-loading">Loading analytics…</div>;
  if (error)   return <div className="av-error">{error}</div>;
  if (!data)   return null;

  const dayMax = Math.max(...(data.completed_by_day || []).map(d => d.count), 1);

  const catEntries = Object.entries(data.completed_by_category || {}).sort((a, b) => b[1] - a[1]);
  const catMax = Math.max(...catEntries.map(e => e[1]), 1);

  const priRaw = Object.entries(data.completed_by_priority || {}).sort((a, b) => b[1] - a[1]);
  const priEntries = priRaw.map(([k, v]) => [PRIORITY_LABELS[k] ?? k, v]);
  const priMax = Math.max(...priEntries.map(e => e[1]), 1);
  const priColors = Object.fromEntries(
    priRaw.map(([k]) => [PRIORITY_LABELS[k] ?? k, PRIORITY_COLORS[k]])
  );

  return (
    <div className="av-view">
      {/* Summary cards */}
      <div className="av-cards">
        <div className="av-card">
          <div className="av-card-value">{data.total_completed}</div>
          <div className="av-card-label">All-Time Completed</div>
        </div>
        <div className="av-card">
          <div className="av-card-value">{data.completed_last_30}</div>
          <div className="av-card-label">Last 30 Days</div>
        </div>
        <div className="av-card av-card--streak">
          <div className="av-card-value">🔥 {data.streak}</div>
          <div className="av-card-label">Day Streak</div>
        </div>
        <div className="av-card">
          <div className="av-card-value">{Number(data.avg_per_day).toFixed(1)}</div>
          <div className="av-card-label">Avg / Day</div>
        </div>
        {data.overdue_count > 0 && (
          <div className="av-card av-card--warn">
            <div className="av-card-value">{data.overdue_count}</div>
            <div className="av-card-label">Overdue</div>
          </div>
        )}
      </div>

      {/* Daily sparkline */}
      {(data.completed_by_day || []).length > 0 && (
        <div className="av-section">
          <h3 className="av-section-title">Completions — Last 30 Days</h3>
          <div className="av-day-chart">
            {data.completed_by_day.map((d, i) => (
              <div key={i} className="av-day-col" title={`${d.date}: ${d.count} completed`}>
                <div
                  className="av-day-bar"
                  style={{ height: `${dayMax > 0 ? (d.count / dayMax) * 100 : 0}%` }}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Category breakdown */}
      {catEntries.length > 0 && (
        <div className="av-section">
          <h3 className="av-section-title">By Category</h3>
          <BarRows entries={catEntries} maxVal={catMax} />
        </div>
      )}

      {/* Priority breakdown */}
      {priEntries.length > 0 && (
        <div className="av-section">
          <h3 className="av-section-title">By Priority</h3>
          <BarRows entries={priEntries} maxVal={priMax} colors={priColors} />
        </div>
      )}
    </div>
  );
}
