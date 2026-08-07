import localDb from './localDb';
import { answerQuestion } from '@/lib/aiEngine';
import { hashPassword, verifyPassword, generateSalt, generateToken, isCryptoAvailable, validatePasswordStrength } from '@/lib/security';
import { defaultPermissionsForRole, canUser } from '@/lib/permissions';

// ─── Helper: match a single row against a Base44-style filter ───
function matchesFilter(row, filter) {
  for (const [key, condition] of Object.entries(filter)) {
    const value = row[key];
    if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
      if ('$gte' in condition && value < condition.$gte) return false;
      if ('$lte' in condition && value > condition.$lte) return false;
      if ('$gt' in condition && value <= condition.$gt) return false;
      if ('$lt' in condition && value >= condition.$lt) return false;
      if ('$in' in condition && !condition.$in.includes(value)) return false;
      if ('$ne' in condition && value === condition.$ne) return false;
    } else {
      if (value !== condition) return false;
    }
  }
  return true;
}

// ─── Helper: sort rows by a field (prefix "-" for descending) ───
function sortRows(rows, sortField) {
  if (!sortField) return rows;
  const desc = sortField.startsWith('-');
  const field = desc ? sortField.slice(1) : sortField;
  return [...rows].sort((a, b) => {
    const aVal = a[field] ?? '';
    const bVal = b[field] ?? '';
    if (aVal < bVal) return desc ? 1 : -1;
    if (aVal > bVal) return desc ? -1 : 1;
    return 0;
  });
}

// ─── Create an entity proxy for a Dexie table ───
function createEntityProxy(tableName) {
  const table = localDb[tableName];

  return {
    async filter(query = {}, sortField, limit) {
      let rows = await table.toArray();
      rows = rows.filter(r => matchesFilter(r, query));
      rows = sortRows(rows, sortField);
      if (limit) rows = rows.slice(0, limit);
      return rows;
    },

    async list(sortField, limit) {
      let rows = await table.toArray();
      rows = sortRows(rows, sortField);
      if (limit) rows = rows.slice(0, limit);
      return rows;
    },

    async get(id) {
      return await table.get(Number(id) || id);
    },

    async create(data) {
      const now = new Date().toISOString();
      const record = { ...data, created_date: now, updated_date: now };
      const newId = await table.add(record);
      return { ...record, id: newId };
    },

    async update(id, data) {
      const numId = Number(id) || id;
      const now = new Date().toISOString();
      await table.update(numId, { ...data, updated_date: now });
      return await table.get(numId);
    },

    async delete(id) {
      await table.delete(Number(id) || id);
      return { success: true };
    },

    async bulkCreate(dataArray) {
      const now = new Date().toISOString();
      const records = dataArray.map(d => ({ ...d, created_date: now, updated_date: now }));
      await table.bulkAdd(records);
      return records;
    },

    async clear() {
      await table.clear();
      return { success: true };
    },
  };
}

// ─── Build the entities proxy ───
// Dynamically creates entity accessors for any table name
const entitiesHandler = {
  get(target, tableName) {
    if (target[tableName]) return target[tableName];
    // Check if the table exists in Dexie
    if (localDb[tableName]) {
      target[tableName] = createEntityProxy(tableName);
      return target[tableName];
    }
    // Fallback: return a no-op entity so the app doesn't crash for unknown entities
    console.warn(`[localDb] Unknown entity: ${tableName}`);
    return createEntityProxy(tableName);
  }
};

const entities = new Proxy({}, entitiesHandler);

// ─── Session management ───
const SESSION_KEY = 'rri_session_v1';

function now() {
  return Date.now();
}

function getSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || !s.userId || !s.token) return null;
    return s;
  } catch (e) {
    return null;
  }
}

function setSession(session) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

function isSessionExpired(session) {
  if (!session || !session.expiresAt) return true;
  return now() > session.expiresAt;
}

// Default idle timeout (ms) — 30 minutes. Remember-me extends to 30 days.
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const REMEMBER_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1000;

function deviceInfo() {
  try {
    const ua = navigator.userAgent || '';
    let device = 'Unknown';
    if (/iPhone/i.test(ua)) device = 'iPhone';
    else if (/Android/i.test(ua)) device = 'Android';
    else if (/iPad/i.test(ua)) device = 'iPad';
    else if (/Windows/i.test(ua)) device = 'Windows';
    else if (/Mac/i.test(ua)) device = 'macOS';
    else if (/Linux/i.test(ua)) device = 'Linux';
    const browser = /Edg\//i.test(ua) ? 'Edge' : /Chrome\//i.test(ua) ? 'Chrome' : /Safari\//i.test(ua) ? 'Safari' : /Firefox\//i.test(ua) ? 'Firefox' : 'Browser';
    return `${device} · ${browser}`;
  } catch (e) {
    return 'Unknown device';
  }
}

