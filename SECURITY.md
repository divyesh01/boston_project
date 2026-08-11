# SECURITY DIRECTIVES — SCHEMAS, SANITIZATION & AUDIT LOGS

## 1. CSV FORMULA INJECTION DEFENSE
- Apply CSV formula neutralization (`=`, `@`, `+`, `-`) strictly during **export/download** generation.
- Never prepend formula defense characters (e.g. literal apostrophes `'`) during **import**, as this corrupts numeric values in IndexedDB into `NaN` strings.

## 2. IMMUTABLE AUDIT LOGGING
- `AuditLog` records must remain immutable and append-only.
- Disallow `update` or `delete` operations on `AuditLog` tables in `src/api/base44Client.js`.
- Include cryptographic SHA-256 hashes (`prev_hash`) linking consecutive audit entries.

## 3. PROPERTY & ACCESS SCOPING
- Ensure all entity queries (`OccupancyDay`, `SourceDay`, `PaymentDay`, `Expense`, `PayrollRun`) strictly respect `property_id` filters to prevent multi-tenant data leakage.