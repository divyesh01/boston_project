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
 *   ImportSession: import('dexie').Table<any, number>;
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

export default localDb;
