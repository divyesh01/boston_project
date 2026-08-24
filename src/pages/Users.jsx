import React, { useState, useEffect, useMemo } from "react";
import { toast } from "@/components/ui/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Eye, EyeOff, Loader2, Lock, LockOpen, Plus, RefreshCw, Search, Trash2, UserCog, UserX, UserCheck, Shield, ShieldOff } from "lucide-react";
import { useAuth } from "@/lib/AuthContext";
import { db } from "@/api/base44Client";
import { useProperties } from "@/lib/useHotelData";
import { ROLES, PERMISSIONS, PERMISSION_KEYS, defaultPermissionsForRole } from "@/lib/permissions";
import { isCryptoAvailable, validatePasswordStrength, generateTemporaryPassword } from "@/lib/security";
import { getCsrfToken, sensitiveActionRateLimiter, validateCsrfToken, rotateCsrfToken } from "@/lib/securityUtils";
import { validateUserForm, PASSWORD_HELP } from "@/lib/userFormValidation";
import PasswordConfirmDialog from "@/components/PasswordConfirmDialog";

const ROLE_BADGE = {
  owner: "bg-purple-500/20 text-purple-300 border-purple-500/40",
  admin: "bg-[#6C63FF]/20 text-[#9D9AFF] border-[#6C63FF]/40",
  manager: "bg-blue-500/20 text-blue-300 border-blue-500/40",
  front_desk: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40",
  accountant: "bg-amber-500/20 text-amber-300 border-amber-500/40",
  read_only: "bg-slate-500/20 text-slate-300 border-slate-500/40",
};

