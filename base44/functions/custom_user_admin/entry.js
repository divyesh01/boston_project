import { createClientFromRequest } from "npm:@base44/sdk@^0.8.41";
import { secrets } from "base44:runtime";
import crypto from "node:crypto";
import { z } from "npm:zod";

const _UserDataSchema = z.object({
  username: z.string().optional(),
  email: z.string().optional(),
  password: z.string().optional(),
  full_name: z.string().optional(),
  role: z.string().optional(),
  permissions: z.any().optional(),
  property_access: z.any().optional(),
  is_active: z.boolean().optional(),
  is_locked: z.boolean().optional(),
  must_change_password: z.boolean().optional(),
}).strict();

const PBKDF2_ITERATIONS = 300000;
const SALT_BYTES = 32;
const KEY_BYTES = 32;
const DERIVATION_ROUNDS = 2;

const ALLOWED_ROLES = ['owner', 'admin', 'manager', 'front_desk', 'accountant', 'read_only', 'user'];

const PERMISSION_KEYS = [
  "view_dashboard", "import_reports", "delete_imports", "replace_imports",
  "export_reports", "manage_expenses", "manage_ota_commissions", "manage_properties",
  "manage_users", "view_financial_reports", "manage_settings", "view_audit_logs",
  "backup_restore", "system_administration", "manage_pricing",
];

const all = () => PERMISSION_KEYS.reduce((acc, k) => ({ ...acc, [k]: true }), {});

const ROLE_DEFAULTS = {
  owner: all(),
  admin: all(),
  manager: {
    view_dashboard: true, import_reports: true, delete_imports: true,
    replace_imports: true, export_reports: true, manage_expenses: true,
    manage_ota_commissions: true, manage_properties: false, manage_users: false,
    view_financial_reports: true, manage_settings: false, view_audit_logs: false,
    backup_restore: false, system_administration: false, manage_pricing: true,
  },
  front_desk: {
    view_dashboard: true, import_reports: true, delete_imports: false,
    replace_imports: false, export_reports: false, manage_expenses: false,
    manage_ota_commissions: false, manage_properties: false, manage_users: false,
    view_financial_reports: false, manage_settings: false, view_audit_logs: false,
    backup_restore: false, system_administration: false,
  },
  accountant: {
    view_dashboard: true, import_reports: false, delete_imports: false,
    replace_imports: false, export_reports: true, manage_expenses: true,
    manage_ota_commissions: true, manage_properties: false, manage_users: false,
    view_financial_reports: true, manage_settings: false, view_audit_logs: false,
    backup_restore: false, system_administration: false,
  },
  read_only: {
    view_dashboard: true, import_reports: false, delete_imports: false,
    replace_imports: false, export_reports: false, manage_expenses: false,
    manage_ota_commissions: false, manage_properties: false, manage_users: false,
    view_financial_reports: true, manage_settings: false, view_audit_logs: false,
    backup_restore: false, system_administration: false,
  },
};

const defaultPermissionsForRole = (role) => ({ ...(ROLE_DEFAULTS[role] || ROLE_DEFAULTS.read_only) });

const USERNAME_RE = /^[a-zA-Z0-9_]{3,30}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function hashPasswordScrypt(password, saltHex) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, saltHex, 64, { N: 16384, r: 8, p: 1 }, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey.toString('hex'));
    });
  });
}

