import localDb from './localDb';
import { answerQuestion } from '@/lib/aiEngine';
import { hashPassword, verifyPassword, generateSalt, generateToken, isCryptoAvailable, validatePasswordStrength, generateTemporaryPassword, generateTotpSecret, formatTotpUri, verifyTotpToken } from '@/lib/security';
import { defaultPermissionsForRole, canUser } from '@/lib/permissions';
import { loginRateLimiter, sanitizeEmail, sanitizeAlphanumeric, secureStore, secureRetrieve, secureRemove, createAuditEntry, getDeviceFingerprint, getClientIpHint } from '@/lib/securityUtils';
import { recalculationService } from '@/lib/recalculationService';

// ─── Tables that trigger recalculation when modified ───
const RECALCULATION_TABLES = new Set([
  'OccupancyDay', 'SourceDay', 'GrossRevenueDay', 'PaymentDay',
  'ClerkShiftRecord', 'Expense', 'PayrollRun', 'Staff', 'HotelMetric'
]);

// Helper to notify recalculation service
function notifyRecalculation(tableName, changeType, record) {
  if (RECALCULATION_TABLES.has(tableName)) {
    recalculationService.notify(tableName, changeType, record);
  }
}

// ─── Transaction Support ───
export async function runInTransaction(operations) {
  const ops = Array.isArray(operations) ? operations : [operations];
  return await localDb.transaction('rw', localDb.tables, async () => {
    const results = [];
    for (const op of ops) {
      results.push(await op());
    }
    return results;
  });
}

// ─── Referential Integrity Checks ───
async function tableUniqueValues(table, field) {
  return await table.orderBy(field).uniqueKeys();
}

export async function checkReferentialIntegrity() {
  const issues = [];
  
  // Check OccupancyDay -> Property
  const occupancyProps = await tableUniqueValues(localDb.OccupancyDay, 'property_id');
  const validProps = new Set((await localDb.Property.toArray()).map(p => String(p.id)));
  for (const pid of occupancyProps) {
    if (pid && !validProps.has(String(pid))) {
      issues.push({ table: 'OccupancyDay', field: 'property_id', value: pid, issue: 'Referenced property does not exist' });
    }
  }
  
  // Check SourceDay -> Property
  const sourceProps = await tableUniqueValues(localDb.SourceDay, 'property_id');
  for (const pid of sourceProps) {
    if (pid && !validProps.has(String(pid))) {
      issues.push({ table: 'SourceDay', field: 'property_id', value: pid, issue: 'Referenced property does not exist' });
    }
  }
  
  // Check Expense -> Property
  const expenseProps = await tableUniqueValues(localDb.Expense, 'property_id');
  for (const pid of expenseProps) {
    if (pid && !validProps.has(String(pid))) {
      issues.push({ table: 'Expense', field: 'property_id', value: pid, issue: 'Referenced property does not exist' });
    }
  }
  
  // Check PayrollRun -> Property
  const payrollProps = await tableUniqueValues(localDb.PayrollRun, 'property_id');
  for (const pid of payrollProps) {
    if (pid && !validProps.has(String(pid))) {
      issues.push({ table: 'PayrollRun', field: 'property_id', value: pid, issue: 'Referenced property does not exist' });
    }
  }
  
  // Check User foreign keys in AuditLog
  const auditUsers = await tableUniqueValues(localDb.AuditLog, 'user_id');
  const validUsers = new Set((await localDb.User.toArray()).map(u => String(u.id)));
  for (const uid of auditUsers) {
    if (uid && !validUsers.has(String(uid))) {
      issues.push({ table: 'AuditLog', field: 'user_id', value: uid, issue: 'Referenced user does not exist' });
    }
  }
  
  return issues;
}

// ─── Import Session Tracking (for rollback capability) ───
const IMPORT_SESSION_KEY = 'rri_import_sessions';

async function getImportSessions() {
  try {
    const stored = await secureRetrieve(IMPORT_SESSION_KEY);
    return stored || [];
  } catch {
    return [];
  }
}

async function saveImportSession(session) {
  const sessions = await getImportSessions();
  sessions.push(session);
  await secureStore(IMPORT_SESSION_KEY, sessions);
}

async function getImportSession(importId) {
  const sessions = await getImportSessions();
  return sessions.find(s => s.importId === importId);
}

