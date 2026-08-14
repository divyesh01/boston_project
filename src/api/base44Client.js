import localDb from '@/api/localDb';
import { answerQuestion } from '@/lib/aiEngine';
import { toCents, fromCents } from '@/lib/decimal';
import { reconcileTimecards } from '@/lib/timecardCalc';
import { secureStore, secureRetrieve, createAuditEntry, getClientIpHint, getCsrfToken, verifyAuditChain } from '@/lib/securityUtils';
import { postSessionRevoked } from '@/lib/sessionChannel';
import { publishChange } from '@/lib/realtime';
import { recalculationService } from '@/lib/recalculationService';
import { isValidEmail } from '@/lib/validator';
import { createClient } from '@base44/sdk';
import * as otplib from 'otplib';

const realClient = createClient({
  appId: import.meta.env?.VITE_BASE44_APP_ID || "6a7d6856ee1cc714b1803c0e",
  serverUrl: import.meta.env?.VITE_BASE44_BACKEND_URL || "",
  headers: {
    "X-CSRF-Token": getCsrfToken()
  }
});

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
// Lifecycle tracking (UI display) uses secureStore. Rollback ledger uses Dexie ImportRecordIds table.

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

// The one rollback implementation. `rollbackImport` in lib/reportParsers.js is a
// thin re-export of this; do not add a third.
//
// Deletes through the entity proxy rather than `localDb[entity]` directly. The
// proxy enforces property isolation and fires notifyRecalculation, so cached
// KPIs refresh after an undo. Raw table deletes skip both, which left the
// dashboard showing revenue from rows that no longer existed.
export async function rollbackImportSession(importId) {
  const ledger = await localDb.ImportRecordIds.where('import_id').equals(importId).toArray();

  if (!ledger.length) {
    // No ledger means nothing can be deleted precisely. Say so rather than
    // reporting success — the previous version returned {success: true} here
    // and callers had no way to learn that zero rows were removed.
    const session = await getImportSession(importId);
    return {
      success: false,
      error: session
        ? 'No rollback ledger for this import, so its rows cannot be identified. It predates ledger tracking and needs manual cleanup.'
        : 'Import session not found',
    };
  }

  // Idempotent: a second rollback of the same import must not re-delete ids
  // that may since have been reassigned by Dexie's auto-increment to unrelated
  // rows. Only 'active' ledger rows are eligible.
  const pending = ledger.filter((row) => row.status !== 'rolled_back');
  if (!pending.length) {
    return { success: true, deletedCount: 0, alreadyRolledBack: true, message: 'This import was already rolled back.' };
  }

  let totalDeleted = 0;
    for (const row of pending) {
      const ids = row.record_ids;
      if (!ids?.length) continue;
      await entities[row.entity].bulkDelete(ids);
      totalDeleted += ids.length;
      await localDb.ImportRecordIds.update(row.id, {
        status: 'rolled_back',
        rolled_back_at: new Date().toISOString(),
      });
    }

  const sessions = await getImportSessions();
  const idx = sessions.findIndex((s) => s.importId === importId);
  if (idx >= 0) {
    sessions[idx] = {
      ...sessions[idx],
      status: 'rolled_back',
      rolledBackAt: new Date().toISOString(),
      rolledBackCount: totalDeleted,
    };
    await secureStore(IMPORT_SESSION_KEY, sessions);
  }

  return { success: true, deletedCount: totalDeleted, message: `Rolled back ${totalDeleted} records from import ${importId}` };
}

export async function listImportSessions() {
  return getImportSessions();
}

