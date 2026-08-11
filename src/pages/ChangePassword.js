import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "@/components/ui/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Eye, EyeOff, Loader2, KeyRound } from "lucide-react";
import { useAuth } from "@/lib/AuthContext";
import db from "@/api/base44Client";
import { isCryptoAvailable, validatePasswordStrength } from "@/lib/security";
import { getCsrfToken, sensitiveActionRateLimiter, validateCsrfToken, rotateCsrfToken } from "@/lib/securityUtils";
export default function ChangePassword() {
    const navigate = useNavigate();
    const { user } = useAuth();
    const [current, setCurrent] = useState("");
    const [next, setNext] = useState("");
    const [confirm, setConfirm] = useState("");
    const [show, setShow] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const handleSubmit = async (e) => {
        e.preventDefault();
        setError("");
        if (!isCryptoAvailable()) {
            setError("Password hashing is not available in this browser.");
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
        if (next !== confirm) {
            setError("New passwords do not match.");
            return;
        }
        const strength = validatePasswordStrength(next);
        if (strength) {
            setError(strength);
            return;
        }
        setLoading(true);
        try {
            await db.users.changeOwnPassword(user, current, next);
            toast({ title: "Password changed", description: "Your password has been updated." });
            rotateCsrfToken();
            navigate("/");
        }
        catch (err) {
            setError(err.message || "Could not change password.");
        }
        finally {
            setLoading(false);
        }
    };
    return (_jsx("div", { className: "mx-auto max-w-md space-y-6", children: _jsxs(Card, { children: [_jsxs(CardHeader, { children: [_jsx("div", { className: "mb-2 inline-flex h-12 w-12 items-center justify-center rounded-xl bg-[#6C63FF]/20", children: _jsx(KeyRound, { className: "h-6 w-6 text-[#6C63FF]" }) }), _jsx(CardTitle, { className: "text-xl", children: "Change Password" }), _jsx(CardDescription, { children: user?.must_change_password
                                ? "Your administrator has asked you to set a new password before continuing."
                                : "Choose a new password for your account." })] }), _jsx(CardContent, { children: _jsxs("form", { onSubmit: handleSubmit, className: "space-y-4", children: [_jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { htmlFor: "current", children: "Current password" }), _jsxs("div", { className: "relative", children: [_jsx(Input, { id: "current", type: show ? "text" : "password", value: current, onChange: (e) => setCurrent(e.target.value), autoComplete: "current-password", required: true, className: "h-11 pr-10" }), _jsx("button", { type: "button", onClick: () => setShow((v) => !v), className: "absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground", tabIndex: -1, children: show ? _jsx(EyeOff, { className: "h-4 w-4" }) : _jsx(Eye, { className: "h-4 w-4" }) })] })] }), _jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { htmlFor: "next", children: "New password" }), _jsx(Input, { id: "next", type: show ? "text" : "password", value: next, onChange: (e) => setNext(e.target.value), autoComplete: "new-password", placeholder: "At least 8 characters, upper/lowercase + number", required: true, className: "h-11" })] }), _jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { htmlFor: "confirm", children: "Confirm new password" }), _jsx(Input, { id: "confirm", type: show ? "text" : "password", value: confirm, onChange: (e) => setConfirm(e.target.value), autoComplete: "new-password", required: true, className: "h-11" })] }), error && (_jsx("div", { className: "rounded-lg bg-destructive/10 p-3 text-sm text-destructive", children: error })), _jsxs(Button, { type: "submit", className: "h-11 w-full", disabled: loading, children: [loading && _jsx(Loader2, { className: "mr-2 h-4 w-4 animate-spin" }), "Change Password"] })] }) })] }) }));
}