const STATUS_BADGE = (u) => {
  if (u.is_locked) return <Badge className="bg-red-500/20 text-red-300 border-red-500/40 flex items-center gap-1"><Lock className="h-3 w-3" /> Locked</Badge>;
  if (u.is_active === false) return <Badge className="bg-slate-500/20 text-slate-300 border-slate-500/40 flex items-center gap-1"><UserX className="h-3 w-3" /> Disabled</Badge>;
  if (u.must_change_password) return <Badge className="bg-amber-500/20 text-amber-300 border-amber-500/40 flex items-center gap-1"><RefreshCw className="h-3 w-3" /> Password change required</Badge>;
  if (u.mfa_enabled) return <Badge className="bg-emerald-500/20 text-emerald-300 border-emerald-500/40 flex items-center gap-1"><Shield className="h-3 w-3" /> MFA Enabled</Badge>;
  return <Badge className="bg-emerald-500/20 text-emerald-300 border-emerald-500/40 flex items-center gap-1"><UserCheck className="h-3 w-3" /> Active</Badge>;
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
  const [loadError, setLoadError] = useState(null);
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
  // Step-up prompt for MFA changes: { pending: { type, user }, busy, error }.
  // The typed password is handed straight to performConfirm and is never held in
  // this page's state.
  const [pwPrompt, setPwPrompt] = useState(null);
  // The one-time enrolment secret returned by enable_mfa: { user, secret, uri }.
  const [mfaHandoff, setMfaHandoff] = useState(null);

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const list = await db.users.list();
      setUsers(list);
    } catch (e) {
      // "No users found." on a failed read implies the roster is empty, which for an
      // account-management screen invites the admin to create a duplicate of someone
      // who already exists.
      setLoadError(e?.message || String(e));
      toast({ variant: "destructive", title: "Error", description: e.message });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) =>
      (u.username || "").toLowerCase().includes(q) ||
      (u.email || "").toLowerCase().includes(q) ||
      (u.full_name || "").toLowerCase().includes(q) ||
      (u.role || "").toLowerCase().includes(q)
    );
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
    // Every problem with the form is reported in ONE toast. Five separate early
    // returns meant five submit attempts to learn five things, and because each
    // attempt pushed its own toast the screen filled with a stack of them. The
    // three checks above stay as early returns on purpose: missing Web Crypto, a
    // rate limit and a stale CSRF token are not things the admin can fix by
    // editing a field. See BRAIN_TROUBLESHOOTING.md section 30.
    const { errors, values } = validateUserForm(form);
    const problems = [...errors];
    if (password !== confirmPassword) problems.push("Passwords do not match.");
    const strength = validatePasswordStrength(password);
    if (strength) problems.push(strength);
    if (problems.length > 0) {
      toast({ variant: "destructive", title: "Check the form", description: problems.join(" ") });
      return;
    }
    const { username: sanitizedUsername, email: sanitizedEmail, full_name: sanitizedFullName } = values;
    setActionBusy(true);
    try {
      // The dialog's "Require password change at next login" switch used to be
      // decorative: this call hard-coded `true`, so turning it off changed
      // nothing and the roster still showed "Password change required". Send
      // what the admin actually chose. Default stays ON (EMPTY_FORM).
      const mustChange = form.must_change_password !== false;
      await db.users.create(me, {
        username: sanitizedUsername,
        email: sanitizedEmail,
        full_name: sanitizedFullName,
        role: form.role,
        permissions: form.permissions,
        property_access: form.property_mode === "all" ? "all" : form.property_ids,
        is_active: true,
        password,
        must_change_password: mustChange,
      });
      toast({
        title: "User created",
        description: mustChange
          ? `${sanitizedUsername} can now log in. They will be asked to set a new password on first login.`
          : `${sanitizedUsername} can now log in with the password you set.`,
      });
      setCreateOpen(false);
      setForm({ ...EMPTY_FORM, permissions: defaultPermissionsForRole("front_desk") });
      setPassword(""); setConfirmPassword(""); setShowPassword(false);
      rotateCsrfToken();
      await load();
    } catch (e) {
      toast({ variant: "destructive", title: "Error", description: e.message });
    } finally {
      setActionBusy(false);
    }
  };

  // The Add User dialog promised "A temporary password will be generated." and
  // then made the admin invent one that satisfies a seven-rule policy the
  // placeholder described wrongly. `generateTemporaryPassword` already existed
  // and was wired only into the reset dialog, so the promise is now kept here
  // instead of being deleted. It draws until the result satisfies
  // validatePasswordStrength, so a generated password is never refused.
  const handleGeneratePassword = () => {
    try {
      const generated = generateTemporaryPassword();
      setPassword(generated);
      setConfirmPassword(generated);
      // Reveal it. A password the admin cannot read is one they cannot pass on,
      // and this dialog is the only place it is ever shown.
      setShowPassword(true);
    } catch {
      toast({
        variant: "destructive",
        title: "Cannot generate a password",
        description: "This browser does not expose the Web Crypto API. Type a password instead, or open the site over HTTPS.",
      });
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
    // Same one-toast rule as handleCreate. `previousUsername` grandfathers the
    // stored name so an admin can fix somebody's email without first being
    // forced to rename an account created under an older rule.
    const { errors, values } = validateUserForm(editForm, { previousUsername: editUser.username });
    if (errors.length > 0) {
      toast({ variant: "destructive", title: "Check the form", description: errors.join(" ") });
      return;
    }
    const { username: sanitizedUsername, email: sanitizedEmail, full_name: sanitizedFullName } = values;
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
    } catch (e) {
      toast({ variant: "destructive", title: "Error", description: e.message });
    } finally {
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
        if (strength) { toast({ variant: "destructive", title: "Error", description: strength }); return; }
      }
      await db.users.resetPassword(me, resetUser.id, newPassword);
      if (resetAction === "temp") {
        toast({
          title: "Temporary password generated",
          description: `Give ${resetUser.username} the temporary password: ${newPassword}`,
        });
      } else {
        toast({ title: "Password reset", description: "The user will be asked to change it at next login." });
      }
      setResetUser(null);
      setResetPassword(""); setResetAction("temp");
      rotateCsrfToken();
    } catch (e) {
      toast({ variant: "destructive", title: "Error", description: e.message });
    } finally {
      setActionBusy(false);
    }
  };

  // Turning a second factor OFF, or replacing one that is already live, is a
  // step-up operation server-side (custom_user_admin#assertActorPassword) and it
  // asks for the ADMIN's OWN password, not the target user's. An admin who never
  // enrolled MFA has no code of their own to give, and no admin can produce
  // another user's code — a password is the only factor the actor always holds.
  const needsStepUp = (type, u) =>
    type === "disable_mfa" || (type === "enable_mfa" && !!u?.mfa_enabled);

  const performConfirm = async ({ type, user: u }, currentPassword) => {
    setActionBusy(true);
    try {
      if (type === "delete") {
        await db.users.delete(me, u.id);
        toast({ title: "User deleted", description: `${u.username} was removed.` });
      } else if (type === "disable") {
        await db.users.setStatus(me, u.id, "disabled");
        toast({ title: "User disabled", description: `${u.username} can no longer log in.` });
      } else if (type === "enable") {
        await db.users.setStatus(me, u.id, "enabled");
        toast({ title: "User enabled", description: `${u.username} can log in again.` });
      } else if (type === "lock") {
        await db.users.setStatus(me, u.id, "locked");
        toast({ title: "User locked", description: `${u.username} is now locked out.` });
      } else if (type === "unlock") {
        await db.users.setStatus(me, u.id, "unlocked");
        toast({ title: "User unlocked", description: `${u.username} can log in again.` });
      } else if (type === "enable_mfa") {
        const result = await db.users.enableMfa(me, u.id, currentPassword);
        // The secret is returned exactly once and is the only way the user can
        // finish enrolment. Saying "enabled" while dropping it on the floor left
        // the admin with a locked-out user and nothing to hand them, so show it.
        setMfaHandoff({ user: u, secret: result?.secret || null, uri: result?.uri || null });
      } else if (type === "disable_mfa") {
        await db.users.disableMfa(me, u.id, currentPassword);
        toast({
          title: "MFA Disabled",
          description: `MFA is off for ${u.username} and their sessions were signed out.`,
        });
      }
      setConfirmAction(null);
      setPwPrompt(null);
      rotateCsrfToken();
      await load();
    } catch (e) {
      const message = e?.message || "The action could not be completed.";
      // A refused step-up password stays in its dialog to be retyped; anything
      // else closes it, because retyping a correct password will not help.
      if (currentPassword !== undefined && /password/i.test(message)) {
        setPwPrompt((p) => (p ? { ...p, busy: false, error: message } : p));
        return;
      }
      setPwPrompt(null);
      toast({ variant: "destructive", title: "Error", description: message });
    } finally {
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
    const action = confirmAction;
    if (needsStepUp(action.type, action.user)) {
      // Hand off to the password dialog and take this one down, so exactly one
      // dialog is ever on screen. The action is carried in pwPrompt.pending.
      setConfirmAction(null);
      setPwPrompt({ pending: action, busy: false, error: null });
      return;
    }
    await performConfirm(action, undefined);
  };

  const isSelf = (u) => me && String(me.id) === String(u.id);
  const isSelfEdit = editUser && isSelf(editUser);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div>
            <CardTitle className="text-xl">User Management</CardTitle>
            <CardDescription>Create accounts, grant permissions, and manage access.</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="icon" onClick={load} title="Refresh">
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            </Button>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="mr-2 h-4 w-4" /> Add User
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="relative max-w-sm">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search users by name, email, or role..."
              className="pl-9"
            />
          </div>

          <div className="rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Property Access</TableHead>
                  <TableHead>MFA</TableHead>
                  <TableHead>Last Login</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow><TableCell colSpan={7} className="py-10 text-center text-muted-foreground">Loading users...</TableCell></TableRow>
                ) : loadError ? (
                  <TableRow>
                    <TableCell colSpan={7} className="py-10 text-center">
                      <p className="font-medium text-[#FF5C5C]">Could not load the user list.</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Accounts may exist that are not shown here — do not treat this as an empty roster. {loadError}
                      </p>
                      <Button variant="outline" size="sm" className="mt-3" onClick={load}>Try again</Button>
                    </TableCell>
                  </TableRow>
                ) : filtered.length === 0 ? (
                  <TableRow><TableCell colSpan={7} className="py-10 text-center text-muted-foreground">{users.length === 0 ? "No users found." : "No users match your search."}</TableCell></TableRow>
                ) : filtered.map((u) => (
                  <TableRow key={u.id}>
                    <TableCell>
                      <div className="font-medium">{u.username}{isSelf(u) && <span className="ml-1 text-xs text-muted-foreground">(you)</span>}</div>
                      <div className="text-xs text-muted-foreground">{u.full_name || "—"}</div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{u.email}</TableCell>
                    <TableCell><Badge className={`border ${ROLE_BADGE[u.role] || ROLE_BADGE.read_only}`}>{ROLES.find((r) => r.key === u.role)?.label || u.role}</Badge></TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {u.property_access === "all" ? "All properties" : Array.isArray(u.property_access) ? `${u.property_access.length} property(ies)` : "None"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{u.last_login ? new Date(u.last_login).toLocaleString() : "Never"}</TableCell>
                    <TableCell>
                      {u.mfa_enabled ? (
                        <Badge className="bg-emerald-500/20 text-emerald-300 border-emerald-500/40 flex items-center gap-1">
                          <Shield className="h-3 w-3" /> Enabled
                        </Badge>
                      ) : (
                        <Badge className="bg-slate-500/20 text-slate-300 border-slate-500/40 flex items-center gap-1">
                          <ShieldOff className="h-3 w-3" /> Disabled
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>{STATUS_BADGE(u)}</TableCell>
<TableCell>
                       <div className="flex items-center justify-end gap-1">
                         <Button variant="ghost" size="sm" onClick={() => openEdit(u)} title="Edit user / permissions">
                           <UserCog className="h-4 w-4" />
                         </Button>
                         <Button variant="ghost" size="sm" onClick={() => { setResetUser(u); setResetPassword(""); setResetAction("temp"); setResetShow(false); }} title="Reset password">
                           <RefreshCw className="h-4 w-4" />
                         </Button>
                         {u.mfa_enabled ? (
                           <Button variant="ghost" size="sm" onClick={() => setConfirmAction({ type: "disable_mfa", user: u })} title="Disable MFA" className="text-amber-400 hover:text-amber-300">
                             <ShieldOff className="h-4 w-4" />
                           </Button>
                         ) : (
                           <Button variant="ghost" size="sm" onClick={() => setConfirmAction({ type: "enable_mfa", user: u })} title="Enable MFA" className="text-emerald-400 hover:text-emerald-300">
                             <Shield className="h-4 w-4" />
                           </Button>
                         )}
                         {!u.is_locked ? (
                           <Button variant="ghost" size="sm" onClick={() => setConfirmAction({ type: "lock", user: u })} title="Lock account">
                             <Lock className="h-4 w-4" />
                           </Button>
                         ) : (
                           <Button variant="ghost" size="sm" onClick={() => setConfirmAction({ type: "unlock", user: u })} title="Unlock account">
                             <LockOpen className="h-4 w-4" />
                           </Button>
                         )}
                         {u.is_active === false ? (
                           <Button variant="ghost" size="sm" onClick={() => setConfirmAction({ type: "enable", user: u })} title="Enable account">
                             <UserCheck className="h-4 w-4" />
                           </Button>
                         ) : (
                           <Button variant="ghost" size="sm" onClick={() => setConfirmAction({ type: "disable", user: u })} title="Disable account">
                             <UserX className="h-4 w-4" />
                           </Button>
                         )}
                         <Button variant="ghost" size="sm" className="text-red-400 hover:text-red-300" onClick={() => setConfirmAction({ type: "delete", user: u })} title="Delete user">
                           <Trash2 className="h-4 w-4" />
                         </Button>
                       </div>
                     </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* ── Add user dialog ── */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Add User</DialogTitle>
            <DialogDescription>Create a new login. Set a password below, or generate a strong one.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Username *</Label>
                <Input value={form.username} onChange={(e) => setFormField("username", e.target.value)} placeholder="jsmith" />
              </div>
              <div className="space-y-1.5">
                <Label>Email *</Label>
                <Input type="email" value={form.email} onChange={(e) => setFormField("email", e.target.value)} placeholder="user@example.com" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Full name</Label>
              <Input value={form.full_name} onChange={(e) => setFormField("full_name", e.target.value)} placeholder="Jane Smith" />
            </div>
            <div className="space-y-1.5">
              <Label>Role</Label>
              <Select value={form.role} onValueChange={(v) => setFormField("role", v)}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ROLES.map((r) => <SelectItem key={r.key} value={r.key}>{r.label}</SelectItem>)}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">Permissions default to the role and can be fine-tuned after creating.</p>
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label>Temporary password *</Label>
                <button type="button" onClick={handleGeneratePassword} className="text-xs font-medium text-[#9D9AFF] hover:underline">
                  Generate a strong one
                </button>
              </div>
              <div className="relative">
                <Input type={showPassword ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Type or generate a password" />
                <button type="button" onClick={() => setShowPassword((v) => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground" tabIndex={-1}>
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <p className="text-xs text-muted-foreground">{PASSWORD_HELP}</p>
            </div>
            <div className="space-y-1.5">
              <Label>Confirm password *</Label>
              <Input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
            </div>
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <Label>Require password change at next login</Label>
                <p className="text-xs text-muted-foreground">Recommended for new and temporary passwords.</p>
              </div>
              <Switch checked={form.must_change_password !== false} onCheckedChange={(v) => setFormField("must_change_password", v)} />
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
            <Button onClick={handleCreate} disabled={actionBusy}>
              {actionBusy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Create User
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Edit user dialog ── */}
      {editUser && editForm && (
        <Dialog open onOpenChange={() => setEditUser(null)}>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Edit User — {editUser.username}</DialogTitle>
              <DialogDescription>
                {isSelf(editUser) ? "You can only update your own profile fields here." : "Changes to permissions and property access take effect immediately."}
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-2">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Username</Label>
                  <Input value={editForm.username} onChange={(e) => setEditForm((f) => ({ ...f, username: e.target.value }))} />
                </div>
                <div className="space-y-1.5">
                  <Label>Email</Label>
                  <Input type="email" value={editForm.email} onChange={(e) => setEditForm((f) => ({ ...f, email: e.target.value }))} />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>Full name</Label>
                <Input value={editForm.full_name} onChange={(e) => setEditForm((f) => ({ ...f, full_name: e.target.value }))} />
              </div>
              {!isSelfEdit && (<>
              <div className="space-y-1.5">
                <Label>Role</Label>
                <Select value={editForm.role} onValueChange={(v) => {
                  const defaults = defaultPermissionsForRole(v);
                  setEditForm((f) => ({ ...f, role: v, permissions: { ...defaults } }));
                }}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {ROLES.map((r) => <SelectItem key={r.key} value={r.key}>{r.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>

              {/* Permissions */}
              <div className="space-y-2 rounded-lg border p-4">
                <Label className="text-sm font-medium">Permissions</Label>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {PERMISSIONS.map((p) => (
                    <div key={p.key} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
                      <div>
                        <span className="text-sm">{p.label}</span>
                        <span className="ml-2 text-[10px] uppercase text-muted-foreground">{p.group}</span>
                      </div>
                      <Checkbox
                        checked={!!editForm.permissions[p.key]}
                        onCheckedChange={(v) => setEditForm((f) => ({ ...f, permissions: { ...f.permissions, [p.key]: !!v } }))}
                      />
                    </div>
                  ))}
                </div>
              </div>

              {/* Property access */}
              <div className="space-y-2 rounded-lg border p-4">
                <Label className="text-sm font-medium">Property Access</Label>
                <div className="flex items-center gap-4">
                  <label className="flex items-center gap-2 text-sm">
                    <input type="radio" name="prop_mode" checked={editForm.property_mode === "all"} onChange={() => setEditForm((f) => ({ ...f, property_mode: "all", property_ids: [] }))} />
                    All properties
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="radio" name="prop_mode" checked={editForm.property_mode === "specific"} onChange={() => setEditForm((f) => ({ ...f, property_mode: "specific" }))} />
                    Selected properties only
                  </label>
                </div>
                {editForm.property_mode === "specific" && (
                  <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {properties.map((p) => (
                      <label key={p.id} className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
                        <Checkbox
                          checked={editForm.property_ids.includes(p.id)}
                          onCheckedChange={(v) => setEditForm((f) => ({
                            ...f,
                            property_ids: v ? [...f.property_ids, p.id] : f.property_ids.filter((x) => x !== p.id),
                          }))}
                        />
                        {p.name || p.code || p.id}
                        <span className="ml-auto text-xs text-muted-foreground">{p.code}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
              </>)}

              {isSelfEdit && (
                <div className="rounded-lg border border-muted px-4 py-3 text-xs text-muted-foreground">
                  Role, permissions, and property access for your own account are managed by another Owner/Admin. Use the Users list to edit other accounts.
                </div>
              )}
            </div>
            <DialogFooter>
              <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
              <Button onClick={handleEditSave} disabled={actionBusy}>
                {actionBusy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Save Changes
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* ── Reset password dialog ── */}
      {resetUser && (
        <Dialog open onOpenChange={() => setResetUser(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Reset password — {resetUser.username}</DialogTitle>
              <DialogDescription>The user will be forced to change their password at next login.</DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <div className="space-y-2">
                <Label>Choose an option</Label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setResetAction("temp")}
                    className={`rounded-lg border p-3 text-left text-sm ${resetAction === "temp" ? "border-[#6C63FF] bg-[#6C63FF]/10" : "border-border"}`}
                  >
                    <div className="font-medium">Generate temporary</div>
                    <div className="text-xs text-muted-foreground">Random strong password shown to you once.</div>
                  </button>
                  <button
                    type="button"
                    onClick={() => setResetAction("permanent")}
                    className={`rounded-lg border p-3 text-left text-sm ${resetAction === "permanent" ? "border-[#6C63FF] bg-[#6C63FF]/10" : "border-border"}`}
                  >
                    <div className="font-medium">Set a password</div>
                    <div className="text-xs text-muted-foreground">Type a specific password below.</div>
                  </button>
                </div>
              </div>
              {resetAction === "permanent" && (
                <div className="space-y-1.5">
                  <Label>New password</Label>
                  <div className="relative">
                    <Input type={resetShow ? "text" : "password"} value={resetPassword} onChange={(e) => setResetPassword(e.target.value)} placeholder="Type a password" />
                    <button type="button" onClick={() => setResetShow((v) => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground" tabIndex={-1}>
                      {resetShow ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                  <p className="text-xs text-muted-foreground">{PASSWORD_HELP}</p>
                </div>
              )}
            </div>
            <DialogFooter>
              <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
              <Button onClick={handleResetPassword} disabled={actionBusy}>
                {actionBusy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Reset Password
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* ── Confirm action dialog ── */}
      {confirmAction && (
        <Dialog open onOpenChange={() => setConfirmAction(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {confirmAction.type === "delete" && "Delete user"}
                {confirmAction.type === "disable" && "Disable account"}
                {confirmAction.type === "enable" && "Enable account"}
                {confirmAction.type === "lock" && "Lock account"}
                {confirmAction.type === "unlock" && "Unlock account"}
                {confirmAction.type === "enable_mfa" && "Enable MFA"}
                {confirmAction.type === "disable_mfa" && "Disable MFA"}
              </DialogTitle>
              <DialogDescription>
                {confirmAction.type === "delete" && `Delete ${confirmAction.user.username} permanently? Their login will stop working immediately.`}
                {confirmAction.type === "disable" && `${confirmAction.user.username} will not be able to log in until re-enabled.`}
                {confirmAction.type === "enable" && `${confirmAction.user.username} will be able to log in again.`}
                {confirmAction.type === "lock" && `${confirmAction.user.username} will be locked out immediately.`}
                {confirmAction.type === "unlock" && `${confirmAction.user.username} will be able to log in again.`}
                {confirmAction.type === "enable_mfa" && `Enable two-factor authentication for ${confirmAction.user.username}? They will need to set up an authenticator app on next login.`}
                {confirmAction.type === "disable_mfa" && `Disable two-factor authentication for ${confirmAction.user.username}? This reduces account security.`}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
              <Button
                variant={confirmAction.type === "delete" ? "destructive" : "default"}
                onClick={runConfirm}
                disabled={actionBusy}
              >
                {actionBusy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Confirm
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* ── Step-up: the admin's own password, for MFA changes ── */}
      <PasswordConfirmDialog
        isOpen={!!pwPrompt}
        busy={!!pwPrompt?.busy}
        error={pwPrompt?.error || null}
        title={pwPrompt?.pending?.type === "disable_mfa" ? "Disable MFA for this user" : "Replace this user's second factor"}
        description={
          pwPrompt?.pending?.type === "disable_mfa"
            ? `Enter YOUR password to turn two-factor authentication off for ${pwPrompt?.pending?.user?.username}. Their sessions will be signed out.`
            : `Enter YOUR password to issue a new authenticator secret for ${pwPrompt?.pending?.user?.username}. Their current authenticator entry will stop working.`
        }
        confirmLabel={pwPrompt?.pending?.type === "disable_mfa" ? "Disable MFA" : "Replace factor"}
        onCancel={() => setPwPrompt(null)}
        onConfirm={(pw) => performConfirm(pwPrompt.pending, pw)}
      />

      {/* ── One-time MFA enrolment hand-off ── */}
      {/* enable_mfa returns the new secret exactly once and revokes the target's
          other sessions. Discarding the secret here (the old behaviour) left the
          user signed out of an account now demanding a code that nobody on the
          property could produce. It has to be displayed so the admin can hand it
          over in person. */}
      {mfaHandoff && (
        <Dialog open onOpenChange={() => setMfaHandoff(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Give {mfaHandoff.user.username} their setup key</DialogTitle>
              <DialogDescription>
                Shown once and never again. {mfaHandoff.user.username} must enter this key into an
                authenticator app before their next login, or they will not be able to sign in.
                Hand it over in person — not by email or chat.
              </DialogDescription>
            </DialogHeader>
            {mfaHandoff.secret ? (
              <div className="space-y-3">
                <div>
                  <Label>Setup key</Label>
                  <div className="mt-1 select-all break-all rounded-md border border-white/10 bg-black/30 p-3 font-mono text-sm tracking-wider text-emerald-300">
                    {mfaHandoff.secret}
                  </div>
                </div>
                {mfaHandoff.uri && (
                  <div>
                    <Label>Or paste this into the app</Label>
                    <div className="mt-1 select-all break-all rounded-md border border-white/10 bg-black/30 p-2 font-mono text-[11px] text-slate-400">
                      {mfaHandoff.uri}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              // Server said yes but returned nothing usable. Saying "enabled" here
              // would be a lie the admin cannot act on.
              <p className="text-sm text-red-400">
                MFA was enabled but no setup key came back, so there is nothing to hand over.
                Disable MFA for this user and try again.
              </p>
            )}
            <DialogFooter>
              <Button onClick={() => setMfaHandoff(null)}>
                {mfaHandoff.secret ? "I have shared this key" : "Close"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