// Add record IDs to the rollback ledger (ImportRecordIds table)
export async function addImportRecordIds(importId, entity, recordIds, propertyId = '') {
  try {
    await localDb.ImportRecordIds.add({
      import_id: importId,
      property_id: propertyId || '',
      entity,
      record_ids: recordIds,
      status: 'active',
      created_date: new Date().toISOString(),
    });
  } catch (e) {
    console.warn('[base44Client] failed to record import IDs:', e.message);
    throw e; // Re-throw so caller can decide to abort import
  }
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

// Login/reset identifiers may be a username OR an email. Emails are checked
// strictly (RFC 5322); the username branch stays deliberately permissive —
// hyphens and up to 50 chars, matching what the sanitizer has historically
// allowed — so a stricter rule can never lock a legacy account out of its own
// login.
function isValidIdentifier(identifier) {
  const s = String(identifier ?? '').trim();
  if (!s || s.length > 254) return false;
  if (s.includes('@')) return isValidEmail(s);
  return /^[A-Za-z0-9_-]{1,50}$/.test(s);
}

// ─── Indexed query planner for the entity proxy ───
//
// Turns a Base44-style filter ({ field: value | { $gte, $lte, $gt, $lt, $in } })
// into a Dexie indexed query instead of a full-table toArray() + in-memory
// filter. Picks ONE driving index — a compound [property_id+<field>] first,
// then the most selective single-field index — and applies whatever conditions
// the index did not consume as a residual predicate over the already narrowed
// set. Results are byte-identical to the old scan; only the number of rows
// materialised changes, which is what turns a 50,000-row scan into a
// sub-millisecond range read.
//
//   { property_id, date:{$gte,$lte} }  -> [property_id+date].between(...)
//   { property_id, status }            -> [property_id+status].equals(...)
//   { date:{$gte,$lte} }               -> date.between(...)
//   { property_id:{$in:[...]} }        -> property_id.anyOf(...)
//   {}                                 -> (no condition) toArray() fallback

const isRangeCond = (c) => !!c && typeof c === 'object' && !Array.isArray(c) &&
  (('$gte' in c) || ('$gt' in c) || ('$lte' in c) || ('$lt' in c));
const isInCond = (c) => !!c && typeof c === 'object' && !Array.isArray(c) && ('$in' in c);
const isEqCond = (c) => c !== undefined && c !== null && !(typeof c === 'object' && !Array.isArray(c));

function singleIndexQuery(table, index, cond) {
  if (cond === undefined || cond === null) return null;
  if (isEqCond(cond)) return table.where(index).equals(cond);
  if (isInCond(cond)) {
    const ids = Array.isArray(cond.$in) && cond.$in.length ? cond.$in : [''];
    return table.where(index).anyOf(ids);
  }
  if (isRangeCond(cond)) {
    const loIncl = cond.$gte !== undefined;
    const hiIncl = cond.$lte !== undefined;
    const lo = cond.$gte !== undefined ? cond.$gte : cond.$gt;
    const hi = cond.$lte !== undefined ? cond.$lte : cond.$lt;
    const q = table.where(index);
    if (lo !== undefined && hi !== undefined) return q.between(lo, hi, loIncl, hiIncl);
    if (lo !== undefined) return loIncl ? q.aboveOrEqual(lo) : q.above(lo);
    if (hi !== undefined) return hiIncl ? q.belowOrEqual(hi) : q.below(hi);
  }
  return null;
}

function compoundIndexQuery(table, index, prefix, cond) {
  if (cond === undefined || cond === null) return null;
  if (isEqCond(cond)) return table.where(index).equals([prefix, cond]);
  if (isInCond(cond)) {
    const ids = Array.isArray(cond.$in) && cond.$in.length ? cond.$in : [''];
    return table.where(index).anyOf(ids.map(id => [prefix, id]));
  }
  if (isRangeCond(cond)) {
    const loIncl = cond.$gte !== undefined;
    const hiIncl = cond.$lte !== undefined;
    const lo = cond.$gte !== undefined ? cond.$gte : cond.$gt;
    const hi = cond.$lte !== undefined ? cond.$lte : cond.$lt;
    const q = table.where(index);
    if (lo !== undefined && hi !== undefined) return q.between([prefix, lo], [prefix, hi], loIncl, hiIncl);
    if (lo !== undefined) return loIncl ? q.aboveOrEqual([prefix, lo]) : q.above([prefix, lo]);
    if (hi !== undefined) return hiIncl ? q.belowOrEqual([prefix, hi]) : q.below([prefix, hi]);
  }
  return null;
}

// Driver-field preference for single-index fallbacks. Date-like columns narrow
// a ledger scan hardest, so they rank above the generic property_id column.
const DRIVER_FIELDS = [
  'date', 'shift_date', 'expense_date', 'pay_period_start',
  'created_date', 'status', 'property_id',
];

function planQuery(table, query) {
  const entries = Object.entries(query || {});
  if (!entries.length) return null;
  const indexes = new Set((table.schema.indexes || []).map((i) => i.name));
  const pid = query.property_id;
  const pidSingle = pid && typeof pid === 'string' ? pid : null;

  // Compound [property_id+<field>]: exact property plus an equality/range on an
  // indexed second component — the hot path for every property-scoped range read.
  if (pidSingle !== null) {
    for (const [field, cond] of entries) {
      if (field === 'property_id' || cond === undefined || cond === null) continue;
      const index = `[property_id+${field}]`;
      if (!indexes.has(index)) continue;
      if (isEqCond(cond) || isRangeCond(cond)) {
        const collection = compoundIndexQuery(table, index, pidSingle, cond);
        if (collection) return { collection };
      }
    }
  }

  // Single-field indexes, most selective driver first.
  for (const field of DRIVER_FIELDS) {
    if (!(field in query)) continue;
    if (!indexes.has(field)) continue;
    const collection = singleIndexQuery(table, field, query[field]);
    if (collection) return { collection };
  }

  // No usable index for the requested conditions — fall back to a scan. The
  // residual matcher below still runs, so results are identical either way.
  return null;
}

// ─── Create an entity proxy for a Dexie table with property isolation ───
function createEntityProxy(tableName) {
  const table = localDb[tableName];

  // Tables that have property_id and should enforce isolation
  const PROPERTY_TABLES = new Set([
    'OccupancyDay', 'SourceDay', 'GrossRevenueDay', 'PaymentDay',
    'ClerkShiftRecord', 'UploadedReport', 'Expense', 'PayrollRun', 'Staff', 'HotelMetric',
    'TransactionLine', 'AnomalyAlert', 'Room', 'RoomStay', 'HousekeepingTask',
    'WeatherSnapshot', 'Review', 'AdjustmentRefund'
  ]);

  // Tables that are immutable append-only (audit trail integrity)
  const PROTECTED_IMMUTABLE_TABLES = new Set([
    'AuditLog'
  ]);

  const isProtectedImmutable = PROTECTED_IMMUTABLE_TABLES.has(tableName);

  function throwIfProtected() {
    if (isProtectedImmutable) {
      throw new Error('Security Violation: Audit logs are immutable and cannot be modified or deleted.');
    }
  }

  // Get current user's property access from session
  async function getUserPropertyAccess() {
    try {
      const user = await auth.me();
      if (!user) return null;
      // Owner/admin have access to all properties
      if (user.role === 'owner' || user.role === 'admin') return 'all';
      if (!user.property_access || user.property_access === 'all') return null;
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
    if (PROPERTY_TABLES.has(tableName)) {
      if (Array.isArray(propertyAccess) && propertyAccess.length > 0) {
        // Force intersection — never allow the raw query to broaden access
        const effective = query.property_id?.$in
          ? query.property_id.$in.filter(id => propertyAccess.includes(id))
          : propertyAccess;
        query.property_id = { $in: effective };
      } else {
        query.property_id = { $in: [] };
      }
    }
    return query;
  }

  return {
    async filter(query = {}, sortField, limit) {
      const propertyAccess = await getUserPropertyAccess();
      const filteredQuery = PROPERTY_TABLES.has(tableName) ? applyPropertyFilter({ ...query }, propertyAccess) : query;
      const plan = planQuery(table, filteredQuery);
      let rows = plan ? await plan.collection.toArray() : await table.toArray();
      rows = rows.filter(r => matchesFilter(r, filteredQuery));
      rows = sortRows(rows, sortField);
      if (limit) rows = rows.slice(0, limit);
      return rows;
    },

    async paginate(query = {}, sortField, limit = 50, cursor = null) {
      const propertyAccess = await getUserPropertyAccess();
      const filteredQuery = PROPERTY_TABLES.has(tableName) ? applyPropertyFilter({ ...query }, propertyAccess) : query;
      const plan = planQuery(table, filteredQuery);
      let rows = plan ? await plan.collection.toArray() : await table.toArray();
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
      const plan = planQuery(table, query);
      let rows = plan ? await plan.collection.toArray() : await table.toArray();
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
      publishChange(tableName, 'create', createdRecord);
      return createdRecord;
    },

    async update(id, data) {
      throwIfProtected();
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
      publishChange(tableName, 'update', updatedRecord);
      return updatedRecord;
    },

    async delete(id) {
      throwIfProtected();
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
      
      // Cascading delete for Property
      if (tableName === 'Property' && deletedRecord) {
        const propId = String(deletedRecord.id);
        for (const related of PROPERTY_TABLES) {
          if (typeof localDb[related]?.where === 'function') {
            const keys = await localDb[related].where({ property_id: propId }).primaryKeys();
            if (keys.length > 0) await localDb[related].bulkDelete(keys);
          }
        }
      }

      await table.delete(numId);
      notifyRecalculation(tableName, 'delete', deletedRecord);
      publishChange(tableName, 'delete', deletedRecord);
      return { success: true };
    },

    async bulkCreate(dataArray) {
      throwIfProtected();
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
      // `allKeys: true` is required — without it Dexie resolves bulkAdd with only
      // the LAST generated key, so every returned record ended up with id undefined
      // and any caller that reused those ids (e.g. import rollback) silently failed.
      const newIds = await table.bulkAdd(records, { allKeys: true });
      const createdRecords = records.map((r, i) => ({ ...r, id: newIds[i] }));
      notifyRecalculation(tableName, 'bulkCreate', { records: createdRecords });
      publishChange(tableName, 'bulkCreate', { records: createdRecords });
      return createdRecords;
    },

    async bulkDelete(ids) {
      throwIfProtected();
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
      
      // Cascading delete for Property
      if (tableName === 'Property' && deletedRecords.length > 0) {
        const propIds = deletedRecords.map(r => String(r.id));
        for (const related of PROPERTY_TABLES) {
          if (typeof localDb[related]?.where === 'function') {
            const keys = await localDb[related].where('property_id').anyOf(propIds).primaryKeys();
            if (keys.length > 0) await localDb[related].bulkDelete(keys);
          }
        }
      }

      await table.bulkDelete(numIds);
      notifyRecalculation(tableName, 'bulkDelete', { records: deletedRecords });
      publishChange(tableName, 'bulkDelete', { records: deletedRecords });
      return { success: true };
    },

    async clear() {
      throwIfProtected();
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
      const plan = planQuery(table, filteredQuery);
      let rows = plan ? await plan.collection.toArray() : await table.toArray();
      return rows.filter(r => matchesFilter(r, filteredQuery)).length;
    },
  };
}

// ─── Build the entities proxy ───
// Dynamically creates entity accessors for any table name
const entitiesHandler = {
  get(target, tableName) {
    if (target[tableName]) return target[tableName];
    // Check if the table exists in Dexie.
    //
    // Tested by duck-typing rather than truthiness: several Dexie instance
    // properties share a name with a plausible table (`Transaction`,
    // `Collection`, `Version`) and are truthy, so a bare existence check would
    // build a proxy over Dexie's own class and every read would come back empty
    // with no error. localDb refuses to declare such a table, so this only
    // catches a typo'd entity name — which is exactly what the warning is for.
    if (typeof localDb[tableName]?.toArray === 'function') {
      target[tableName] = createEntityProxy(tableName);
      return target[tableName];
    }
    // Fallback: return a no-op entity so the app doesn't crash for unknown entities
    console.warn(`[localDb] Unknown entity: ${tableName}`);
    return createEntityProxy(tableName);
  }
};

const entities = new Proxy({}, entitiesHandler);

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

export const setupRateLimiter = new ServerRateLimiter('setup', {
  windowMs: 15 * 60 * 1000,
  maxRequests: 3,
  blockDurationMs: 24 * 60 * 60 * 1000,
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
      
      // Persist to server audit log securely
      await functions.invoke('audit_log', {
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
    const res = await functions.invoke('audit_list', { filter, limit });
    return res.logs || [];
  },

  async clear() {
    await functions.invoke('audit_clear', {});
    return { success: true };
  },

  // Authoritative audit-chain verification. In production this delegates to
  // the serverless function base44/functions/audit_verify/entry.js (which
  // recomputes the chain with the server-held AUDIT_CHAIN_SECRET over rows
  // persisted via audit_log/entry.js). In local-dev mode it falls back to
  // the client-side verifyAuditChain() guard built over localDb rows.
  //
  // The returned `source` field ('server' | 'local') tells the caller which
  // check ran — only 'server' is forensic against DB-admin tampering. The
  // other fields mirror verifyAuditChain()'s shape for UI compatibility:
  //   { valid: true,  count,                     source }
  //   { valid: false, tamperedAt, expected, actual, source }   (hash drift)
  //   { valid: false, brokenAt,   expectedPrevious, actualPrevious, source } (chain break)
  async verifyChain() {
    return functions.invoke('audit_verify', {});
  },
};

// ─── Auth: real local authentication ───
const auth = {
  async isAuthenticated() {
    try {
      const res = await functions.invoke('custom_auth_me');
      return !!res.user;
    } catch { return false; }
  },
  async me() {
    try {
      const res = await functions.invoke('custom_auth_me');
      return res.user;
    } catch { return null; }
  },
  async login(identifier, password, remember = false, totpToken = null) {
    try {
      const res = await functions.invoke('custom_auth_login', { email: identifier, password, mfa_token: totpToken, remember });
      if (res.require_mfa_setup) {
        return { mfaRequired: true, mfaSetup: true, secret: res.secret, uri: res.uri, userId: 'mfa_pending', username: identifier };
      }
      if (res.require_mfa) {
        return { mfaRequired: true, userId: 'mfa_pending', username: identifier };
      }
      return { user: res.user, session: { token: 'http-only' } };
    } catch (err) {
      throw new Error(err.message || 'Login failed');
    }
  },
  async touchSession() {
    // Handled automatically by auth_me slide expiry
  },
  async rotateSession() {
    // Session is handled via cookies
    return { token: 'http-only' };
  },
  async logout(redirect) {
    try {
      await functions.invoke('custom_auth_logout');
    } catch {}
    if (redirect) window.location.href = redirect;
  },
  async resetPasswordRequest(identifier) {
    return functions.invoke('custom_auth_reset_request', { identifier });
  },
  async resetPassword(token, newPassword) {
    return functions.invoke('custom_auth_reset_password', { token, newPassword });
  },
  async registerUser(userData) {
    return functions.invoke('custom_auth_register', { userData });
  },
  async getCurrentSession() {
    if (USE_LOCAL_AUTH) {
      try {
        const raw = localStorage.getItem(LOCAL_SESSION_KEY);
        if (!raw) return null;
        const { userId, expiresAt } = JSON.parse(raw);
        if (new Date(expiresAt) < new Date()) {
          localStorage.removeItem(LOCAL_SESSION_KEY);
          return null;
        }
        return { userId, token: 'local' };
      } catch {
        return null;
      }
    }
    return { token: 'http-only' };
  },
  async setSessionToken(token) {
    // No-op for HttpOnly cookies
  }
};

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
  Email: {
    async SendEmail({ to, subject, body }) {
      // Mock for local dev
      console.log('\n================ EMAIL DISPATCH ================');
      console.log(`To: ${to}`);
      console.log(`Subject: ${subject}`);
      console.log(`Body:\n${body}`);
      console.log('================================================\n');
      return { status: 'success' };
    },
  },
  ChannelManager: {
    async Connect(channel, credentials) {
      console.log(`[ChannelManager] Connected to ${channel}`);
      return { status: 'success' };
    },
    async PushInventory(propertyId, mapping) {
      console.log(`[ChannelManager] Pushed inventory for property ${propertyId}`);
      return { status: 'success' };
    },
    async PullReservations(propertyId) {
      console.log(`[ChannelManager] Pulling reservations for property ${propertyId}`);
      // Return deterministic mock reservations for UI idempotency testing
      return [
        {
          channel: 'Booking.com',
          confirmation_num: `BKG-74892`,
          check_in: new Date().toISOString().split('T')[0],
          check_out: new Date(Date.now() + 86400000 * 2).toISOString().split('T')[0],
          status: 'confirmed',
          guest_name: 'John Doe',
        },
        {
          channel: 'Expedia',
          confirmation_num: `EXP-19304`,
          check_in: new Date(Date.now() + 86400000 * 1).toISOString().split('T')[0],
          check_out: new Date(Date.now() + 86400000 * 3).toISOString().split('T')[0],
          status: 'confirmed',
          guest_name: 'Jane Smith',
        }
      ];
    }
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

  let staff = await localDb.Staff.filter((s) => s.active !== false).toArray();
  if (params.propertyId) staff = staff.filter((s) => s.property_id === params.propertyId);
  if (staff.length === 0) {
    return { data: { status: "ok", message: "No active staff found — nothing to process.", periodStart, periodEnd, createdCount: 0, skippedCount: 0 } };
  }

  const existing = await localDb.PayrollRun.filter((r) => r.pay_period_end === periodEnd).toArray();
  const paidKeys = new Set(existing.map((r) => `${r.property_id || "all"}::${String(r.employee_name || "").toLowerCase()}`));

  let timecardWeeks = [];
  try {
    const allPunches = await localDb.TimecardPunch.toArray() || [];
    const punches = allPunches.filter(
      (p) =>
        (!params.propertyId || p.property_id === params.propertyId) &&
        String(p.shift_date || "").slice(0, 10) >= periodStart &&
        String(p.shift_date || "").slice(0, 10) <= periodEnd
    );
    if (punches.length) {
      const staffNames = new Set(staff.map((s) => String(s.employee_name).trim().toLowerCase()));
      timecardWeeks = reconcileTimecards(punches).filter((w) => staffNames.has(String(w.employeeKey || "").toLowerCase()));
    }
  } catch (err) {
    timecardWeeks = [];
  }

  const byEmployee = (low) => {
    const weeks = timecardWeeks.filter((w) => String(w.employeeKey || "").toLowerCase() === low);
    if (!weeks.length) return null;
    return weeks.reduce(
      (acc, w) => ({
        hours: acc.hours + (Number(w.hours) || 0),
        overtime_hours: acc.overtime_hours + (Number(w.overtime_hours) || 0),
      }),
      { hours: 0, overtime_hours: 0 }
    );
  };

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
    const tc = byEmployee(String(s.employee_name || "").toLowerCase());
    const hours = tc ? Number(tc.hours) || 0 : Number(s.hours) || 0;
    const otHours = tc ? Number(tc.overtime_hours) || 0 : Number(s.overtime_hours) || 0;
    const otRate = Number(s.overtime_rate) || baseRate * 1.5;
    const bonus = Number(s.bonus) || 0;
    const deductions = Number(s.deductions) || 0;
    
    const baseRateCents = toCents(baseRate);
    const regularPayCents = s.pay_type === "salary" ? baseRateCents : Math.round(baseRateCents * hours);
    const overtimePayCents = Math.round(toCents(otRate) * otHours);
    const totalPayCents = regularPayCents + overtimePayCents + toCents(bonus) - toCents(deductions);

    const record = {
      property_id: s.property_id || "",
      property_name: s.property_name || "",
      employee_name: s.employee_name,
      department: s.department || "",
      pay_type: s.pay_type || "hourly",
      base_rate: baseRate,
      hours,
      regular_pay: fromCents(regularPayCents),
      overtime_hours: otHours,
      overtime_rate: otRate,
      overtime_pay: fromCents(overtimePayCents),
      bonus,
      deductions,
      total_pay: fromCents(totalPayCents),
      pay_period_start: periodStart,
      pay_period_end: periodEnd,
      payroll_date: periodEnd,
      payroll_status: "approved",
      timecard_derived: !!tc,
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

// ─── Local auth helpers (browser-only, no backend required) ───
const LOCAL_SESSION_KEY = 'rr_local_session';

export async function browserHashPassword(password, salt) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations: 310000, hash: 'SHA-256' },
    keyMaterial, 256,
  );
  return Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function generateLocalId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function publicUserLocal(user) {
  if (!user) return null;
  // Never return credential material to the client/session.
  const {
    password, password_hash, salt, mfa_secret,
    reset_token_hash, reset_token_expires_at,
    ...safe
  } = user;
  return safe;
}

function getAllLocalUsers() {
  return localDb.User.toArray();
}

async function findLocalUser(identifier) {
  const normalized = String(identifier).toLowerCase();
  const all = await getAllLocalUsers();
  return (
    all.find((u) => (u.email || '').toLowerCase() === normalized) ||
    all.find((u) => (u.username || '').toLowerCase() === normalized) ||
    null
  );
}

async function getLocalSessionUser() {
  const raw = await secureRetrieve(LOCAL_SESSION_KEY);
  if (!raw) return null;
  try {
    const { userId, expiresAt } = JSON.parse(raw);
    if (new Date(expiresAt) < new Date()) {
      await secureStore(LOCAL_SESSION_KEY, '');
      return null;
    }
    const user = await localDb.User.get(userId);
    if (!user || !user.is_active || user.is_locked) return null;
    return publicUserLocal(user);
  } catch {
    await secureStore(LOCAL_SESSION_KEY, '');
    return null;
  }
}

const PERMISSION_KEYS = [
  'view_dashboard', 'import_reports', 'delete_imports', 'replace_imports',
  'export_reports', 'manage_expenses', 'manage_ota_commissions', 'manage_properties',
  'manage_users', 'view_financial_reports', 'manage_settings', 'view_audit_logs',
  'backup_restore', 'system_administration', 'manage_pricing',
];
const allPermissions = () => PERMISSION_KEYS.reduce((acc, k) => ({ ...acc, [k]: true }), {});

const ROLE_DEFAULTS_LOCAL = {
  owner: allPermissions(),
  admin: allPermissions(),
  manager: {
    view_dashboard: true, import_reports: true, delete_imports: true, replace_imports: true,
    export_reports: true, manage_expenses: true, manage_ota_commissions: true,
    manage_properties: false, manage_users: false, view_financial_reports: true,
    manage_settings: false, view_audit_logs: false, backup_restore: false,
    system_administration: false, manage_pricing: true,
  },
  front_desk: {
    view_dashboard: true, import_reports: true, delete_imports: false, replace_imports: false,
    export_reports: false, manage_expenses: false, manage_ota_commissions: false,
    manage_properties: false, manage_users: false, view_financial_reports: false,
    manage_settings: false, view_audit_logs: false, backup_restore: false,
    system_administration: false,
  },
  accountant: {
    view_dashboard: true, import_reports: false, delete_imports: false, replace_imports: false,
    export_reports: true, manage_expenses: true, manage_ota_commissions: true,
    manage_properties: false, manage_users: false, view_financial_reports: true,
    manage_settings: false, view_audit_logs: false, backup_restore: false,
    system_administration: false,
  },
  read_only: {
    view_dashboard: true, import_reports: false, delete_imports: false, replace_imports: false,
    export_reports: false, manage_expenses: false, manage_ota_commissions: false,
    manage_properties: false, manage_users: false, view_financial_reports: true,
    manage_settings: false, view_audit_logs: false, backup_restore: false,
    system_administration: false,
  },
};
const defaultPermissionsForRoleLocal = (role) => ({ ...(ROLE_DEFAULTS_LOCAL[role] || ROLE_DEFAULTS_LOCAL.read_only) });

async function handleLocalUserAdmin(params = {}) {
  const { action } = params;
  if (action === 'initialized') {
    const all = await getAllLocalUsers();
    const owners = all.filter((u) => u.role === 'owner');
    return { initialized: owners.length > 0 };
  }
  if (action === 'list') {
    const all = await getAllLocalUsers();
    return { users: all.map(publicUserLocal) };
  }
  if (action === 'search') {
    const all = await getAllLocalUsers();
    return { users: all.map(publicUserLocal) };
  }
  if (action === 'set_status') {
    const { id, status } = params || {};
    const user = await localDb.User.get(id);
    if (!user) throw new Error('User not found');
    let updates;
    if (status === 'disabled') updates = { is_active: false, is_locked: false };
    else if (status === 'enabled') updates = { is_active: true, is_locked: false };
    else if (status === 'locked') updates = { is_locked: true, is_active: true };
    else if (status === 'unlocked') updates = { is_locked: false, is_active: true };
    else throw new Error(`Unknown status: ${status}`);
    await localDb.User.update(id, updates);
    // Instant cross-tab revocation for any state that must end the session.
    if (status === 'disabled' || status === 'locked') {
      postSessionRevoked({ type: 'SESSION_REVOKED', targetUserId: id, status, reason: `User ${status}` });
    }
    return { user: publicUserLocal({ ...user, ...updates }) };
  }
  if (action === 'enable_mfa') {
    const { id } = params;
    const secret = otplib.generateSecret();
    const user = await localDb.User.get(id);
    const uri = otplib.generateURI({ label: user.email, secret, issuer: 'RedRoofIntelligence' });
    await localDb.User.update(id, { mfa_secret_pending: secret });
    return { success: true, secret, uri };
  }
  if (action === 'verify_mfa') {
    const { id, token } = params;
    const user = await localDb.User.get(id);
    const secret = user.mfa_secret_pending || user.mfa_secret;
    const result = otplib.verifySync({ token, secret });
    if (!result || !result.valid) throw new Error('Invalid MFA token');
    await localDb.User.update(id, { mfa_secret: secret, mfa_enabled: true, mfa_secret_pending: null });
    return { success: true };
  }
  if (action === 'disable_mfa') {
    const { id } = params;
    await localDb.User.update(id, { mfa_secret: null, mfa_enabled: false, mfa_secret_pending: null });
    return { success: true };
  }
  if (action === 'delete') {
    const { id } = params;
    await localDb.User.delete(id);
    return { success: true };
  }
  throw new Error(`Local fallback does not support action: ${action}`);
}

async function handleLocalAuditLog(params = {}) {
  const row = {
    action: params.action,
    created_date: params.created_date || new Date().toISOString(),
    ip_address: params.ip_address || 'client-side',
    device: params.device || 'browser',
    user_id: params.user_id ?? null,
    username: params.username || 'unknown',
    performed_by_id: params.performed_by_id ?? null,
    performed_by: params.performed_by || 'system',
    property_id: params.property_id ?? null,
    property_name: params.property_name ?? null,
    result: params.result || 'success',
    detail: params.detail || '',
    hash: params.hash || null,
    previous_hash: params.previous_hash || null,
  };
  await localDb.AuditLog.add(row);
  return { success: true, entry: row };
}

async function handleLocalAuditList({ filter = /** @type {any} */ ({}), limit = 500 } = {}) {
  let logs = await localDb.AuditLog.toArray();
  if (filter && filter.action) logs = logs.filter((l) => l.action === filter.action);
  if (typeof limit === 'number') logs = logs.slice(-limit);
  return { logs };
}

async function handleLocalAuditClear() {
  await localDb.AuditLog.clear();
  publishChange('AuditLog', 'clear', {});
  return { success: true };
}

// Local-dev fallback for the server-side audit-chain verifier. In local-dev
// mode the audit rows live in localDb (written by handleLocalAuditLog via
// createAuditEntry, which builds its own chain with a public salt), so the
// authoritative verifier is src/lib/securityUtils.js#verifyAuditChain — the
// client's integrity guard. In production this function is never reached:
// `functions.invoke('audit_verify', ...)` delegates to the serverless function
// at base44/functions/audit_verify/entry.js, which recomputes the chain with
// the server-held AUDIT_CHAIN_SECRET. `source` lets the UI label which check
// ran, since only the server check is forensic against DB-admin tampering.
async function handleLocalAuditVerify() {
  try {
    // verifyAuditChain is imported at the top of this file via securityUtils.
    const res = await verifyAuditChain();
    return { ...res, source: 'local' };
  } catch (e) {
    return { valid: false, error: e?.message || String(e), source: 'local' };
  }
}

async function handleLocalAuthRegister({ userData } = /** @type {any} */ ({})) {
  const {
    username, email, password, role = 'read_only', assigned_property_ids = [],
    property_access, full_name = '', must_change_password = true,
  } = userData || {};

  if (!username || !email || !password) {
    throw new Error('Username, email, and password are required');
  }

  const all = await getAllLocalUsers();
  const owners = all.filter((u) => u.role === 'owner');

  if (owners.length > 0) {
    throw new Error('Unauthorized');
  }
  if (role !== 'owner') {
    throw new Error('The first account must be the Owner');
  }

  if (all.some((u) => (u.email || '').toLowerCase() === email.toLowerCase())) {
    throw new Error('Email is already registered.');
  }
  if (all.some((u) => u.username === username)) {
    throw new Error('Username is already taken.');
  }

  const salt = generateLocalId().replace(/-/g, '').substring(0, 32);
  const password_hash = '$pbkdf2$' + await browserHashPassword(password, salt);

  const newUser = {
    id: generateLocalId(),
    username,
    email: email.toLowerCase(),
    full_name: full_name || '',
    role,
    permissions: defaultPermissionsForRoleLocal(role),
    property_access: property_access === 'all' || !property_access ? null : property_access,
    is_active: true,
    is_locked: false,
    must_change_password: !!must_change_password,
    failed_login_count: 0,
    salt,
    password_hash,
    created_date: new Date().toISOString(),
    updated_date: new Date().toISOString(),
  };

  await localDb.User.add(newUser);
  return { success: true, user: publicUserLocal(newUser) };
}

async function handleLocalAuthLogin({ email, password, mfa_token: _mfa_token, remember = false } = /** @type {any} */ ({})) {
  const identifier = email;
  if (!identifier || !password) {
    throw new Error('Email and password are required');
  }

  const user = await findLocalUser(identifier);
  if (!user) throw new Error('Invalid email or password');
  if (user.is_locked) throw new Error('Account is locked');
  if (!user.is_active) throw new Error('Account is inactive');

  const isBrowserHash = (user.password_hash || '').startsWith('$pbkdf2$');
  if (!isBrowserHash) {
    throw new Error('Backend authentication required. Please start the server with "base44 dev".');
  }

  const computed = '$pbkdf2$' + await browserHashPassword(password, user.salt);
  if (computed !== user.password_hash) {
    const failed = (user.failed_login_count || 0) + 1;
    await localDb.User.update(user.id, { failed_login_count: failed });
    throw new Error('Invalid email or password');
  }

  if (user.failed_login_count > 0) {
    await localDb.User.update(user.id, { failed_login_count: 0 });
  }

  // MFA Challenge
  if (user.mfa_enabled) {
    if (!_mfa_token) {
      return { require_mfa: true, userId: user.id, username: user.email };
    }
    const result = otplib.verifySync({ token: _mfa_token, secret: user.mfa_secret });
    if (!result || !result.valid) throw new Error('Invalid MFA code');
  }

  const expiresAt = remember
    ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
    : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await secureStore(LOCAL_SESSION_KEY, JSON.stringify({ userId: user.id, expiresAt }));

  return { success: true, user: publicUserLocal(user) };
}

async function handleLocalAuthMe() {
  const user = await getLocalSessionUser();
  return { user };
}

async function handleLocalAuthLogout() {
  await secureStore(LOCAL_SESSION_KEY, '');
  return { success: true };
}

// Mirror a user returned by the hosted backend into localDb so subsequent
// offline (or 404-backend) logins keep working. When a plaintext password is
// available (login time), it is re-hashed with PBKDF2 for browser-side verify.
async function mirrorRemoteUserIntoLocal(user, plaintextPassword) {
  if (!user || (!user.id && !user.email)) return null;
  const existing = (await findLocalUser(user.email || '')) || (await findLocalUser(user.username || ''));
  const salt = existing?.salt || generateLocalId().replace(/-/g, '').substring(0, 32);
  const role = user.role || existing?.role || 'read_only';
  const password_hash = plaintextPassword
    ? '$pbkdf2$' + await browserHashPassword(plaintextPassword, salt)
    : (existing?.password_hash || '');
  const full = {
    id: existing?.id || user.id || generateLocalId(),
    username: user.username || existing?.username || '',
    email: (user.email || existing?.email || '').toLowerCase(),
    full_name: user.full_name || existing?.full_name || '',
    role,
    permissions: user.permissions || existing?.permissions || defaultPermissionsForRoleLocal(role),
    property_access: user.property_access || existing?.property_access || null,
    is_active: user.is_active !== false,
    is_locked: !!user.is_locked,
    must_change_password: user.must_change_password ?? existing?.must_change_password ?? false,
    failed_login_count: 0,
    salt,
    password_hash,
    created_date: existing?.created_date || new Date().toISOString(),
    updated_date: new Date().toISOString(),
  };
  if (existing) await localDb.User.update(existing.id, full);
  else await localDb.User.add(full);
  return full;
}

function localSessionExpiry(remember) {
  return remember
    ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
    : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
}

async function tryRemote(functionName, params) {
  try {
    return await realClient.functions.invoke(functionName, params);
  } catch (e) {
    console.warn(`[localAuth] remote fallback for ${functionName} unavailable:`, e?.message || e);
    return null;
  }
}

// ─── Environment-gated auth routing (Zero-Trust default) ───
// The in-browser auth handlers are NOT a security boundary: they trust
// localStorage / IndexedDB as the source of truth and are therefore unsafe for
// production. They run ONLY when an explicit local-development flag is set. In
// every other build the auth/session calls go straight to the secure
// serverless functions in base44/functions/ (password hashing, MFA, RBAC,
// property isolation, and audit are all enforced server-side).
//
//   Production build (no flag)  -> backend serverless functions (SECURE)
//   `npm run dev` w/ .env.local -> local-first dev shims (DEV ONLY)
//
// The flag is read from Vite (import.meta.env) first, then from process.env so
// Node test harnesses can opt in without a bundler.
const USE_LOCAL_AUTH =
  (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_USE_LOCAL_AUTH === 'true') ||
  (typeof process !== 'undefined' && !!process.env && process.env.VITE_USE_LOCAL_AUTH === 'true');

// Authoritative backend delegation. Used directly in production and as the
// fallback inside the local-first dev path.
async function invokeBackend(functionName, params) {
  try {
    const res = await realClient.functions.invoke(functionName, params);
    if (functionName === 'deleteAccount') {
      await Promise.all(localDb.tables.map((t) => t.clear()));
      localStorage.clear();
    } else if (functionName === 'audit_clear') {
      await localDb.AuditLog.clear();
      publishChange('AuditLog', 'clear', {});
    }
    return res;
  } catch (e) {
    console.error(`[realClient] failed to invoke ${functionName}:`, e);
    if (e.response && e.response.data && e.response.data.error) {
      throw new Error(e.response.data.error);
    }
    throw e;
  }
}

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
    if (functionName === 'autoPayroll') {
      return runLocalAutoPayroll(params);
    }

    // ─── Local-first dev path: ONLY when explicitly enabled (VITE_USE_LOCAL_AUTH) ───
    // When the flag is OFF (production default) we skip the untrusted local
    // auth shims entirely and delegate to the authoritative backend below.
    if (!USE_LOCAL_AUTH) {
      return invokeBackend(functionName, params);
    }

    // ─── Local auth fallbacks (offline dev only) ───
    if (functionName === 'custom_user_admin') {
      if (params?.action === 'initialized') {
        try {
          const local = await handleLocalUserAdmin({ action: 'initialized' });
          if (local.initialized) return local;
          const remote = await tryRemote('custom_user_admin', params);
          if (remote && remote.initialized) return { initialized: true };
          return local;
        } catch (e) {
          console.error(`[localAuth] custom_user_admin failed:`, e);
          throw e;
        }
      }
      try {
        return await handleLocalUserAdmin(params);
      } catch (e) {
        console.error(`[localAuth] custom_user_admin failed:`, e);
        throw e;
      }
    }
    if (functionName === 'custom_auth_register') {
      // Local-first bootstrap. Falls back to the hosted backend only when the
      // local path is unavailable, then mirrors the created user so offline
      // logins keep working.
      try {
        return await handleLocalAuthRegister(params);
      } catch (localErr) {
        if (/Unauthorized|first account|already/i.test(localErr?.message || '')) throw localErr;
        const remote = await tryRemote('custom_auth_register', params);
        if (remote && remote.user) {
          const mirrored = await mirrorRemoteUserIntoLocal(remote.user, params?.userData?.password);
          return { success: true, user: publicUserLocal(mirrored) };
        }
        throw localErr;
      }
    }
    if (functionName === 'custom_auth_login') {
      try {
        return await handleLocalAuthLogin(params);
      } catch (localErr) {
        // A local "invalid credentials" or "needs backend hash" can mean the
        // account only exists on the hosted backend — try it, then mirror.
        if (/Invalid email or password|Backend authentication required/i.test(localErr?.message || '')) {
          const remote = await tryRemote('custom_auth_login', params);
          if (remote && remote.user) {
            const mirrored = await mirrorRemoteUserIntoLocal(remote.user, params?.password);
            if (mirrored) {
              await secureStore(
                LOCAL_SESSION_KEY,
                JSON.stringify({ userId: mirrored.id, expiresAt: localSessionExpiry(!!params?.remember) }),
              );
              return { success: true, user: publicUserLocal(mirrored) };
            }
          }
        }
        throw localErr;
      }
    }
    if (functionName === 'custom_auth_me') {
      try {
        const local = await handleLocalAuthMe();
        if (local.user) return local;
        const remote = await tryRemote('custom_auth_me', params);
        if (remote && remote.user) {
          const mirrored = await mirrorRemoteUserIntoLocal(remote.user);
          return { user: publicUserLocal(mirrored) || remote.user };
        }
        return local;
      } catch (e) {
        console.error(`[localAuth] custom_auth_me failed:`, e);
        throw e;
      }
    }
    if (functionName === 'custom_auth_logout') {
      try {
        return await handleLocalAuthLogout();
      } catch (e) {
        console.error(`[localAuth] custom_auth_logout failed:`, e);
        throw e;
      }
    }
    if (functionName === 'audit_log') {
      try {
        return await handleLocalAuditLog(params);
      } catch (e) {
        console.error(`[localAuth] audit_log failed:`, e);
        throw e;
      }
    }
    if (functionName === 'audit_list') {
      try {
        return await handleLocalAuditList(params);
      } catch (e) {
        console.error(`[localAuth] audit_list failed:`, e);
        throw e;
      }
    }
    if (functionName === 'audit_clear') {
      try {
        return await handleLocalAuditClear();
      } catch (e) {
        console.error(`[localAuth] audit_clear failed:`, e);
        throw e;
      }
    }
    if (functionName === 'audit_verify') {
      try {
        return await handleLocalAuditVerify();
      } catch (e) {
        console.error(`[localAuth] audit_verify failed:`, e);
        throw e;
      }
    }

    // ─── Production / default: backend is authoritative. Never trust local storage. ───
    return invokeBackend(functionName, params);
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
    const res = await functions.invoke('custom_user_admin', { action: 'list' });
    return res.users || [];
  },

  async search(query) {
    const res = await functions.invoke('custom_user_admin', { action: 'search', query });
    return res.users || [];
  },

  async getById(id) {
    const res = await functions.invoke('custom_user_admin', { action: 'getById', id });
    return res.user || null;
  },

  async create(actor, data = {}) {
    const res = await functions.invoke('custom_user_admin', { action: 'create', data });
    return res.user;
  },

  async update(actor, id, data = {}) {
    const res = await functions.invoke('custom_user_admin', { action: 'update', id, data });
    return res.user;
  },

  async setStatus(actor, id, status) {
    const res = await functions.invoke('custom_user_admin', { action: 'set_status', id, status });
    return res.user;
  },

  async resetPassword(actor, id, newPassword) {
    return functions.invoke('custom_user_admin', { action: 'reset_password', id, newPassword });
  },

  async setPassword(actor, id, newPassword) {
    return functions.invoke('custom_user_admin', { action: 'set_password', id, newPassword });
  },

  async changeOwnPassword(user, currentPassword, newPassword) {
    return functions.invoke('custom_user_admin', { action: 'change_own_password', id: user && user.id, currentPassword, newPassword });
  },

  async enableMfa(actor, id) {
    return functions.invoke('custom_user_admin', { action: 'enable_mfa', id });
  },

  async disableMfa(actor, id) {
    return functions.invoke('custom_user_admin', { action: 'disable_mfa', id });
  },

  async verifyMfa(actor, id, token) {
    return functions.invoke('custom_user_admin', { action: 'verify_mfa', id, token });
  },

  async delete(actor, id) {
    return functions.invoke('custom_user_admin', { action: 'delete', id });
  },

  async inviteUser(email, role = 'read_only') {
    return functions.invoke('custom_user_admin', { action: 'invite', email, role });
  },

  async initialized() {
    const res = await functions.invoke('custom_user_admin', { action: 'initialized' });
    return !!res.initialized;
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
