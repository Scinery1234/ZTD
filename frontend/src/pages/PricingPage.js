import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { api } from '../api';
import './PricingPage.css';

const TIER_ORDER = ['free', 'premium'];

function PricingPage({ onBack }) {
  const { user, subscription } = useAuth();
  const [tiers, setTiers] = useState({});
  const [loading, setLoading] = useState(true);
  const [checkoutLoading, setCheckoutLoading] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    api.getTiers()
      .then(setTiers)
      .catch(() => setError('Failed to load pricing. Please try again.'))
      .finally(() => setLoading(false));
  }, []);

  const handleUpgrade = async (tier) => {
    if (tier === 'free') return;
    setCheckoutLoading(tier);
    setError('');
    try {
      const { url } = await api.createCheckoutSession(tier);
      window.location.href = url;
    } catch (err) {
      if (err.status === 503) {
        setError('Payment processing is not yet configured. Please contact the administrator.');
      } else {
        setError(err.message || 'Failed to start checkout. Please try again.');
      }
    } finally {
      setCheckoutLoading('');
    }
  };

  const currentTier = subscription?.tier || user?.tier || 'free';

  if (loading) {
    return (
      <div className="pricing-page">
        <div className="pricing-loading">Loading pricing...</div>
      </div>
    );
  }

  return (
    <div className="pricing-page">
      <div className="pricing-header">
        <button className="pricing-back" onClick={onBack}>
          ← Back to Tasks
        </button>
        <h1>Choose Your Plan</h1>
        <p>Upgrade anytime. Cancel anytime.</p>
      </div>

      {error && <div className="pricing-error">{error}</div>}

      <div className="pricing-grid">
        {TIER_ORDER.map((tierKey) => {
          const tier = tiers[tierKey];
          if (!tier) return null;
          const isCurrent = currentTier === tierKey;
          const isPopular = tierKey === 'premium';

          return (
            <div key={tierKey} className={`pricing-card ${isPopular ? 'popular' : ''} ${isCurrent ? 'current' : ''}`}>
              {isPopular && <div className="popular-badge">Most Popular</div>}
              {isCurrent && <div className="current-badge">Your Plan</div>}

              <div className="tier-name">{tier.name}</div>
              <div className="tier-price">
                {tier.price === 0 ? (
                  <span className="price-amount">Free</span>
                ) : (
                  <>
                    <span className="price-currency">$</span>
                    <span className="price-amount">{tier.price}</span>
                    <span className="price-period">/mo</span>
                  </>
                )}
              </div>

              <ul className="tier-features">
                {(tier.features || []).map((feature, i) => (
                  <li key={i}>
                    <span className="feature-check">✓</span> {feature}
                  </li>
                ))}
              </ul>

              <button
                className={`tier-btn ${tierKey} ${isCurrent ? 'current-btn' : ''}`}
                onClick={() => handleUpgrade(tierKey)}
                disabled={isCurrent || tierKey === 'free' || checkoutLoading === tierKey}
              >
                {checkoutLoading === tierKey
                  ? 'Redirecting...'
                  : isCurrent
                  ? 'Current Plan'
                  : tierKey === 'free'
                  ? 'Free Forever'
                  : `Upgrade to ${tier.name}`}
              </button>
            </div>
          );
        })}
      </div>

      <div className="pricing-footer">
        <p>All plans include a 14-day money-back guarantee. Payments processed securely by Stripe.</p>
        {currentTier !== 'free' && subscription?.has_subscription && (
          <p className="manage-sub">
            To manage or cancel your subscription, visit your{' '}
            <a
              href="https://billing.stripe.com/p/login/test_placeholder"
              target="_blank"
              rel="noopener noreferrer"
            >
              billing portal
            </a>
            .
          </p>
        )}
      </div>
    </div>
  );
}

export default PricingPage;
