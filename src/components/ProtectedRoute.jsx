import React, { useEffect, useRef, useState } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '@/lib/AuthContext';
import { logAuditEvent } from '@/lib/auditLogger';
import { isRouteMapped } from '@/lib/permissions';
import { Shield, Lock, UserX, AlertCircle } from 'lucide-react';

export default function ProtectedRoute({
  children,
  requiredRole,
  requiredPermission,
  fallback,
}) {
  const { user, isAuthenticated, isLoadingAuth, authChecked, hasPermission, canAccessRoute, validateCurrentAccountStatus, logout, accountRestricted } = useAuth();
  const location = useLocation();

  // Real-time revocation state: set when the live account status is no longer
  // Active (Disabled/Locked) so the restricted banner renders immediately
  // instead of the login redirect.
  const [restrictedStatus, setRestrictedStatus] = useState(null);
  const revocationInFlight = useRef(false);

  // Check route-level permission
  const routeAllowed = requiredPermission ? hasPermission(requiredPermission) : canAccessRoute(location.pathname);
  
  // Check role requirement
  const roleAllowed = !requiredRole || (user && user.role === requiredRole);

  // Handle account status
  const isAccountDisabled = user?.is_active === false;
  const isAccountLocked = user?.is_locked === true;

  // Log unauthorized access attempts
  useEffect(() => {
    if (authChecked && isAuthenticated && (!routeAllowed || !roleAllowed)) {
      logAuditEvent('Unauthorized Route Access', {
        user_id: user?.id,
        username: user?.username,
        result: 'failed',
        detail: isRouteMapped(location.pathname)
          ? `No permission for route ${location.pathname}. Required: ${requiredPermission || 'route permission'}, Role: ${requiredRole || 'none'}`
          : `Unmapped route: ${location.pathname}`,
      });
    }
  }, [authChecked, isAuthenticated, routeAllowed, roleAllowed, location.pathname, requiredPermission, requiredRole, user]);

  // Real-time account status revocation: re-checks the live user record on every
  // route mount/navigation. If the account is no longer Active (Disabled, Locked,
  // or removed), revoke the session immediately and show the restricted banner —
  // no waiting for the 30s idle poll.
  useEffect(() => {
    if (!authChecked || !isAuthenticated || revocationInFlight.current) return;
    let cancelled = false;
    (async () => {
      const result = await validateCurrentAccountStatus();
      if (cancelled) return;
      if (result.valid) return;
      revocationInFlight.current = true;
      setRestrictedStatus(result.status);
      await logAuditEvent('Session Revoked', {
        user_id: user?.id,
        username: user?.username,
        result: 'failed',
        detail: result.status === 'property_restricted'
          ? 'Account is not authorised for all properties (launch policy). Session revoked in real-time.'
          : `Account status changed to "${result.status}". Session revoked in real-time.`,
      });
      await logout(false);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authChecked, isAuthenticated, location.pathname, user?.id, user?.username]);

  // Show loading state
  if (isLoadingAuth || !authChecked) {
    return fallback || (
      <div className="fixed inset-0 flex items-center justify-center bg-[#040D1A]">
        <div className="h-8 w-8 border-4 border-slate-700 border-t-[#6C63FF] rounded-full animate-spin"></div>
      </div>
    );
  }

  // Real-time account revocation detected — show the restricted banner immediately
  // (before the not-authenticated redirect, since the session has been cleared).
  // `accountRestricted` is set by AuthContext when a cross-tab SESSION_REVOKED is
  // received; `restrictedStatus` is set by the on-navigation re-validation below.
  const effectiveRestriction = restrictedStatus || accountRestricted;
  if (effectiveRestriction) {
    const isLocked = effectiveRestriction === 'locked';
    // A per-property account is not in trouble — this release simply cannot
    // serve it (see src/lib/launchPolicy.js). Saying "no longer active" would
    // send the user to an administrator to fix an account that is fine.
    const isPropertyRestricted = effectiveRestriction === 'property_restricted';
    const isWarning = isLocked || isPropertyRestricted;
    const Icon = isLocked ? Lock : UserX;
    const title = isLocked
      ? 'Account Locked'
      : isPropertyRestricted
        ? 'Single-Property Access Not Available'
        : effectiveRestriction === 'revoked' ? 'Account Restricted' : 'Account Disabled';
    const message = isLocked
      ? 'Your account has been locked. Please contact an administrator to unlock your account.'
      : isPropertyRestricted
        ? 'This account is limited to specific properties. This release supports accounts with access to all properties only — ask an owner to widen this account.'
        : 'Your account is no longer active. Please contact an administrator to regain access.';
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#040D1A] p-6">
        <div className={`w-full max-w-md rounded-2xl border p-6 text-center ${isWarning ? 'border-amber-500/30 bg-[#0F1F35]' : 'border-red-500/30 bg-[#0F1F35]'}`}>
          <div className={`mx-auto w-16 h-16 rounded-full flex items-center justify-center mb-4 ${isWarning ? 'bg-amber-500/20' : 'bg-red-500/20'}`}>
            <Icon className={`h-8 w-8 ${isWarning ? 'text-amber-400' : 'text-red-400'}`} />
          </div>
          <h1 className={`text-xl font-semibold ${isWarning ? 'text-amber-300' : 'text-red-300'}`}>{title}</h1>
          <p className="mt-2 text-sm text-slate-400">{message}</p>
        </div>
      </div>
    );
  }

  // Not authenticated - redirect to login
  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  // Account disabled
  if (isAccountDisabled) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#040D1A] p-6">
        <div className="w-full max-w-md rounded-2xl border border-red-500/30 bg-[#0F1F35] p-6 text-center">
          <div className="mx-auto w-16 h-16 rounded-full bg-red-500/20 flex items-center justify-center mb-4">
            <UserX className="h-8 w-8 text-red-400" />
          </div>
          <h1 className="text-xl font-semibold text-red-300">Account Disabled</h1>
          <p className="mt-2 text-sm text-slate-400">
            Your account has been disabled. Please contact an administrator to regain access.
          </p>
        </div>
      </div>
    );
  }

  // Account locked
  if (isAccountLocked) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#040D1A] p-6">
        <div className="w-full max-w-md rounded-2xl border border-amber-500/30 bg-[#0F1F35] p-6 text-center">
          <div className="mx-auto w-16 h-16 rounded-full bg-amber-500/20 flex items-center justify-center mb-4">
            <Lock className="h-8 w-8 text-amber-400" />
          </div>
          <h1 className="text-xl font-semibold text-amber-300">Account Locked</h1>
          <p className="mt-2 text-sm text-slate-400">
            Your account has been locked due to multiple failed login attempts.
            Please contact an administrator to unlock your account.
          </p>
        </div>
      </div>
    );
  }

  // Permission/role check failed
  if (!routeAllowed || !roleAllowed) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#040D1A] p-6">
        <div className="w-full max-w-md rounded-2xl border border-red-500/30 bg-[#0F1F35] p-6 text-center">
          <div className="mx-auto w-16 h-16 rounded-full bg-red-500/20 flex items-center justify-center mb-4">
            <Shield className="h-8 w-8 text-red-400" />
          </div>
          <h1 className="text-xl font-semibold text-red-300">Access Denied</h1>
          <p className="mt-2 text-sm text-slate-400">
            You don't have permission to access this page.
            {requiredPermission && <span className="block mt-1">Required permission: <code className="px-1 bg-slate-800 rounded">{requiredPermission}</code></span>}
            {requiredRole && <span className="block mt-1">Required role: <code className="px-1 bg-slate-800 rounded">{requiredRole}</code></span>}
          </p>
          <button
            onClick={() => window.history.back()}
            className="mt-4 inline-flex items-center gap-2 rounded-lg bg-[#6C63FF] px-4 py-2 text-sm font-medium text-white hover:bg-[#5A52E0]"
          >
            <AlertCircle className="h-4 w-4" /> Go back
          </button>
        </div>
      </div>
    );
  }

  return children || <Outlet />;
}