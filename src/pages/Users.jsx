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
import { Eye, EyeOff, Loader2, Lock, LockOpen, Plus, RefreshCw, Search, Trash2, UserCog, UserX, UserCheck } from "lucide-react";
import { useAuth } from "@/lib/AuthContext";
import db from "@/api/base44Client";
import { useProperties } from "@/lib/useHotelData";
import { ROLES, PERMISSIONS, PERMISSION_KEYS, defaultPermissionsForRole } from "@/lib/permissions";
import { isCryptoAvailable, validatePasswordStrength, generateTemporaryPassword } from "@/lib/security";
import { getCsrfToken, sensitiveActionRateLimiter, validateCsrfToken, rotateCsrfToken, sanitizeEmail, sanitizeAlphanumeric, sanitizeText } from "@/lib/securityUtils";

const ROLE_BADGE = {
  owner: "bg-purple-500/20 text-purple-300 border-purple-500/40",
  admin: "bg-[#6C63FF]/20 text-[#9D9AFF] border-[#6C63FF]/40",
  manager: "bg-blue-500/20 text-blue-300 border-blue-500/40",
  front_desk: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40",
  accountant: "bg-amber-500/20 text-amber-300 border-amber-500/40",
  read_only: "bg-slate-500/20 text-slate-300 border-slate-500/40",
};

const STATUS_BADGE = (u) => {
  if (u.is_locked) return <Badge className="bg-red-500/20 text-red-300 border-red-500/40">Locked</Badge>;
  if (u.is_active === false) return <Badge className="bg-slate-500/20 text-slate-300 border-slate-500/40">Disabled</Badge>;
  if (u.must_change_password) return <Badge className="bg-amber-500/20 text-amber-300 border-amber-500/40">Password change required</Badge>;
  return <Badge className="bg-emerald-500/20 text-emerald-300 border-emerald-500/40">Active</Badge>;
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
    } catch (e) {
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
    const sanitizedFullName = sanitizeText(form.full_name);
    if (sanitizedUsername !== form.username || sanitizedEmail !== form.email) {
      toast({ variant: "destructive", title: "Error", description: "Invalid characters in username or email." });
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
      setPassword(""); setConfirmPassword(""); setShowPassword(false);
      rotateCsrfToken();
      await load();
    } catch (e) {
      toast({ variant: "destructive", title: "Error", description: e.message });
    } finally {
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
    const sanitizedFullName = sanitizeText(editForm.full_name);
    if (sanitizedUsername !== editForm.username || sanitizedEmail !== editForm.email) {
      toast({ variant: "destructive", title: "Error", description: "Invalid characters in username or email." });
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
      }
      setConfirmAction(null);
      rotateCsrfToken();
      await load();
    } catch (e) {
      toast({ variant: "destructive", title: "Error", description: e.message });
    } finally {
      setActionBusy(false);
    }
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
                  <TableHead>Last Login</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow><TableCell colSpan={7} className="py-10 text-center text-muted-foreground">Loading users...</TableCell></TableRow>
                ) : filtered.length === 0 ? (
                  <TableRow><TableCell colSpan={7} className="py-10 text-center text-muted-foreground">No users found.</TableCell></TableRow>
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
                    <TableCell>{STATUS_BADGE(u)}</TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => openEdit(u)} title="Edit user / permissions">
                          <UserCog className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => { setResetUser(u); setResetPassword(""); setResetAction("temp"); setResetShow(false); }} title="Reset password">
                          <RefreshCw className="h-4 w-4" />
                        </Button>
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
            <DialogDescription>Create a new login. A temporary password will be generated.</DialogDescription>
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
              <Label>Temporary password *</Label>
              <div className="relative">
                <Input type={showPassword ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters, upper/lowercase + number" />
                <button type="button" onClick={() => setShowPassword((v) => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground" tabIndex={-1}>
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
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
                    <Input type={resetShow ? "text" : "password"} value={resetPassword} onChange={(e) => setResetPassword(e.target.value)} placeholder="At least 8 characters, upper/lowercase + number" />
                    <button type="button" onClick={() => setResetShow((v) => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground" tabIndex={-1}>
                      {resetShow ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
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
              </DialogTitle>
              <DialogDescription>
                {confirmAction.type === "delete" && `Delete ${confirmAction.user.username} permanently? Their login will stop working immediately.`}
                {confirmAction.type === "disable" && `${confirmAction.user.username} will not be able to log in until re-enabled.`}
                {confirmAction.type === "enable" && `${confirmAction.user.username} will be able to log in again.`}
                {confirmAction.type === "lock" && `${confirmAction.user.username} will be locked out immediately.`}
                {confirmAction.type === "unlock" && `${confirmAction.user.username} will be able to log in again.`}
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
    </div>
  );
}
