import Dexie from 'dexie';

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
});

export default localDb;
