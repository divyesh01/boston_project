import { createClientFromRequest } from "npm:@base44/sdk@^0.8.41";
import crypto from "node:crypto";

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

function verifyTotpToken(secretBase32, token, window = 1) {
  const secretBytes = base32Decode(secretBase32);
  const provided = String(token).replace(/\s/g, "");
  if (!/^\d{6}$/.test(provided)) return false;
  const counter = Math.floor(Date.now() / 30000);
  for (let w = -window; w <= window; w++) {
    const expected = String(totp(secretBytes, (counter + w) * 30000)).padStart(6, "0");
    if (crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) {
      return true;
    }
  }
  return false;
}

function publicUser(user) {
  if (!user) return null;
  const { password_hash, salt, mfa_secret, reset_token_hash, reset_token_expires_at, session_created, session_expires, ...safe } = user;
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

async function revokeUserSessions(base44, userId) {
  const sessions = await base44.asServiceRole.entities.Session.filter({ user_id: userId }, null, 500, 0);
  for (const s of sessions) {
    await base44.asServiceRole.entities.Session.update(s.id, { is_revoked: true });
  }
}

async function writeAudit(base44, { action, actor, targetUser, detail }) {
  // Audit writes must never break the operation they record.
  try {
    await base44.asServiceRole.entities.AuditLog.create({
      user_id: targetUser && targetUser.id,
      username: (targetUser && targetUser.username) || (targetUser && targetUser.email) || 'unknown',
      action,
      performed_by_id: actor.id,
      performed_by: actor.username || actor.email || 'unknown',
      result: 'success',
      detail: detail || '',
      created_date: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[user_admin] audit write failed:', err);
  }
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

function validatePasswordStrength(password) {
  if (!password || password.length < 8) return 'Password must be at least 8 characters.';
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
    return 'Password must contain uppercase, lowercase, and a number.';
  }
  return null;
}

async function assertNotLastOwner(base44, user) {
  if (user.role !== 'owner') return;
  const owners = await base44.asServiceRole.entities.User.filter({ role: 'owner' }, null, 100, 0);
  if (owners.length <= 1) {
    throw new Error('Cannot modify the last remaining Owner account.');
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
    const _csrfCookieMatch = _cookieHeader.match(/csrf_token=([^;]+)/);
    const _csrfCookie = _csrfCookieMatch ? _csrfCookieMatch[1] : null;
    if (!_csrfHeader || !_csrfCookie || _csrfHeader !== _csrfCookie) {
      return Response.json({ error: "Invalid CSRF token" }, { status: 403 });
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

        const updated = await base44.asServiceRole.entities.User.update(user.id, patch);
        await writeAudit(base44, {
          action: isSelf ? 'Profile Updated' : 'User Updated',
          actor,
          targetUser: updated,
          detail: `Changed: ${Object.keys(patch).join(', ')}`,
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

        const roleChanged = patch.role && patch.role !== user.role;
        const permissionsChanged = patch.permissions && JSON.stringify(patch.permissions) !== JSON.stringify(user.permissions);
        const accessChanged = 'property_access' in patch && JSON.stringify(patch.property_access) !== JSON.stringify(user.property_access);

        if (patch.is_locked === true || patch.is_active === false || roleChanged || permissionsChanged || accessChanged) {
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
        await writeAudit(base44, {
          action: 'Password Reset',
          actor,
          targetUser: user,
          detail: 'Administrator reset password (temporary)',
        });
        return Response.json({ success: true });
      },

      set_password: async () => {
        requireAdmin();
        const id = body.id;
        const newPassword = body.newPassword;
        const user = await base44.asServiceRole.entities.User.get(id);
        if (!user) return Response.json({ error: 'User not found.' }, { status: 404 });
        if (!newPassword || newPassword.length < 8) throw new Error('Password must be at least 8 characters.');
        const salt = crypto.randomBytes(16).toString('hex');
        const password_hash = '$scrypt$' + await hashPasswordScrypt(newPassword, salt);
        await base44.asServiceRole.entities.User.update(user.id, {
          salt,
          password_hash,
          must_change_password: false,
          failed_login_count: 0,
          is_locked: false,
        });
        await writeAudit(base44, {
          action: 'Password Changed',
          actor,
          targetUser: user,
          detail: 'Administrator set password',
        });
        return Response.json({ success: true });
      },

      change_own_password: async () => {
        const id = body.id;
        const user = await base44.asServiceRole.entities.User.get(id);
        if (!user) return Response.json({ error: 'User not found.' }, { status: 404 });
        if (String(actor.id) !== String(id)) throw new Error('You can only change your own password.');

        const expectedHash = user.password_hash;
        const isLegacy = !expectedHash.startsWith('$scrypt$');
        let actualHash;
        if (isLegacy) {
          actualHash = await hashPassword(body.currentPassword, user.salt);
        } else {
          actualHash = '$scrypt$' + await hashPasswordScrypt(body.currentPassword, user.salt);
        }
        if (!crypto.timingSafeEqual(Buffer.from(actualHash), Buffer.from(expectedHash))) {
          throw new Error('Current password is incorrect.');
        }
        const newPassword = body.newPassword;
        if (!newPassword || newPassword.length < 8) throw new Error('Password must be at least 8 characters.');
        const salt = crypto.randomBytes(16).toString('hex');
        const password_hash = '$scrypt$' + await hashPasswordScrypt(newPassword, salt);
        await base44.asServiceRole.entities.User.update(user.id, {
          salt,
          password_hash,
          must_change_password: false,
          failed_login_count: 0,
        });
        await writeAudit(base44, {
          action: 'Password Changed',
          actor,
          targetUser: user,
          detail: 'By user',
        });
        return Response.json({ success: true });
      },

      enable_mfa: async () => {
        const id = body.id;
        if (!isAdmin && String(actor.id) !== String(id)) throw new Error('Forbidden.');
        const user = await base44.asServiceRole.entities.User.get(id);
        if (!user) return Response.json({ error: 'User not found.' }, { status: 404 });
        const secret = generateTotpSecret();
        await base44.asServiceRole.entities.User.update(user.id, { mfa_enabled: true, mfa_secret: secret });
        await writeAudit(base44, { action: 'MFA Enabled', actor, targetUser: user });
        return Response.json({ secret, uri: formatTotpUri(secret, user.email || user.username, 'Red Roof Intelligence') });
      },

      disable_mfa: async () => {
        const id = body.id;
        if (!isAdmin && String(actor.id) !== String(id)) throw new Error('Forbidden.');
        const user = await base44.asServiceRole.entities.User.get(id);
        if (!user) return Response.json({ error: 'User not found.' }, { status: 404 });
        await base44.asServiceRole.entities.User.update(user.id, { mfa_enabled: false, mfa_secret: null });
        await writeAudit(base44, { action: 'MFA Disabled', actor, targetUser: user });
        return Response.json({ success: true });
      },

      verify_mfa: async () => {
        const id = body.id;
        const user = await base44.asServiceRole.entities.User.get(id);
        if (!user) return Response.json({ error: 'User not found.' }, { status: 404 });
        if (!user.mfa_enabled || !user.mfa_secret) throw new Error('MFA not enabled for this user.');
        if (!verifyTotpToken(user.mfa_secret, body.token)) throw new Error('Invalid MFA token.');
        await writeAudit(base44, { action: 'MFA Verified', actor, targetUser: user });
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
    return Response.json({ error: err.message || 'Internal server error' }, { status });
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