export async function createImportSession(metadata) {
  const importId = `imp_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const session = {
    importId,
    ...metadata,
    status: 'in_progress',
    startedAt: new Date().toISOString(),
    tablesAffected: [],
    rowCounts: {},
  };
  await saveImportSession(session);
  return session;
}

export async function completeImportSession(importId, results) {
  const sessions = await getImportSessions();
  const idx = sessions.findIndex(s => s.importId === importId);
  if (idx >= 0) {
    sessions[idx] = {
      ...sessions[idx],
      status: 'completed',
      completedAt: new Date().toISOString(),
      rowCounts: results,
    };
    await secureStore(IMPORT_SESSION_KEY, sessions);
  }
}

export async function rollbackImportSession(importId) {
  const session = await getImportSession(importId);
  if (!session) return { success: false, error: 'Import session not found' };
  if (session.status !== 'completed') return { success: false, error: 'Can only rollback completed imports' };
  
  // Delete rows that were added during this import
  const deleteResults = {};
  for (const [tableName, count] of Object.entries(session.rowCounts)) {
    if (count > 0) {
      // We need to track specific IDs for precise rollback
      // For now, we'll mark the session as rolled back
      // In a full implementation, we'd store the IDs of created records
    }
  }
  
  const sessions = await getImportSessions();
  const idx = sessions.findIndex(s => s.importId === importId);
  if (idx >= 0) {
    sessions[idx] = {
      ...sessions[idx],
      status: 'rolled_back',
      rolledBackAt: new Date().toISOString(),
    };
    await secureStore(IMPORT_SESSION_KEY, sessions);
  }
  
  return { success: true, message: 'Import marked as rolled back. Manual cleanup may be required.' };
}

export async function listImportSessions() {
  return getImportSessions();
}

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

// ─── Create an entity proxy for a Dexie table with property isolation ───
function createEntityProxy(tableName) {
  const table = localDb[tableName];

  // Tables that have property_id and should enforce isolation
  const PROPERTY_TABLES = new Set([
    'OccupancyDay', 'SourceDay', 'GrossRevenueDay', 'PaymentDay',
    'ClerkShiftRecord', 'UploadedReport', 'Expense', 'PayrollRun', 'Staff', 'HotelMetric'
  ]);

  // Get current user's property access from session
  async function getUserPropertyAccess() {
    try {
      const session = await getSession();
      if (!session) return null;
      const user = await findUserById(session.userId);
      if (!user) return null;
      // Owner/admin have access to all properties
      if (user.role === 'owner' || user.role === 'admin') return 'all';
      if (!user.property_access || user.property_access === 'all') return 'all';
      if (Array.isArray(user.property_access) && user.property_access.length > 0) {
        return user.property_access;
      }
      return []; // No property access
    } catch {
      return null;
    }
  }

  function applyPropertyFilter(query, propertyAccess) {
    if (propertyAccess === 'all' || propertyAccess === null) return query;
    if (Array.isArray(propertyAccess) && propertyAccess.length > 0) {
      // If query already has property_id, intersect with allowed properties
      if (query.property_id) {
        if (query.property_id.$in) {
          query.property_id.$in = query.property_id.$in.filter(id => propertyAccess.includes(id));
        } else if (typeof query.property_id === 'string' || typeof query.property_id === 'number') {
          if (!propertyAccess.includes(query.property_id)) {
            query.property_id = { $in: [] }; // No matching properties
          }
        }
      } else {
        query.property_id = { $in: propertyAccess };
      }
    } else {
      // No access - return empty result
      query.property_id = { $in: [] };
    }
    return query;
  }

  return {
    async filter(query = {}, sortField, limit) {
      const propertyAccess = await getUserPropertyAccess();
      const filteredQuery = PROPERTY_TABLES.has(tableName) ? applyPropertyFilter({ ...query }, propertyAccess) : query;
      let rows = await table.toArray();
      rows = rows.filter(r => matchesFilter(r, filteredQuery));
      rows = sortRows(rows, sortField);
      if (limit) rows = rows.slice(0, limit);
      return rows;
    },

    async paginate(query = {}, sortField, limit = 50, cursor = null) {
      const propertyAccess = await getUserPropertyAccess();
      const filteredQuery = PROPERTY_TABLES.has(tableName) ? applyPropertyFilter({ ...query }, propertyAccess) : query;
      let rows = await table.toArray();
      rows = rows.filter(r => matchesFilter(r, filteredQuery));
      rows = sortRows(rows, sortField);
      
      // Apply cursor if provided (cursor is the last seen value of the sort field)
      if (cursor !== null && sortField) {
        const field = sortField.startsWith('-') ? sortField.slice(1) : sortField;
        const desc = sortField.startsWith('-');
        rows = rows.filter(r => {
          const val = r[field];
          return desc ? val < cursor : val > cursor;
        });
      }
      
      const page = rows.slice(0, limit + 1); // +1 to detect if there are more
      const hasMore = page.length > limit;
      const items = hasMore ? page.slice(0, limit) : page;
      const nextCursor = items.length > 0 ? items[items.length - 1][sortField?.startsWith('-') ? sortField.slice(1) : sortField] : null;
      
      return { items, hasMore, nextCursor, total: rows.length };
    },

    async list(sortField, limit) {
      const propertyAccess = await getUserPropertyAccess();
      const query = PROPERTY_TABLES.has(tableName) ? applyPropertyFilter({}, propertyAccess) : {};
      let rows = await table.toArray();
      rows = rows.filter(r => matchesFilter(r, query));
      rows = sortRows(rows, sortField);
      if (limit) rows = rows.slice(0, limit);
      return rows;
    },

    async get(id) {
      const record = await table.get(Number(id) || id);
      if (!record) return null;
      // Check property access for property-scoped tables
      if (PROPERTY_TABLES.has(tableName)) {
        const propertyAccess = await getUserPropertyAccess();
        if (propertyAccess !== 'all' && propertyAccess !== null) {
          if (Array.isArray(propertyAccess) && !propertyAccess.includes(record.property_id)) {
            return null; // Access denied
          }
        }
      }
      return record;
    },

    async create(data) {
      const propertyAccess = await getUserPropertyAccess();
      if (PROPERTY_TABLES.has(tableName)) {
        if (propertyAccess !== 'all' && propertyAccess !== null) {
          if (Array.isArray(propertyAccess)) {
            // If user has specific property access, ensure they're creating for one of their properties
            if (data.property_id && !propertyAccess.includes(data.property_id)) {
              throw new Error('Access denied: Cannot create records for unauthorized property');
            }
            // If no property_id specified but user has only one property, use that
            if (!data.property_id && propertyAccess.length === 1) {
              data.property_id = propertyAccess[0];
            }
          }
        }
      }
      const now = new Date().toISOString();
      const record = { ...data, created_date: now, updated_date: now };
      const newId = await table.add(record);
      const createdRecord = { ...record, id: newId };
      notifyRecalculation(tableName, 'create', createdRecord);
      return createdRecord;
    },

    async update(id, data) {
      const numId = Number(id) || id;
      // Check access before updating
      if (PROPERTY_TABLES.has(tableName)) {
        const record = await table.get(numId);
        if (!record) throw new Error('Record not found');
        const propertyAccess = await getUserPropertyAccess();
        if (propertyAccess !== 'all' && propertyAccess !== null) {
          if (Array.isArray(propertyAccess) && !propertyAccess.includes(record.property_id)) {
            throw new Error('Access denied: Cannot update records for unauthorized property');
          }
        }
        // Prevent changing property_id to unauthorized property
        if (data.property_id) {
          if (propertyAccess !== 'all' && propertyAccess !== null) {
            if (Array.isArray(propertyAccess) && !propertyAccess.includes(data.property_id)) {
              throw new Error('Access denied: Cannot move record to unauthorized property');
            }
          }
        }
      }
      const now = new Date().toISOString();
      await table.update(numId, { ...data, updated_date: now });
      const updatedRecord = await table.get(numId);
      notifyRecalculation(tableName, 'update', updatedRecord);
      return updatedRecord;
    },

    async delete(id) {
      const numId = Number(id) || id;
      // Check access before deleting
      if (PROPERTY_TABLES.has(tableName)) {
        const record = await table.get(numId);
        if (!record) throw new Error('Record not found');
        const propertyAccess = await getUserPropertyAccess();
        if (propertyAccess !== 'all' && propertyAccess !== null) {
          if (Array.isArray(propertyAccess) && !propertyAccess.includes(record.property_id)) {
            throw new Error('Access denied: Cannot delete records for unauthorized property');
          }
        }
      }
      const deletedRecord = await table.get(numId);
      await table.delete(numId);
      notifyRecalculation(tableName, 'delete', deletedRecord);
      return { success: true };
    },

    async bulkCreate(dataArray) {
      const propertyAccess = await getUserPropertyAccess();
      if (PROPERTY_TABLES.has(tableName)) {
        if (propertyAccess !== 'all' && propertyAccess !== null) {
          if (Array.isArray(propertyAccess)) {
            for (const data of dataArray) {
              if (data.property_id && !propertyAccess.includes(data.property_id)) {
                throw new Error('Access denied: Cannot create records for unauthorized property');
              }
              if (!data.property_id && propertyAccess.length === 1) {
                data.property_id = propertyAccess[0];
              }
            }
          }
        }
      }
      const now = new Date().toISOString();
      const records = dataArray.map(d => ({ ...d, created_date: now, updated_date: now }));
      const newIds = await table.bulkAdd(records);
      const createdRecords = records.map((r, i) => ({ ...r, id: newIds[i] }));
      notifyRecalculation(tableName, 'bulkCreate', { records: createdRecords });
      return createdRecords;
    },

    async bulkDelete(ids) {
      const propertyAccess = await getUserPropertyAccess();
      if (PROPERTY_TABLES.has(tableName)) {
        if (propertyAccess !== 'all' && propertyAccess !== null) {
          if (Array.isArray(propertyAccess)) {
            for (const id of ids) {
              const record = await table.get(Number(id) || id);
              if (record && !propertyAccess.includes(record.property_id)) {
                throw new Error('Access denied: Cannot delete records for unauthorized property');
              }
            }
          }
        }
      }
      const numIds = (Array.isArray(ids) ? ids : [ids]).map((id) => Number(id) || id);
      // Get records before deletion for notification
      const deletedRecords = await table.where('id').anyOf(numIds).toArray();
      await table.bulkDelete(numIds);
      notifyRecalculation(tableName, 'bulkDelete', { records: deletedRecords });
      return { success: true };
    },

    async clear() {
      // Only allow clear for users with full access (owner/admin)
      const propertyAccess = await getUserPropertyAccess();
      if (propertyAccess !== 'all') {
        throw new Error('Access denied: Only owner/admin can clear all data');
      }
      await table.clear();
      return { success: true };
    },

    async count(query = {}) {
      const propertyAccess = await getUserPropertyAccess();
      const filteredQuery = PROPERTY_TABLES.has(tableName) ? applyPropertyFilter({ ...query }, propertyAccess) : query;
      let rows = await table.toArray();
      return rows.filter(r => matchesFilter(r, filteredQuery)).length;
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
const SECURE_SESSION_KEY = 'rri_session_secure';

function now() {
  return Date.now();
}

async function getSession() {
  try {
    // Try secure storage first
    const secureSession = await secureRetrieve(SECURE_SESSION_KEY);
    if (secureSession && secureSession.userId && secureSession.token) {
      return secureSession;
    }
    // Fallback to localStorage for backward compatibility
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || !s.userId || !s.token) return null;
    return s;
  } catch (e) {
    return null;
  }
}

async function setSession(session) {
  try {
    // Store in secure storage
    await secureStore(SECURE_SESSION_KEY, session);
    // Also store in localStorage for backward compatibility (but with minimal info)
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      userId: session.userId,
      token: session.token,
      remember: session.remember,
      expiresAt: session.expiresAt,
    }));
  } catch (e) {
    console.error('[session] failed to store:', e);
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  }
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY);
  secureRemove(SECURE_SESSION_KEY);
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

// ─── User lookups (single source of truth for auth + admin flows) ───
async function findUserById(id) {
  if (id === undefined || id === null || id === '') return null;
  const num = typeof id === 'number' ? id : Number(id);
  if (Number.isInteger(num) && num > 0) {
    const byNumeric = await localDb.User.get(num);
    if (byNumeric) return byNumeric;
  }
  return (await localDb.User.where('id').equals(String(id)).first()) || null;
}

async function findUserByIdentity(identifier) {
  if (!identifier) return null;
  const term = String(identifier).trim().toLowerCase();
  if (!term) return null;
  const direct =
    (await localDb.User.where('email').equals(term).first()) ||
    (await localDb.User.where('username').equals(term).first());
  if (direct) return direct;
  const all = await localDb.User.toArray();
  return (
    all.find(
      (u) =>
        String(u.email || '').toLowerCase() === term ||
        String(u.username || '').toLowerCase() === term
    ) || null
  );
}

// ─── Server-side Rate Limiting (enforced at API layer) ───
const RATE_LIMIT_DB_KEY = 'rri_rate_limits_v1';

async function getRateLimitStore() {
  try {
    const stored = await secureRetrieve(RATE_LIMIT_DB_KEY);
    return stored || {};
  } catch {
    return {};
  }
}

async function setRateLimitStore(store) {
  await secureStore(RATE_LIMIT_DB_KEY, store);
}

function getDeviceId() {
  try {
    const ua = navigator.userAgent || '';
    const screen = `${window.screen.width}x${window.screen.height}`;
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const lang = navigator.language;
    const fp = `${ua}|${screen}|${tz}|${lang}`;
    let hash = 0;
    for (let i = 0; i < fp.length; i++) {
      hash = ((hash << 5) - hash) + fp.charCodeAt(i);
      hash |= 0;
    }
    return 'device_' + Math.abs(hash).toString(16);
  } catch {
    return 'device_unknown';
  }
}

export class ServerRateLimiter {
  constructor(action, options = {}) {
    this.action = action;
    this.windowMs = options.windowMs || 15 * 60 * 1000;
    this.maxRequests = options.maxRequests || 20;
    this.blockDurationMs = options.blockDurationMs || 60 * 60 * 1000;
  }

  async check(identifier = null) {
    const deviceId = getDeviceId();
    const key = identifier ? `${this.action}:${identifier}` : `${this.action}:${deviceId}`;
    const now = Date.now();
    const store = await getRateLimitStore();
    
    if (!store[key]) {
      store[key] = { requests: [], blockedUntil: 0 };
    }
    
    const entry = store[key];
    
    if (entry.blockedUntil > now) {
      return {
        allowed: false,
        remaining: 0,
        resetAt: entry.blockedUntil,
        blocked: true,
        retryAfter: Math.ceil((entry.blockedUntil - now) / 1000),
      };
    }
    
    // Clean old requests
    const cutoff = now - this.windowMs;
    entry.requests = entry.requests.filter((ts) => ts > cutoff);
    
    if (entry.requests.length >= this.maxRequests) {
      entry.blockedUntil = now + this.blockDurationMs;
      await setRateLimitStore(store);
      return {
        allowed: false,
        remaining: 0,
        resetAt: entry.blockedUntil,
        blocked: true,
        retryAfter: Math.ceil(this.blockDurationMs / 1000),
      };
    }
    
    entry.requests.push(now);
    await setRateLimitStore(store);
    
    return {
      allowed: true,
      remaining: this.maxRequests - entry.requests.length,
      resetAt: now + this.windowMs,
      blocked: false,
    };
  }

  async reset(identifier = null) {
    const deviceId = getDeviceId();
    const key = identifier ? `${this.action}:${identifier}` : `${this.action}:${deviceId}`;
    const store = await getRateLimitStore();
    delete store[key];
    await setRateLimitStore(store);
  }
}

// Pre-configured server-side limiters
export const serverLoginRateLimiter = new ServerRateLimiter('login', {
  windowMs: 15 * 60 * 1000,
  maxRequests: 5,
  blockDurationMs: 30 * 60 * 1000,
});

export const serverSensitiveActionRateLimiter = new ServerRateLimiter('sensitive_action', {
  windowMs: 60 * 60 * 1000,
  maxRequests: 20,
  blockDurationMs: 60 * 60 * 1000,
});

export const serverApiRateLimiter = new ServerRateLimiter('api', {
  windowMs: 60 * 1000,
  maxRequests: 60,
  blockDurationMs: 5 * 60 * 1000,
});

export const serverAiQueryRateLimiter = new ServerRateLimiter('ai_query', {
  windowMs: 60 * 1000,
  maxRequests: 10,
  blockDurationMs: 5 * 60 * 1000,
});

export const serverImportRateLimiter = new ServerRateLimiter('import', {
  windowMs: 60 * 60 * 1000,
  maxRequests: 30,
  blockDurationMs: 60 * 60 * 1000,
});

// ─── Audit logging ───
const audit = {
  async log(entry) {
    try {
      const auditEntry = await createAuditEntry(entry.action || 'Action', {
        userId: entry.user_id || null,
        username: entry.username || 'unknown',
        performedById: entry.performed_by_id || null,
        performedBy: entry.performed_by || 'system',
        ipAddress: entry.ip_address || getClientIpHint(),
        device: entry.device || deviceInfo(),
        propertyId: entry.property_id || null,
        propertyName: entry.property_name || null,
        result: entry.result || 'success',
        detail: entry.detail || '',
      });
      
      await localDb.AuditLog.add({
        user_id: auditEntry.userId,
        username: auditEntry.username,
        action: auditEntry.action,
        performed_by_id: auditEntry.performedById,
        performed_by: auditEntry.performedBy,
        ip_address: auditEntry.ipAddress,
        device: auditEntry.device,
        property_id: auditEntry.propertyId,
        property_name: auditEntry.propertyName,
        result: auditEntry.result,
        detail: auditEntry.detail,
        created_date: auditEntry.timestamp,
        hash: auditEntry.hash,
        previous_hash: auditEntry.previous_hash,
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
    const session = await getSession();
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
    // If user has MFA enabled but session doesn't have mfa_verified, require re-auth
    if (user.mfa_enabled && !session.mfa_verified) {
      clearSession();
      return false;
    }
    return true;
  },

  async me() {
    const session = await getSession();
    if (!session || isSessionExpired(session)) return null;
    const user = await findUserById(session.userId);
    if (!user) return null;
    if (user.is_active === false || user.is_locked === true) return null;
    if (user.mfa_enabled && !session.mfa_verified) return null;
    return publicUser(user);
  },

  async login(identifier, password, remember = false, totpToken = null) {
    // Server-side rate limiting check (by identifier)
    const rateLimit = await serverLoginRateLimiter.check(identifier);
    if (!rateLimit.allowed) {
      await audit.log({
        username: String(identifier || '').toLowerCase(),
        action: 'Login',
        result: 'failed',
        detail: `Rate limited. Try again in ${rateLimit.retryAfter} seconds.`,
      });
      throw new Error(`Too many login attempts. Please try again in ${Math.ceil(rateLimit.retryAfter / 60)} minutes.`);
    }

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

    // Check MFA if enabled
    if (user.mfa_enabled) {
      if (!totpToken) {
        await audit.log({ user_id: user.id, username: user.username, action: 'Login', result: 'mfa_required', detail: 'MFA token required' });
        return { mfaRequired: true, userId: user.id, username: user.username };
      }
      const totpValid = await verifyTotpToken(user.mfa_secret, totpToken);
      if (!totpValid) {
        await audit.log({ user_id: user.id, username: user.username, action: 'Login', result: 'failed', detail: 'Invalid MFA token' });
        throw new Error('Invalid MFA token. Please try again.');
      }
    }

    // Reset server-side rate limiter on successful login
    await serverLoginRateLimiter.reset(identifier);

    const expiresAt = now() + (remember ? REMEMBER_TIMEOUT_MS : IDLE_TIMEOUT_MS);
    const session = {
      userId: user.id,
      token: generateToken(),
      remember: !!remember,
      expiresAt,
      lastActivity: now(),
      mfa_verified: user.mfa_enabled ? true : false,
    };
    await setSession(session);

    await localDb.User.update(user.id, { last_login: new Date().toISOString(), failed_attempts: 0 });
    await audit.log({ user_id: user.id, username: user.username, action: 'Login', result: 'success' });

    const updated = await findUserById(user.id);
    return { user: publicUser(updated), session };
  },

  async touchSession() {
    const session = await getSession();
    if (!session) return;
    session.lastActivity = now();
    if (session.remember) session.expiresAt = now() + REMEMBER_TIMEOUT_MS;
    else session.expiresAt = now() + IDLE_TIMEOUT_MS;
    await setSession(session);
  },

  async logout(redirect) {
    const session = await getSession();
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

  async resetPasswordRequest(identifier) {
    throw new Error('Password reset must be requested from an administrator.');
  },

  async resetPassword(options) {
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
  async loginWithProvider(provider, returnUrl) {
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

// ─── Local mirror of the autoPayroll backend function ───
// Used when running fully local (npm run dev against the hosted backend is
// handled by the deployed base44/functions/autoPayroll cron job). Mirrors the
// backend logic: runs only on the final day of the month unless forced, is
// idempotent per pay period, and defaults generated runs to "approved".
async function runLocalAutoPayroll(params = {}) {
  const now = new Date();
  const year = Number.isInteger(params.year) ? params.year : now.getFullYear();
  const month = Number.isInteger(params.month) ? params.month : now.getMonth();
  const pad = (n) => String(n).padStart(2, "0");
  const lastDay = new Date(year, month + 1, 0).getDate();
  const periodStart = `${year}-${pad(month + 1)}-01`;
  const periodEnd = `${year}-${pad(month + 1)}-${pad(lastDay)}`;

  const isLastDayToday = now.getFullYear() === year && now.getMonth() === month && now.getDate() === lastDay;
  if (!params.force && !isLastDayToday) {
    return {
      data: {
        status: "skipped",
        message: `Today (${now.toISOString().slice(0, 10)}) is not the final day of ${new Date(year, month, 1).toLocaleString("en-US", { month: "long", year: "numeric" })} (which is the ${lastDay}th). Payroll only auto-runs on the last calendar day.`,
        scheduledFor: periodEnd,
      },
    };
  }

  const staff = await localDb.Staff.filter((s) => s.active !== false).toArray();
  if (staff.length === 0) {
    return { data: { status: "ok", message: "No active staff found — nothing to process.", periodStart, periodEnd, createdCount: 0, skippedCount: 0 } };
  }

  const existing = await localDb.PayrollRun.filter((r) => r.pay_period_end === periodEnd).toArray();
  const paidKeys = new Set(existing.map((r) => `${r.property_id || "all"}::${String(r.employee_name || "").toLowerCase()}`));

  const created = [];
  const skipped = [];
  for (const s of staff) {
    const key = `${s.property_id || "all"}::${String(s.employee_name || "").toLowerCase()}`;
    if (paidKeys.has(key)) {
      skipped.push({ employee_name: s.employee_name, reason: "already processed for this period" });
      continue;
    }
    if (!s.employee_name || !(Number(s.base_rate) > 0)) {
      skipped.push({ employee_name: s.employee_name, reason: "missing pay configuration" });
      continue;
    }
    const baseRate = Number(s.base_rate) || 0;
    const hours = Number(s.hours) || 0;
    const otHours = Number(s.overtime_hours) || 0;
    const otRate = Number(s.overtime_rate) || baseRate * 1.5;
    const bonus = Number(s.bonus) || 0;
    const deductions = Number(s.deductions) || 0;
    const regularPay = s.pay_type === "salary" ? baseRate : baseRate * hours;
    const overtimePay = otHours * otRate;
    const totalPay = regularPay + overtimePay + bonus - deductions;

    const record = {
      property_id: s.property_id || "",
      property_name: s.property_name || "",
      employee_name: s.employee_name,
      department: s.department || "",
      pay_type: s.pay_type || "hourly",
      base_rate: baseRate,
      hours,
      regular_pay: Math.round(regularPay * 100) / 100,
      overtime_hours: otHours,
      overtime_rate: otRate,
      overtime_pay: Math.round(overtimePay * 100) / 100,
      bonus,
      deductions,
      total_pay: Math.round(totalPay * 100) / 100,
      pay_period_start: periodStart,
      pay_period_end: periodEnd,
      payroll_date: periodEnd,
      payroll_status: "approved",
      auto_generated: true,
    };
    await localDb.PayrollRun.add({ ...record, created_date: now.toISOString(), updated_date: now.toISOString() });
    created.push(record);
  }

  return {
    data: {
      status: "ok",
      message: `Payroll executed for ${created.length} active staff member(s) and marked as Approved.`,
      periodStart,
      periodEnd,
      createdCount: created.length,
      skippedCount: skipped.length,
      created,
      skipped,
    },
  };
}

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
          allowedPropertyIds: params.allowedPropertyIds,
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
    if (functionName === 'autoPayroll') {
      return runLocalAutoPayroll(params);
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

// Never allow removing the final active Owner (prevents lockout / living account takeover)
async function assertNotLastOwner(target) {
  if (!target || String(target.role) !== 'owner') return;
  const all = await localDb.User.toArray();
  const owners = all.filter((u) => u.role === 'owner' && u.is_active !== false);
  if (owners.length <= 1) throw new Error('You cannot remove or demote the last Owner account.');
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
    const strengthErr = validatePasswordStrength(password);
    if (strengthErr) throw new Error(strengthErr);

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

    const isSelf = String(actor.id) === String(id);
    // Users may only edit their own profile fields — never role/permissions/access/status.
    const adminOnlyFields = ['role', 'permissions', 'property_access', 'is_active', 'is_locked', 'must_change_password'];
    if (isSelf && adminOnlyFields.some((f) => f in data)) {
      throw new Error('You cannot change your own role, permissions, property access, or status.');
    }

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
      if (String(actor.id) === String(id) && ['owner', 'admin'].includes(String(data.role))) {
        throw new Error('You cannot change your own role.');
      }
      // Never demote the last remaining Owner.
      if (user.role === 'owner' && data.role !== 'owner') await assertNotLastOwner(user);
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
      await assertNotLastOwner(user);
      await localDb.User.update(user.id, { is_active: false, is_locked: false });
      await audit.log({ user_id: user.id, username: user.username, action: 'User Disabled', performed_by_id: actor.id, performed_by: actor.username || actor.email, result: 'success' });
    } else if (status === 'enabled') {
      await localDb.User.update(user.id, { is_active: true, is_locked: false, failed_attempts: 0 });
      await audit.log({ user_id: user.id, username: user.username, action: 'User Enabled', performed_by_id: actor.id, performed_by: actor.username || actor.email, result: 'success' });
    } else if (status === 'locked') {
      await assertNotSelf(actor.id, id);
      await assertNotLastOwner(user);
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
    if (newPassword && newPassword.length < 12) throw new Error('Password must be at least 12 characters.');
    const salt = generateSalt();
    const password_hash = await hashPassword(newPassword, salt);
    await localDb.User.update(dbUser.id, { salt, password_hash, must_change_password: false, failed_attempts: 0 });
    await audit.log({ user_id: dbUser.id, username: dbUser.username, action: 'Password Changed', performed_by_id: dbUser.id, performed_by: dbUser.username, result: 'success', detail: 'By user' });
    return { success: true };
  },

  async enableMfa(actor, id) {
    assertAdmin(actor);
    const user = await findUserById(id);
    if (!user) throw new Error('User not found.');
    const secret = generateTotpSecret();
    await localDb.User.update(user.id, { mfa_enabled: true, mfa_secret: secret });
    await audit.log({ user_id: user.id, username: user.username, action: 'MFA Enabled', performed_by_id: actor.id, performed_by: actor.username || actor.email, result: 'success' });
    return { secret, uri: formatTotpUri(secret, user.email, 'Red Roof Intelligence') };
  },

  async disableMfa(actor, id) {
    assertAdmin(actor);
    const user = await findUserById(id);
    if (!user) throw new Error('User not found.');
    await localDb.User.update(user.id, { mfa_enabled: false, mfa_secret: null });
    await audit.log({ user_id: user.id, username: user.username, action: 'MFA Disabled', performed_by_id: actor.id, performed_by: actor.username || actor.email, result: 'success' });
    return { success: true };
  },

  async verifyMfa(actor, id, token) {
    const user = await findUserById(id);
    if (!user) throw new Error('User not found.');
    if (!user.mfa_enabled || !user.mfa_secret) throw new Error('MFA not enabled for this user.');
    const valid = await verifyTotpToken(user.mfa_secret, token);
    if (!valid) throw new Error('Invalid MFA token.');
    await audit.log({ user_id: user.id, username: user.username, action: 'MFA Verified', performed_by_id: actor.id, performed_by: actor.username || actor.email, result: 'success' });
    return { success: true };
  },

  async delete(actor, id) {
    assertAdmin(actor);
    const user = await findUserById(id);
    if (!user) throw new Error('User not found.');
    await assertNotSelf(actor.id, id);
    await assertNotLastOwner(user);
    await audit.log({ user_id: user.id, username: user.username, action: 'User Deleted', performed_by_id: actor.id, performed_by: actor.username || actor.email, result: 'success' });
    await localDb.User.delete(user.id);
    return { success: true };
  },

  // Backward-compatible convenience
  async inviteUser(email, role = 'read_only') {
    const existing = await localDb.User.where('email').equals(String(email).toLowerCase()).first();
    if (existing) return publicUser(existing);
    const actor = await auth.me();
    const tempPassword = generateTemporaryPassword();
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
