import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React, { useEffect, useRef, useState } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '@/lib/AuthContext';
import { logAuditEvent } from '@/lib/auditLogger';
import { isRouteMapped } from '@/lib/permissions';
import { Shield, Lock, UserX, AlertCircle } from 'lucide-react';
export default function ProtectedRoute({ children, requiredRole, requiredPermission, fallback, }) {
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
        if (!authChecked || !isAuthenticated || revocationInFlight.current)
            return;
        let cancelled = false;
        (async () => {
            const result = await validateCurrentAccountStatus();
            if (cancelled)
                return;
            if (result.valid)
                return;
            revocationInFlight.current = true;
            setRestrictedStatus(result.status);
            await logAuditEvent('Session Revoked', {
                user_id: user?.id,
                username: user?.username,
                result: 'failed',
                detail: `Account status changed to "${result.status}". Session revoked in real-time.`,
            });
            await logout(false);
        })();
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [authChecked, isAuthenticated, location.pathname, user?.id, user?.username]);
    // Show loading state
    if (isLoadingAuth || !authChecked) {
        return fallback || (_jsx("div", { className: "fixed inset-0 flex items-center justify-center bg-[#040D1A]", children: _jsx("div", { className: "h-8 w-8 border-4 border-slate-700 border-t-[#6C63FF] rounded-full animate-spin" }) }));
    }
    // Real-time account revocation detected — show the restricted banner immediately
    // (before the not-authenticated redirect, since the session has been cleared).
    // `accountRestricted` is set by AuthContext when a cross-tab SESSION_REVOKED is
    // received; `restrictedStatus` is set by the on-navigation re-validation below.
    const effectiveRestriction = restrictedStatus || accountRestricted;
    if (effectiveRestriction) {
        const isLocked = effectiveRestriction === 'locked';
        const Icon = isLocked ? Lock : UserX;
        const title = isLocked ? 'Account Locked' : effectiveRestriction === 'revoked' ? 'Account Restricted' : 'Account Disabled';
        const message = isLocked
            ? 'Your account has been locked. Please contact an administrator to unlock your account.'
            : 'Your account is no longer active. Please contact an administrator to regain access.';
        return (_jsx("div", { className: "min-h-screen flex items-center justify-center bg-[#040D1A] p-6", children: _jsxs("div", { className: `w-full max-w-md rounded-2xl border p-6 text-center ${isLocked ? 'border-amber-500/30 bg-[#0F1F35]' : 'border-red-500/30 bg-[#0F1F35]'}`, children: [_jsx("div", { className: `mx-auto w-16 h-16 rounded-full flex items-center justify-center mb-4 ${isLocked ? 'bg-amber-500/20' : 'bg-red-500/20'}`, children: _jsx(Icon, { className: `h-8 w-8 ${isLocked ? 'text-amber-400' : 'text-red-400'}` }) }), _jsx("h1", { className: `text-xl font-semibold ${isLocked ? 'text-amber-300' : 'text-red-300'}`, children: title }), _jsx("p", { className: "mt-2 text-sm text-slate-400", children: message })] }) }));
    }
    // Not authenticated - redirect to login
    if (!isAuthenticated) {
        return _jsx(Navigate, { to: "/login", replace: true, state: { from: location } });
    }
    // Account disabled
    if (isAccountDisabled) {
        return (_jsx("div", { className: "min-h-screen flex items-center justify-center bg-[#040D1A] p-6", children: _jsxs("div", { className: "w-full max-w-md rounded-2xl border border-red-500/30 bg-[#0F1F35] p-6 text-center", children: [_jsx("div", { className: "mx-auto w-16 h-16 rounded-full bg-red-500/20 flex items-center justify-center mb-4", children: _jsx(UserX, { className: "h-8 w-8 text-red-400" }) }), _jsx("h1", { className: "text-xl font-semibold text-red-300", children: "Account Disabled" }), _jsx("p", { className: "mt-2 text-sm text-slate-400", children: "Your account has been disabled. Please contact an administrator to regain access." })] }) }));
    }
    // Account locked
    if (isAccountLocked) {
        return (_jsx("div", { className: "min-h-screen flex items-center justify-center bg-[#040D1A] p-6", children: _jsxs("div", { className: "w-full max-w-md rounded-2xl border border-amber-500/30 bg-[#0F1F35] p-6 text-center", children: [_jsx("div", { className: "mx-auto w-16 h-16 rounded-full bg-amber-500/20 flex items-center justify-center mb-4", children: _jsx(Lock, { className: "h-8 w-8 text-amber-400" }) }), _jsx("h1", { className: "text-xl font-semibold text-amber-300", children: "Account Locked" }), _jsx("p", { className: "mt-2 text-sm text-slate-400", children: "Your account has been locked due to multiple failed login attempts. Please contact an administrator to unlock your account." })] }) }));
    }
    // Permission/role check failed
    if (!routeAllowed || !roleAllowed) {
        return (_jsx("div", { className: "min-h-screen flex items-center justify-center bg-[#040D1A] p-6", children: _jsxs("div", { className: "w-full max-w-md rounded-2xl border border-red-500/30 bg-[#0F1F35] p-6 text-center", children: [_jsx("div", { className: "mx-auto w-16 h-16 rounded-full bg-red-500/20 flex items-center justify-center mb-4", children: _jsx(Shield, { className: "h-8 w-8 text-red-400" }) }), _jsx("h1", { className: "text-xl font-semibold text-red-300", children: "Access Denied" }), _jsxs("p", { className: "mt-2 text-sm text-slate-400", children: ["You don't have permission to access this page.", requiredPermission && _jsxs("span", { className: "block mt-1", children: ["Required permission: ", _jsx("code", { className: "px-1 bg-slate-800 rounded", children: requiredPermission })] }), requiredRole && _jsxs("span", { className: "block mt-1", children: ["Required role: ", _jsx("code", { className: "px-1 bg-slate-800 rounded", children: requiredRole })] })] }), _jsxs("button", { onClick: () => window.history.back(), className: "mt-4 inline-flex items-center gap-2 rounded-lg bg-[#6C63FF] px-4 py-2 text-sm font-medium text-white hover:bg-[#5A52E0]", children: [_jsx(AlertCircle, { className: "h-4 w-4" }), " Go back"] })] }) }));
    }
    return children || _jsx(Outlet, {});
}
