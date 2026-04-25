import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { api } from '../api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [subscription, setSubscription] = useState(null);
  const [loading, setLoading] = useState(true);

  const loadSubscription = useCallback(async () => {
    try {
      const sub = await api.getSubscription();
      setSubscription(sub);
    } catch {
      // Non-fatal
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
        try {
          await loadSubscription();
        } catch {
          setSubscription(null);
        }
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

  const login = async (email, password) => {
    const { token, user: u } = await api.login(email, password);
    localStorage.setItem('ztd_token', token);
    setUser(u);
    // Never block sign-in if subscription/Stripe call fails
    try {
      await loadSubscription();
    } catch {
      setSubscription(null);
    }
    return u;
  };

  const register = async (name, email, password) => {
    const { token, user: u } = await api.register(name, email, password);
    localStorage.setItem('ztd_token', token);
    setUser(u);
    try {
      await loadSubscription();
    } catch {
      setSubscription(null);
    }
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