function publicUser(user) {
  if (!user) return null;
  const { password_hash, salt, ...safe } = user;
  return safe;
}

async function findUserByIdentity(identifier) {
  const id = String(identifier || '').trim().toLowerCase();
  if (!id) return null;
  const users = await localDb.User.toArray();
  return users.find((u) =>
    (u.username && String(u.username).toLowerCase() === id) ||
    (u.email && String(u.email).toLowerCase() === id)
  ) || null;
}

async function findUserById(userId) {
  if (!userId) return null;
  const u = await localDb.User.get(Number(userId) || userId);
  return u || null;
}

// ─── Audit logging ───
const audit = {
  async log(entry) {
    try {
      const nowIso = new Date().toISOString();
      await localDb.AuditLog.add({
        user_id: entry.user_id || null,
        username: entry.username || 'unknown',
        action: entry.action || 'Action',
        performed_by_id: entry.performed_by_id || null,
        performed_by: entry.performed_by || 'system',
        ip_address: entry.ip_address || '',
        device: entry.device || deviceInfo(),
        result: entry.result || 'success',
        detail: entry.detail || '',
        created_date: nowIso,
      });
    } catch (e) {
      console.error('[audit] failed to write log:', e);
    }
  },

  async list(filter = {}, limit = 500) {
    let rows = await localDb.AuditLog.toArray();
    rows = rows.filter((r) => matchesFilter(r, filter));
    rows = sortRows(rows, '-created_date');
    return rows.slice(0, limit);
  },

  async clear() {
    await localDb.AuditLog.clear();
    return { success: true };
  },
};

// ─── Auth: real local authentication ───
const auth = {
  async isAuthenticated() {
    const session = getSession();
    if (!session) return false;
    if (isSessionExpired(session)) {
      clearSession();
      return false;
    }
    const user = await findUserById(session.userId);
    if (!user) {
      clearSession();
      return false;
    }
    if (user.is_active === false || user.is_locked === true) {
      clearSession();
      return false;
    }
    return true;
  },

  async me() {
    const session = getSession();
    if (!session || isSessionExpired(session)) return null;
    const user = await findUserById(session.userId);
    if (!user) return null;
    if (user.is_active === false || user.is_locked === true) return null;
    return publicUser(user);
  },

  async login(identifier, password, remember = false) {
    const user = await findUserByIdentity(identifier);
    if (!user) {
      await audit.log({
        username: String(identifier || '').toLowerCase(),
        action: 'Login',
        result: 'failed',
        detail: 'Unknown username/email',
      });
      throw new Error('Invalid username/email or password.');
    }
    if (user.is_locked === true) {
      await audit.log({ user_id: user.id, username: user.username, action: 'Login', result: 'failed', detail: 'Account locked' });
      throw new Error('This account is locked. Contact the administrator.');
    }
    if (user.is_active === false) {
      await audit.log({ user_id: user.id, username: user.username, action: 'Login', result: 'failed', detail: 'Account disabled' });
      throw new Error('This account is disabled. Contact the administrator.');
    }
    if (!user.password_hash || !user.salt) {
      await audit.log({ user_id: user.id, username: user.username, action: 'Login', result: 'failed', detail: 'No password set' });
      throw new Error('This account has no password set. Contact the administrator.');
    }
    const ok = await verifyPassword(password, user.salt, user.password_hash);
    if (!ok) {
      const attempts = (user.failed_attempts || 0) + 1;
      const shouldLock = attempts >= 5;
      await localDb.User.update(user.id, { failed_attempts: shouldLock ? 0 : attempts, is_locked: shouldLock ? true : user.is_locked });
      await audit.log({ user_id: user.id, username: user.username, action: 'Failed Login Attempt', result: 'failed', detail: shouldLock ? 'Account locked after repeated failures' : 'Incorrect password' });
      if (shouldLock) throw new Error('Too many failed attempts. Account locked. Contact the administrator.');
      throw new Error('Invalid username/email or password.');
    }

    const expiresAt = now() + (remember ? REMEMBER_TIMEOUT_MS : IDLE_TIMEOUT_MS);
    const session = {
      userId: user.id,
      token: generateToken(),
      remember: !!remember,
      expiresAt,
      lastActivity: now(),
    };
    setSession(session);

    await localDb.User.update(user.id, { last_login: new Date().toISOString(), failed_attempts: 0 });
    await audit.log({ user_id: user.id, username: user.username, action: 'Login', result: 'success' });

    const updated = await findUserById(user.id);
    return { user: publicUser(updated), session };
  },

  async touchSession() {
    const session = getSession();
    if (!session) return;
    session.lastActivity = now();
    if (session.remember) session.expiresAt = now() + REMEMBER_TIMEOUT_MS;
    else session.expiresAt = now() + IDLE_TIMEOUT_MS;
    setSession(session);
  },

  async logout(redirect) {
    const session = getSession();
    if (session) {
      const user = await findUserById(session.userId);
      await audit.log({
        user_id: session.userId,
        username: user?.username || 'unknown',
        action: 'Logout',
        result: 'success',
      });
    }
    clearSession();
    if (redirect && typeof redirect === 'string') {
      window.location.href = redirect;
    }
  },

  async resetPasswordRequest() {
    throw new Error('Password reset must be requested from an administrator.');
  },

  async resetPassword() {
    throw new Error('Password reset must be performed by the administrator from User Management.');
  },

  redirectToLogin(returnUrl) {
    const target = returnUrl || '/';
    window.location.href = `/login?returnTo=${encodeURIComponent(target)}`;
  },

  // Backward-compatible shims
  async loginViaEmailPassword(identifier, password, remember) {
    return auth.login(identifier, password, remember);
  },
  async loginWithProvider() {
    throw new Error('Single sign-on is not available. Use username/email and password.');
  },
};

