import { createClientFromRequest } from "npm:@base44/sdk@^0.8.41";
import crypto from "node:crypto";
import { z } from "npm:zod";

const ALLOWED_ROLES = ['owner', 'admin', 'manager', 'front_desk', 'accountant', 'read_only', 'user'];

async function hashPasswordScrypt(password, saltHex) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, saltHex, 64, { N: 16384, r: 8, p: 1 }, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey.toString('hex'));
    });
  });
}

const PERMISSION_KEYS = [
  "view_dashboard",
  "import_reports",
  "delete_imports",
  "replace_imports",
  "export_reports",
  "manage_expenses",
  "manage_ota_commissions",
  "manage_properties",
  "manage_users",
  "view_financial_reports",
  "manage_settings",
  "view_audit_logs",
  "backup_restore",
  "system_administration",
  "manage_pricing",
];

const all = () => PERMISSION_KEYS.reduce((acc, k) => ({ ...acc, [k]: true }), {});

const ROLE_DEFAULTS = {
  owner: all(),
  admin: all(),
  manager: {
    view_dashboard: true,
    import_reports: true,
    delete_imports: true,
    replace_imports: true,
    export_reports: true,
    manage_expenses: true,
    manage_ota_commissions: true,
    manage_properties: false,
    manage_users: false,
    view_financial_reports: true,
    manage_settings: false,
    view_audit_logs: false,
    backup_restore: false,
    system_administration: false,
    manage_pricing: true,
  },
  front_desk: {
    view_dashboard: true,
    import_reports: true,
    delete_imports: false,
    replace_imports: false,
    export_reports: false,
    manage_expenses: false,
    manage_ota_commissions: false,
    manage_properties: false,
    manage_users: false,
    view_financial_reports: false,
    manage_settings: false,
    view_audit_logs: false,
    backup_restore: false,
    system_administration: false,
  },
  accountant: {
    view_dashboard: true,
    import_reports: false,
    delete_imports: false,
    replace_imports: false,
    export_reports: true,
    manage_expenses: true,
    manage_ota_commissions: true,
    manage_properties: false,
    manage_users: false,
    view_financial_reports: true,
    manage_settings: false,
    view_audit_logs: false,
    backup_restore: false,
    system_administration: false,
  },
  read_only: {
    view_dashboard: true,
    import_reports: false,
    delete_imports: false,
    replace_imports: false,
    export_reports: false,
    manage_expenses: false,
    manage_ota_commissions: false,
    manage_properties: false,
    manage_users: false,
    view_financial_reports: true,
    manage_settings: false,
    view_audit_logs: false,
    backup_restore: false,
    system_administration: false,
  },
};

const defaultPermissionsForRole = (role) => ({ ...(ROLE_DEFAULTS[role] || ROLE_DEFAULTS.read_only) });


// The fields a browser may see, as an ALLOWLIST.
//
// This used to be a denylist: it destructured the sensitive columns away and
// spread the rest, which made every column later added to the User entity public
// by default. That is how `mfa_secret_pending` got out. custom_auth_login writes
// a live TOTP enrolment seed to that column when it force-enrols an owner or
// admin, nobody thought to add it here, and so `list`, `search`, `getById`,
// `update`, `set_status` and the login response itself handed any admin the
// second-factor seed of every colleague mid-enrolment - with no audit row to
// show it had been read. An allowlist fails closed instead: a new column is
// invisible here until someone deliberately names it.
//
// Every entry below is either a field the UI provably reads (src/pages/Users.jsx,
// src/pages/Settings.jsx, src/lib/AuthContext.jsx, src/components/Layout.jsx,
// src/lib/launchPolicy.js, and mirrorRemoteUserIntoLocal in
// src/api/base44Client.js) or a non-secret operational field an admin screen
// needs to explain why an account is in the state it is in.
//
// Deliberately absent, and each one for a reason: password_hash and salt (the
// credential), mfa_secret and mfa_secret_pending (the second factor itself),
// mfa_last_counter (tells an observer when the factor was last used, and is only
// ever compared server-side), reset_token_hash and reset_token_expires_at (a
// live reset capability), session_created and session_expires (session bookkeeping
// the client already has in its cookie).
//
// Kept byte-identical to the copies in the other auth functions. The base44 host
// gives these functions no shared module they can all import, so
// scripts/probe-auth-hardening.mjs section 17 asserts the copies never drift
// and that no sensitive column from base44/entities/User.jsonc is ever named here.
const PUBLIC_USER_FIELDS = [
  'id', 'email', 'username', 'full_name', 'display_name', 'role',
  'property_access', 'permissions', 'is_active', 'is_locked',
  'must_change_password', 'mfa_enabled', 'email_confirmed',
  'last_login', 'failed_login_count', 'locked_until',
  'created_date', 'updated_date',
];

export function publicUser(user) {
  if (!user) return null;
  const safe = {};
  for (const field of PUBLIC_USER_FIELDS) {
    if (user[field] !== undefined) safe[field] = user[field];
  }
  return safe;
}

