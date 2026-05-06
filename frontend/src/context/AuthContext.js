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
    const token = localStorage.getItem('ztd_token') || sessionStorage.getItem('ztd_token');
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
        sessionStorage.removeItem('ztd_token');
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

  const login = async (email, password, remember = true) => {
    const res = await api.login(email, password);
    const token = res?.token || res?.access_token;
    const u = res?.user;
    if (!token) {
      throw new Error('Login succeeded but no token was returned.');
    }
    if (remember) {
      localStorage.setItem('ztd_token', token);
      sessionStorage.removeItem('ztd_token');
    } else {
      sessionStorage.setItem('ztd_token', token);
      localStorage.removeItem('ztd_token');
    }
    const resolvedUser = u || (await api.me());
    if (!resolvedUser) {
      throw new Error('Login succeeded but account data could not be loaded.');
    }
    setUser(resolvedUser);
    void loadSubscription();
    return resolvedUser;
  };

  const register = async (name, email, password) => {
    const res = await api.register(name, email, password);
    const token = res?.token || res?.access_token;
    const u = res?.user;
    if (!token) {
      const keys = res && typeof res === 'object' ? Object.keys(res).join(', ') : typeof res;
      throw new Error(
        `Registration response missing token. Received keys: [${keys || 'none'}]. ` +
        'This usually indicates the frontend hit the wrong endpoint/service (HTML or non-auth JSON) ' +
        'instead of the API /auth/register route.'
      );
    }
    localStorage.setItem('ztd_token', token);
    const resolvedUser = u || (await api.me());
    if (!resolvedUser) {
      throw new Error('Account was created but profile loading failed.');
    }
    setUser(resolvedUser);
    void loadSubscription();
    return resolvedUser;
  };

  const logout = () => {
    localStorage.removeItem('ztd_token');
    sessionStorage.removeItem('ztd_token');
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
