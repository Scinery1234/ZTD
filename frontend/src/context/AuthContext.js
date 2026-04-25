import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { api } from '../api';

const AuthContext = createContext(null);

const SUBSCRIPTION_FETCH_MS = 8000;

/** Stripe/slow network must not block login, register, or first paint. */
function loadSubscriptionRaced() {
  return Promise.race([
    api.getSubscription(),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('subscription timeout')), SUBSCRIPTION_FETCH_MS);
    }),
  ]);
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [subscription, setSubscription] = useState(null);
  const [loading, setLoading] = useState(true);

  const loadSubscription = useCallback(async () => {
    try {
      const sub = await loadSubscriptionRaced();
      setSubscription(sub);
    } catch {
      setSubscription(null);
    }
  }, []);

  useEffect(() => {
    const token = localStorage.getItem('ztd_token');
    if (!token) {
      setLoading(false);
      return undefined;
    }
    let done = false; // set true on timeout, unmount, or after session load finishes
    const t = window.setTimeout(() => {
      if (done) return;
      done = true;
      localStorage.removeItem('ztd_token');
      setUser(null);
      setSubscription(null);
      setLoading(false);
    }, 20000);

    (async () => {
      try {
        const u = await api.me();
        if (done) return;
        window.clearTimeout(t);
        setUser(u);
        // Never await — can hang on Stripe; race inside loadSubscription caps wait time
        void loadSubscription();
      } catch {
        if (done) return;
        window.clearTimeout(t);
        localStorage.removeItem('ztd_token');
      } finally {
        if (!done) {
          done = true;
          window.clearTimeout(t);
          setLoading(false);
        }
      }
    })();

    return () => {
      done = true;
      window.clearTimeout(t);
    };
  }, [loadSubscription]);

  // Handle token expiry mid-session
  useEffect(() => {
    const handleExpiry = () => {
      setUser(null);
      setSubscription(null);
    };
    window.addEventListener('ztd-session-expired', handleExpiry);
    return () => window.removeEventListener('ztd-session-expired', handleExpiry);
  }, []);

  // Clear #register / #login from the URL after successful sign-in
  useEffect(() => {
    if (user && window.location.hash) {
      window.location.hash = '';
    }
  }, [user]);

  const login = async (email, password) => {
    const { token, user: u } = await api.login(email, password);
    localStorage.setItem('ztd_token', token);
    setUser(u);
    void loadSubscription();
    return u;
  };

  const register = async (name, email, password) => {
    const { token, user: u } = await api.register(name, email, password);
    localStorage.setItem('ztd_token', token);
    setUser(u);
    void loadSubscription();
    return u;
  };

  const logout = () => {
    localStorage.removeItem('ztd_token');
    setUser(null);
    setSubscription(null);
  };

  const refreshSubscription = () => loadSubscription();

  return (
    <AuthContext.Provider value={{ user, subscription, loading, login, register, logout, refreshSubscription }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
