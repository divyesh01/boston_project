import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import React, { useState, useEffect, useMemo } from "react";
import { toast } from "@/components/ui/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose, } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Eye, EyeOff, Loader2, Lock, LockOpen, Plus, RefreshCw, Search, Trash2, UserCog, UserX, UserCheck, Shield, ShieldOff } from "lucide-react";
import { useAuth } from "@/lib/AuthContext";
import db from "@/api/base44Client";
import { useProperties } from "@/lib/useHotelData";
import { ROLES, PERMISSIONS, PERMISSION_KEYS, defaultPermissionsForRole } from "@/lib/permissions";
import { isCryptoAvailable, validatePasswordStrength, generateTemporaryPassword } from "@/lib/security";
import { getCsrfToken, sensitiveActionRateLimiter, validateCsrfToken, rotateCsrfToken, sanitizeEmail, sanitizeAlphanumeric, sanitizeText, sanitizeCsvCell } from "@/lib/securityUtils";
import { isValidEmail, isValidUsername } from "@/lib/validator";
const ROLE_BADGE = {
    owner: "bg-purple-500/20 text-purple-300 border-purple-500/40",
    admin: "bg-[#6C63FF]/20 text-[#9D9AFF] border-[#6C63FF]/40",
    manager: "bg-blue-500/20 text-blue-300 border-blue-500/40",
    front_desk: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40",
    accountant: "bg-amber-500/20 text-amber-300 border-amber-500/40",
    read_only: "bg-slate-500/20 text-slate-300 border-slate-500/40",
};
const STATUS_BADGE = (u) => {
    if (u.is_locked)
        return _jsx(Badge, { className: "bg-red-500/20 text-red-300 border-red-500/40", children: "Locked" });
    if (u.is_active === false)
        return _jsx(Badge, { className: "bg-slate-500/20 text-slate-300 border-slate-500/40", children: "Disabled" });
    if (u.must_change_password)
        return _jsx(Badge, { className: "bg-amber-500/20 text-amber-300 border-amber-500/40", children: "Password change required" });
    if (u.mfa_enabled)
        return _jsxs(Badge, { className: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40 flex items-center gap-1", children: [_jsx(Shield, { className: "h-3 w-3" }), " MFA Enabled"] });
    return _jsx(Badge, { className: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40", children: "Active" });
};
const EMPTY_FORM = {
    username: "", email: "", full_name: "", role: "front_desk",
    permissions: {}, property_mode: "all", property_ids: [], must_change_password: true,
};
export default function Users() {
    const { user: me } = useAuth();
    const { data: properties = [] } = useProperties();
    const [users, setUsers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState("");
    const [actionBusy, setActionBusy] = useState(false);
    // Create dialog
    const [createOpen, setCreateOpen] = useState(false);
    const [form, setForm] = useState({ ...EMPTY_FORM, permissions: defaultPermissionsForRole("front_desk") });
    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [showPassword, setShowPassword] = useState(false);
    // Edit dialog
    const [editUser, setEditUser] = useState(null);
    const [editForm, setEditForm] = useState(null);
    // Reset password dialog
    const [resetUser, setResetUser] = useState(null);
    const [resetPassword, setResetPassword] = useState("");
    const [resetShow, setResetShow] = useState(false);
    const [resetAction, setResetAction] = useState("temp"); // temp | permanent
    // Confirm dialogs
    const [confirmAction, setConfirmAction] = useState(null); // { type, user }
    const load = async () => {
        setLoading(true);
        try {
            const list = await db.users.list();
            setUsers(list);
        }
        catch (e) {
            toast({ variant: "destructive", title: "Error", description: e.message });
        }
        finally {
            setLoading(false);
        }
    };
    useEffect(() => { load(); }, []);
    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        if (!q)
            return users;
        return users.filter((u) => (u.username || "").toLowerCase().includes(q) ||
            (u.email || "").toLowerCase().includes(q) ||
            (u.full_name || "").toLowerCase().includes(q) ||
            (u.role || "").toLowerCase().includes(q));
    }, [users, search]);
    const setFormField = (key, value) => setForm((f) => ({ ...f, [key]: value }));
    const handleCreate = async () => {
        if (!isCryptoAvailable()) {
            toast({ variant: "destructive", title: "Error", description: "Password hashing unavailable. Open via localhost/HTTPS." });
            return;
        }
        // Rate limiting for sensitive actions
        const rateLimit = sensitiveActionRateLimiter.check();
        if (!rateLimit.allowed) {
            toast({ variant: "destructive", title: "Rate Limited", description: `Too many requests. Try again in ${Math.ceil(rateLimit.retryAfter / 60)} minutes.` });
            return;
        }
        // CSRF validation
        const csrfToken = getCsrfToken();
        if (!validateCsrfToken(csrfToken)) {
            toast({ variant: "destructive", title: "Security Error", description: "Invalid security token. Please refresh the page and try again." });
            rotateCsrfToken();
            return;
        }
        if (password !== confirmPassword) {
            toast({ variant: "destructive", title: "Error", description: "Passwords do not match." });
            return;
        }
        const strength = validatePasswordStrength(password);
        if (strength) {
            toast({ variant: "destructive", title: "Error", description: strength });
            return;
        }
        // Input sanitization
        const sanitizedUsername = sanitizeAlphanumeric(form.username);
        const sanitizedEmail = sanitizeEmail(form.email);
        const sanitizedFullName = sanitizeCsvCell(sanitizeText(form.full_name));
        if (sanitizedUsername !== form.username || sanitizedEmail !== form.email) {
            toast({ variant: "destructive", title: "Error", description: "Invalid characters in username or email." });
            return;
        }
        if (!isValidUsername(sanitizedUsername)) {
            toast({ variant: "destructive", title: "Error", description: "Username must be 3-30 alphanumeric or underscore characters." });
            return;
        }
        if (!isValidEmail(sanitizedEmail)) {
            toast({ variant: "destructive", title: "Error", description: "Invalid email address." });
            return;
        }
        setActionBusy(true);
        try {
            await db.users.create(me, {
                username: sanitizedUsername,
                email: sanitizedEmail,
                full_name: sanitizedFullName,
                role: form.role,
                permissions: form.permissions,
                property_access: form.property_mode === "all" ? "all" : form.property_ids,
                is_active: true,
                password,
                must_change_password: true,
            });
            toast({ title: "User created", description: `${sanitizedUsername} can now log in. They will be asked to set a password on first login.` });
            setCreateOpen(false);
            setForm({ ...EMPTY_FORM, permissions: defaultPermissionsForRole("front_desk") });
            setPassword("");
            setConfirmPassword("");
            setShowPassword(false);
            rotateCsrfToken();
            await load();
        }
        catch (e) {
            toast({ variant: "destructive", title: "Error", description: e.message });
        }
        finally {
            setActionBusy(false);
        }
    };
    const openEdit = (u) => {
        setEditUser(u);
        setEditForm({
            username: u.username, email: u.email, full_name: u.full_name || "", role: u.role,
            permissions: { ...PERMISSION_KEYS.reduce((a, k) => ({ ...a, [k]: !!(u.permissions && u.permissions[k]) }), {}) },
            property_mode: u.property_access === "all" ? "all" : "specific",
            property_ids: Array.isArray(u.property_access) ? u.property_access : [],
        });
    };
    const handleEditSave = async () => {
        const rateLimit = sensitiveActionRateLimiter.check();
        if (!rateLimit.allowed) {
            toast({ variant: "destructive", title: "Rate Limited", description: `Too many requests. Try again in ${Math.ceil(rateLimit.retryAfter / 60)} minutes.` });
            return;
        }
        const csrfToken = getCsrfToken();
        if (!validateCsrfToken(csrfToken)) {
            toast({ variant: "destructive", title: "Security Error", description: "Invalid security token. Please refresh the page and try again." });
            rotateCsrfToken();
            return;
        }
        // Input sanitization
        const sanitizedUsername = sanitizeAlphanumeric(editForm.username);
        const sanitizedEmail = sanitizeEmail(editForm.email);
        const sanitizedFullName = sanitizeCsvCell(sanitizeText(editForm.full_name));
        if (sanitizedUsername !== editForm.username || sanitizedEmail !== editForm.email) {
            toast({ variant: "destructive", title: "Error", description: "Invalid characters in username or email." });
            return;
        }
        if (sanitizedUsername !== String(editUser.username || "") && !isValidUsername(sanitizedUsername)) {
            toast({ variant: "destructive", title: "Error", description: "Username must be 3-30 alphanumeric or underscore characters." });
            return;
        }
        if (!isValidEmail(sanitizedEmail)) {
            toast({ variant: "destructive", title: "Error", description: "Invalid email address." });
            return;
        }
        setActionBusy(true);
        try {
            const isSelf = me && String(me.id) === String(editUser.id);
            const patch = {
                username: sanitizedUsername,
                email: sanitizedEmail,
                full_name: sanitizedFullName,
            };
            if (!isSelf) {
                patch.role = editForm.role;
                patch.permissions = editForm.permissions;
                patch.property_access = editForm.property_mode === "all" ? "all" : editForm.property_ids;
            }
            await db.users.update(me, editUser.id, patch);
            toast({ title: "User updated", description: "Changes take effect immediately." });
            setEditUser(null);
            rotateCsrfToken();
            await load();
        }
        catch (e) {
            toast({ variant: "destructive", title: "Error", description: e.message });
        }
        finally {
            setActionBusy(false);
        }
    };
    const handleResetPassword = async () => {
        if (!isCryptoAvailable()) {
            toast({ variant: "destructive", title: "Error", description: "Password hashing unavailable. Open via localhost/HTTPS." });
            return;
        }
        const rateLimit = sensitiveActionRateLimiter.check();
        if (!rateLimit.allowed) {
            toast({ variant: "destructive", title: "Rate Limited", description: `Too many requests. Try again in ${Math.ceil(rateLimit.retryAfter / 60)} minutes.` });
            return;
        }
        const csrfToken = getCsrfToken();
        if (!validateCsrfToken(csrfToken)) {
            toast({ variant: "destructive", title: "Security Error", description: "Invalid security token. Please refresh the page and try again." });
            rotateCsrfToken();
            return;
        }
        setActionBusy(true);
        try {
            const newPassword = resetAction === "temp" ? generateTemporaryPassword() : resetPassword;
            if (resetAction === "permanent") {
                const strength = validatePasswordStrength(newPassword);
                if (strength) {
                    toast({ variant: "destructive", title: "Error", description: strength });
                    return;
                }
            }
            await db.users.resetPassword(me, resetUser.id, newPassword);
            if (resetAction === "temp") {
                toast({
                    title: "Temporary password generated",
                    description: `Give ${resetUser.username} the temporary password: ${newPassword}`,
                });
            }
            else {
                toast({ title: "Password reset", description: "The user will be asked to change it at next login." });
            }
            setResetUser(null);
            setResetPassword("");
            setResetAction("temp");
            rotateCsrfToken();
        }
        catch (e) {
            toast({ variant: "destructive", title: "Error", description: e.message });
        }
        finally {
            setActionBusy(false);
        }
    };
    const runConfirm = async () => {
        const rateLimit = sensitiveActionRateLimiter.check();
        if (!rateLimit.allowed) {
            toast({ variant: "destructive", title: "Rate Limited", description: `Too many requests. Try again in ${Math.ceil(rateLimit.retryAfter / 60)} minutes.` });
            return;
        }
        const csrfToken = getCsrfToken();
        if (!validateCsrfToken(csrfToken)) {
            toast({ variant: "destructive", title: "Security Error", description: "Invalid security token. Please refresh the page and try again." });
            rotateCsrfToken();
            return;
        }
        const { type, user: u } = confirmAction;
        setActionBusy(true);
        try {
            if (type === "delete") {
                await db.users.delete(me, u.id);
                toast({ title: "User deleted", description: `${u.username} was removed.` });
            }
            else if (type === "disable") {
                await db.users.setStatus(me, u.id, "disabled");
                toast({ title: "User disabled", description: `${u.username} can no longer log in.` });
            }
            else if (type === "enable") {
                await db.users.setStatus(me, u.id, "enabled");
                toast({ title: "User enabled", description: `${u.username} can log in again.` });
            }
            else if (type === "lock") {
                await db.users.setStatus(me, u.id, "locked");
                toast({ title: "User locked", description: `${u.username} is now locked out.` });
            }
            else if (type === "unlock") {
                await db.users.setStatus(me, u.id, "unlocked");
                toast({ title: "User unlocked", description: `${u.username} can log in again.` });
            }
            else if (type === "enable_mfa") {
                const result = await db.users.enableMfa(me, u.id);
                toast({
                    title: "MFA Enabled",
                    description: `MFA has been enabled for ${u.username}. Share the setup details securely with the user.`,
                });
                // In a real app, you'd show the secret/QR code here for the admin to share
                console.log('MFA Setup for user:', u.username, result);
            }
            else if (type === "disable_mfa") {
                await db.users.disableMfa(me, u.id);
                toast({ title: "MFA Disabled", description: `MFA has been disabled for ${u.username}.` });
            }
            setConfirmAction(null);
            rotateCsrfToken();
            await load();
        }
        catch (e) {
            toast({ variant: "destructive", title: "Error", description: e.message });
        }
        finally {
            setActionBusy(false);
        }
    };
    const isSelf = (u) => me && String(me.id) === String(u.id);
    const isSelfEdit = editUser && isSelf(editUser);
    return (_jsxs("div", { className: "space-y-6", children: [_jsxs(Card, { children: [_jsxs(CardHeader, { className: "flex flex-row items-start justify-between space-y-0", children: [_jsxs("div", { children: [_jsx(CardTitle, { className: "text-xl", children: "User Management" }), _jsx(CardDescription, { children: "Create accounts, grant permissions, and manage access." })] }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsx(Button, { variant: "outline", size: "icon", onClick: load, title: "Refresh", children: _jsx(RefreshCw, { className: `h-4 w-4 ${loading ? "animate-spin" : ""}` }) }), _jsxs(Button, { onClick: () => setCreateOpen(true), children: [_jsx(Plus, { className: "mr-2 h-4 w-4" }), " Add User"] })] })] }), _jsxs(CardContent, { className: "space-y-4", children: [_jsxs("div", { className: "relative max-w-sm", children: [_jsx(Search, { className: "absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" }), _jsx(Input, { value: search, onChange: (e) => setSearch(e.target.value), placeholder: "Search users by name, email, or role...", className: "pl-9" })] }), _jsx("div", { className: "rounded-xl border", children: _jsxs(Table, { children: [_jsx(TableHeader, { children: _jsxs(TableRow, { children: [_jsx(TableHead, { children: "User" }), _jsx(TableHead, { children: "Email" }), _jsx(TableHead, { children: "Role" }), _jsx(TableHead, { children: "Property Access" }), _jsx(TableHead, { children: "MFA" }), _jsx(TableHead, { children: "Last Login" }), _jsx(TableHead, { children: "Status" }), _jsx(TableHead, { className: "text-right", children: "Actions" })] }) }), _jsx(TableBody, { children: loading ? (_jsx(TableRow, { children: _jsx(TableCell, { colSpan: 7, className: "py-10 text-center text-muted-foreground", children: "Loading users..." }) })) : filtered.length === 0 ? (_jsx(TableRow, { children: _jsx(TableCell, { colSpan: 7, className: "py-10 text-center text-muted-foreground", children: "No users found." }) })) : filtered.map((u) => (_jsxs(TableRow, { children: [_jsxs(TableCell, { children: [_jsxs("div", { className: "font-medium", children: [u.username, isSelf(u) && _jsx("span", { className: "ml-1 text-xs text-muted-foreground", children: "(you)" })] }), _jsx("div", { className: "text-xs text-muted-foreground", children: u.full_name || "—" })] }), _jsx(TableCell, { className: "text-sm text-muted-foreground", children: u.email }), _jsx(TableCell, { children: _jsx(Badge, { className: `border ${ROLE_BADGE[u.role] || ROLE_BADGE.read_only}`, children: ROLES.find((r) => r.key === u.role)?.label || u.role }) }), _jsx(TableCell, { className: "text-xs text-muted-foreground", children: u.property_access === "all" ? "All properties" : Array.isArray(u.property_access) ? `${u.property_access.length} property(ies)` : "None" }), _jsx(TableCell, { className: "text-xs text-muted-foreground", children: u.last_login ? new Date(u.last_login).toLocaleString() : "Never" }), _jsx(TableCell, { children: u.mfa_enabled ? (_jsxs(Badge, { className: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40 flex items-center gap-1", children: [_jsx(Shield, { className: "h-3 w-3" }), " Enabled"] })) : (_jsxs(Badge, { className: "bg-slate-500/20 text-slate-300 border-slate-500/40 flex items-center gap-1", children: [_jsx(ShieldOff, { className: "h-3 w-3" }), " Disabled"] })) }), _jsx(TableCell, { children: STATUS_BADGE(u) }), _jsx(TableCell, { children: _jsxs("div", { className: "flex items-center justify-end gap-1", children: [_jsx(Button, { variant: "ghost", size: "sm", onClick: () => openEdit(u), title: "Edit user / permissions", children: _jsx(UserCog, { className: "h-4 w-4" }) }), _jsx(Button, { variant: "ghost", size: "sm", onClick: () => { setResetUser(u); setResetPassword(""); setResetAction("temp"); setResetShow(false); }, title: "Reset password", children: _jsx(RefreshCw, { className: "h-4 w-4" }) }), u.mfa_enabled ? (_jsx(Button, { variant: "ghost", size: "sm", onClick: () => setConfirmAction({ type: "disable_mfa", user: u }), title: "Disable MFA", className: "text-amber-400 hover:text-amber-300", children: _jsx(ShieldOff, { className: "h-4 w-4" }) })) : (_jsx(Button, { variant: "ghost", size: "sm", onClick: () => setConfirmAction({ type: "enable_mfa", user: u }), title: "Enable MFA", className: "text-emerald-400 hover:text-emerald-300", children: _jsx(Shield, { className: "h-4 w-4" }) })), !u.is_locked ? (_jsx(Button, { variant: "ghost", size: "sm", onClick: () => setConfirmAction({ type: "lock", user: u }), title: "Lock account", children: _jsx(Lock, { className: "h-4 w-4" }) })) : (_jsx(Button, { variant: "ghost", size: "sm", onClick: () => setConfirmAction({ type: "unlock", user: u }), title: "Unlock account", children: _jsx(LockOpen, { className: "h-4 w-4" }) })), u.is_active === false ? (_jsx(Button, { variant: "ghost", size: "sm", onClick: () => setConfirmAction({ type: "enable", user: u }), title: "Enable account", children: _jsx(UserCheck, { className: "h-4 w-4" }) })) : (_jsx(Button, { variant: "ghost", size: "sm", onClick: () => setConfirmAction({ type: "disable", user: u }), title: "Disable account", children: _jsx(UserX, { className: "h-4 w-4" }) })), _jsx(Button, { variant: "ghost", size: "sm", className: "text-red-400 hover:text-red-300", onClick: () => setConfirmAction({ type: "delete", user: u }), title: "Delete user", children: _jsx(Trash2, { className: "h-4 w-4" }) })] }) })] }, u.id))) })] }) })] })] }), _jsx(Dialog, { open: createOpen, onOpenChange: setCreateOpen, children: _jsxs(DialogContent, { className: "max-w-lg max-h-[90vh] overflow-y-auto", children: [_jsxs(DialogHeader, { children: [_jsx(DialogTitle, { children: "Add User" }), _jsx(DialogDescription, { children: "Create a new login. A temporary password will be generated." })] }), _jsxs("div", { className: "grid gap-4 py-2", children: [_jsxs("div", { className: "grid grid-cols-2 gap-3", children: [_jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Username *" }), _jsx(Input, { value: form.username, onChange: (e) => setFormField("username", e.target.value), placeholder: "jsmith" })] }), _jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Email *" }), _jsx(Input, { type: "email", value: form.email, onChange: (e) => setFormField("email", e.target.value), placeholder: "user@example.com" })] })] }), _jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Full name" }), _jsx(Input, { value: form.full_name, onChange: (e) => setFormField("full_name", e.target.value), placeholder: "Jane Smith" })] }), _jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Role" }), _jsxs(Select, { value: form.role, onValueChange: (v) => setFormField("role", v), children: [_jsx(SelectTrigger, { className: "w-full", children: _jsx(SelectValue, {}) }), _jsx(SelectContent, { children: ROLES.map((r) => _jsx(SelectItem, { value: r.key, children: r.label }, r.key)) })] }), _jsx("p", { className: "text-xs text-muted-foreground", children: "Permissions default to the role and can be fine-tuned after creating." })] }), _jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Temporary password *" }), _jsxs("div", { className: "relative", children: [_jsx(Input, { type: showPassword ? "text" : "password", value: password, onChange: (e) => setPassword(e.target.value), placeholder: "At least 8 characters, upper/lowercase + number" }), _jsx("button", { type: "button", onClick: () => setShowPassword((v) => !v), className: "absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground", tabIndex: -1, children: showPassword ? _jsx(EyeOff, { className: "h-4 w-4" }) : _jsx(Eye, { className: "h-4 w-4" }) })] })] }), _jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Confirm password *" }), _jsx(Input, { type: "password", value: confirmPassword, onChange: (e) => setConfirmPassword(e.target.value) })] }), _jsxs("div", { className: "flex items-center justify-between rounded-lg border p-3", children: [_jsxs("div", { children: [_jsx(Label, { children: "Require password change at next login" }), _jsx("p", { className: "text-xs text-muted-foreground", children: "Recommended for new and temporary passwords." })] }), _jsx(Switch, { checked: form.must_change_password !== false, onCheckedChange: (v) => setFormField("must_change_password", v) })] })] }), _jsxs(DialogFooter, { children: [_jsx(DialogClose, { asChild: true, children: _jsx(Button, { variant: "outline", children: "Cancel" }) }), _jsxs(Button, { onClick: handleCreate, disabled: actionBusy, children: [actionBusy && _jsx(Loader2, { className: "mr-2 h-4 w-4 animate-spin" }), " Create User"] })] })] }) }), editUser && editForm && (_jsx(Dialog, { open: true, onOpenChange: () => setEditUser(null), children: _jsxs(DialogContent, { className: "max-w-2xl max-h-[90vh] overflow-y-auto", children: [_jsxs(DialogHeader, { children: [_jsxs(DialogTitle, { children: ["Edit User \u2014 ", editUser.username] }), _jsx(DialogDescription, { children: isSelf(editUser) ? "You can only update your own profile fields here." : "Changes to permissions and property access take effect immediately." })] }), _jsxs("div", { className: "grid gap-4 py-2", children: [_jsxs("div", { className: "grid grid-cols-2 gap-3", children: [_jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Username" }), _jsx(Input, { value: editForm.username, onChange: (e) => setEditForm((f) => ({ ...f, username: e.target.value })) })] }), _jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Email" }), _jsx(Input, { type: "email", value: editForm.email, onChange: (e) => setEditForm((f) => ({ ...f, email: e.target.value })) })] })] }), _jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Full name" }), _jsx(Input, { value: editForm.full_name, onChange: (e) => setEditForm((f) => ({ ...f, full_name: e.target.value })) })] }), !isSelfEdit && (_jsxs(_Fragment, { children: [_jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Role" }), _jsxs(Select, { value: editForm.role, onValueChange: (v) => {
                                                        const defaults = defaultPermissionsForRole(v);
                                                        setEditForm((f) => ({ ...f, role: v, permissions: { ...defaults } }));
                                                    }, children: [_jsx(SelectTrigger, { className: "w-full", children: _jsx(SelectValue, {}) }), _jsx(SelectContent, { children: ROLES.map((r) => _jsx(SelectItem, { value: r.key, children: r.label }, r.key)) })] })] }), _jsxs("div", { className: "space-y-2 rounded-lg border p-4", children: [_jsx(Label, { className: "text-sm font-medium", children: "Permissions" }), _jsx("div", { className: "grid grid-cols-1 gap-2 sm:grid-cols-2", children: PERMISSIONS.map((p) => (_jsxs("div", { className: "flex items-center justify-between gap-2 rounded-md border px-3 py-2", children: [_jsxs("div", { children: [_jsx("span", { className: "text-sm", children: p.label }), _jsx("span", { className: "ml-2 text-[10px] uppercase text-muted-foreground", children: p.group })] }), _jsx(Checkbox, { checked: !!editForm.permissions[p.key], onCheckedChange: (v) => setEditForm((f) => ({ ...f, permissions: { ...f.permissions, [p.key]: !!v } })) })] }, p.key))) })] }), _jsxs("div", { className: "space-y-2 rounded-lg border p-4", children: [_jsx(Label, { className: "text-sm font-medium", children: "Property Access" }), _jsxs("div", { className: "flex items-center gap-4", children: [_jsxs("label", { className: "flex items-center gap-2 text-sm", children: [_jsx("input", { type: "radio", name: "prop_mode", checked: editForm.property_mode === "all", onChange: () => setEditForm((f) => ({ ...f, property_mode: "all", property_ids: [] })) }), "All properties"] }), _jsxs("label", { className: "flex items-center gap-2 text-sm", children: [_jsx("input", { type: "radio", name: "prop_mode", checked: editForm.property_mode === "specific", onChange: () => setEditForm((f) => ({ ...f, property_mode: "specific" })) }), "Selected properties only"] })] }), editForm.property_mode === "specific" && (_jsx("div", { className: "mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2", children: properties.map((p) => (_jsxs("label", { className: "flex items-center gap-2 rounded-md border px-3 py-2 text-sm", children: [_jsx(Checkbox, { checked: editForm.property_ids.includes(p.id), onCheckedChange: (v) => setEditForm((f) => ({
                                                                    ...f,
                                                                    property_ids: v ? [...f.property_ids, p.id] : f.property_ids.filter((x) => x !== p.id),
                                                                })) }), p.name || p.code || p.id, _jsx("span", { className: "ml-auto text-xs text-muted-foreground", children: p.code })] }, p.id))) }))] })] })), isSelfEdit && (_jsx("div", { className: "rounded-lg border border-muted px-4 py-3 text-xs text-muted-foreground", children: "Role, permissions, and property access for your own account are managed by another Owner/Admin. Use the Users list to edit other accounts." }))] }), _jsxs(DialogFooter, { children: [_jsx(DialogClose, { asChild: true, children: _jsx(Button, { variant: "outline", children: "Cancel" }) }), _jsxs(Button, { onClick: handleEditSave, disabled: actionBusy, children: [actionBusy && _jsx(Loader2, { className: "mr-2 h-4 w-4 animate-spin" }), " Save Changes"] })] })] }) })), resetUser && (_jsx(Dialog, { open: true, onOpenChange: () => setResetUser(null), children: _jsxs(DialogContent, { children: [_jsxs(DialogHeader, { children: [_jsxs(DialogTitle, { children: ["Reset password \u2014 ", resetUser.username] }), _jsx(DialogDescription, { children: "The user will be forced to change their password at next login." })] }), _jsxs("div", { className: "space-y-4 py-2", children: [_jsxs("div", { className: "space-y-2", children: [_jsx(Label, { children: "Choose an option" }), _jsxs("div", { className: "grid grid-cols-2 gap-2", children: [_jsxs("button", { type: "button", onClick: () => setResetAction("temp"), className: `rounded-lg border p-3 text-left text-sm ${resetAction === "temp" ? "border-[#6C63FF] bg-[#6C63FF]/10" : "border-border"}`, children: [_jsx("div", { className: "font-medium", children: "Generate temporary" }), _jsx("div", { className: "text-xs text-muted-foreground", children: "Random strong password shown to you once." })] }), _jsxs("button", { type: "button", onClick: () => setResetAction("permanent"), className: `rounded-lg border p-3 text-left text-sm ${resetAction === "permanent" ? "border-[#6C63FF] bg-[#6C63FF]/10" : "border-border"}`, children: [_jsx("div", { className: "font-medium", children: "Set a password" }), _jsx("div", { className: "text-xs text-muted-foreground", children: "Type a specific password below." })] })] })] }), resetAction === "permanent" && (_jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "New password" }), _jsxs("div", { className: "relative", children: [_jsx(Input, { type: resetShow ? "text" : "password", value: resetPassword, onChange: (e) => setResetPassword(e.target.value), placeholder: "At least 8 characters, upper/lowercase + number" }), _jsx("button", { type: "button", onClick: () => setResetShow((v) => !v), className: "absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground", tabIndex: -1, children: resetShow ? _jsx(EyeOff, { className: "h-4 w-4" }) : _jsx(Eye, { className: "h-4 w-4" }) })] })] }))] }), _jsxs(DialogFooter, { children: [_jsx(DialogClose, { asChild: true, children: _jsx(Button, { variant: "outline", children: "Cancel" }) }), _jsxs(Button, { onClick: handleResetPassword, disabled: actionBusy, children: [actionBusy && _jsx(Loader2, { className: "mr-2 h-4 w-4 animate-spin" }), " Reset Password"] })] })] }) })), confirmAction && (_jsx(Dialog, { open: true, onOpenChange: () => setConfirmAction(null), children: _jsxs(DialogContent, { children: [_jsxs(DialogHeader, { children: [_jsxs(DialogTitle, { children: [confirmAction.type === "delete" && "Delete user", confirmAction.type === "disable" && "Disable account", confirmAction.type === "enable" && "Enable account", confirmAction.type === "lock" && "Lock account", confirmAction.type === "unlock" && "Unlock account", confirmAction.type === "enable_mfa" && "Enable MFA", confirmAction.type === "disable_mfa" && "Disable MFA"] }), _jsxs(DialogDescription, { children: [confirmAction.type === "delete" && `Delete ${confirmAction.user.username} permanently? Their login will stop working immediately.`, confirmAction.type === "disable" && `${confirmAction.user.username} will not be able to log in until re-enabled.`, confirmAction.type === "enable" && `${confirmAction.user.username} will be able to log in again.`, confirmAction.type === "lock" && `${confirmAction.user.username} will be locked out immediately.`, confirmAction.type === "unlock" && `${confirmAction.user.username} will be able to log in again.`, confirmAction.type === "enable_mfa" && `Enable two-factor authentication for ${confirmAction.user.username}? They will need to set up an authenticator app on next login.`, confirmAction.type === "disable_mfa" && `Disable two-factor authentication for ${confirmAction.user.username}? This reduces account security.`] })] }), _jsxs(DialogFooter, { children: [_jsx(DialogClose, { asChild: true, children: _jsx(Button, { variant: "outline", children: "Cancel" }) }), _jsxs(Button, { variant: confirmAction.type === "delete" ? "destructive" : "default", onClick: runConfirm, disabled: actionBusy, children: [actionBusy && _jsx(Loader2, { className: "mr-2 h-4 w-4 animate-spin" }), "Confirm"] })] })] }) }))] }));
}
