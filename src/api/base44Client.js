import localDb from '@/api/localDb';
import { answerQuestion } from '@/lib/aiEngine';
import { toCents, fromCents } from '@/lib/decimal';
import { reconcileTimecards } from '@/lib/timecardCalc';
import { secureStore, secureRetrieve, createAuditEntry, getClientIpHint, getCsrfToken, pinCsrfCookie, verifyAuditChain } from '@/lib/securityUtils';
import { recordAuditFailure } from '@/lib/auditFailureLog';
import { hasAllPropertyAccess, allPropertyRequiredError } from '@/lib/launchPolicy';
import { postSessionRevoked } from '@/lib/sessionChannel';
import { publishChange } from '@/lib/realtime';
import { recalculationService } from '@/lib/recalculationService';
import { isValidEmail } from '@/lib/validator';
import { createClient } from '@base44/sdk';
import * as otplib from 'otplib';

// ─── The CSRF pair, and why the header value has to be captured here ───
// Every server function compares the X-CSRF-Token header against the csrf_token
// cookie. The SDK copies the headers object ONCE, when the client is constructed
// (node_modules/@base44/sdk/dist/client.js: `const headers = { ...optionalHeaders,
// "X-App-Id": String(appId) }`, handed straight to axios defaults) — so this
// value is frozen for the life of the page and mutating the literal below after
// the fact has no effect.
//
// Meanwhile rotateCsrfToken() legitimately replaces the cookie (a password
// change, a guarded delete). Once it did, the frozen header no longer matched the
// cookie and EVERY later function call answered 403 "Invalid CSRF token" until
// the tab was reloaded — the user watching a save fail over and over with no
// explanation. Naming the captured value makes it something the code can keep the
// cookie in step with; pinCsrfCookie() below does that immediately before each
// call.
const CSRF_HEADER_TOKEN = getCsrfToken();

// ─── The production tenant ───
// NOT a development placeholder, despite reading like one. None of
// .env.development, .env.local or .env.production sets VITE_BASE44_APP_ID, so
// this literal is the actual configuration of every build this repo produces —
// deleting it as a "hardcoded value" would break every deployment.
//
// It is also not a secret. It ships inside the JS bundle, travels as the
// X-App-Id header on every request, and is duplicated in base44/.app.jsonc,
// which is the file the base44 CLI deploys the functions against. The two must
// stay equal or the client and its own backend address different tenants;
// scripts/probe-app-config.mjs pins that equality.
//
// The environment variable still wins when set, and its absence stays
// non-fatal on purpose: making an unset variable throw would brick production
// on the next push, which is a far larger outage than the legibility problem it
// would fix. The real hazard here is defaulting to the WRONG tenant silently,
// so .env.example asks every environment to set it explicitly.
const PRODUCTION_APP_ID = "6a7d6856ee1cc714b1803c0e";

// ─── Refuse a bearer token that arrived in the URL ───
// createClient() calls getAccessToken() while it is constructing
// (node_modules/@base44/sdk/dist/client.js: `const accessToken = token ||
// getAccessToken()`), and getAccessToken (dist/utils/auth-utils.js) reads
// ?access_token= out of window.location.search, writes the value to
// localStorage under BOTH 'base44_access_token' and 'token', and then hides the
// parameter with history.replaceState. That code ships — the built bundle in
// dist/assets carries four occurrences of 'base44_access_token' — and the call
// below passes no `token`, so the getAccessToken branch runs on every load.
//
// Nothing in this app ever issues or reads a base44 bearer token: every auth
// call goes through custom_auth_* against an HttpOnly cookie, and
// auth.setSessionToken below is a no-op for exactly that reason. So a token in
// that parameter cannot be ours. It is a link the user was sent, and following
// it banks someone else's credential in their browser, after which the SDK's
// localStorage fallback keeps handing it over long after the URL is gone.
//
// safeReturnTo() in src/lib/authReturnTo.js strips the same parameter, but only
// out of ?returnTo=, which covers the post-login hop and nothing else — a
// direct link to any route reaches this module first.
//
// The stored keys are cleared as well as the query string. Cleaning only the URL
// would leave a browser that already followed such a link compromised for as
// long as the key survives, and the key is the part that persists.
// scripts/probe-app-config.mjs section 3 runs the real SDK helper against this
// guard, both with a crafted URL and with a pre-poisoned store.
function refuseUrlSuppliedAccessToken() {
  try {
    if (typeof window === 'undefined' || !window.location) return false;
    const params = new URLSearchParams(window.location.search || '');
    const fromUrl = params.has('access_token') || params.has('clear_access_token');
    if (fromUrl) {
      params.delete('access_token');
      params.delete('clear_access_token');
      const qs = params.toString();
      const cleaned = `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash || ''}`;
      const title = typeof document !== 'undefined' ? document.title : '';
      window.history?.replaceState?.({}, title, cleaned);
    }
    // Unconditional, not just when a parameter was present: neither slot has a
    // legitimate writer in this app, so any value in either one is stale or
    // injected. Other keys are untouched.
    let banked = false;
    for (const key of ['base44_access_token', 'token']) {
      if (window.localStorage?.getItem?.(key) != null) {
        window.localStorage.removeItem(key);
        banked = true;
      }
    }
    return fromUrl || banked;
  } catch {
    // A hardening step must never be the reason the app fails to load.
    return false;
  }
}

