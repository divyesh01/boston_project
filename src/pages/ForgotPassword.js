import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import React, { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Mail, Loader2, AlertCircle, CheckCircle, Copy } from "lucide-react";
import AuthLayout from "@/components/AuthLayout";
import db from "@/api/base44Client";
import { toast } from "@/components/ui/use-toast";
import { getCsrfToken, sensitiveActionRateLimiter, validateCsrfToken, rotateCsrfToken } from "@/lib/securityUtils";
import { isValidEmail } from "@/lib/validator";
export default function ForgotPassword() {
    const [identifier, setIdentifier] = useState("");
    const [loading, setLoading] = useState(false);
    const [submitted, setSubmitted] = useState(false);
    const [resetToken, setResetToken] = useState(null);
    const [showToken, setShowToken] = useState(false);
    const [copied, setCopied] = useState(false);
    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        try {
            // Format check first, so malformed input never reaches the rate limiter.
            const id = identifier.trim();
            if (id.includes("@") ? !isValidEmail(id) : !/^[A-Za-z0-9_-]{1,50}$/.test(id)) {
                toast({ variant: "destructive", title: "Error", description: "Please enter a valid username or email." });
                return;
            }
            // CSRF validation
            const csrfToken = getCsrfToken();
            if (!validateCsrfToken(csrfToken)) {
                toast({ variant: "destructive", title: "Security Error", description: "Invalid security token. Please refresh the page and try again." });
                rotateCsrfToken();
                return;
            }
            // Rate limiting
            const rateLimit = sensitiveActionRateLimiter.check();
            if (!rateLimit.allowed) {
                toast({ variant: "destructive", title: "Rate Limited", description: `Too many requests. Try again in ${Math.ceil(rateLimit.retryAfter / 60)} minutes.` });
                return;
            }
            const result = await db.auth.resetPasswordRequest({ identifier });
            if (result.token) {
                setResetToken(result.token);
            }
            setSubmitted(true);
            rotateCsrfToken();
            toast({ title: "Request processed", description: result.message });
        }
        catch (err) {
            // Always show generic success to prevent user enumeration
            setSubmitted(true);
            toast({ title: "Request processed", description: "If an account exists, a reset token has been generated." });
        }
        finally {
            setLoading(false);
        }
    };
    const copyToken = async () => {
        if (resetToken) {
            await navigator.clipboard?.writeText?.(resetToken);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        }
    };
    const getResetLink = () => {
        if (!resetToken)
            return null;
        return `${window.location.origin}/reset-password?token=${encodeURIComponent(resetToken)}`;
    };
    return (_jsxs(AuthLayout, { icon: Mail, title: submitted ? "Reset instructions sent" : "Reset password", subtitle: submitted ? "Check the token below to reset your password" : "Enter your username or email to receive a reset token", footer: _jsx(Link, { to: "/login", className: "text-primary font-medium hover:underline", children: "Back to log in" }), children: [!submitted && (_jsxs("form", { onSubmit: handleSubmit, className: "space-y-4", children: [_jsxs("div", { className: "space-y-2", children: [_jsx(Label, { htmlFor: "identifier", children: "Username or Email" }), _jsxs("div", { className: "relative", children: [_jsx(Mail, { className: "absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground", "aria-hidden": "true" }), _jsx(Input, { id: "identifier", type: "text", autoComplete: "username", autoFocus: true, placeholder: "username or email@example.com", value: identifier, onChange: (e) => setIdentifier(e.target.value), className: "pl-10 h-12", required: true })] })] }), _jsx(Button, { type: "submit", className: "w-full h-12 font-medium", disabled: loading || !identifier.trim(), children: loading ? (_jsxs(_Fragment, { children: [_jsx(Loader2, { className: "w-4 h-4 mr-2 animate-spin" }), "Sending..."] })) : ("Request reset token") })] })), submitted && resetToken && (_jsxs("div", { className: "space-y-4", children: [_jsxs("div", { className: "rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4", children: [_jsxs("div", { className: "flex items-center gap-2 text-emerald-400 mb-2", children: [_jsx(CheckCircle, { className: "h-5 w-5" }), _jsx("span", { className: "font-medium", children: "Reset token generated" })] }), _jsx("p", { className: "text-sm text-slate-400 mb-4", children: "Use the token below to reset your password. This token expires in 1 hour." }), _jsxs("div", { className: "relative mb-4", children: [_jsx(Input, { type: showToken ? "text" : "password", value: resetToken, readOnly: true, className: "pr-12 font-mono text-sm bg-slate-900/50" }), _jsxs("div", { className: "absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-2", children: [_jsx("button", { type: "button", onClick: () => setShowToken((v) => !v), className: "text-muted-foreground hover:text-slate-100", tabIndex: -1, "aria-label": showToken ? "Hide token" : "Show token", children: showToken ? _jsx(AlertCircle, { className: "h-4 w-4" }) : _jsx(CheckCircle, { className: "h-4 w-4" }) }), _jsx("button", { type: "button", onClick: copyToken, className: "text-primary hover:text-primary/80", "aria-label": copied ? "Copied!" : "Copy token", children: _jsx(Copy, { className: "h-4 w-4" }) })] })] }), copied && (_jsx("p", { className: "text-xs text-emerald-400 text-center", children: "Token copied to clipboard!" })), _jsxs("div", { className: "rounded-lg border border-slate-700 bg-slate-900/50 p-3 text-sm", children: [_jsx("p", { className: "font-medium text-slate-300 mb-1", children: "Or use this direct link:" }), _jsx("code", { className: "text-xs text-slate-400 break-all", children: getResetLink() })] })] }), _jsx("div", { className: "rounded-lg border border-slate-700/50 bg-slate-900/30 p-4", children: _jsxs("p", { className: "text-sm text-slate-400", children: [_jsx("strong", { children: "Development mode:" }), " In production, this token would be emailed to the user. For local development, copy the token above and use the link or navigate to", _jsx("code", { className: "px-1 bg-slate-800 rounded", children: "/reset-password?token=..." })] }) }), _jsx(Link, { to: "/login", className: "block text-center text-primary font-medium hover:underline mt-4", children: "Return to login" })] }))] }));
}
