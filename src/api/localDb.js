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
 *   Room: import('dexie').Table<any, number>;
 *   RoomStay: import('dexie').Table<any, number>;
 *   HousekeepingTask: import('dexie').Table<any, number>;
 *   WeatherSnapshot: import('dexie').Table<any, number>;
 *   Review: import('dexie').Table<any, number>;
 *   ImportRecordIds: import('dexie').Table<any, number>;
 *   ScanResult: import('dexie').Table<any, number>;
 *   HotelMetric: import('dexie').Table<any, number>;
 *   TransactionLine: import('dexie').Table<any, number>;
 *   PasswordResetRequest: import('dexie').Table<any, number>;
 *   AnomalyAlert: import('dexie').Table<any, number>;
 *   Reservation: import('dexie').Table<any, number>;
 *   RoomType: import('dexie').Table<any, number>;
 *   ChannelMap: import('dexie').Table<any, number>;
 *   AdjustmentRefund: import('dexie').Table<any, number>;
 *   TimecardPunch: import('dexie').Table<any, number>;
 *   DailyFinancialAggregate: import('dexie').Table<any, number>;
 *   LocalSession: import('dexie').Table<any, number>;
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

// v13 — add PasswordResetRequest table for self-service password reset flow
localDb.version(13).stores({
  PasswordResetRequest: '++id, user_id, token, expires_at, used, created_date',
});

// v14 — compound indexes for indexed range queries.
//
// [property_id+date] on the four daily ledgers is the driving index for every
// property-scoped date-range read (Dashboard, Payments, Sources, occupancy
// pages). It sits alongside the existing [date+property_id] so trend scans that
// start from the date axis stay indexed too. [property_id+status] on Expense
// serves status scoping (e.g. committed/approved expense filters). Adding
// indexes is a non-destructive upgrade: Dexie backfills the new indexes from
// existing rows without touching data.
localDb.version(14).stores({
  OccupancyDay:     '++id, date, property_id, [date+property_id], [property_id+date], import_id, created_date',
  SourceDay:        '++id, date, property_id, code, source, [date+property_id], [property_id+date], import_id, created_date',
  GrossRevenueDay:  '++id, date, property_id, [date+property_id], [property_id+date], import_id, created_date',
  PaymentDay:       '++id, date, property_id, [date+property_id], [property_id+date], import_id, created_date',
  Expense:          '++id, property_id, expense_date, category, status, [property_id+expense_date], [property_id+status], import_id, created_date',
});

// v15 — automated financial anomaly & fraud detection alerts.
//
// One row per flagged transaction (see src/lib/anomalyDetector.js). [property_id+date]
// is the driving index for the Dashboard banner's property-scoped date-range read.
localDb.version(15).stores({
  AnomalyAlert: '++id, property_id, date, alert_type, status, [property_id+date], [property_id+date+alert_type], dedupe_key, created_date',
});

// v16 — operational modules: enhanced room board, housekeeping, weather cache,
// and guest reputation. All are property-scoped (enforcement lives in
// base44Client's PROPERTY_TABLES) and are additive — no existing store changes.
//
// Room is the room master register; RoomStay is the per-room nightly ledger the
// enhanced Room Board renders (guest, check-in/out, rate stored in integer
// cents, room type). HousekeepingTask is the operational room-cleaning queue.
// WeatherSnapshot caches OpenWeather responses per property+date to respect the
// API rate limit. Review is the aggregated review inbox (Google / TripAdvisor /
// OTA) with a sentiment column computed at ingest.
localDb.version(16).stores({
  Room: '++id, property_id, room_number, room_type, floor, capacity, [property_id+room_number], [property_id+status], created_date',
  RoomStay: '++id, property_id, date, room_number, guest_name, status, [property_id+date], [property_id+room_number], [property_id+date+status], created_date',
  HousekeepingTask: '++id, property_id, task_date, room_number, assignee, status, [property_id+task_date], [property_id+room_number], [property_id+task_date+status], created_date',
  WeatherSnapshot: '++id, property_id, date, kind, [property_id+date], [property_id+date+kind], created_date',
  Review: '++id, property_id, source, rating, sentiment, status, review_date, [property_id+review_date], [property_id+source+status], created_date',
});

// v17 — Add AdjustmentRefund for Clerk Audit.
localDb.version(17).stores({
  AdjustmentRefund: '++id, property_id, date, record_type, username, [property_id+date], [property_id+username], import_id, created_date',
});

// v18 — Channel Manager tables that were lost due to a duplicate version(16)
// overwrite in an earlier migration. Adding them as a forward-only new version
// so existing databases (already at v17) can upgrade without a schema conflict.
localDb.version(18).stores({
  Reservation: '++id, property_id, channel, confirmation_num, check_in, check_out, room_type_id, status, [property_id+check_in], created_date',
  RoomType: '++id, property_id, name, total_inventory',
  ChannelMap: '++id, property_id, channel_name, local_room_id, remote_room_id',
});

// v19 — raw clock-in/clock-out punches for the timecard reconciler
// (src/lib/timecardCalc.js). One row per punch pair; `shift_date` is the day
// the shift started, `clock_in`/`clock_out` are free-text times (HH:MM or
// HH:MM AM/PM) parsed by the reconciler. Property-scoped like the other
// operational tables; enforcement lives in base44Client's PROPERTY_TABLES.
localDb.version(19).stores({
  TimecardPunch: '++id, property_id, employee_name, employee_id, department, shift_date, [property_id+shift_date], import_id, created_date',
});

// v20 — materialized daily financial aggregates.
//
// One row per (property_id, business_date) holding the additive daily totals
// the dashboard derives from the four daily ledgers (occupancy / source /
// gross / payment) plus per-day expense sums. Rebuilt on every import so the
// Dashboard can read a few hundred pre-summed rows instead of scanning tens of
// thousands of raw rows — keeping metric loads instant at scale. The raw rows
// stay canonical; this cache is recomputed, never hand-edited.
localDb.version(20).stores({
  DailyFinancialAggregate: '++id, property_id, business_date, [property_id+business_date], created_date',
});

// v21 — local auth session table (browser-only mode, no backend required).
localDb.version(21).stores({
  LocalSession: '++id, user_id, token_hash, is_revoked, expires_at, created_date',
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
