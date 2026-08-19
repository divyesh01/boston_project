// @refresh reset
import React, { createContext, useState, useContext, useEffect, useCallback, useRef } from 'react';
import { db } from '@/api/base44Client';
import { canUser, canAccessRoute as checkRouteAccess } from '@/lib/permissions';
import { subscribeSessionRevoked } from '@/lib/sessionChannel';
import { logAuditEvent } from '@/lib/auditLogger';
import { hasAllPropertyAccess } from '@/lib/launchPolicy';

const AuthContext = /** @type {import('react').Context<any>} */ (createContext(null));

const IDLE_CHECK_MS = 30 * 1000;
const INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000;

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoadingAuth, setIsLoadingAuth] = useState(true);
  const [isLoadingPublicSettings, setIsLoadingPublicSettings] = useState(false);
  const [authError, setAuthError] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [appPublicSettings, setAppPublicSettings] = useState({ id: 'local', public_settings: {} });
  const [accountRestricted, setAccountRestricted] = useState(null);

  const authenticatedRef = useRef(false);
  const crossTabRevokingRef = useRef(false);
  const activityEvents = useRef(0);
  const lastActivityTime = useRef(Date.now());



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
      console.error('[AuthProvider] refreshUser error:', e);
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
    lastActivityTime.current = Date.now();
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
      // Idle timeout enforcement
      if (authenticatedRef.current && Date.now() - lastActivityTime.current > INACTIVITY_TIMEOUT_MS) {
        db.auth.logout().catch(() => {});
        authenticatedRef.current = false;
        setUser(null);
        setIsAuthenticated(false);
        const target = window.location.pathname + window.location.search;
        const delim = target.includes('?') ? '&' : '?';
        navigateToLoginRef.current(target + delim + 'timeout=1');
        return;
      }

      // Calls a read-only endpoint (custom_auth_check) that DOES NOT slide the session expiry.
      // This ensures unattended open tabs eventually log out, while still catching revocations.
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

  const login = useCallback(async (identifier, password, remember = false, totpToken = null) => {
    setIsLoadingAuth(true);
    setAuthError(null);
    try {
      const result = await db.auth.login(identifier, password, remember, totpToken);
      if (result.user) {
        setUser(result.user);
        setIsAuthenticated(true);
      }
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
    // Delegates to the catch-all default-deny check in permissions.js: unmapped
    // routes are denied unless they are public or explicitly mapped.
    return checkRouteAccess(path, user?.permissions);
  }, [user]);

  const canAccessProperty = useCallback((propertyId) => {
    if (!user) return false;
    if (user.role === 'owner' || user.role === 'admin') return true;
    if (user.property_access === 'all') return true;
    if (Array.isArray(user.property_access) && user.property_access.includes(propertyId)) return true;
    return false;
  }, [user]);

  const validateCurrentAccountStatus = useCallback(async () => {
    // If we already know the user was disabled locally, return valid so
    // ProtectedRoute can show its dedicated Red Disabled Screen without
    // preempting it with the generic 'revoked' banner.
    if (user?.is_active === false) return { valid: true };

    try {
      const me = await db.auth.me();
      if (!me) return { valid: false, status: 'revoked' };
      if (me.is_active === false) return { valid: false, status: 'disabled' };
      if (me.is_locked === true) return { valid: false, status: 'locked' };
      // Launch policy (src/lib/launchPolicy.js): this release admits only
      // accounts entitled to every property. Re-checked here, not just at login,
      // so narrowing someone's property_access takes effect on their next
      // navigation instead of waiting for their week-long session to expire.
      if (!hasAllPropertyAccess(me)) return { valid: false, status: 'property_restricted' };
      return { valid: true, user: me };
    } catch (e) {
      console.error('[AuthProvider] validateCurrentAccountStatus error:', e);
      return { valid: false, status: 'revoked' };
    }
  }, []);

  // Cross-tab revocation: an admin disabling/locking this user (or a logout) in
  // another tab/window broadcasts over BroadcastChannel (with a localStorage
  // `storage`-event fallback). Any open tab of this user revokes instantly —
  // no route navigation and no 30s idle-poll wait.
  const handleCrossTabRevocation = useCallback(async (message) => {
    if (crossTabRevokingRef.current) return;
    crossTabRevokingRef.current = true;
    try {
      const session = await db.auth.getCurrentSession();
      const selfId = user?.id ?? session?.userId;
      // If the session is already gone (e.g. a re-broadcast echo of our own
      // logout), ignore the message to stay idempotent.
      if (!selfId) return;
      const targetsSelf =
        message.type === 'SESSION_REVOKED_ALL' ||
        String(message.targetUserId) === String(selfId);
      if (!targetsSelf) return;
      await logAuditEvent('Cross-Tab Session Revoked', {
        user_id: selfId,
        username: user?.username || 'unknown',
        result: 'failed',
        detail: message.reason || 'Session revoked from another tab',
      });
      await db.auth.logout().catch(() => {});
      setIsAuthenticated(false);
      authenticatedRef.current = false;
      if (message.status === 'logged_out') {
        setUser(null);
        setAccountRestricted(null);
        navigateToLoginRef.current(window.location.pathname + window.location.search);
      } else {
        // Account was disabled/locked -> show the restricted banner immediately.
        if (message.status === 'disabled') {
          // Keep the user object but mark it inactive so the dedicated
          // 'Account Disabled' screen in ProtectedRoute is triggered.
          setUser((prev) => (prev ? { ...prev, is_active: false } : null));
          setAccountRestricted(null);
        } else {
          setUser(null);
          setAccountRestricted(message.status === 'locked' ? message.status : 'revoked');
        }
      }
    } finally {
      crossTabRevokingRef.current = false;
    }
  }, [user]);

  useEffect(() => {
    return subscribeSessionRevoked((message) => {
      handleCrossTabRevocation(message);
    });
  }, [handleCrossTabRevocation]);



  return (
    <AuthContext.Provider value={{
      user,
      isAuthenticated,
      isLoadingAuth,
      isLoadingPublicSettings,
      authError,
      appPublicSettings,
      authChecked,
      accountRestricted,
      login,
      logout,
      navigateToLogin,
      checkUserAuth,
      checkAppState,
      refreshUser,
      validateCurrentAccountStatus,
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
