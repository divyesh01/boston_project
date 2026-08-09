import Dexie from 'dexie';

// The runtime instance exposes a typed table per schema (see version().stores() below).
/** @type {import('dexie').Dexie & {
 *   Property: import('dexie').Table<any, number>;
 *   OccupancyDay: import('dexie').Table<any, number>;
 *   SourceDay: import('dexie').Table<any, number>;
 *   GrossRevenueDay: import('dexie').Table<any, number>;
 *   PaymentDay: import('dexie').Table<any, number>;
 *   ClerkShiftRecord: import('dexie').Table<any, number>;
 *   UploadedReport: import('dexie').Table<any, number>;
 *   Expense: import('dexie').Table<any, number>;
 *   PayrollRun: import('dexie').Table<any, number>;
 *   User: import('dexie').Table<any, number>;
 *   AuditLog: import('dexie').Table<any, number>;
 *   Staff: import('dexie').Table<any, number>;
 *   ImportRecordIds: import('dexie').Table<any, number>;
 *   ScanResult: import('dexie').Table<any, number>;
 *   HotelMetric: import('dexie').Table<any, number>;
 *   TransactionLine: import('dexie').Table<any, number>;
 * }} */
// @ts-ignore — augment the non-generic Dexie interface with the app's tables.
const localDb = new Dexie('RedRoofIntelligence');

localDb.version(1).stores({
  Property:         '++id, code, name, active, created_date',
  OccupancyDay:     '++id, date, property_id, created_date',
  SourceDay:        '++id, date, property_id, code, source, created_date',
  GrossRevenueDay:  '++id, date, property_id, created_date',
  PaymentDay:       '++id, date, property_id, created_date',
  ClerkShiftRecord: '++id, property_id, record_type, clerk_name, shift_date, created_date',
  UploadedReport:   '++id, report_type, property_id, created_date',
  Expense:          '++id, property_id, expense_date, category, status, created_date',
  PayrollRun:       '++id, property_id, pay_period_start, payroll_status, created_date',
  User:             '++id, email, role, created_date',
});

// v2 — add authentication & access-control fields plus the audit log table
localDb.version(2).stores({
  Property:         '++id, name, active, created_date',
  OccupancyDay:     '++id, date, property_id, created_date',
  SourceDay:        '++id, date, property_id, code, source, created_date',
  GrossRevenueDay:  '++id, date, property_id, created_date',
  PaymentDay:       '++id, date, property_id, created_date',
  ClerkShiftRecord: '++id, property_id, record_type, clerk_name, shift_date, created_date',
  UploadedReport:   '++id, report_type, property_id, created_date',
  Expense:          '++id, property_id, expense_date, category, status, created_date',
  PayrollRun:       '++id, property_id, pay_period_start, payroll_status, created_date',
  User:             '++id, username, email, role, is_active, created_date, updated_date',
  AuditLog:         '++id, user_id, username, action, performed_by_id, result, created_date',
});

// v3 — staff directory consumed by the automated payroll engine (autoPayroll)
localDb.version(3).stores({
  Property:         '++id, code, name, active, created_date',
  OccupancyDay:     '++id, date, property_id, created_date',
  SourceDay:        '++id, date, property_id, code, source, created_date',
  GrossRevenueDay:  '++id, date, property_id, created_date',
  PaymentDay:       '++id, date, property_id, created_date',
  ClerkShiftRecord: '++id, property_id, record_type, clerk_name, shift_date, created_date',
  UploadedReport:   '++id, report_type, property_id, created_date',
  Expense:          '++id, property_id, expense_date, category, status, created_date',
  PayrollRun:       '++id, property_id, pay_period_start, payroll_status, created_date',
  User:             '++id, username, email, role, is_active, created_date, updated_date',
  AuditLog:         '++id, user_id, username, action, performed_by_id, result, created_date',
  Staff:            '++id, property_id, employee_name, department, active, created_date',
});

// v6 — add referential integrity indexes, import session tracking, and better query performance
localDb.version(6).stores({
  Property:         '++id, code, name, active, created_date',
  OccupancyDay:     '++id, date, property_id, [date+property_id], import_id, created_date',
  SourceDay:        '++id, date, property_id, code, source, [date+property_id], import_id, created_date',
  GrossRevenueDay:  '++id, date, property_id, [date+property_id], import_id, created_date',
  PaymentDay:       '++id, date, property_id, [date+property_id], import_id, created_date',
  ClerkShiftRecord: '++id, property_id, record_type, clerk_name, shift_date, [property_id+shift_date], import_id, created_date',
  UploadedReport:   '++id, report_type, property_id, import_id, [property_id+created_date], created_date',
  Expense:          '++id, property_id, expense_date, category, status, [property_id+expense_date], import_id, created_date',
  PayrollRun:       '++id, property_id, pay_period_start, payroll_status, [property_id+pay_period_start], import_id, created_date',
  User:             '++id, username, email, role, is_active, [username+email], created_date, updated_date, mfa_enabled, mfa_secret',
  AuditLog:         '++id, user_id, username, action, performed_by_id, result, created_date, hash, previous_hash',
  Staff:            '++id, property_id, employee_name, department, active, [property_id+employee_name], import_id, created_date',
  ImportSession:    '++id, import_id, property_id, status, started_at, completed_at, row_counts, created_date',
});