function deriveKey(password, saltHex, iterations) {
  return new Promise((resolve, reject) => {
    const salt = Buffer.from(saltHex, 'hex');
    crypto.pbkdf2(password, salt, iterations, KEY_BYTES, 'sha256', (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

async function hashPassword(password, saltHex) {
  let key = await deriveKey(password, saltHex, PBKDF2_ITERATIONS);
  for (let i = 1; i < DERIVATION_ROUNDS; i++) {
    const intermediateSalt = key.subarray(0, SALT_BYTES).toString('hex');
    key = await deriveKey(password, intermediateSalt, PBKDF2_ITERATIONS / DERIVATION_ROUNDS);
  }
  return key.toString('hex');
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buffer) {
  let bits = "";
  for (const byte of buffer) bits += byte.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    out += BASE32_ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  }
  return out;
}

function base32Decode(input) {
  const cleaned = input.toUpperCase().replace(/[^A-Z2-7]/g, "");
  const bits = [];
  for (const ch of cleaned) {
    const val = BASE32_ALPHABET.indexOf(ch);
    if (val < 0) continue;
    for (let b = 4; b >= 0; b--) bits.push((val >> b) & 1);
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let byte = 0;
    for (let b = 0; b < 8; b++) byte = (byte << 1) | bits[i + b];
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

function generateTotpSecret() {
  return base32Encode(crypto.randomBytes(20)).slice(0, 32);
}

function formatTotpUri(secret, label, issuer = 'Red Roof Intelligence') {
  return `otpauth://totp/${encodeURIComponent(`${issuer}:${label}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&period=30&digits=6&algorithm=SHA1`;
}

function hotp(secretBytes, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", secretBytes).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return code % 1000000;
}

function totp(secretBytes, timestampMs) {
  const counter = Math.floor(timestampMs / 30000);
  return hotp(secretBytes, counter);
}

/**
 * The 30-second counter the code matched, or -1 for no match.
 *
 * Returns the counter rather than a boolean so callers can persist it and refuse
 * anything at or below it next time (`notBefore`). A TOTP code is valid across
 * the whole ±1 window — about 90 seconds — and nothing recorded which counter
 * had been spent, so an accepted code could be replayed inside that window.
 * Kept identical in shape to the copy in custom_auth_login/entry.js; the base44
 * host gives functions no way to import a shared module.
 */
function verifyTotpToken(secretBase32, token, { window = 1, notBefore = -Infinity } = {}) {
  const secretBytes = base32Decode(secretBase32);
  const provided = String(token).replace(/\s/g, "");
  if (!/^\d{6}$/.test(provided)) return -1;
  const counter = Math.floor(Date.now() / 30000);
  for (let w = -window; w <= window; w++) {
    const candidate = counter + w;
    if (candidate <= notBefore) continue;
    const expected = String(totp(secretBytes, candidate * 30000)).padStart(6, "0");
    // Both operands are always six ASCII digits, so this cannot hit the length
    // mismatch hashesEqual() exists for.
    if (crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) {
      return candidate;
    }
  }
  return -1;
}

/** The counter a stored value represents, or -Infinity if none is recorded. */
const lastUsedCounter = (user) =>
  Number.isFinite(user && user.mfa_last_counter) ? Number(user.mfa_last_counter) : -Infinity;

/**
 * Constant-time comparison that tolerates a length mismatch.
 *
 * crypto.timingSafeEqual THROWS RangeError ("Input buffers must have the same
 * byte length") on unequal lengths, and change_own_password reached it with a
 * stored hash it does not control: the raw error text was returned to the
 * browser as the reason the password change failed. Comparing lengths first
 * leaks only the length of a derived hash, which is fixed by the algorithm and
 * is not a secret. Kept identical to the copy in custom_auth_login/entry.js.
 */
function hashesEqual(actual, expected) {
  const a = Buffer.from(String(actual ?? ''), 'utf8');
  const b = Buffer.from(String(expected ?? ''), 'utf8');
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

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

function publicUser(user) {
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

/**
 * Revoke every session for a user, optionally sparing one.
 *
 * `exceptTokenHash` exists for the self-service cases: someone rotating their own
 * password, or enrolling their own second factor, must stay signed in — the very
 * next thing enrolment asks them to do is confirm a code, and logging them out
 * first would make that impossible. Every OTHER session for that account still
 * goes, which is the point: a credential change has to evict whoever else is
 * holding the old one.
 */
async function revokeUserSessions(base44, userId, exceptTokenHash = null) {
  const sessions = await base44.asServiceRole.entities.Session.filter({ user_id: userId }, null, 500, 0);
  for (const s of sessions) {
    if (exceptTokenHash && s.token_hash === exceptTokenHash) continue;
    await base44.asServiceRole.entities.Session.update(s.id, { is_revoked: true });
  }
}

/** sha256 of the caller's session cookie, or null — pairs with revokeUserSessions. */
function sessionTokenHash(req) {
  const match = (req.headers.get("cookie") || "").match(/base44_session=([^;]+)/);
  return match ? crypto.createHash('sha256').update(match[1]).digest('hex') : null;
}

// Privileged server-side audit write. These rows MUST join the same
// tamper-evident chain that base44/functions/audit_log writes and
// base44/functions/audit_verify checks: this function previously created rows
// with no `hash` and no `previous_hash`, so the FIRST user-admin action (user
// created, role changed, password reset, MFA toggled, account deleted...) left
// the verifier reporting a permanently broken chain. A chain that is always red
// evidences nothing — nobody can tell routine breakage from an intrusion.
//
// The base44 host gives functions no way to import a shared module (every
// specifier is npm:, node: or base44:runtime), so the canonical payload is
// spelled out here as well as in the writer and the verifier.
// scripts/probe-audit-chain.mjs asserts the three copies stay identical.
async function writeAudit(base44, { action, actor, targetUser, detail }) {
  // Audit writes must never break the operation they record. A missing chain
  // secret is refused UP FRONT in the request handler instead (before anything
  // mutates), so reaching this catch means a transient backend failure, not a
  // misconfiguration.
  try {
    const chainSecret = secrets.get('AUDIT_CHAIN_SECRET');
    if (!chainSecret) throw new Error('AUDIT_CHAIN_SECRET is not configured');

    const lastEntries = await base44.asServiceRole.entities.AuditLog.filter({}, '-created_date', 1, 0);
    const lastRow = (lastEntries && lastEntries[0]) || null;
    const previousHash = (lastRow && lastRow.hash) || '0'.repeat(64);
    // Strictly increasing, because the verifier orders the chain by
    // created_date; a same-millisecond tie could be walked in the opposite
    // order to the one the rows were linked in and reported as a chain break.
    const nowIso = monotonicIso(lastRow && lastRow.created_date);

    // `|| null` rather than a bare undefined: JSON.stringify DROPS undefined
    // keys, so an undefined here would hash a different shape than the verifier
    // rebuilds from a row the backend stored as null.
    const userId = (targetUser && targetUser.id) || null;
    const performedBy = actor.username || actor.email || 'unknown';

    // AUDIT_CANONICAL_V1 = user_id,action,performed_by_id,performed_by,property_id,result,detail,created_date,previous_hash
    const canonical = JSON.stringify({
      user_id: userId,
      action,
      performed_by_id: actor.id,
      performed_by: performedBy,
      property_id: null,
      result: 'success',
      detail: detail || '',
      created_date: nowIso,
      previous_hash: previousHash,
    });
    const hash = crypto.createHash('sha256').update(`${chainSecret}:${canonical}`).digest('hex');

    await base44.asServiceRole.entities.AuditLog.create({
      user_id: userId,
      username: (targetUser && targetUser.username) || (targetUser && targetUser.email) || 'unknown',
      action,
      performed_by_id: actor.id,
      performed_by: performedBy,
      property_id: null,
      result: 'success',
      detail: detail || '',
      created_date: nowIso,
      hash,
      previous_hash: previousHash,
    });
  } catch (err) {
    console.error('[user_admin] audit write failed:', err);
  }
}

// Next ISO timestamp strictly greater than the previous row's. Mirrors
// base44/functions/audit_log/entry.js#monotonicIso (no module sharing here).
function monotonicIso(lastIso) {
  const now = Date.now();
  const last = lastIso ? Date.parse(lastIso) : NaN;
  return new Date(Number.isFinite(last) && last >= now ? last + 1 : now).toISOString();
}

async function createUser(base44, data) {
  const username = String(data.username || '').trim();
  const email = String(data.email || '').trim().toLowerCase();
  const password = data.password || '';
  const role = data.role || 'read_only';

  if (!isValidUsername(username)) throw new Error('Username must be 3-30 alphanumeric or underscore characters.');
  if (!isValidEmail(email)) throw new Error('Invalid email address.');
  if (!ALLOWED_ROLES.includes(role)) throw new Error('Invalid role.');
  if (!password) throw new Error('A password is required when creating a user.');
  const strengthErr = validatePasswordStrength(password);
  if (strengthErr) throw new Error(strengthErr);

  const byUsername = await base44.asServiceRole.entities.User.filter({ username }, null, 1, 0);
  if (byUsername.length > 0) throw new Error(`Username "${username}" is already taken.`);
  const byEmail = await base44.asServiceRole.entities.User.filter({ email }, null, 1, 0);
  if (byEmail.length > 0) throw new Error(`Email "${email}" is already registered.`);

  const salt = crypto.randomBytes(16).toString('hex');
  const password_hash = '$scrypt$' + await hashPasswordScrypt(password, salt);

  const isPrivileged = role === 'owner' || role === 'admin';
  const permissions = data.permissions === 'all' || !data.permissions
    ? defaultPermissionsForRole(role)
    : data.permissions;
  const property_access = data.property_access === 'all' || data.property_access === null
    ? null
    : Array.isArray(data.property_access)
      ? data.property_access
      : isPrivileged ? 'all' : [];

  return base44.asServiceRole.entities.User.create({
    username,
    email,
    full_name: data.full_name || '',
    role,
    permissions,
    property_access,
    is_active: data.is_active !== false,
    is_locked: false,
    must_change_password: data.must_change_password === true,
    failed_login_count: 0,
    salt,
    password_hash,
  });
}

function isValidUsername(username) {
  return USERNAME_RE.test(username);
}

function isValidEmail(email) {
  return EMAIL_RE.test(email);
}

// THE PASSWORD POLICY, server side. Kept character-for-character identical to
// custom_auth_reset_password/entry.js#validatePasswordStrength and to
// src/lib/security.js#validatePasswordStrength, which is the browser copy.
//
// Until 2026-08-20 this read `length < 8` and checked three character classes, so
// "Abcdefg1" was a perfectly valid password as far as the only gate that cannot
// be bypassed was concerned — while the UI told every user the minimum was 12
// characters with a special character and no repeated runs. A rule enforced only
// in the browser is a suggestion: the client is entirely under the caller's
// control and every action in this file is reachable with a crafted request. The
// advertised policy and the enforced policy are now the same policy. Measured
// before the change: 1078 of 4000 fuzzed inputs were accepted here and refused by
// the client (scripts/probe-password-policy.mjs section 7).
//
// Every caller is a SET-password path (create, reset_password, set_password,
// change_password) — never a verify path — so raising the bar cannot lock out an
// existing account. It only requires the next password to be a good one.
//
// Returns null when acceptable (callers test truthiness) or the message naming the
// single rule that was broken. The line-terminator rule is stated explicitly
// rather than falling out of a `.+$` regex; the long note in src/lib/security.js
// explains why that regex was not the dead code it appeared to be.
function validatePasswordStrength(password) {
  if (typeof password !== 'string' || password.length < 12) return 'Password must be at least 12 characters.';
  if (!/[a-z]/.test(password)) return 'Password must include at least one lowercase letter.';
  if (!/[A-Z]/.test(password)) return 'Password must include at least one uppercase letter.';
  if (!/[0-9]/.test(password)) return 'Password must include at least one number.';
  if (!/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/.test(password)) return 'Password must include at least one special character.';
  if (/(.)\1{2,}/.test(password)) return 'Password must not contain repeating characters.';
  if (/[\n\r\u2028\u2029]/.test(password)) return 'Password must not contain line breaks.';
  return null;
}

async function assertNotLastOwner(base44, user) {
  if (user.role !== 'owner') return;
  const owners = await base44.asServiceRole.entities.User.filter({ role: 'owner' }, null, 100, 0);
  if (owners.length <= 1) {
    throw new Error('Cannot modify the last remaining Owner account.');
  }
}

/**
 * Re-prove the CALLER's own password, or refuse.
 *
 * Step-up authentication for the actions that can remove or replace a second
 * factor. Those actions were reachable with nothing but a session cookie, which
 * meant a stolen cookie could strip the protection the account was relying on —
 * and unlike a password change, the account owner gets no signal that it
 * happened until they next look at their authenticator.
 *
 * The actor's password, not the target's and not a TOTP code: an admin acting on
 * someone else's account cannot produce that person's code, and an admin who has
 * not enrolled a factor of their own would have no code to give — so demanding
 * one would make the recovery path unusable exactly when it is needed.
 */
async function assertActorPassword(base44, actor, currentPassword) {
  if (!currentPassword) {
    throw new Error('Forbidden: your current password is required for this change.');
  }
  // actor comes from User.get() via currentSessionUser, so the stored credential
  // is present on it. A record with neither is refused rather than throwing.
  const expectedHash = actor.password_hash;
  if (!expectedHash || !actor.salt) {
    throw new Error('Forbidden: your current password is required for this change.');
  }
  const actualHash = expectedHash.startsWith('$scrypt$')
    ? '$scrypt$' + await hashPasswordScrypt(currentPassword, actor.salt)
    : await hashPassword(currentPassword, actor.salt);
  if (!hashesEqual(actualHash, expectedHash)) {
    throw new Error('Forbidden: your current password is incorrect.');
  }
}

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json();
    const { action } = body;

    // `initialized` is intentionally public: reports only whether the system has
    // been bootstrapped (an owner exists), never any account details.
    if (action === 'initialized') {
      const owners = await base44.asServiceRole.entities.User.filter({ role: 'owner' }, null, 1, 0);
      return Response.json({ initialized: owners.length > 0 });
    }

    const actor = await currentSessionUser(base44, req);
    if (!actor) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    const _csrfHeader = req.headers.get('x-csrf-token');
    const _cookieHeader = req.headers.get('cookie') || '';
    const _csrfCookieMatch = _cookieHeader.match(/__Host-csrf_token=([^;]+)/);
    const _csrfCookie = _csrfCookieMatch ? _csrfCookieMatch[1] : null;
    if (!_csrfHeader || !_csrfCookie || _csrfHeader !== _csrfCookie) {
      return Response.json({ error: "Invalid CSRF token" }, { status: 403 });
    }

    // ─── A privileged change that cannot be recorded must not happen ───
    // Every mutating action below writes an audit row. Refuse up front, BEFORE
    // anything is written, if the chain secret is missing: letting writeAudit
    // discover it afterwards would leave the change applied but unrecorded, or
    // (if it threw) leave the caller told "failed" about work that succeeded.
    // The set is a deny-by-default allowlist — a new action added later needs
    // the secret unless it is explicitly listed as read-only.
    const READ_ONLY_ACTIONS = new Set(['initialized', 'list', 'search', 'getById']);
    if (!READ_ONLY_ACTIONS.has(action) && !secrets.get('AUDIT_CHAIN_SECRET')) {
      console.error('[user_admin] AUDIT_CHAIN_SECRET is not configured — refusing unrecordable change:', action);
      return Response.json({
        error: 'Audit chain secret is not configured, so this change cannot be recorded. Set AUDIT_CHAIN_SECRET on this deployment before managing users.',
        code: 'chain_secret_missing',
      }, { status: 503 });
    }


    const isAdmin = actor.role === 'owner' || actor.role === 'admin';
    const requireAdmin = () => {
      if (!isAdmin) throw new Error('Forbidden: only owners and admins can manage users.');
    };

    const dispatch = {
      list: async () => {
        requireAdmin();
        const users = await base44.asServiceRole.entities.User.filter({}, "-created_date", 500, 0);
        return Response.json({ users: users.map(publicUser) });
      },

      search: async () => {
        requireAdmin();
        const q = String(body.query || '').trim().toLowerCase();
        const users = await base44.asServiceRole.entities.User.filter({}, null, 500, 0);
        const filtered = q
          ? users.filter((u) =>
              (u.username || '').toLowerCase().includes(q) ||
              (u.email || '').toLowerCase().includes(q) ||
              (u.full_name || '').toLowerCase().includes(q) ||
              (u.role || '').toLowerCase().includes(q)
            )
          : users;
        return Response.json({ users: filtered.map(publicUser) });
      },

      getById: async () => {
        requireAdmin();
        const user = await base44.asServiceRole.entities.User.get(body.id);
        if (!user) return Response.json({ error: 'User not found.' }, { status: 404 });
        return Response.json({ user: publicUser(user) });
      },

      create: async () => {
        requireAdmin();
        const record = await createUser(base44, body.data || {});
        await writeAudit(base44, {
          action: 'User Created',
          actor,
          targetUser: record,
          detail: `Role: ${record.role}`,
        });
        return Response.json({ user: publicUser(record) });
      },

      update: async () => {
        const id = body.id;
        const data = body.data || {};
        const user = await base44.asServiceRole.entities.User.get(id);
        if (!user) return Response.json({ error: 'User not found.' }, { status: 404 });

        if (!isAdmin && String(id) !== String(actor.id)) {
          throw new Error('Forbidden: only owners and admins can manage users.');
        }

        const isSelf = String(actor.id) === String(id);
        const adminOnlyFields = ['role', 'permissions', 'property_access', 'is_active', 'is_locked', 'must_change_password'];
        if (isSelf && adminOnlyFields.some((f) => f in data)) {
          throw new Error('You cannot change your own role, permissions, property access, or status.');
        }

        const patch = {};
        if ('username' in data) {
          const username = String(data.username || '').trim();
          if (!username) throw new Error('Username cannot be empty.');
          if (username !== String(user.username || '')) {
            if (!isValidUsername(username)) throw new Error('Username must be 3-30 alphanumeric or underscore characters.');
          }
          const dup = await base44.asServiceRole.entities.User.filter({ username }, null, 1, 0);
          if (dup.length > 0 && String(dup[0].id) !== String(user.id)) {
            throw new Error(`Username "${username}" is already taken.`);
          }
          patch.username = username;
        }
        if ('email' in data) {
          const email = String(data.email || '').trim().toLowerCase();
          if (!isValidEmail(email)) throw new Error('Invalid email address.');
          const dup = await base44.asServiceRole.entities.User.filter({ email }, null, 1, 0);
          if (dup.length > 0 && String(dup[0].id) !== String(user.id)) {
            throw new Error(`Email "${email}" is already registered.`);
          }
          patch.email = email;
        }
        if ('full_name' in data) patch.full_name = data.full_name;
        if ('role' in data) {
          if (isSelf && ['owner', 'admin'].includes(String(data.role))) {
            throw new Error('You cannot change your own role.');
          }
          if (!ALLOWED_ROLES.includes(data.role)) throw new Error('Invalid role.');
          if (user.role === 'owner' && data.role !== 'owner') await assertNotLastOwner(base44, user);
          patch.role = data.role;
        }
        if ('permissions' in data) {
          patch.permissions = data.permissions === 'all' || !data.permissions
            ? defaultPermissionsForRole(patch.role || user.role)
            : data.permissions;
        }
        if ('property_access' in data) {
          patch.property_access = data.property_access === 'all' || data.property_access === null
            ? null
            : Array.isArray(data.property_access) ? data.property_access : [];
        }
        if ('must_change_password' in data) patch.must_change_password = data.must_change_password === true;

        if (Object.keys(patch).length === 0) {
          return Response.json({ user: publicUser(user) });
        }

        // ─── A privilege change has to reach the sessions already holding it ───
        // Every entity read in this app happens in the browser against Dexie, and
        // the permissions that gate it come from the session's cached user. So a
        // demotion, a narrowed property grant, or a permission removal changes
        // nothing at all for anyone currently signed in — the open tab keeps the
        // access it had until they choose to sign out, which could be days.
        // Revoking forces the next request through authentication, where the new
        // grant is the one that gets loaded.
        //
        // This test used to live in set_status, whose patch can only ever contain
        // is_active/is_locked/failed_login_count — so the role, permission and
        // access conditions there could never fire. `update` is the only action
        // that can change any of them, which makes this the only place the check
        // does anything. Compared against the stored row (not just presence in
        // the patch) so re-saving a form without changing anything, or editing a
        // name, does not sign the user out for no reason.
        const privilegeChanged =
          ('role' in patch && patch.role !== user.role) ||
          ('permissions' in patch && JSON.stringify(patch.permissions) !== JSON.stringify(user.permissions)) ||
          ('property_access' in patch && JSON.stringify(patch.property_access) !== JSON.stringify(user.property_access)) ||
          ('is_active' in patch && patch.is_active === false) ||
          ('is_locked' in patch && patch.is_locked === true);

        const updated = await base44.asServiceRole.entities.User.update(user.id, patch);
        if (privilegeChanged) {
          // The actor's own session is spared only when they are editing
          // themselves; the guard above already refuses self-edits of any
          // privileged field, so in practice this only matters if that guard is
          // ever relaxed.
          await revokeUserSessions(base44, user.id, isSelf ? sessionTokenHash(req) : null);
        }
        await writeAudit(base44, {
          action: isSelf ? 'Profile Updated' : 'User Updated',
          actor,
          targetUser: updated,
          detail: `Changed: ${Object.keys(patch).join(', ')}${privilegeChanged ? ' (sessions revoked)' : ''}`,
        });
        return Response.json({ user: publicUser(updated) });
      },

      set_status: async () => {
        requireAdmin();
        const id = body.id;
        const status = body.status;
        const user = await base44.asServiceRole.entities.User.get(id);
        if (!user) return Response.json({ error: 'User not found.' }, { status: 404 });

        const patch = {};
        if (status === 'disabled') {
          if (String(actor.id) === String(id)) throw new Error('You cannot disable your own account.');
          await assertNotLastOwner(base44, user);
          patch.is_active = false;
          patch.is_locked = false;
        } else if (status === 'enabled') {
          patch.is_active = true;
          patch.is_locked = false;
          patch.failed_login_count = 0;
        } else if (status === 'locked') {
          if (String(actor.id) === String(id)) throw new Error('You cannot lock your own account.');
          await assertNotLastOwner(base44, user);
          patch.is_locked = true;
        } else if (status === 'unlocked') {
          patch.is_locked = false;
          patch.failed_login_count = 0;
        } else {
          throw new Error(`Unknown status: ${status}`);
        }

        // Disabling or locking evicts whoever is holding the account open. The
        // role/permissions/property_access conditions that used to be tested here
        // were dead code — this patch is built entirely from `status` above and
        // can only contain is_active, is_locked and failed_login_count, so they
        // could never be true. They now live in `update`, the only action that can
        // change a privilege. Reading protection that does not exist is worse than
        // reading none.
        if (patch.is_locked === true || patch.is_active === false) {
          await revokeUserSessions(base44, user.id);
        }

        const updated = await base44.asServiceRole.entities.User.update(user.id, patch);
        await writeAudit(base44, {
          action: `User ${status.charAt(0).toUpperCase()}${status.slice(1)}`,
          actor,
          targetUser: updated,
          detail: `Status changed to ${status}`,
        });
        return Response.json({ user: publicUser(updated) });
      },

      reset_password: async () => {
        requireAdmin();
        const id = body.id;
        const newPassword = body.newPassword;
        const user = await base44.asServiceRole.entities.User.get(id);
        if (!user) return Response.json({ error: 'User not found.' }, { status: 404 });
        const strengthErr = validatePasswordStrength(newPassword);
        if (strengthErr) throw new Error(strengthErr);
        const salt = crypto.randomBytes(16).toString('hex');
        const password_hash = '$scrypt$' + await hashPasswordScrypt(newPassword, salt);
        await base44.asServiceRole.entities.User.update(user.id, {
          salt,
          password_hash,
          must_change_password: true,
          failed_login_count: 0,
          is_locked: false,
        });
        // An admin resetting a password is usually responding to a compromise or
        // a departure. Leaving the account's existing sessions alive means the
        // new password is the only thing that changed — whoever was already in
        // stays in, because nothing re-checks the credential until they sign out.
        await revokeUserSessions(base44, user.id);
        await writeAudit(base44, {
          action: 'Password Reset',
          actor,
          targetUser: user,
          detail: 'Administrator reset password (temporary); all sessions revoked',
        });
        return Response.json({ success: true });
      },

      set_password: async () => {
        requireAdmin();
        const id = body.id;
        const newPassword = body.newPassword;
        const user = await base44.asServiceRole.entities.User.get(id);
        if (!user) return Response.json({ error: 'User not found.' }, { status: 404 });
        // The same rule every other writer applies. This action used to check only
        // the length, so "aaaaaaaa" was accepted here while being refused at
        // create, invite and reset — a way in through the one door left open.
        const strengthErr = validatePasswordStrength(newPassword);
        if (strengthErr) throw new Error(strengthErr);
        const salt = crypto.randomBytes(16).toString('hex');
        const password_hash = '$scrypt$' + await hashPasswordScrypt(newPassword, salt);
        await base44.asServiceRole.entities.User.update(user.id, {
          salt,
          password_hash,
          must_change_password: false,
          failed_login_count: 0,
          is_locked: false,
        });
        await revokeUserSessions(base44, user.id);
        await writeAudit(base44, {
          action: 'Password Changed',
          actor,
          targetUser: user,
          detail: 'Administrator set password; all sessions revoked',
        });
        return Response.json({ success: true });
      },

      change_own_password: async () => {
        const id = body.id;
        const user = await base44.asServiceRole.entities.User.get(id);
        if (!user) return Response.json({ error: 'User not found.' }, { status: 404 });
        if (String(actor.id) !== String(id)) throw new Error('You can only change your own password.');

        const expectedHash = user.password_hash;
        // A record with no stored credential cannot confirm a current password.
        // Reaching the comparison with one threw — either on the undefined
        // dereference here or, on a length mismatch, RangeError out of
        // timingSafeEqual — and the catch below returned the raw crypto message
        // ("Input buffers must have the same byte length") to the browser as the
        // reason the password change failed.
        if (!expectedHash || !user.salt) {
          throw new Error('Current password is incorrect.');
        }
        const isLegacy = !expectedHash.startsWith('$scrypt$');
        let actualHash;
        if (isLegacy) {
          actualHash = await hashPassword(body.currentPassword, user.salt);
        } else {
          actualHash = '$scrypt$' + await hashPasswordScrypt(body.currentPassword, user.salt);
        }
        if (!hashesEqual(actualHash, expectedHash)) {
          throw new Error('Current password is incorrect.');
        }
        const newPassword = body.newPassword;
        // Length alone was checked here, so a user could downgrade their own
        // password to something the account-creation path would have refused.
        const strengthErr = validatePasswordStrength(newPassword);
        if (strengthErr) throw new Error(strengthErr);
        const salt = crypto.randomBytes(16).toString('hex');
        const password_hash = '$scrypt$' + await hashPasswordScrypt(newPassword, salt);
        await base44.asServiceRole.entities.User.update(user.id, {
          salt,
          password_hash,
          must_change_password: false,
          failed_login_count: 0,
        });
        // Someone who changes their password because they think it leaked expects
        // that to end the intruder's access. Every session EXCEPT the one making
        // the change goes; sparing the caller's keeps them from being bounced to
        // the login screen by their own security action.
        await revokeUserSessions(base44, user.id, sessionTokenHash(req));
        await writeAudit(base44, {
          action: 'Password Changed',
          actor,
          targetUser: user,
          detail: 'By user; other sessions revoked',
        });
        return Response.json({ success: true });
      },

      enable_mfa: async () => {
        const id = body.id;
        if (!isAdmin && String(actor.id) !== String(id)) throw new Error('Forbidden.');
        const user = await base44.asServiceRole.entities.User.get(id);
        if (!user) return Response.json({ error: 'User not found.' }, { status: 404 });

        // ─── Rotating a live second factor is a step-up operation ───
        // This action overwrites mfa_secret unconditionally and returns the new
        // one. Against an account that ALREADY has MFA on, that is a way to
        // replace a factor you do not hold with one you do — so whoever holds a
        // stolen session cookie could hand themselves the second factor the
        // account was protected by. Re-proving the actor's own password costs a
        // legitimate rotation one prompt and costs a cookie thief everything.
        //
        // The actor's password rather than a TOTP code: an admin rotating another
        // user's factor cannot produce that user's code, and an admin who has not
        // enrolled MFA has no code of their own to give.
        if (user.mfa_enabled) {
          await assertActorPassword(base44, actor, body.currentPassword);
        }

        const secret = generateTotpSecret();
        await base44.asServiceRole.entities.User.update(user.id, {
          mfa_enabled: true,
          mfa_secret: secret,
          mfa_secret_pending: null,
          // A counter recorded against the OLD secret would refuse the first code
          // from the new one, so enrolment starts with no spent counter.
          mfa_last_counter: null,
        });
        // Other sessions go: they were opened under the old factor (or none). The
        // caller's own survives, because the next step of enrolment is to confirm
        // a code from the secret returned below and they have to be signed in to
        // do it.
        await revokeUserSessions(base44, user.id, String(actor.id) === String(id) ? sessionTokenHash(req) : null);
        await writeAudit(base44, {
          action: 'MFA Enabled',
          actor,
          targetUser: user,
          detail: user.mfa_enabled ? 'Second factor rotated; other sessions revoked' : 'Second factor enrolled',
        });
        return Response.json({ secret, uri: formatTotpUri(secret, user.email || user.username, 'Red Roof Intelligence') });
      },

      disable_mfa: async () => {
        const id = body.id;
        if (!isAdmin && String(actor.id) !== String(id)) throw new Error('Forbidden.');
        const user = await base44.asServiceRole.entities.User.get(id);
        if (!user) return Response.json({ error: 'User not found.' }, { status: 404 });
        // Turning the second factor off is the single most valuable thing an
        // attacker holding a session cookie can do: it converts a stolen cookie
        // into permanent password-only access. It used to require nothing but the
        // cookie. Always step up here, whether or not MFA is currently on, so
        // there is no state in which the protection can be removed silently.
        await assertActorPassword(base44, actor, body.currentPassword);
        await base44.asServiceRole.entities.User.update(user.id, {
          mfa_enabled: false,
          mfa_secret: null,
          mfa_secret_pending: null,
          mfa_last_counter: null,
        });
        // Every session for the account goes, including the caller's own if they
        // are disabling their own factor: the sessions that exist were opened
        // under a protection that no longer applies.
        await revokeUserSessions(base44, user.id);
        await writeAudit(base44, {
          action: 'MFA Disabled',
          actor,
          targetUser: user,
          detail: 'Second factor removed; all sessions revoked',
        });
        return Response.json({ success: true });
      },

      verify_mfa: async () => {
        const id = body.id;
        // ─── Admin-or-self, before anything else ───
        // There was no check here at all: any signed-in account could submit codes
        // against any other account's id. Only the wrong code stopped it, which is
        // to say nothing stopped a patient caller. Every other action in this
        // dispatch either requires admin or compares against actor.id; this one
        // was the gap.
        if (!isAdmin && String(actor.id) !== String(id)) throw new Error('Forbidden.');
        const user = await base44.asServiceRole.entities.User.get(id);
        if (!user) return Response.json({ error: 'User not found.' }, { status: 404 });
        if (!user.mfa_enabled || !user.mfa_secret) throw new Error('MFA not enabled for this user.');

        // ─── Six digits is a million guesses, so the account needs a ceiling ───
        // Unlike the login path this endpoint has no failure counter and no
        // lockout, so an authenticated caller could grind the code space here.
        // The bucket is keyed on the TARGET ACCOUNT rather than the source IP: an
        // attempt spread across many addresses is exactly the shape a determined
        // attacker takes, and per-IP counting does not bound guessing against one
        // account.
        const throttleKey = `user:${user.id}`;
        const now = Date.now();
        const buckets = await base44.asServiceRole.entities.RateLimit.filter(
          { ip: throttleKey, action: 'verify_mfa' }, null, 1, 0
        );
        const bucket = buckets[0];
        if (bucket && new Date(bucket.reset_at).getTime() > now) {
          if ((bucket.count || 0) >= 10) {
            await writeAudit(base44, {
              action: 'Failed MFA',
              actor,
              targetUser: user,
              detail: '10 verification attempts within 15 minutes; further attempts in this window are refused',
            });
            return Response.json(
              { error: 'Too many verification attempts. Try again in a few minutes.' },
              { status: 429 }
            );
          }
          await base44.asServiceRole.entities.RateLimit.update(bucket.id, { count: (bucket.count || 0) + 1 });
        } else if (bucket) {
          await base44.asServiceRole.entities.RateLimit.update(bucket.id, {
            count: 1,
            reset_at: new Date(now + 15 * 60 * 1000).toISOString(),
          });
        } else {
          await base44.asServiceRole.entities.RateLimit.create({
            ip: throttleKey,
            action: 'verify_mfa',
            count: 1,
            reset_at: new Date(now + 15 * 60 * 1000).toISOString(),
          });
        }

        const counter = verifyTotpToken(user.mfa_secret, body.token, { notBefore: lastUsedCounter(user) });
        if (counter < 0) throw new Error('Invalid MFA token.');
        // Spend the counter, exactly as the login path does, so a code confirmed
        // here cannot then be replayed at sign-in inside its ±1 window.
        await base44.asServiceRole.entities.User.update(user.id, { mfa_last_counter: counter });
        await writeAudit(base44, { action: 'MFA Verified', actor, targetUser: user, detail: 'MFA verification succeeded' });
        return Response.json({ success: true });
      },

      delete: async () => {
        requireAdmin();
        const id = body.id;
        const user = await base44.asServiceRole.entities.User.get(id);
        if (!user) return Response.json({ error: 'User not found.' }, { status: 404 });
        if (String(actor.id) === String(id)) throw new Error('You cannot delete your own account.');
        await assertNotLastOwner(base44, user);
        await revokeUserSessions(base44, user.id);
        await writeAudit(base44, {
          action: 'User Deleted',
          actor,
          targetUser: user,
          detail: `Deleted account ${user.username}`,
        });
        await base44.asServiceRole.entities.User.delete(user.id);
        return Response.json({ success: true });
      },

      invite: async () => {
        requireAdmin();
        const email = String(body.email || '').trim().toLowerCase();
        const role = body.role || 'read_only';
        if (!isValidEmail(email)) throw new Error('Invalid email address.');
        const existing = await base44.asServiceRole.entities.User.filter({ email }, null, 1, 0);
        if (existing.length > 0) {
          return Response.json({ user: publicUser(existing[0]) });
        }
        const tempPassword = generateTemporaryPassword();
        const local = email.split('@')[0].replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
        const username = local.length >= 3 ? local.slice(0, 30) : `${local || 'user'}${Date.now().toString(36).slice(-4)}`;

        const record = await createUser(base44, { username, email, role, password: tempPassword, must_change_password: true });
        await writeAudit(base44, {
          action: 'User Invited',
          actor,
          targetUser: record,
          detail: `Invited with temporary password (role: ${role})`,
        });
        return Response.json({ user: publicUser(record), temporary_password: tempPassword });
      },
    };

    const handler = dispatch[action];
    if (!handler) {
      return Response.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
    return await handler();

  } catch (err) {
    const status = /Forbidden/.test(err.message) || /cannot|only|Not allowed|your own/.test(err.message) ? 403 : 400;
    const message = String(err?.message || '');
    const safeError = /^Password must /.test(message) || message === 'Current password is incorrect.'
      ? message
      : status === 403 ? 'Forbidden.' : 'Request could not be completed.';
    return Response.json({ error: safeError }, { status });
  }
}

function generateTemporaryPassword() {
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const parts = [];
  for (let i = 0; i < 3; i++) {
    let part = '';
    for (let j = 0; j < 4; j++) part += alphabet[crypto.randomInt(alphabet.length)];
    parts.push(part);
  }
  const pwd = parts.join('-');
  if (!/[A-Z]/.test(pwd) || !/[0-9]/.test(pwd)) return generateTemporaryPassword();
  return pwd;
}
