import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import React, { useState, useEffect } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { LogIn, Mail, Lock, Eye, EyeOff, Loader2, Smartphone, RotateCcw, Shield } from "lucide-react";
import AuthLayout from "@/components/AuthLayout";
import { safeReturnTo } from "@/lib/authReturnTo";
import { useAuth } from "@/lib/AuthContext";
import db from "@/api/base44Client";
import { getCsrfToken, validateCsrfToken, rotateCsrfToken } from "@/lib/securityUtils";
import { isValidEmail } from "@/lib/validator";
import MFASetup from "@/components/MFASetup";
export default function Login() {
    const { login, isAuthenticated } = useAuth();
    const [identifier, setIdentifier] = useState("");
    const [password, setPassword] = useState("");
    const [showPassword, setShowPassword] = useState(false);
    const [remember, setRemember] = useState(false);
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);
    const [returnTo, setReturnTo] = useState("/");
    const [searchParams] = useSearchParams();
    const [setupRequired, setSetupRequired] = useState(false);
    // MFA flow states
    const [mfaStep, setMfaStep] = useState(null); // null = password step, 'verify' = MFA token, 'setup' = first-time setup
    const [mfaUserId, setMfaUserId] = useState(null);
    const [mfaUsername, setMfaUsername] = useState(null);
    const [mfaSecret, setMfaSecret] = useState(null);
    const [mfaUri, setMfaUri] = useState(null);
    const [mfaBackupCodes, setMfaBackupCodes] = useState([]);
    const [mfaToken, setMfaToken] = useState("");
    const [mfaError, setMfaError] = useState("");
    // Post-login destination (same-origin paths only)
    useEffect(() => {
        setReturnTo(safeReturnTo() || "/");
    }, [searchParams]);
    useEffect(() => {
        if (isAuthenticated) {
            window.location.href = safeReturnTo() || "/";
        }
    }, [isAuthenticated]);
    // Detect first-run: no users exist yet → show Setup prompt
    useEffect(() => {
        let mounted = true;
        (async () => {
            try {
                const count = await db.entities.User.filter({});
                if (mounted)
                    setSetupRequired(count.length === 0);
            }
            catch (e) {
                const all = await db.entities.User.list();
                if (mounted)
                    setSetupRequired(all.length === 0);
            }
        })();
        return () => { mounted = false; };
    }, []);
    const handlePasswordSubmit = async (e) => {
        e.preventDefault();
        setError("");
        // Format check before any network/auth work. Emails are validated strictly;
        // the username branch mirrors the identifier policy in base44Client (hyphens
        // allowed, bounded length) so legacy accounts are never blocked here.
        const id = identifier.trim();
        if (id.includes("@") ? !isValidEmail(id) : !/^[A-Za-z0-9_-]{1,50}$/.test(id)) {
            setError("Please enter a valid username or email.");
            return;
        }
        // CSRF validation
        const csrfToken = getCsrfToken();
        if (!validateCsrfToken(csrfToken)) {
            setError("Invalid security token. Please refresh the page and try again.");
            rotateCsrfToken();
            return;
        }
        setLoading(true);
        try {
            const result = await login(identifier, password, remember);
            if (result?.mfaRequired) {
                // MFA required but no token provided - move to MFA verification step
                setMfaStep('verify');
                setMfaUserId(result.userId);
                setMfaUsername(result.username);
                setError("");
            }
            else {
                // Login successful (no MFA or MFA already verified)
                rotateCsrfToken();
                window.location.href = returnTo;
            }
        }
        catch (err) {
            setError(err.message || "Invalid username/email or password");
        }
        finally {
            setLoading(false);
        }
    };
    const handleMfaVerify = async (e) => {
        e.preventDefault();
        setMfaError("");
        const csrfToken = getCsrfToken();
        if (!validateCsrfToken(csrfToken)) {
            setMfaError("Invalid security token. Please refresh the page and try again.");
            rotateCsrfToken();
            return;
        }
        if (!mfaToken || mfaToken.length !== 6) {
            setMfaError("Please enter a 6-digit code.");
            return;
        }
        setLoading(true);
        try {
            await login(identifier, password, remember, mfaToken);
            rotateCsrfToken();
            window.location.href = returnTo;
        }
        catch (err) {
            setMfaError(err.message || "Invalid MFA code. Please try again.");
        }
        finally {
            setLoading(false);
        }
    };
    const handleMfaSetupComplete = async (token, done) => {
        if (done) {
            // Setup complete, redirect
            rotateCsrfToken();
            window.location.href = returnTo;
            return;
        }
        // Verify the token during setup
        setLoading(true);
        try {
            await login(identifier, password, remember, token);
            rotateCsrfToken();
            window.location.href = returnTo;
        }
        catch (err) {
            setMfaError(err.message || "Invalid MFA code. Please try again.");
        }
        finally {
            setLoading(false);
        }
    };
    const handleMfaSetupCancel = () => {
        // Cancel MFA setup - go back to password step
        setMfaStep(null);
        setMfaUserId(null);
        setMfaUsername(null);
        setMfaSecret(null);
        setMfaUri(null);
        setMfaBackupCodes([]);
        setMfaToken("");
        setMfaError("");
    };
    const goBackToPassword = () => {
        setMfaStep(null);
        setMfaUserId(null);
        setMfaUsername(null);
        setMfaToken("");
        setMfaError("");
    };
    return (_jsxs(AuthLayout, { icon: LogIn, title: mfaStep === 'verify' ? "Two-Factor Authentication" : mfaStep === 'setup' ? "Set Up MFA" : "Welcome back", subtitle: mfaStep === 'verify' ? "Enter the code from your authenticator app" :
            mfaStep === 'setup' ? "Scan the QR code to enable MFA" :
                "Log in to RRI Executive", footer: _jsxs(_Fragment, { children: ["Don't have an account?", " ", _jsx("span", { className: "text-slate-500", children: "Contact the administrator to create your login." })] }), children: [setupRequired && mfaStep === null && (_jsxs("div", { className: "mb-6 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-300", children: [_jsx("p", { className: "font-medium", children: "First-time setup" }), _jsx("p", { className: "mt-1", children: "No user accounts exist yet. Create the Owner account to get started." }), _jsx(Link, { to: "/setup", className: "mt-2 inline-block font-medium text-[#6C63FF] hover:underline", children: "Create Owner account \u2192" })] })), (error && mfaStep === null) && (_jsx("div", { className: "mb-4 rounded-lg bg-destructive/10 p-3 text-sm text-destructive", children: error })), (mfaError && mfaStep !== null) && (_jsx("div", { className: "mb-4 rounded-lg bg-destructive/10 p-3 text-sm text-destructive", children: mfaError })), mfaStep === 'verify' && (_jsxs("form", { onSubmit: handleMfaVerify, className: "space-y-4", children: [_jsxs("div", { className: "flex items-center justify-center gap-3 mb-4", children: [_jsx(Shield, { className: "h-8 w-8 text-[#6C63FF]" }), _jsxs("div", { className: "text-left", children: [_jsx("p", { className: "font-medium", children: "MFA Required" }), _jsx("p", { className: "text-sm text-slate-500", children: "Enter the 6-digit code from your authenticator app" })] })] }), _jsxs("div", { className: "space-y-2", children: [_jsx(Label, { htmlFor: "mfa-token", children: "Authentication Code" }), _jsxs("div", { className: "relative", children: [_jsx(Smartphone, { className: "absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground", "aria-hidden": "true" }), _jsx(Input, { id: "mfa-token", type: "text", inputMode: "numeric", pattern: "[0-9]*", maxLength: 6, placeholder: "000000", value: mfaToken, onChange: (e) => setMfaToken(e.target.value.replace(/\D/g, '').slice(0, 6)), className: "h-12 pl-10 text-2xl tracking-widest text-center", autoFocus: true, autoComplete: "one-time-code", required: true })] })] }), _jsxs("div", { className: "flex items-center justify-between text-sm", children: [_jsx("span", { className: "text-slate-500", children: "Code refreshes every 30 seconds" }), _jsxs(Button, { type: "button", variant: "ghost", size: "sm", onClick: goBackToPassword, children: [_jsx(RotateCcw, { className: "mr-1 h-3 w-3" }), " Use password instead"] })] }), _jsx(Button, { type: "submit", className: "h-12 w-full font-medium", disabled: loading || mfaToken.length !== 6, children: loading ? (_jsxs(_Fragment, { children: [_jsx(Loader2, { className: "mr-2 h-4 w-4 animate-spin" }), "Verifying..."] })) : ("Verify & Log in") })] })), mfaStep === 'setup' && (_jsx(MFASetup, { secret: mfaSecret, uri: mfaUri, userEmail: mfaUsername, backupCodes: mfaBackupCodes, onComplete: handleMfaSetupComplete, onCancel: handleMfaSetupCancel, isEnabling: true })), mfaStep === null && (_jsxs("form", { onSubmit: handlePasswordSubmit, className: "space-y-4", children: [_jsxs("div", { className: "space-y-2", children: [_jsx(Label, { htmlFor: "identifier", children: "Username or Email" }), _jsxs("div", { className: "relative", children: [_jsx(Mail, { className: "absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground", "aria-hidden": "true" }), _jsx(Input, { id: "identifier", type: "text", autoComplete: "username", autoFocus: true, placeholder: "you@example.com or username", value: identifier, onChange: (e) => setIdentifier(e.target.value), className: "h-12 pl-10", required: true })] })] }), _jsxs("div", { className: "space-y-2", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsx(Label, { htmlFor: "password", children: "Password" }), _jsx(Link, { to: "/forgot-password", className: "text-xs text-[#6C63FF] hover:underline", children: "Forgot password?" })] }), _jsxs("div", { className: "relative", children: [_jsx(Lock, { className: "absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground", "aria-hidden": "true" }), _jsx(Input, { id: "password", type: showPassword ? "text" : "password", autoComplete: "current-password", placeholder: "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022", value: password, onChange: (e) => setPassword(e.target.value), className: "h-12 pl-10 pr-10", required: true }), _jsx("button", { type: "button", onClick: () => setShowPassword((v) => !v), className: "absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-slate-100", "aria-label": showPassword ? "Hide password" : "Show password", tabIndex: -1, children: showPassword ? _jsx(EyeOff, { className: "h-4 w-4" }) : _jsx(Eye, { className: "h-4 w-4" }) })] })] }), _jsxs("div", { className: "flex items-center space-x-2", children: [_jsx(Checkbox, { id: "remember", checked: remember, onCheckedChange: (v) => setRemember(!!v) }), _jsx("label", { htmlFor: "remember", className: "text-sm text-slate-400", children: "Remember me for 30 days" })] }), _jsx(Button, { type: "submit", className: "h-12 w-full font-medium", disabled: loading, children: loading ? (_jsxs(_Fragment, { children: [_jsx(Loader2, { className: "mr-2 h-4 w-4 animate-spin" }), "Logging in..."] })) : ("Log in") })] }))] }));
}
