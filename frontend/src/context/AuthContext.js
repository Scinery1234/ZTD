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
      return;
    }
    api.me()
      .then((u) => {
        setUser(u);
        return loadSubscription();
      })
      .catch(() => {
        localStorage.removeItem('ztd_token');
      })
      .finally(() => setLoading(false));
  }, [loadSubscription]);

  const login = async (email, password) => {
    const { token, user: u } = await api.login(email, password);
    localStorage.setItem('ztd_token', token);
    setUser(u);
    await loadSubscription();
    return u;
  };

  const register = async (name, email, password) => {
    const { token, user: u } = await api.register(name, email, password);
    localStorage.setItem('ztd_token', token);
    setUser(u);
    await loadSubscription();
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
