import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ShieldCheck, Eye, EyeOff, Loader2 } from "lucide-react";
import AuthLayout from "@/components/AuthLayout";
import { useAuth } from "@/lib/AuthContext";
import db from "@/api/base44Client";
import { isCryptoAvailable, validatePasswordStrength } from "@/lib/security";
import { getCsrfToken, sensitiveActionRateLimiter, validateCsrfToken, rotateCsrfToken, sanitizeAlphanumeric, sanitizeEmail, sanitizeText, sanitizeCsvCell } from "@/lib/securityUtils";
export default function Setup() {
    const navigate = useNavigate();
    const { login } = useAuth();
    const [checked, setChecked] = useState(false);
    const [alreadyExists, setAlreadyExists] = useState(false);
    const [username, setUsername] = useState("");
    const [email, setEmail] = useState("");
    const [fullName, setFullName] = useState("");
    const [password, setPassword] = useState("");
    const [confirm, setConfirm] = useState("");
    const [showPassword, setShowPassword] = useState(false);
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);
    useEffect(() => {
        let mounted = true;
        (async () => {
            try {
                const all = await db.entities.User.list();
                if (mounted)
                    setAlreadyExists(all.length > 0);
            }
            catch (e) {
                if (mounted)
                    setAlreadyExists(false);
            }
            finally {
                if (mounted)
                    setChecked(true);
            }
        })();
        return () => { mounted = false; };
    }, []);
    if (!checked) {
        return (_jsx("div", { className: "flex min-h-screen items-center justify-center bg-[#040D1A]", children: _jsx(Loader2, { className: "h-8 w-8 animate-spin text-[#6C63FF]" }) }));
    }
    const handleSubmit = async (e) => {
        e.preventDefault();
        setError("");
        if (!isCryptoAvailable()) {
            setError("Password hashing is not available in this browser. Open the app via localhost or HTTPS.");
            return;
        }
        // Rate limiting
        const rateLimit = sensitiveActionRateLimiter.check();
        if (!rateLimit.allowed) {
            setError(`Too many requests. Try again in ${Math.ceil(rateLimit.retryAfter / 60)} minutes.`);
            return;
        }
        // CSRF validation
        const csrfToken = getCsrfToken();
        if (!validateCsrfToken(csrfToken)) {
            setError("Invalid security token. Please refresh the page and try again.");
            rotateCsrfToken();
            return;
        }
        if (password !== confirm) {
            setError("Passwords do not match.");
            return;
        }
        const strengthError = validatePasswordStrength(password);
        if (strengthError) {
            setError(strengthError);
            return;
        }
        // Input sanitization
        const sanitizedUsername = sanitizeAlphanumeric(username);
        const sanitizedEmail = sanitizeEmail(email);
        const sanitizedFullName = sanitizeCsvCell(sanitizeText(fullName));
        if (sanitizedUsername !== username || sanitizedEmail !== email) {
            setError("Invalid characters in username or email.");
            return;
        }
        setLoading(true);
        try {
            await db.users.create({ id: "setup", username: sanitizedUsername || "owner", email: sanitizedEmail || "owner", role: "owner", is_active: true }, {
                username: sanitizedUsername,
                email: sanitizedEmail,
                full_name: sanitizedFullName,
                role: "owner",
                permissions: "all",
                property_access: "all",
                is_active: true,
                password,
                must_change_password: false,
            });
            await login(sanitizedUsername, password, true);
            rotateCsrfToken();
            window.location.href = "/";
        }
        catch (err) {
            setError(err.message || "Could not create the Owner account.");
            setLoading(false);
        }
    };
    return (_jsx(AuthLayout, { icon: ShieldCheck, title: "Create Owner account", subtitle: "Set up the first administrator account", children: alreadyExists ? (_jsxs("div", { className: "rounded-lg border border-white/10 bg-[#0A1628] p-4 text-sm text-slate-400", children: [_jsx("p", { className: "text-slate-200 font-medium", children: "Setup already complete" }), _jsx("p", { className: "mt-1", children: "User accounts already exist. Go to the login page to sign in." }), _jsx(Button, { className: "mt-4 w-full", onClick: () => navigate("/login"), children: "Go to Login" })] })) : (_jsxs("form", { onSubmit: handleSubmit, className: "space-y-4", children: [_jsxs("div", { className: "space-y-2", children: [_jsx(Label, { htmlFor: "full_name", children: "Full name (optional)" }), _jsx(Input, { id: "full_name", value: fullName, onChange: (e) => setFullName(e.target.value), placeholder: "Jane Doe", className: "h-11" })] }), _jsxs("div", { className: "space-y-2", children: [_jsx(Label, { htmlFor: "username", children: "Username" }), _jsx(Input, { id: "username", value: username, onChange: (e) => setUsername(e.target.value), placeholder: "owner", className: "h-11", required: true })] }), _jsxs("div", { className: "space-y-2", children: [_jsx(Label, { htmlFor: "email", children: "Email" }), _jsx(Input, { id: "email", type: "email", value: email, onChange: (e) => setEmail(e.target.value), placeholder: "owner@example.com", className: "h-11", required: true })] }), _jsxs("div", { className: "space-y-2", children: [_jsx(Label, { htmlFor: "password", children: "Password" }), _jsxs("div", { className: "relative", children: [_jsx(Input, { id: "password", type: showPassword ? "text" : "password", value: password, onChange: (e) => setPassword(e.target.value), placeholder: "At least 8 characters with upper/lowercase and a number", className: "h-11 pr-10", required: true }), _jsx("button", { type: "button", onClick: () => setShowPassword((v) => !v), className: "absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-slate-100", "aria-label": "Toggle password visibility", tabIndex: -1, children: showPassword ? _jsx(EyeOff, { className: "h-4 w-4" }) : _jsx(Eye, { className: "h-4 w-4" }) })] })] }), _jsxs("div", { className: "space-y-2", children: [_jsx(Label, { htmlFor: "confirm", children: "Confirm password" }), _jsx(Input, { id: "confirm", type: "password", value: confirm, onChange: (e) => setConfirm(e.target.value), className: "h-11", required: true })] }), error && (_jsx("div", { className: "rounded-lg bg-destructive/10 p-3 text-sm text-destructive", children: error })), _jsx(Button, { type: "submit", className: "h-12 w-full font-medium", disabled: loading, children: loading ? (_jsxs(_Fragment, { children: [_jsx(Loader2, { className: "mr-2 h-4 w-4 animate-spin" }), "Creating account..."] })) : ("Create Owner account") })] })) }));
}
