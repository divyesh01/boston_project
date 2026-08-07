import React, { createContext, useState, useContext, useEffect, useCallback, useRef } from 'react';
import db from '@/api/base44Client';
import { canUser, ROUTE_PERMISSIONS } from '@/lib/permissions';

const AuthContext = createContext();

const IDLE_CHECK_MS = 30 * 1000;

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoadingAuth, setIsLoadingAuth] = useState(true);
  const [isLoadingPublicSettings, setIsLoadingPublicSettings] = useState(false);
  const [authError, setAuthError] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [appPublicSettings, setAppPublicSettings] = useState({ id: 'local', public_settings: {} });
  const activityEvents = useRef(0);
  const authenticatedRef = useRef(false);

  const refreshUser = useCallback(async () => {
    try {
      const ok = await db.auth.isAuthenticated();
      if (!ok) {
        setUser(null);
        setIsAuthenticated(false);
        authenticatedRef.current = false;
        setAuthChecked(true);
        setIsLoadingAuth(false);
        return false;
      }
      const me = await db.auth.me();
      setUser(me);
      setIsAuthenticated(true);
      authenticatedRef.current = true;
      setAuthChecked(true);
      setIsLoadingAuth(false);
      return true;
    } catch (e) {
      console.error('[auth] refreshUser error:', e);
      setUser(null);
      setIsAuthenticated(false);
      authenticatedRef.current = false;
      setAuthChecked(true);
      setIsLoadingAuth(false);
      return false;
    }
  }, []);

  const checkUserAuth = useCallback(async () => {
    setIsLoadingAuth(true);
    await refreshUser();
  }, [refreshUser]);

  const checkAppState = useCallback(async () => {
    setIsLoadingAuth(true);
    setIsLoadingPublicSettings(false);
    await refreshUser();
  }, [refreshUser]);

  const handleActivity = useCallback(() => {
    activityEvents.current += 1;
    if (activityEvents.current % 2 === 0) return;
    if (isAuthenticated) {
      db.auth.touchSession().catch(() => {});
    }
  }, [isAuthenticated]);

  useEffect(() => {
    const events = ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'];
    events.forEach((ev) => window.addEventListener(ev, handleActivity, { passive: true }));
    return () => events.forEach((ev) => window.removeEventListener(ev, handleActivity));
  }, [handleActivity]);

  // Initial auth check + idle polling
  useEffect(() => {
    checkUserAuth();
    const interval = setInterval(async () => {
      const ok = await db.auth.isAuthenticated();
      if (!ok && authenticatedRef.current) {
        authenticatedRef.current = false;
        setUser(null);
        setIsAuthenticated(false);
        navigateToLoginRef.current(window.location.pathname + window.location.search);
      }
    }, IDLE_CHECK_MS);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const navigateToLogin = useCallback((returnUrl) => {
    const target = returnUrl || window.location.pathname + window.location.search;
    const encoded = encodeURIComponent(target && target !== "/" ? target : "/");
    window.location.href = `/login?returnTo=${encoded}`;
  }, []);

  const navigateToLoginRef = useRef(navigateToLogin);
  useEffect(() => { navigateToLoginRef.current = navigateToLogin; }, [navigateToLogin]);

  const login = useCallback(async (identifier, password, remember = false) => {
    setIsLoadingAuth(true);
    setAuthError(null);
    try {
      const result = await db.auth.login(identifier, password, remember);
      setUser(result.user);
      setIsAuthenticated(true);
      setAuthChecked(true);
      setIsLoadingAuth(false);
      return result;
    } catch (e) {
      setAuthError({ type: 'login_failed', message: e.message });
      setIsLoadingAuth(false);
      throw e;
    }
  }, []);

  const logout = useCallback(async (shouldRedirect = true) => {
    const me = user || (await db.auth.me().catch(() => null));
    await db.auth.logout().catch(() => {});
    setUser(null);
    setIsAuthenticated(false);
    if (shouldRedirect) {
      const returnTo = window.location.pathname === '/login' ? '/' : window.location.pathname + window.location.search;
      const loginUrl = returnTo && returnTo !== '/' ? `/login?returnTo=${encodeURIComponent(returnTo)}` : '/login';
      window.location.href = loginUrl;
    }
  }, [user]);

  const hasPermission = useCallback((permission) => {
    return canUser(user?.permissions, permission);
  }, [user]);

  const canAccessRoute = useCallback((path) => {
    const required = ROUTE_PERMISSIONS[path];
    if (!required) return true;
    return canUser(user?.permissions, required);
  }, [user]);

  const canAccessProperty = useCallback((propertyId) => {
    if (!user) return false;
    if (user.role === 'owner' || user.role === 'admin') return true;
    if (!user.property_access || user.property_access === 'all') return true;
    if (Array.isArray(user.property_access) && user.property_access.includes(propertyId)) return true;
    return false;
  }, [user]);

  return (
    <AuthContext.Provider value={{
      user,
      isAuthenticated,
      isLoadingAuth,
      isLoadingPublicSettings,
      authError,
      appPublicSettings,
      authChecked,
      login,
      logout,
      navigateToLogin,
      checkUserAuth,
      checkAppState,
      refreshUser,
      hasPermission,
      canAccessRoute,
      canAccessProperty,
    }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