refuseUrlSuppliedAccessToken();

const realClient = createClient({
  appId: import.meta.env?.VITE_BASE44_APP_ID || PRODUCTION_APP_ID,
  serverUrl: import.meta.env?.VITE_BASE44_BACKEND_URL || "",
  headers: {
    "X-CSRF-Token": CSRF_HEADER_TOKEN
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
  // Resolve the caller's property access BEFORE opening the Dexie zone. Entity
  // methods called inside the transaction then read a cached snapshot instead of
  // awaiting custom_auth_me, which would leave the zone and force an early
  // commit — the import would persist rows and still report failure.
  // `force` keeps the snapshot fresh at the transaction boundary, so nothing
  // inside the zone is authorized against stale privileges.
  await primePropertyAccess({ force: true });
  dexieZoneDepth += 1;
  try {
    return await localDb.transaction('rw', localDb.tables, async () => {
      const results = [];
      for (const op of ops) {
        results.push(await op());
      }
      return results;
    });
  } finally {
    dexieZoneDepth -= 1;
  }
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

// Mark a session as failed. Without this a crashed import stays 'in_progress'
// forever, which is indistinguishable from an import that is still running and
// makes the rollback path unable to tell "atomically rolled back" from
// "committed rows we can no longer identify".
export async function failImportSession(importId, errorMessage = '') {
  const sessions = await getImportSessions();
  const idx = sessions.findIndex(s => s.importId === importId);
  if (idx >= 0) {
    sessions[idx] = {
      ...sessions[idx],
      status: 'failed',
      failedAt: new Date().toISOString(),
      error: String(errorMessage || '').slice(0, 500),
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
    // One exception: a session explicitly marked 'failed' has no ledger because
    // the Dexie transaction rolled the ledger rows back together with the data
    // rows. Nothing committed, so there is nothing to clean up — reporting a
    // scary "needs manual cleanup" here would be a false alarm.
    if (session && session.status === 'failed') {
      return {
        success: true,
        deletedCount: 0,
        atomicRollback: true,
        message: 'The failed import committed no rows, so there was nothing to undo.',
      };
    }
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

// Erase the whole lifecycle list.
//
// Exported because IMPORT_SESSION_KEY is module-private on purpose: this file
// writes that slot in five places, and a second copy of the literal elsewhere
// would be one rename away from silently clearing nothing. src/lib/importReset.js
// calls this so a "clear all imported data" removes the import history the dialog
// promises to remove — previously the data rows went and the history stayed, so the
// page kept offering "Undo" for imports whose rows were already gone, and
// rollbackImportSession reported success for deleting nothing.
//
// Returns the number of sessions removed so the caller can report a real figure.
export async function clearImportSessions() {
  const removed = (await getImportSessions()).length;
  await secureStore(IMPORT_SESSION_KEY, []);
  return removed;
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

// ─── Cached authorization snapshot ───
// Every entity-proxy method needs the caller's property access. Resolving it
// calls auth.me() -> functions.invoke('custom_auth_me'), which is a real network
// round trip. That is a macrotask, and awaiting a macrotask inside a Dexie
// transaction zone makes Dexie commit the transaction early: the next table
// operation then throws TransactionInactiveError. Because the import runs
// doImport() inside runInTransaction(), an import could commit some rows and
// then report failure to the caller.
//
// Measured with scripts/probe-import-txn-zone.mjs:
//   awaiting a macrotask inside a Dexie rw zone            -> zone DIES
//   awaiting an already-resolved promise / no-await async fn -> zone SURVIVES
//
// So the snapshot is resolved BEFORE the zone opens and read without a network
// call inside it. This also removes one custom_auth_me round trip per entity
// operation, which on a 16,921-row import was thousands of redundant calls.
//
// Staleness is bounded three ways: a short TTL, explicit invalidation on any
// privilege-mutating backend call (see PRIVILEGE_MUTATING_FUNCTIONS), and a
// forced re-resolve at the start of every transaction.
const PROPERTY_ACCESS_TTL_MS = 30_000;
let propertyAccessSnapshot = { primed: false, value: null, at: 0 };
let propertyAccessInFlight = null;
let dexieZoneDepth = 0;

// Deny by default. The value this function returns is the only thing standing
// between a caller and another property's ledger, so every path out of it that
// is not a positive grant returns "no properties".
//
// It used to return `null` — the sentinel meaning "apply no filter" — for an
// absent user, an unset property_access field, and any thrown error alike. A
// signed-out tab, a user record created without property_access, and a transient
// auth.me() failure therefore all escalated to full-portfolio scope
// (scripts/probe-property-isolation.mjs §6 measured all three). There is now no
// input to this function that produces "no filter" except an explicit grant, and
// `'all'` is the only value applyScope() lets through unfiltered.
const ALL_PROPERTIES = 'all';

async function resolvePropertyAccessUncached() {
  try {
    const user = await auth.me();
    if (!user) return [];
    // Owner/admin are entitled to every property by role.
    if (user.role === 'owner' || user.role === 'admin') return ALL_PROPERTIES;
    if (user.property_access === ALL_PROPERTIES) return ALL_PROPERTIES;
    // An empty array is a legitimate (if useless) grant: no properties.
    if (Array.isArray(user.property_access)) return user.property_access;
    // Unset, null, or a shape nobody planned for.
    return [];
  } catch {
    return [];
  }
}

function propertyAccessSnapshotUsable() {
  if (!propertyAccessSnapshot.primed) return false;
  // Inside a Dexie zone the snapshot is always preferred over a network call —
  // re-resolving there would destroy the transaction. runInTransaction force-
  // primes on entry, so a snapshot read inside a zone is microseconds old.
  if (dexieZoneDepth > 0) return true;
  return Date.now() - propertyAccessSnapshot.at < PROPERTY_ACCESS_TTL_MS;
}

// Resolve and cache the caller's property access. Concurrent callers share one
// in-flight request. `force` bypasses the TTL.
export async function primePropertyAccess({ force = false } = {}) {
  if (!force && propertyAccessSnapshotUsable()) return propertyAccessSnapshot.value;
  if (!propertyAccessInFlight) {
    propertyAccessInFlight = resolvePropertyAccessUncached().then(
      (value) => {
        propertyAccessSnapshot = { primed: true, value, at: Date.now() };
        propertyAccessInFlight = null;
        return value;
      },
      (err) => {
        propertyAccessInFlight = null;
        throw err;
      },
    );
  }
  return propertyAccessInFlight;
}

// Drop the cached snapshot. Called whenever identity or privileges may have
// changed, so a demoted user cannot keep a wider grant until the TTL expires.
export function invalidatePropertyAccess() {
  propertyAccessSnapshot = { primed: false, value: null, at: 0 };
  propertyAccessInFlight = null;
}

// Backend calls that can change who the caller is, or what they may see.
const PRIVILEGE_MUTATING_FUNCTIONS = new Set([
  'custom_user_admin',
  'custom_auth_login',
  'custom_auth_logout',
  'custom_auth_register',
  'custom_auth_reset_password',
  'deleteAccount',
]);

// Read the caller's property access. Returns synchronously-resolved values when
// the snapshot is usable, which is what keeps Dexie transaction zones alive.
async function getUserPropertyAccess() {
  if (propertyAccessSnapshotUsable()) return propertyAccessSnapshot.value;
  return primePropertyAccess();
}

// ─── Create an entity proxy for a Dexie table with property isolation ───
function createEntityProxy(tableName) {
  const table = localDb[tableName];

  // Tables that carry a property_id and must be scoped to the caller's access.
  //
  // Membership is not cosmetic: a table missing from this set is readable and
  // writable across every property even by code that uses the proxy correctly.
  // The six at the end were absent until 2026-08-15 and each one leaked
  // (probe-property-isolation.mjs §4). DailyFinancialAggregate was the worst of
  // them, because it is the per-day revenue cache the Dashboard prefers over the
  // raw ledgers — so the headline numbers were the least isolated data in the app.
  //
  // Rule for anything added to localDb.js later: if the schema line contains
  // `property_id`, its name belongs here.
  const PROPERTY_TABLES = new Set([
    'OccupancyDay', 'SourceDay', 'GrossRevenueDay', 'PaymentDay',
    'ClerkShiftRecord', 'UploadedReport', 'Expense', 'PayrollRun', 'Staff', 'HotelMetric',
    'TransactionLine', 'AnomalyAlert', 'Room', 'RoomStay', 'HousekeepingTask',
    'WeatherSnapshot', 'Review', 'AdjustmentRefund',
    'DailyFinancialAggregate', 'ScanResult', 'TimecardPunch', 'Reservation',
    'RoomType', 'ChannelMap',
  ]);

  // The roster itself. Property rows have no property_id column — they ARE the
  // property — so they are scoped on their primary key instead. Without this the
  // whole portfolio (names, codes, room counts) was listed to every account, and
  // 18 read sites across the pages render that list.
  //
  // User is deliberately NOT here: a user row carries property_access, not
  // property_id, so scoping it by property is meaningless. Who may read the user
  // list is a permission question (`manage_users`), not a property-scope one.
  const ROSTER_TABLES = new Set(['Property']);

  // Tables that are immutable append-only (audit trail integrity)
  const PROTECTED_IMMUTABLE_TABLES = new Set([
    'AuditLog'
  ]);

  const isProtectedImmutable = PROTECTED_IMMUTABLE_TABLES.has(tableName);
  const isRoster = ROSTER_TABLES.has(tableName);
  const isScoped = PROPERTY_TABLES.has(tableName) || isRoster;
  // The column that says which property a row belongs to.
  const SCOPE_FIELD = isRoster ? 'id' : 'property_id';

  function throwIfProtected() {
    if (isProtectedImmutable) {
      throw new Error('Security Violation: Audit logs are immutable and cannot be modified or deleted.');
    }
  }

  // Property access is resolved by the module-scope getUserPropertyAccess(),
  // which reads a cached snapshot. It must NOT do a network call here: these
  // methods run inside Dexie transaction zones during imports.

  /** The property ids this caller may touch. `'all'` is handled by the callers. */
  const allowedIds = (propertyAccess) => (Array.isArray(propertyAccess) ? propertyAccess : []);

  /** True when the caller may read/write rows belonging to `id`. */
  function inScope(propertyAccess, id) {
    if (propertyAccess === ALL_PROPERTIES) return true;
    return allowedIds(propertyAccess).includes(id);
  }

  // Narrow a query to the caller's properties. Never widens: the returned query
  // can only ever match a subset of what the caller asked for.
  function applyScope(query, propertyAccess) {
    if (propertyAccess === ALL_PROPERTIES || !isScoped) return query;
    const allowed = allowedIds(propertyAccess);
    const requested = query[SCOPE_FIELD];
    let effective;
    if (requested && Array.isArray(requested.$in)) {
      // Intersect — never let the raw query broaden access.
      effective = requested.$in.filter((id) => allowed.includes(id));
    } else if (requested !== undefined && requested !== null && typeof requested !== 'object') {
      // A single requested property. Previously this branch was overwritten with
      // the caller's whole allowed list, so asking for a property you may not see
      // silently returned a DIFFERENT property's rows instead of nothing.
      effective = allowed.includes(requested) ? [requested] : [];
    } else {
      // No property condition, or a range/operator shape nothing currently
      // produces: fall back to the caller's full allowance. Dropping an exotic
      // condition can only widen the result set WITHIN that allowance, so it
      // stays a subset of what the caller is entitled to see.
      effective = allowed;
    }
    query[SCOPE_FIELD] = { $in: effective };
    return query;
  }

  /** Roster rows describe the tenancy boundary, so only all-property accounts may edit them. */
  function throwIfRosterEditDenied(propertyAccess) {
    if (isRoster && propertyAccess !== ALL_PROPERTIES) {
      throw new Error('Access denied: only accounts with access to all properties can change the property roster');
    }
  }

  return {
    async filter(query = {}, sortField, limit) {
      const propertyAccess = await getUserPropertyAccess();
      const filteredQuery = isScoped ? applyScope({ ...query }, propertyAccess) : query;
      const plan = planQuery(table, filteredQuery);
      let rows = plan ? await plan.collection.toArray() : await table.toArray();
      rows = rows.filter(r => matchesFilter(r, filteredQuery));
      rows = sortRows(rows, sortField);
      if (limit) rows = rows.slice(0, limit);
      return rows;
    },

    async paginate(query = {}, sortField, limit = 50, cursor = null) {
      const propertyAccess = await getUserPropertyAccess();
      const filteredQuery = isScoped ? applyScope({ ...query }, propertyAccess) : query;
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
      const query = isScoped ? applyScope({}, propertyAccess) : {};
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
      if (!isScoped) return record;
      const propertyAccess = await getUserPropertyAccess();
      if (!inScope(propertyAccess, record[SCOPE_FIELD])) return null; // Access denied
      return record;
    },

    async create(data) {
      const propertyAccess = await getUserPropertyAccess();
      if (isScoped && propertyAccess !== ALL_PROPERTIES) {
        throwIfRosterEditDenied(propertyAccess);
        const allowed = allowedIds(propertyAccess);
        if (data.property_id) {
          if (!allowed.includes(data.property_id)) {
            throw new Error('Access denied: Cannot create records for unauthorized property');
          }
        } else if (allowed.length === 1) {
          // Unambiguous: a single-property account gets its own property.
          data.property_id = allowed[0];
        } else {
          // Writing an unscoped row into a scoped table used to be allowed. The
          // row then belonged to no property, which means every scoped read
          // misses it — data that is silently invisible instead of loudly refused.
          throw new Error('Access denied: a property must be specified for this record');
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
      if (isScoped) {
        const record = await table.get(numId);
        if (!record) throw new Error('Record not found');
        const propertyAccess = await getUserPropertyAccess();
        throwIfRosterEditDenied(propertyAccess);
        if (!inScope(propertyAccess, record[SCOPE_FIELD])) {
          throw new Error('Access denied: Cannot update records for unauthorized property');
        }
        // Prevent moving a row to a property the caller may not touch.
        if (data.property_id && !inScope(propertyAccess, data.property_id)) {
          throw new Error('Access denied: Cannot move record to unauthorized property');
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
      if (isScoped) {
        const record = await table.get(numId);
        if (!record) throw new Error('Record not found');
        const propertyAccess = await getUserPropertyAccess();
        throwIfRosterEditDenied(propertyAccess);
        if (!inScope(propertyAccess, record[SCOPE_FIELD])) {
          throw new Error('Access denied: Cannot delete records for unauthorized property');
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
      if (isScoped && propertyAccess !== ALL_PROPERTIES) {
        throwIfRosterEditDenied(propertyAccess);
        const allowed = allowedIds(propertyAccess);
        for (const data of dataArray) {
          if (data.property_id) {
            if (!allowed.includes(data.property_id)) {
              throw new Error('Access denied: Cannot create records for unauthorized property');
            }
          } else if (allowed.length === 1) {
            data.property_id = allowed[0];
          } else {
            throw new Error('Access denied: a property must be specified for this record');
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
      if (isScoped && propertyAccess !== ALL_PROPERTIES) {
        throwIfRosterEditDenied(propertyAccess);
        for (const id of ids) {
          const record = await table.get(Number(id) || id);
          if (record && !inScope(propertyAccess, record[SCOPE_FIELD])) {
            throw new Error('Access denied: Cannot delete records for unauthorized property');
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
      if (propertyAccess !== ALL_PROPERTIES) {
        throw new Error('Access denied: Only owner/admin can clear all data');
      }
      await table.clear();
      return { success: true };
    },

    async count(query = {}) {
      const propertyAccess = await getUserPropertyAccess();
      const filteredQuery = isScoped ? applyScope({ ...query }, propertyAccess) : query;
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
      return { ok: true };
    } catch (e) {
      console.error('[audit] failed to write log:', e);
      // A swallowed audit failure is indistinguishable from "nothing happened",
      // which is the one thing an append-only trail must never be ambiguous
      // about: audit_verify only checks that the rows it can see are linked, so a
      // row that was never written leaves the chain green and the event invisible.
      // Recorded for the Audit Log page to surface. Not thrown: six callers await
      // this (Payroll, Settings, the report import path), and none of them should
      // fail because logging did. See src/lib/auditFailureLog.js.
      recordAuditFailure(entry?.action, e, {
        source: 'base44Client.db.audit.log',
        username: entry?.username,
        property_id: entry?.property_id,
      });
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async list(filter = {}, limit = 500) {
    const res = await functions.invoke('audit_list', { filter, limit });
    return res.logs || [];
  },

  // NOTE: there is deliberately no clear()/purge() here. The audit log is
  // append-only — see base44/functions/audit_clear/entry.js, which now refuses
  // every caller. Bounding retention has to be an archive-then-trim job that
  // records the trim in the chain, not a button that empties the table.

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
let lastTouchTime = 0;
const THROTTLE_MS = 5 * 60 * 1000;

const auth = {
  async isAuthenticated() {
    try {
      const res = await functions.invoke('custom_auth_check');
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
    const now = Date.now();
    if (now - lastTouchTime < THROTTLE_MS) return;
    lastTouchTime = now;
    try {
      await functions.invoke('custom_auth_me');
    } catch {}
  },
  async rotateSession() {
    return this.touchSession();
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
      // Reads through readLocalSessionRecord(), the single reader that matches
      // the writer. This used to do its own localStorage.getItem(LOCAL_SESSION_KEY)
      // and JSON.parse — but the session is written with secureStore(), which
      // AES-GCM encrypts the value AND prefixes the key. So the plain read looked
      // in a slot nothing ever writes and returned null for every signed-in user.
      const session = await readLocalSessionRecord();
      return session ? { userId: session.userId, token: 'local' } : null;
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
      // This is a stub: there is no client-side mail transport, and there cannot
      // be one — sending mail needs a credential, which must never reach the
      // browser. Real mail is sent server-side by the base44 functions
      // (custom_auth_register, custom_auth_reset_request) through
      // asServiceRole.integrations.Core.SendEmail, so password resets and
      // registrations are unaffected by this stub.
      //
      // console.warn, not console.log, for two reasons. The production build
      // strips console.log (vite.config.js `esbuild.pure`), and this line is not
      // a debug trace — it is the only signal that a notification did not go
      // out. It logs the body's length rather than the body: the one caller
      // (reportParsers.js:1262) passes anomaly detail including property names,
      // and a shared front-desk browser console is not a place to leave that.
      // The detection itself is durably recorded in the audit log by the caller
      // immediately above that line, so nothing is lost but the email.
      console.warn(
        `[Email] Not sent — no client-side mail transport. ` +
          `to="${to}" subject="${subject}" body=${body ? `${body.length} chars` : 'empty'}`
      );
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
  // Never return credential material to the client/session. `mfa_secret_pending`
  // belongs here for the same reason as `mfa_secret`: handleLocalEnableMfa writes
  // a live TOTP enrolment seed to it a few lines below, and this function is what
  // the local list/update/login shims return. It was missing, exactly as it was
  // missing from the three server-side copies of publicUser() — the shared cause
  // being a denylist, which is public-by-default for every column added later.
  const {
    password, password_hash, salt, mfa_secret, mfa_secret_pending, mfa_last_counter,
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

// The persisted local session record, or null if there is none or it expired.
// Deliberately the ONLY reader of LOCAL_SESSION_KEY: both writers go through
// secureStore(), so anything that reads the slot has to go through
// secureRetrieve() to see it. auth.getCurrentSession() kept a second, plain-
// localStorage copy of this logic, which silently returned null forever.
async function readLocalSessionRecord() {
  const raw = await secureRetrieve(LOCAL_SESSION_KEY);
  if (!raw) return null;
  try {
    const record = JSON.parse(raw);
    if (!record?.userId) return null;
    if (new Date(record.expiresAt) < new Date()) {
      await secureStore(LOCAL_SESSION_KEY, '');
      return null;
    }
    return record;
  } catch {
    await secureStore(LOCAL_SESSION_KEY, '');
    return null;
  }
}

async function getLocalSessionUser() {
  const session = await readLocalSessionRecord();
  if (!session) return null;
  try {
    const user = await localDb.User.get(session.userId);
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
  // NOTE ON DIVERGENCE: the branches below do not implement the step-up password,
  // the TOTP replay guard, the verification throttle or the session revocation
  // that custom_user_admin/entry.js enforces. They are reachable only when
  // VITE_USE_LOCAL_AUTH=true (.env.development), which is off in every deployed
  // build — production always takes the `!USE_LOCAL_AUTH` early return above and
  // talks to the real function. A `currentPassword` sent by the UI is accepted and
  // ignored here rather than checked, so MFA flows stay usable offline; do not
  // read these as the security model.
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

/**
 * Match one audit row against a caller-supplied filter. Local-dev shim only.
 *
 * WHY THIS EXISTS. handleLocalAuditList honoured exactly one key — `filter.action`
 * — and silently dropped every other one, so `db.audit.list({ property_id: 'x' })`
 * returned rows from every property. Measured 2026-08-23 by
 * scripts/test_defect_5_probe.mjs: three rows seeded across two properties plus
 * null, asked for one, got all three.
 *
 * Production was never affected. base44/functions/audit_list/entry.js spreads the
 * caller's filter into the datastore query (`effectiveFilter`), derives the allowed
 * scope from the authenticated actor, and refuses out-of-scope ids with 403; and
 * src/main.jsx refuses to boot when PROD && VITE_USE_LOCAL_AUTH === 'true', so this
 * shim cannot serve a real user. It was a dev/prod parity defect — and a
 * load-bearing one, because scripts/_loader-boot.mjs sets VITE_USE_LOCAL_AUTH=true,
 * which means every suite in scripts/ that reads db.audit.list was asserting
 * against a mock that ignored filters. A property-scoping regression in the audit
 * read path was undetectable in the harness.
 *
 * `{ $in: [...] }` is supported because the server generates that shape itself:
 * propertyFilterFor() in the entry file emits it whenever a restricted actor's
 * scope spans more than one property. The String() comparison mirrors that file's
 * `value.$in.map(String)`.
 *
 * Any other operator object ({ $ne }, { $regex }, a bare nested object) matches
 * NOTHING rather than being ignored. The server rejects those with 400, so neither
 * path yields rows; failing closed keeps an unrecognized operator from quietly
 * widening a read, which is the direction this function was already wrong in once.
 *
 * NOT mirrored, deliberately: actor-derived property scoping and the 403 on
 * cross-tenant ids. Those need the authenticated user, and src/lib/launchPolicy.js
 * admits only all-property accounts, so there is no restricted actor to scope.
 * Sort order is also left alone — src/pages/AuditLog.jsx sorts client-side via
 * sortAuditLogs, so the shim's insertion order has no consumer.
 *
 * @param {any} row
 * @param {any} filter
 * @returns {boolean}
 */
function auditRowMatchesFilter(row, filter) {
  for (const key of Object.keys(filter)) {
    const want = filter[key];
    if (want === undefined) continue;
    const got = row ? row[key] : undefined;
    if (want !== null && typeof want === 'object') {
      const keys = Array.isArray(want) ? [] : Object.keys(want);
      if (keys.length === 1 && keys[0] === '$in' && Array.isArray(want.$in)) {
        if (!want.$in.some((/** @type {any} */ v) => String(v) === String(got))) return false;
        continue;
      }
      return false;
    }
    if (got !== want) return false;
  }
  return true;
}

async function handleLocalAuditList({ filter = /** @type {any} */ ({}), limit = 500 } = {}) {
  // `db.audit.list(null)` arrives here as filter === null: a parameter default
  // fills in `undefined` only. The server performs the same coercion with
  // `payload.filter || {}`.
  const active = /** @type {any} */ (filter == null ? {} : filter);
  // A non-object filter is answered with 400 by the server — no rows either way.
  if (typeof active !== 'object' || Array.isArray(active)) return { logs: [] };

  let logs = await localDb.AuditLog.toArray();
  logs = logs.filter((row) => auditRowMatchesFilter(row, active));
  if (typeof limit === 'number') logs = logs.slice(-limit);
  return { logs };
}

async function handleLocalAuditClear() {
  // Append-only, in dev too. A local "clear" that works while production
  // refuses would train the operator to expect a capability that does not
  // exist, and would hide chain breakage during development — the exact place
  // it is cheapest to notice. Mirrors base44/functions/audit_clear/entry.js.
  throw new Error('The audit log is append-only. Clearing it is not permitted.');
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

  // Launch policy: only accounts entitled to every property may sign in
  // (see src/lib/launchPolicy.js for why, and base44/functions/custom_auth_login
  // for the authoritative server-side copy of this rule).
  //
  // Checked HERE — after the password and MFA — on purpose. Refusing earlier
  // would answer "does this account exist, and is it restricted?" to anyone who
  // can reach the login form, which is an account-enumeration oracle. Past this
  // point the caller has already proven they hold the credentials, so naming the
  // reason tells them nothing they did not already know.
  if (!hasAllPropertyAccess(user)) {
    throw allPropertyRequiredError();
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
    // Put the csrf_token cookie back in step with the X-CSRF-Token header the SDK
    // froze at construction (see CSRF_HEADER_TOKEN). Any rotation since then left
    // the pair mismatched, and the server compares them on every mutating call.
    pinCsrfCookie();
    const res = await realClient.functions.invoke(functionName, params);
    if (functionName === 'deleteAccount') {
      await Promise.all(localDb.tables.map((t) => t.clear()));
      localStorage.clear();
    }
    return res;
  } catch (e) {
    console.error(`[realClient] failed to invoke ${functionName}:`, e);
    if (e.response && e.response.data && e.response.data.error) {
      const err = /** @type {Error & { code?: string }} */ (new Error(e.response.data.error));
      // Carry the server's machine-readable code across the rewrap. Callers that
      // must distinguish one refusal from another (see Login.jsx and
      // src/lib/launchPolicy.js) cannot do it on the message text alone.
      if (e.response.data.code) err.code = e.response.data.code;
      throw err;
    }
    throw e;
  }
}

const functions = {
  async invoke(functionName, params = {}) {
    // Drop the cached authorization snapshot before any call that can change
    // identity or privileges. Invalidating up front (rather than on success)
    // means a partially-applied change can never leave a wider grant cached.
    if (PRIVILEGE_MUTATING_FUNCTIONS.has(functionName)) invalidatePropertyAccess();
    if (functionName === 'aiAssistant' || functionName === 'query_database') {
      const start = Date.now();
      try {
        // Resolve the AI's property scope from the SESSION, not from the caller.
        // AIAssistant.jsx used to compute `allowedPropertyIds` itself from the
        // user object and send it along — an authorization decision made by the
        // thing being authorized, and one that resolved to "unrestricted" when
        // there was no user at all. The assistant summarises revenue across
        // whatever it is given, so that hint was a portfolio-wide read for
        // anyone who could edit a request.
        const access = await getUserPropertyAccess();
        const data = await answerQuestion({
          question: params.question || '',
          propertyId: params.propertyId,
          from: params.dateFrom || (params.from || ""),
          to: params.dateTo || (params.to || ""),
          allowedPropertyIds: access,
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
    if (functionName === 'custom_auth_me' || functionName === 'custom_auth_check') {
      try {
        const local = await handleLocalAuthMe();
        if (local.user) return local;
        const remote = await tryRemote(functionName, params);
        if (remote && remote.user) {
          const mirrored = await mirrorRemoteUserIntoLocal(remote.user);
          return { user: publicUserLocal(mirrored) || remote.user };
        }
        return local;
      } catch (e) {
        console.error(`[localAuth] ${functionName} failed:`, e);
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

  // currentPassword is the CALLER's own password, and the server demands it
  // whenever this call would replace a second factor that is already in use (see
  // custom_user_admin#enable_mfa). A first-time enrolment does not need it, so the
  // argument is optional here and the UI only prompts when it has to.
  async enableMfa(actor, id, currentPassword) {
    return functions.invoke('custom_user_admin', { action: 'enable_mfa', id, currentPassword });
  },

  // currentPassword is the CALLER's own password. Always required: removing a
  // second factor with nothing but a session cookie would turn a stolen cookie
  // into permanent password-only access to the account.
  async disableMfa(actor, id, currentPassword) {
    return functions.invoke('custom_user_admin', { action: 'disable_mfa', id, currentPassword });
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