async function currentSessionUser(base44, req) {
  const cookieHeader = req.headers.get("cookie") || "";
  const match = cookieHeader.match(/base44_session=([^;]+)/);
  if (!match) return null;
  const tokenHash = crypto.createHash('sha256').update(match[1]).digest('hex');
  const sessions = await base44.asServiceRole.entities.Session.filter({ token_hash: tokenHash }, null, 1, 0);
  const session = sessions[0];
  if (!session || session.is_revoked || new Date(session.expires_at) < new Date()) return null;
  const actor = await base44.asServiceRole.entities.User.get(session.user_id);
  if (!actor || !actor.is_active || actor.is_locked) return null;
  return actor;
}

export default async function (req) {
  try {
  const _csrfHeader = req.headers.get('x-csrf-token');
  const _cookieHeader = req.headers.get('cookie') || '';
  const _csrfCookieMatch = _cookieHeader.match(/__Host-csrf_token=([^;]+)/);
  const _csrfCookie = _csrfCookieMatch ? _csrfCookieMatch[1] : null;
  if (!_csrfHeader || !_csrfCookie || _csrfHeader !== _csrfCookie) {
    return Response.json({ error: "Invalid CSRF token" }, { status: 403 });
  }

    const base44 = createClientFromRequest(req);
    let body;
    try {
      body = await req.json();
    } catch (e) {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    const UserDataSchema = z.object({
      username: z.string().regex(/^[a-zA-Z0-9_-]+$/, "Username can only contain alphanumeric characters, underscores, and dashes").min(3).max(30),
      email: z.string().email().max(100),
      password: z.string().min(12).max(128),
      role: z.enum(['owner', 'admin', 'manager', 'front_desk', 'accountant', 'read_only', 'user']).default('read_only'),
      assigned_property_ids: z.array(z.union([z.string(), z.number()])).default([]),
      property_access: z.union([z.string(), z.array(z.union([z.string(), z.number()]))]).optional(),
      full_name: z.string().max(100).default(''),
      must_change_password: z.boolean().default(true),
    }).strict();

    const BodySchema = z.object({
      userData: UserDataSchema
    }).strict();

    const parseResult = BodySchema.safeParse(body);
    if (!parseResult.success) {
      const details = parseResult.error.errors.map(err => ({ field: err.path.join('.'), issue: err.message }));
      return Response.json({ error: "Validation failed", details }, { status: 400 });
    }

    const {
      username,
      email,
      password,
      role,
      assigned_property_ids,
      property_access,
      full_name,
      must_change_password,
    } = parseResult.data.userData;

    const actor = await currentSessionUser(base44, req);
    const isAdminCaller = actor && (actor.role === 'owner' || actor.role === 'admin');

    if (!isAdminCaller) {
      // Bootstrap: the very first owner may be created before any session exists.
      const owners = await base44.asServiceRole.entities.User.filter({ role: 'owner' }, null, 1, 0);
      if (owners.length > 0) {
        return Response.json({ error: "Unauthorized" }, { status: 403 });
      }
      if (role !== 'owner') {
        return Response.json({ error: "The first account must be the Owner" }, { status: 400 });
      }
    } else if (!['owner', 'admin', 'manager', 'front_desk', 'accountant', 'read_only', 'user'].includes(role)) {
      return Response.json({ error: "Invalid role" }, { status: 400 });
    }

    const emailMatch = await base44.asServiceRole.entities.User.filter({ email: email.toLowerCase() }, null, 1, 0);
    if (emailMatch.length > 0) {
      return Response.json({ error: "Email is already registered." }, { status: 400 });
    }

    const usernameMatch = await base44.asServiceRole.entities.User.filter({ username }, null, 1, 0);
    if (usernameMatch.length > 0) {
      return Response.json({ error: "Username is already taken." }, { status: 400 });
    }

    const salt = crypto.randomBytes(16).toString('hex');
    const password_hash = '$scrypt$' + await hashPasswordScrypt(password, salt);

    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetTokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');
    const resetTokenExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days

    const isPrivileged = role === 'owner' || role === 'admin';
    const finalPropertyAccess =
      property_access !== undefined
        ? (property_access === 'all' ? null : property_access)
        : isPrivileged
          ? null
          : assigned_property_ids.length > 0
            ? assigned_property_ids
            : [];

    const newUser = await base44.asServiceRole.entities.User.create({
      username,
      email: email.toLowerCase(),
      full_name: full_name || '',
      role,
      permissions: defaultPermissionsForRole(role),
      property_access: finalPropertyAccess,
      is_active: true,
      is_locked: false,
      must_change_password: !!must_change_password,
      failed_login_count: 0,
      salt,
      password_hash,
      reset_token_hash: resetTokenHash,
      reset_token_expires_at: resetTokenExpiresAt
    });

    try {
      await base44.asServiceRole.integrations.Core.SendEmail({
        to: newUser.email,
        subject: "Welcome to Red Roof Intelligence",
        body: `Your account has been created. Set your password: https://your-app.com/reset-password?token=${resetToken}`
      });
    } catch (emailErr) {
      console.error("Failed to send welcome email:", emailErr);
    }

    return Response.json({ success: true, user: publicUser(newUser) });

  } catch (err) {
    console.error("Registration error:", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