// ─── Integrations: local file handling ───
const integrations = {
  Core: {
    async UploadFile({ file }) {
      // Create a blob URL so the CSV parser can fetch() it
      const url = URL.createObjectURL(file);
      // Append the original filename as a hash so isCsvFile() can detect .csv
      const fileUrl = url + '#' + encodeURIComponent(file.name);
      return { file_url: fileUrl };
    },
    async ExtractDataFromUploadedFile({ file_url, json_schema }) {
      // AI extraction not available locally
      return {
        status: 'error',
        details: 'AI data extraction is not available in local mode. Please use CSV files for import.',
        output: [],
      };
    },
  },
};

// ─── Server functions: graceful fallback ───
const functions = {
  async invoke(functionName, params = {}) {
    if (functionName === 'aiAssistant' || functionName === 'query_database') {
      const start = Date.now();
      try {
        const data = await answerQuestion({
          question: params.question || '',
          propertyId: params.propertyId,
          from: params.dateFrom || (params.from || ""),
          to: params.dateTo || (params.to || ""),
        });
        return { data };
      } catch (e) {
        console.error('[aiAssistant] local error:', e);
        return {
          data: {
            answer: `I ran into a problem answering that: ${e.message || 'unknown error'}. Your data is fully local — nothing was sent to the internet.`,
            summary: null,
          },
        };
      }
    }
    if (functionName === 'generate_data_insights') {
      return {
        data: {
          answer: 'Data insights generation requires a cloud connection. Please review the dashboard charts and KPI cards for your analytics.',
          summary: null,
        },
      };
    }
    if (functionName === 'deleteAccount') {
      // Clear all local data
      await Promise.all(localDb.tables.map(t => t.clear()));
      localStorage.clear();
      return { success: true };
    }
    console.warn(`[local] Unknown function invoked: ${functionName}`);
    return { data: {} };
  },
};

// ─── User management (Owner/Admin only) ───
function assertAdmin(actor) {
  if (!actor) throw new Error('Not authorized.');
  const role = actor.role;
  if (role !== 'owner' && role !== 'admin') throw new Error('Only the Owner/Admin can manage users.');
}

async function assertNotSelf(actorId, targetId) {
  const a = String(actorId);
  const t = String(targetId);
  if (a === t) throw new Error('You cannot perform this action on your own account.');
}