// v7 — add ScanResult table for the Data Intelligence module
localDb.version(7).stores({
  ScanResult: '++id, file_id, property_id, scanned_at, created_date, health_score',
});

// v8 — add HotelMetric table for universal hotel data ingestion
localDb.version(8).stores({
  HotelMetric: '++id, property_id, business_date, section, metric_name, period, import_id, file_hash, [property_id+business_date], [property_id+business_date+section+metric_name+period], created_date',
});

// v9 — add Transaction table for line-level PMS transaction ledgers.
//
// SUPERSEDED BY v10. `Transaction` is a reserved property name on a Dexie
// instance: `db.Transaction` resolves to Dexie's own Transaction class, not to
// the table. The store was created but was unreachable through the `localDb[name]`
// property access the whole app uses, so nothing could ever read or write it.
// Left declared here so the version history stays continuous; v10 renames it.
localDb.version(9).stores({
  Transaction: '++id, property_id, date, username, transaction_code, transaction_type, charge_category, folio_number, confirmation_number, room_number, import_id, file_hash, dedupe_key, [property_id+date], [property_id+username], [username+date], [property_id+date+username], created_date',
});

// v10 — rename the transaction ledger to TransactionLine (one row = one posted
// line on a folio), which does not collide with Dexie's own API.
//
// Dropping the v9 `Transaction` store is safe, not a destructive migration: it
// was unreachable by construction (see above), so no code path could have
// written a row to it. `null` on a store that was never created is a no-op.
//
// Index choices are driven by the queries the analytics pages actually run:
//   date                     — daily/weekly/monthly trend scans
//   [property_id+date]       — the standard property-scoped range scan
//   username                 — per-employee rollups
//   [property_id+username]   — employee comparison within a property
//   [username+date]          — one employee's activity over time
//   transaction_code         — charge-mix breakdowns
//   folio_number             — folio drill-down
//   dedupe_key               — re-import guard (see reportParsers)
// `import_id` and `file_hash` mirror the other imported tables so rollback and
// file-level dedupe work identically here.
localDb.version(10).stores({
  Transaction: null,
  TransactionLine: '++id, property_id, date, username, transaction_code, transaction_type, charge_category, ledger_side, folio_number, confirmation_number, room_number, import_id, file_hash, dedupe_key, [property_id+date], [property_id+username], [username+date], [property_id+date+username], created_date',
});

// v11 — split the rollback ledger out of ImportSession into ImportRecordIds.
//
// `ImportSession` named two unrelated things: the v6 Dexie table (one row per
// import_id+entity, holding the array of created record ids that rollback
// deletes) and a separate lifecycle record — status in_progress/completed, row
// counts — that base44Client.js keeps in secureStore. They share no fields and
// use different casings, snake_case here and camelCase there. Reading the wrong
// one failed silently rather than loudly: a `status === "completed"` query
// against the Dexie table always matched 0 rows because nothing ever wrote a
// status there, which looked exactly like a failed import.
//
// Distinct names make the two impossible to confuse. Lifecycle questions ("did
// this import finish?") go to listImportSessions(); ledger questions ("what did
// it write?") go to ImportRecordIds.
//
// Split across two versions on purpose: Dexie applies the schema change before
// the upgrade callback runs, so a store dropped in the same version it is read
// from is already gone by then. v11 copies, v12 drops.
localDb.version(11).stores({
  ImportSession:    '++id, import_id, property_id, status, started_at, completed_at, row_counts, created_date',
  ImportRecordIds:  '++id, import_id, property_id, entity, status, [import_id+entity], created_date',
}).upgrade(async (tx) => {
  const carried = await tx.table('ImportSession').toArray();
  const ledgerRows = carried
    .filter((r) => Array.isArray(r.record_ids) && r.record_ids.length)
    .map(({ id, ...row }) => ({ ...row, status: row.status || 'active' }));
  if (ledgerRows.length) await tx.table('ImportRecordIds').bulkAdd(ledgerRows);
});

// v12 — drop ImportSession now that v11 has copied its ledger rows across.
localDb.version(12).stores({
  ImportSession: null,
});

// Guard: a table whose name collides with a Dexie instance property is created
// in IndexedDB but is unreachable through `localDb[name]` — which is how every
// caller in this app reaches its tables. That failure is silent: writes appear
// to succeed against Dexie's own class and reads return nothing. `Transaction`
// hit exactly this in v9. Fail loudly at startup instead.
//
// Checked against the tables Dexie actually declared, so it costs one pass over
// a dozen names at module load and cannot drift from the schema above.
const RESERVED_TABLE_NAMES = new Set([
  'Table', 'Version', 'WhereClause', 'Collection', 'Transaction',
  'vip', 'on', 'use', 'open', 'close', 'delete', 'backendDB', 'isOpen',
  'name', 'tables', 'verno', 'core', '_dbSchema',
]);
for (const table of localDb.tables) {
  if (RESERVED_TABLE_NAMES.has(table.name) || typeof localDb[table.name]?.toArray !== 'function') {
    throw new Error(
      `[localDb] Table "${table.name}" collides with a Dexie instance property, so localDb.${table.name} ` +
      `does not resolve to the table. Rename the store (e.g. "${table.name}Line" or "${table.name}Record").`
    );
  }
}

export default localDb;