const users = {
  async list() {
    const rows = await localDb.User.toArray();
    return rows.map(publicUser);
  },

  async search(query) {
    const q = String(query || '').trim().toLowerCase();
    let rows = await localDb.User.toArray();
    if (q) {
      rows = rows.filter((u) =>
        (u.username || '').toLowerCase().includes(q) ||
        (u.email || '').toLowerCase().includes(q) ||
        (u.full_name || '').toLowerCase().includes(q) ||
        (u.role || '').toLowerCase().includes(q)
      );
    }
    return rows.map(publicUser);
  },

  async getById(id) {
    const u = await findUserById(id);
    return publicUser(u);
  },

  async create(actor, data = {}) {
    assertAdmin(actor);
    const username = String(data.username || '').trim();
    const email = String(data.email || '').trim().toLowerCase();
    const password = data.password || '';
    if (!username || !email) throw new Error('Username and email are required.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Invalid email address.');

    const all = await localDb.User.toArray();
    if (all.some((u) => u.username && u.username.toLowerCase() === username.toLowerCase())) {
      throw new Error(`Username "${username}" is already taken.`);
    }
    if (all.some((u) => u.email && u.email.toLowerCase() === email.toLowerCase())) {
      throw new Error(`Email "${email}" is already registered.`);
    }
    if (!password) throw new Error('A password is required when creating a user.');
    if (!isCryptoAvailable()) throw new Error('Password hashing is not available in this browser.');

    const salt = generateSalt();
    const password_hash = await hashPassword(password, salt);

    const record = {
      username,
      email,
      full_name: data.full_name || '',
      role: data.role || 'read_only',
      permissions: data.permissions === 'all' ? defaultPermissionsForRole(data.role || 'owner') : (data.permissions || defaultPermissionsForRole(data.role || 'read_only')),
      property_access: data.property_access === 'all' ? 'all' : (Array.isArray(data.property_access) ? data.property_access : []),
      is_active: data.is_active !== false,
      is_locked: false,
      must_change_password: data.must_change_password === true,
      last_login: null,
      failed_attempts: 0,
      salt,
      password_hash,
    };
    const id = await localDb.User.add(record);
    await audit.log({
      user_id: id, username,
      action: 'User Created',
      performed_by_id: actor.id, performed_by: actor.username || actor.email,
      result: 'success',
      detail: `Role: ${record.role}`,
    });
    return publicUser({ ...record, id });
  },

  async update(actor, id, data = {}) {
    assertAdmin(actor);
    const user = await findUserById(id);
    if (!user) throw new Error('User not found.');

    const patch = {};
    if ('username' in data) {
      const username = String(data.username || '').trim();
      if (!username) throw new Error('Username cannot be empty.');
      const all = await localDb.User.toArray();
      if (all.some((u) => u.id !== user.id && u.username && u.username.toLowerCase() === username.toLowerCase())) {
        throw new Error(`Username "${username}" is already taken.`);
      }
      patch.username = username;
    }
    if ('email' in data) {
      const email = String(data.email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Invalid email address.');
      const all = await localDb.User.toArray();
      if (all.some((u) => u.id !== user.id && u.email && u.email.toLowerCase() === email.toLowerCase())) {
        throw new Error(`Email "${email}" is already registered.`);
      }
      patch.email = email;
    }
    if ('full_name' in data) patch.full_name = data.full_name;
    if ('role' in data) {
      // Users cannot promote themselves to an admin/owner role.
      if (String(actor.id) === String(id) && ['owner', 'admin'].includes(data.role)) {
        throw new Error('You cannot change your own role.');
      }
      patch.role = data.role;
      if ('permissions' in data) patch.permissions = data.permissions || defaultPermissionsForRole(data.role);
    }
    if ('permissions' in data) patch.permissions = data.permissions || defaultPermissionsForRole(user.role);
    if ('property_access' in data) {
      patch.property_access = data.property_access === 'all' ? 'all' : (Array.isArray(data.property_access) ? data.property_access : []);
    }
    if ('must_change_password' in data) patch.must_change_password = data.must_change_password === true;

    await localDb.User.update(user.id, patch);
    await audit.log({
      user_id: user.id, username: patch.username || user.username,
      action: 'User Updated',
      performed_by_id: actor.id, performed_by: actor.username || actor.email,
      result: 'success',
    });
    return publicUser(await findUserById(user.id));
  },

  async setStatus(actor, id, status) {
    assertAdmin(actor);
    const user = await findUserById(id);
    if (!user) throw new Error('User not found.');
    if (status === 'disabled') {
      await assertNotSelf(actor.id, id);
      await localDb.User.update(user.id, { is_active: false, is_locked: false });
      await audit.log({ user_id: user.id, username: user.username, action: 'User Disabled', performed_by_id: actor.id, performed_by: actor.username || actor.email, result: 'success' });
    } else if (status === 'enabled') {
      await localDb.User.update(user.id, { is_active: true, is_locked: false, failed_attempts: 0 });
      await audit.log({ user_id: user.id, username: user.username, action: 'User Enabled', performed_by_id: actor.id, performed_by: actor.username || actor.email, result: 'success' });
    } else if (status === 'locked') {
      await assertNotSelf(actor.id, id);
      await localDb.User.update(user.id, { is_locked: true });
      await audit.log({ user_id: user.id, username: user.username, action: 'User Locked', performed_by_id: actor.id, performed_by: actor.username || actor.email, result: 'success' });
    } else if (status === 'unlocked') {
      await localDb.User.update(user.id, { is_locked: false, failed_attempts: 0 });
      await audit.log({ user_id: user.id, username: user.username, action: 'User Unlocked', performed_by_id: actor.id, performed_by: actor.username || actor.email, result: 'success' });
    } else {
      throw new Error(`Unknown status: ${status}`);
    }
    return publicUser(await findUserById(user.id));
  },

  async resetPassword(actor, id, newPassword) {
    assertAdmin(actor);
    const user = await findUserById(id);
    if (!user) throw new Error('User not found.');
    const err = validatePasswordStrength(newPassword);
    if (err) throw new Error(err);
    const salt = generateSalt();
    const password_hash = await hashPassword(newPassword, salt);
    await localDb.User.update(user.id, { salt, password_hash, must_change_password: true, failed_attempts: 0, is_locked: false });
    await audit.log({ user_id: user.id, username: user.username, action: 'Password Reset', performed_by_id: actor.id, performed_by: actor.username || actor.email, result: 'success' });
    return { success: true };
  },

  async setPassword(actor, id, newPassword) {
    // Same as resetPassword but does NOT force change at next login
    assertAdmin(actor);
    const user = await findUserById(id);
    if (!user) throw new Error('User not found.');
    if (newPassword && newPassword.length < 8) throw new Error('Password must be at least 8 characters.');
    const salt = generateSalt();
    const password_hash = await hashPassword(newPassword, salt);
    await localDb.User.update(user.id, { salt, password_hash, must_change_password: false, failed_attempts: 0, is_locked: false });
    await audit.log({ user_id: user.id, username: user.username, action: 'Password Changed', performed_by_id: actor.id, performed_by: actor.username || actor.email, result: 'success' });
    return { success: true };
  },

  async changeOwnPassword(user, currentPassword, newPassword) {
    if (!user) throw new Error('Not authenticated.');
    const dbUser = await findUserById(user.id);
    if (!dbUser) throw new Error('User not found.');
    const ok = await verifyPassword(currentPassword, dbUser.salt, dbUser.password_hash);
    if (!ok) throw new Error('Current password is incorrect.');
    if (newPassword && newPassword.length < 8) throw new Error('Password must be at least 8 characters.');
    const salt = generateSalt();
    const password_hash = await hashPassword(newPassword, salt);
    await localDb.User.update(dbUser.id, { salt, password_hash, must_change_password: false, failed_attempts: 0 });
    await audit.log({ user_id: dbUser.id, username: dbUser.username, action: 'Password Changed', performed_by_id: dbUser.id, performed_by: dbUser.username, result: 'success', detail: 'By user' });
    return { success: true };
  },

  async delete(actor, id) {
    assertAdmin(actor);
    const user = await findUserById(id);
    if (!user) throw new Error('User not found.');
    await assertNotSelf(actor.id, id);
    await audit.log({ user_id: user.id, username: user.username, action: 'User Deleted', performed_by_id: actor.id, performed_by: actor.username || actor.email, result: 'success' });
    await localDb.User.delete(user.id);
    return { success: true };
  },

  // Backward-compatible convenience
  async inviteUser(email, role = 'read_only') {
    const existing = await localDb.User.where('email').equals(String(email).toLowerCase()).first();
    if (existing) return publicUser(existing);
    const actor = await auth.me();
    const tempPassword = 'ChangeMe123';
    return users.create(actor, { username: String(email).split('@')[0], email, role, password: tempPassword, must_change_password: true });
  },
};

const db = {
  auth,
  entities,
  integrations,
  functions,
  users,
  audit,
};

export const base44 = db;
export { db };
export default db;
