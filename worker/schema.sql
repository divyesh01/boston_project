-- ===========================================================================
-- boston_shared_local — Cloudflare D1 schema (Phase 1, off-production)
--
-- MONEY CONTRACT (load-bearing — do not "optimise" to INTEGER/NUMERIC):
--   Money is never SUM()'d in SQL on fractional-dollar columns; scoped queries
--   return rows and totals are computed in JS via src/lib/decimal.js
--   sumCents/toCents. Integer rate_cents MAY be summed in SQL.
--
--   Every money field declared "type":"number" in base44/entities/*.jsonc is a
--   REAL column here. REAL is an IEEE-754 double, which round-trips bit-exact
--   with a JS Number, so the $1,020,598.17 reconciliation survives with zero
--   read-site edits (the client Dexie stays numeric this phase). Non-money
--   numeric fields (room counts, rates, health scores) are ALSO REAL for the
--   same bit-exact-Number reason and because the client treats every numeric
--   column as a JS Number regardless. RoomStay.rate_cents is the ONLY field
--   that holds integer cents; it is REAL and is NOT rescaled (it keeps the same
--   integer value the client wrote), and being integer-valued it MAY be SUM()'d
--   in SQL exactly.
--
-- IDENTITY / property_id CONTRACT:
--   `property` owns a server-issued stable TEXT id and a UNIQUE business `code`.
--   EVERY child table's property_id is TEXT REFERENCES property(id) ON DELETE
--   CASCADE, so the DATABASE enforces the cascade that string-matching in the
--   client used to fake (the orphan bug). The client Dexie keeps numeric ++id;
--   the numeric->TEXT unification is deferred to Phase 2.
--
--   D1 does NOT honour foreign keys unless they are enabled per connection.
--   The Worker MUST run `PRAGMA foreign_keys = ON;` (or D1 `execute` with FK
--   enforcement) before any cascade-dependent write, or ON DELETE CASCADE and
--   the REFERENCES checks are silently inert. The PRAGMA below documents intent
--   for a local `wrangler dev --local` / sqlite3 load.
-- ===========================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- IDENTITY ROOT
-- ---------------------------------------------------------------------------

CREATE TABLE account (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  created_date TEXT NOT NULL
);

-- The parent every property-scoped table cascades from. `id` is the server's
-- stable TEXT key (not the client's numeric ++id); `code` is the cross-device
-- business key the import maps onto.
CREATE TABLE property (
  id           TEXT PRIMARY KEY,          -- server-issued stable id
  account_id   TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  code         TEXT NOT NULL,             -- cross-device stable business key
  name         TEXT NOT NULL,
  rooms        REAL,                      -- count; REAL for bit-exact JS Number
  address      TEXT,
  city         TEXT,
  state        TEXT,
  phone        TEXT,
  active       INTEGER NOT NULL DEFAULT 1, -- boolean 0/1
  created_date TEXT,
  UNIQUE (account_id, code),
  UNIQUE (account_id, id)
);
CREATE INDEX idx_property_account ON property (account_id);

-- The account's people. NOT property-scoped by a single FK: access is expressed
-- by property_access_mode + the user_property_access join, mirroring the legacy
-- client shape `property_access: 'all' | string[]`.
--
--   property_access_mode = 'all'      -> unrestricted (no rows in the join)
--   property_access_mode = 'specific' -> grants live in user_property_access
--
-- The server MUST project this back to the legacy client shape when it answers:
-- mode='all' -> "all"; mode='specific' -> the array of granted property ids.
-- Migration maps BOTH today's null AND the literal 'all' -> mode='all'. Roles
-- owner/admin override the mode entirely and are ALWAYS treated as 'all'; the
-- stored mode for such a user is irrelevant to the scope resolver. There is NO
-- null sentinel column — the CHECK forbids any third value.
--
-- CONSTRAINT PARITY: every column below is declared EXACTLY as
-- migrations-production/0001_auth_schema.sql declares it, and
-- scripts/verify-schema-parity.mjs fails the build if the two ever drift again.
-- The NOT NULLs are not decoration: they are what makes a harness INSERT that
-- omits password_hash/salt fail here the same way it fails in production.
CREATE TABLE user (
  id                     TEXT PRIMARY KEY,
  account_id             TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  username               TEXT NOT NULL,
  display_name           TEXT,
  email                  TEXT NOT NULL,
  role                   TEXT NOT NULL,
  property_access_mode   TEXT NOT NULL CHECK (property_access_mode IN ('all','specific')),
  permissions            TEXT,             -- JSON object, per-feature flags
  is_active              INTEGER NOT NULL DEFAULT 1,  -- boolean 0/1
  is_locked              INTEGER NOT NULL DEFAULT 0,
  must_change_password   INTEGER NOT NULL DEFAULT 0,
  mfa_enabled            INTEGER NOT NULL DEFAULT 0,
  email_confirmed        INTEGER NOT NULL DEFAULT 1,
  password_hash          TEXT NOT NULL,
  salt                   TEXT NOT NULL,
  mfa_secret             TEXT,
  mfa_secret_pending     TEXT,
  mfa_last_counter       INTEGER,
  reset_token_hash       TEXT,
  reset_token_expires_at TEXT,
  last_login             TEXT,
  failed_login_count     INTEGER NOT NULL DEFAULT 0,
  locked_until           TEXT,
  session_created        TEXT,
  session_expires        TEXT,
  created_date           TEXT NOT NULL,
  updated_date           TEXT NOT NULL,
  UNIQUE (account_id, id)
);
CREATE INDEX idx_user_username ON user (username);
CREATE UNIQUE INDEX idx_user_username_ci ON user (lower(username));
CREATE UNIQUE INDEX idx_user_email_ci ON user (lower(email));

-- Browser-independent application sessions. The browser receives only the
-- random bearer token in an HttpOnly cookie; D1 stores its SHA-256 digest, so a
-- database read cannot be replayed as a session. Deleting a user revokes every
-- session through the foreign key.
CREATE TABLE app_session (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  remember     INTEGER NOT NULL DEFAULT 0 CHECK (remember IN (0, 1))
);
CREATE INDEX idx_app_session_user ON app_session (user_id);
CREATE INDEX idx_app_session_expiry ON app_session (expires_at);

-- Five-minute, single-use proof that the password step succeeded. This lets
-- the MFA submission avoid retaining/re-hashing the password while never
-- turning the challenge itself into a full application session.
CREATE TABLE app_mfa_challenge (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_app_mfa_challenge_expiry ON app_mfa_challenge (expires_at);

-- Per-property grants; populated ONLY when a user's mode = 'specific'. A grant
-- is deleted automatically if either the user or the property is removed.
CREATE TABLE user_property_access (
  account_id  TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,
  property_id TEXT NOT NULL,
  FOREIGN KEY (account_id, user_id) REFERENCES user(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, property_id) REFERENCES property(account_id, id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, property_id)
);
CREATE INDEX idx_upa_account_user ON user_property_access (account_id, user_id);
CREATE INDEX idx_upa_property ON user_property_access (property_id);

-- ---------------------------------------------------------------------------
-- PHASE-2 MIGRATION BOOKKEEPING (NOT AN IMPORT RUNTIME TABLE)
--
-- Records how the canonical browser's historical local property references map
-- onto server ids. THE IMPORT RUNTIME DOES NOT READ THIS TABLE AT ALL:
-- worker/import.js resolves a row's canonical `property_code` against the
-- account-scoped `property` roster (UNIQUE(account_id, code)), which is the
-- authoritative table the app writes when a property is created. Resolving
-- through this bridge made an entity-created property unimportable, because no
-- production code ever writes here.
--
-- `local_numeric_id` IS LIKEWISE NOT READ BY THE IMPORT RUNTIME. worker/import.js
-- resolves code-only: it never binds this column, never projects it, and never
-- accepts a browser-local numeric id as a property reference (such a row is
-- rejected 422 `property_code is required`).
--
-- PHASE 2 MUST ADD AN EXPLICIT `(local_numeric_id, code, server_id)` CONSISTENCY
-- GATE before either column is trusted as a key: nothing validates them at
-- runtime, so a stale or cross-browser value can sit here unnoticed.
-- `server_id` FK-cascades so a deleted property drops its map row too.
-- ---------------------------------------------------------------------------
CREATE TABLE property_id_map (
  account_id       TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  local_numeric_id INTEGER NOT NULL,
  code             TEXT NOT NULL,
  server_id        TEXT NOT NULL,
  FOREIGN KEY (account_id, server_id) REFERENCES property(account_id, id) ON DELETE CASCADE,
  PRIMARY KEY (account_id, code),
  UNIQUE (account_id, local_numeric_id)
);

-- ---------------------------------------------------------------------------
-- RESUMABLE CHUNKED IMPORT PROGRESS
--
-- One row per import. A retried chunk is idempotent because the chunk writes its
-- rows AND advances chunk_cursor/rows_committed in ONE atomic transaction (see
-- worker/index.js import seam). Replaying a committed chunk_cursor is a no-op.
--
-- D1 LIMITS THAT SHAPE CHUNK SIZING (why chunks are small and atomic):
--   * 50 queries per Worker invocation on the free plan (1000 on paid).
--   * 100 bound parameters per statement -> ~10 rows per multi-row INSERT
--     (each transaction row binds ~10 columns).
--   * 100 KB per SQL statement; 2 MB per row.
--   * batch() does NOT pool these limits — each statement is still bounded.
-- Each chunk is therefore ONE atomic transaction that writes its data rows plus
-- its progress marker together. Orphan rows (a `property_code` the account's
-- `property` roster does not carry) are REJECTED LOUDLY, never dropped and never
-- written as a dangling FK — the FK REFERENCES above would reject them anyway
-- with foreign_keys = ON, and the import handler surfaces the rejection to the
-- caller.
-- ---------------------------------------------------------------------------
CREATE TABLE import_progress (
  account_id     TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  import_id      TEXT NOT NULL,
  property_id    TEXT REFERENCES property(id) ON DELETE CASCADE,
  chunk_cursor   INTEGER NOT NULL DEFAULT 0,
  rows_committed INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'in_progress'
                   CHECK (status IN ('in_progress','completed','failed')),
  created_date   TEXT,
  updated_date   TEXT,
  PRIMARY KEY (account_id, import_id)
);

-- ===========================================================================
-- TRANSACTION LEDGER (the money-and-idempotency core)
--
-- No committed entity schema exists; columns mirror what the app reads
-- (src/api/localDb.js v10 index list + src/lib/transactionNorm.js mapping).
-- `amount` is money -> REAL. `dedupe_key` mirrors transactionDedupeKey
-- (property_id|date|time|folio|code|amount|occurrence) computed with the SERVER
-- property id, and carries a UNIQUE constraint so a re-sent row cannot
-- double-insert; `occurrence` is baked into the key so legitimate byte-identical
-- multi-night postings remain distinct rows.
-- ===========================================================================
CREATE TABLE transaction_line (
  id                   TEXT PRIMARY KEY,
  property_id          TEXT NOT NULL REFERENCES property(id) ON DELETE CASCADE,
  date                 TEXT,
  time                 TEXT,
  username             TEXT,
  transaction_code     TEXT,
  transaction_type     TEXT,
  charge_category      TEXT,
  sub_charge_type      TEXT,
  outlet_name          TEXT,
  ledger_side          TEXT,               -- 'charge' | 'payment'
  payment_method       TEXT,
  account_class        TEXT,
  employee_label       TEXT,
  folio_number         TEXT,
  confirmation_number  TEXT,
  room_number          TEXT,
  guest_name           TEXT,
  guest_first_name     TEXT,
  guest_last_name      TEXT,
  card_last4           TEXT,
  amount               REAL,               -- money (signed as the PMS emitted)
  quantity             REAL,
  adults               REAL,
  remarks              TEXT,
  import_id            TEXT,
  file_hash            TEXT,
  dedupe_key           TEXT NOT NULL UNIQUE, -- per-row idempotency (server pid)
  created_date         TEXT
);
CREATE INDEX idx_txn_property_date ON transaction_line (property_id, date);
CREATE INDEX idx_txn_property_user ON transaction_line (property_id, username);
CREATE INDEX idx_txn_folio ON transaction_line (folio_number);

-- ===========================================================================
-- DAILY LEDGERS (committed entity schemas; every money field -> REAL)
-- ===========================================================================

CREATE TABLE occupancy_day (
  id                     TEXT PRIMARY KEY,
  property_id            TEXT NOT NULL REFERENCES property(id) ON DELETE CASCADE,
  property_name          TEXT,
  report_type            TEXT,
  import_id              TEXT,
  source_file            TEXT,
  date                   TEXT,
  day_of_week            TEXT,
  room_revenue           REAL,             -- money
  other_room_revenue     REAL,             -- money
  total_revenue          REAL,             -- money
  total_rooms            REAL,
  rooms_sold             REAL,
  rooms_sold_without_comp REAL,
  down_rooms             REAL,
  vacant_rooms           REAL,
  clean_rooms            REAL,
  dirty_rooms            REAL,
  stayover_rooms         REAL,
  same_day_bookings      REAL,
  comp_rooms             REAL,
  house_rooms            REAL,
  zero_rate_rooms        REAL,
  day_use_rooms          REAL,
  no_shows               REAL,
  cancellations          REAL,
  total_guests           REAL,
  adr                    REAL,             -- money (avg daily rate, dollars)
  occupancy              REAL,             -- rate
  revpar                 REAL,             -- money (revenue per available room)
  created_date           TEXT
);
CREATE INDEX idx_occ_property_date ON occupancy_day (property_id, date);

CREATE TABLE source_day (
  id                     TEXT PRIMARY KEY,
  property_id            TEXT NOT NULL REFERENCES property(id) ON DELETE CASCADE,
  property_name          TEXT,
  report_type            TEXT,
  import_id              TEXT,
  source_file            TEXT,
  date                   TEXT,
  day_of_week            TEXT,
  code                   TEXT,
  source                 TEXT,
  net_revenue            REAL,             -- money (== gross booked revenue, Model 1)
  stays                  REAL,
  adr                    REAL,             -- money
  occupancy_contribution REAL,
  revpar_contribution    REAL,
  created_date           TEXT
);
CREATE INDEX idx_src_property_date ON source_day (property_id, date);

CREATE TABLE gross_revenue_day (
  id              TEXT PRIMARY KEY,
  property_id     TEXT NOT NULL REFERENCES property(id) ON DELETE CASCADE,
  property_name   TEXT,
  report_type     TEXT,
  import_id       TEXT,
  source_file     TEXT,
  date            TEXT,
  day_of_week     TEXT,
  room_rent       REAL,                    -- money
  misc_charge     REAL,                    -- money
  system_charge   REAL,                    -- money
  food            REAL,                    -- money
  event           REAL,                    -- money
  bar             REAL,                    -- money
  laundry         REAL,                    -- money
  phone           REAL,                    -- money
  other           REAL,                    -- money
  non_revenue     REAL,                    -- money
  advance_deposit REAL,                    -- money
  beverage        REAL,                    -- money
  created_date    TEXT
);
CREATE INDEX idx_gross_property_date ON gross_revenue_day (property_id, date);

CREATE TABLE payment_day (
  id                   TEXT PRIMARY KEY,
  property_id          TEXT NOT NULL REFERENCES property(id) ON DELETE CASCADE,
  property_name        TEXT,
  report_type          TEXT,
  import_id            TEXT,
  source_file          TEXT,
  date                 TEXT,
  day_of_week          TEXT,
  cash                 REAL,               -- money
  "check"              REAL,               -- money ("check" is a SQL-adjacent word; quoted)
  closed_balance_folio REAL,               -- money
  corpay               REAL,               -- money
  direct_bill          REAL,               -- money
  loyalty_certificate  REAL,               -- money
  loyalty_discount     REAL,               -- money
  vip_pass             REAL,               -- money
  wire_transfer        REAL,               -- money
  amex                 REAL,               -- money
  discover             REAL,               -- money
  master               REAL,               -- money
  other                REAL,               -- money
  visa                 REAL,               -- money
  total                REAL,               -- money
  created_date         TEXT
);
CREATE INDEX idx_pay_property_date ON payment_day (property_id, date);

-- ===========================================================================
-- OPERATIONS / FINANCE (committed entity schemas)
-- ===========================================================================

CREATE TABLE clerk_shift_record (
  id                TEXT PRIMARY KEY,
  property_id       TEXT NOT NULL REFERENCES property(id) ON DELETE CASCADE,
  property_name     TEXT,
  report_type       TEXT,
  import_id         TEXT,
  source_file       TEXT,
  record_type       TEXT,
  payment_type      TEXT,
  clerk_name        TEXT,
  shift_date        TEXT,
  actual            REAL,                  -- money
  adjusted          REAL,                  -- money
  net_today         REAL,                  -- money
  amount            REAL,                  -- money
  transaction_count REAL,
  created_date      TEXT
);
CREATE INDEX idx_clerk_property_date ON clerk_shift_record (property_id, shift_date);

CREATE TABLE expense (
  id             TEXT PRIMARY KEY,
  property_id    TEXT NOT NULL REFERENCES property(id) ON DELETE CASCADE,
  property_name  TEXT,
  expense_name   TEXT,
  vendor         TEXT,
  category       TEXT,
  frequency      TEXT,
  amount         REAL,                     -- money
  expense_date   TEXT,
  payment_status TEXT,
  recurring      INTEGER,                  -- boolean 0/1
  taxable        INTEGER,                  -- boolean 0/1
  notes          TEXT,
  import_id      TEXT,
  created_date   TEXT
);
CREATE INDEX idx_expense_property_date ON expense (property_id, expense_date);

CREATE TABLE payroll_run (
  id               TEXT PRIMARY KEY,
  property_id      TEXT NOT NULL REFERENCES property(id) ON DELETE CASCADE,
  property_name    TEXT,
  employee_name    TEXT,
  department       TEXT,
  pay_type         TEXT,
  base_rate        REAL,                   -- money
  hours            REAL,
  regular_pay      REAL,                   -- money
  overtime_hours   REAL,
  overtime_rate    REAL,                   -- money
  overtime_pay     REAL,                   -- money
  bonus            REAL,                   -- money
  deductions       REAL,                   -- money
  total_pay        REAL,                   -- money
  pay_period_start TEXT,
  pay_period_end   TEXT,
  payroll_status   TEXT,
  payroll_date     TEXT,
  created_date     TEXT
);
CREATE INDEX idx_payroll_property_period ON payroll_run (property_id, pay_period_start);

CREATE TABLE staff (
  id             TEXT PRIMARY KEY,
  property_id    TEXT NOT NULL REFERENCES property(id) ON DELETE CASCADE,
  property_name  TEXT,
  employee_id    TEXT,
  employee_name  TEXT,
  department     TEXT,
  role_title     TEXT,
  pay_type       TEXT,
  base_rate      REAL,                     -- money
  hours          REAL,
  overtime_hours REAL,
  overtime_rate  REAL,                     -- money
  bonus          REAL,                     -- money
  deductions     REAL,                     -- money
  hire_date      TEXT,
  active         INTEGER,                  -- boolean 0/1
  import_id      TEXT,
  created_date   TEXT
);
CREATE INDEX idx_staff_property_name ON staff (property_id, employee_name);

CREATE TABLE timecard_punch (
  id            TEXT PRIMARY KEY,
  property_id   TEXT NOT NULL REFERENCES property(id) ON DELETE CASCADE,
  property_name TEXT,
  report_type   TEXT,
  import_id     TEXT,
  source_file   TEXT,
  employee_name TEXT,
  employee_id   TEXT,
  department    TEXT,
  shift_date    TEXT,
  clock_in      TEXT,
  clock_out     TEXT,
  break_minutes REAL,
  created_date  TEXT
);
CREATE INDEX idx_punch_property_date ON timecard_punch (property_id, shift_date);

CREATE TABLE uploaded_report (
  id                  TEXT PRIMARY KEY,
  property_id         TEXT NOT NULL REFERENCES property(id) ON DELETE CASCADE,
  property_name       TEXT,
  report_type         TEXT,
  import_id           TEXT,
  source_file         TEXT,
  drive_file_id       TEXT,
  drive_backup_status TEXT,
  file_name           TEXT,
  rows_imported       REAL,
  rows_skipped        REAL,
  rows_parsed         REAL,
  file_url            TEXT,
  columns             TEXT,                -- JSON array
  raw_rows            TEXT,                -- JSON array
  created_date        TEXT
);
CREATE INDEX idx_report_property ON uploaded_report (property_id, created_date);

-- ===========================================================================
-- TABLES WITH NO COMMITTED ENTITY SCHEMA
-- Columns mirror what the app reads (src/api/localDb.js index lists + grep of
-- src/). Money-bearing numeric fields are REAL; RoomStay.rate_cents is the one
-- integer-cents field and stays REAL, un-rescaled.
-- ===========================================================================

CREATE TABLE hotel_metric (
  id           TEXT PRIMARY KEY,
  property_id  TEXT NOT NULL REFERENCES property(id) ON DELETE CASCADE,
  business_date TEXT,
  section      TEXT,
  metric_name  TEXT,
  period       TEXT,
  value        REAL,                       -- may be money; REAL either way
  import_id    TEXT,
  file_hash    TEXT,
  created_date TEXT
);
CREATE INDEX idx_metric_property_date ON hotel_metric (property_id, business_date);
CREATE INDEX idx_metric_property_date_key
  ON hotel_metric (property_id, business_date, section, metric_name, period);

CREATE TABLE anomaly_alert (
  id           TEXT PRIMARY KEY,
  property_id  TEXT NOT NULL REFERENCES property(id) ON DELETE CASCADE,
  date         TEXT,
  alert_type   TEXT,
  status       TEXT,
  amount       REAL,                       -- money (flagged transaction amount)
  detail       TEXT,
  dedupe_key   TEXT,
  created_date TEXT
);
CREATE INDEX idx_anomaly_property_date ON anomaly_alert (property_id, date);

CREATE TABLE room (
  id           TEXT PRIMARY KEY,
  property_id  TEXT NOT NULL REFERENCES property(id) ON DELETE CASCADE,
  room_number  TEXT,
  room_type    TEXT,
  floor        TEXT,
  capacity     REAL,
  status       TEXT,
  created_date TEXT
);
CREATE INDEX idx_room_property_number ON room (property_id, room_number);

-- rate_cents is the ONLY integer-cents field in the model. It is REAL and is
-- NOT rescaled: it holds the same integer cent value the client wrote
-- (toRateCents), and being integer-valued it MAY be SUM()'d in SQL exactly.
CREATE TABLE room_stay (
  id           TEXT PRIMARY KEY,
  property_id  TEXT NOT NULL REFERENCES property(id) ON DELETE CASCADE,
  date         TEXT,
  room_number  TEXT,
  room_type    TEXT,
  guest_name   TEXT,
  check_in     TEXT,
  check_out    TEXT,
  rate_cents   REAL,                       -- integer cents, NOT rescaled
  status       TEXT,
  created_date TEXT
);
CREATE INDEX idx_stay_property_date ON room_stay (property_id, date);
CREATE INDEX idx_stay_property_room ON room_stay (property_id, room_number);

CREATE TABLE housekeeping_task (
  id           TEXT PRIMARY KEY,
  property_id  TEXT NOT NULL REFERENCES property(id) ON DELETE CASCADE,
  task_date    TEXT,
  room_number  TEXT,
  room_type    TEXT,
  assignee     TEXT,
  status       TEXT,
  created_date TEXT
);
CREATE INDEX idx_hk_property_date ON housekeeping_task (property_id, task_date);

CREATE TABLE weather_snapshot (
  id           TEXT PRIMARY KEY,
  property_id  TEXT NOT NULL REFERENCES property(id) ON DELETE CASCADE,
  date         TEXT,
  kind         TEXT,
  payload      TEXT,                       -- JSON cached API response
  created_date TEXT
);
CREATE INDEX idx_weather_property_date ON weather_snapshot (property_id, date);

CREATE TABLE review (
  id           TEXT PRIMARY KEY,
  property_id  TEXT NOT NULL REFERENCES property(id) ON DELETE CASCADE,
  source       TEXT,
  rating       REAL,
  sentiment    TEXT,
  status       TEXT,
  review_date  TEXT,
  guest_name   TEXT,
  created_date TEXT
);
CREATE INDEX idx_review_property_date ON review (property_id, review_date);

CREATE TABLE adjustment_refund (
  id           TEXT PRIMARY KEY,
  property_id  TEXT NOT NULL REFERENCES property(id) ON DELETE CASCADE,
  date         TEXT,
  record_type  TEXT,
  username     TEXT,
  amount       REAL,                       -- money
  import_id    TEXT,
  created_date TEXT
);
CREATE INDEX idx_adj_property_date ON adjustment_refund (property_id, date);

-- Materialised daily rollups (all additive money totals -> REAL). Recomputed on
-- import, never hand-edited.
CREATE TABLE daily_financial_aggregate (
  id             TEXT PRIMARY KEY,
  property_id    TEXT NOT NULL REFERENCES property(id) ON DELETE CASCADE,
  business_date  TEXT,
  total_revenue  REAL,                     -- money
  room_revenue   REAL,                     -- money
  other_revenue  REAL,                     -- money
  payments_total REAL,                     -- money
  expenses_total REAL,                     -- money
  created_date   TEXT
);
CREATE INDEX idx_dfa_property_date ON daily_financial_aggregate (property_id, business_date);

CREATE TABLE scan_result (
  id           TEXT PRIMARY KEY,
  property_id  TEXT NOT NULL REFERENCES property(id) ON DELETE CASCADE,
  file_id      TEXT,
  scanned_at   TEXT,
  health_score REAL,
  created_date TEXT
);
CREATE INDEX idx_scan_property ON scan_result (property_id, scanned_at);

CREATE TABLE reservation (
  id              TEXT PRIMARY KEY,
  property_id     TEXT NOT NULL REFERENCES property(id) ON DELETE CASCADE,
  channel         TEXT,
  confirmation_num TEXT,
  check_in        TEXT,
  check_out       TEXT,
  room_type_id    TEXT,
  status          TEXT,
  created_date    TEXT
);
CREATE INDEX idx_res_property_checkin ON reservation (property_id, check_in);

CREATE TABLE room_type (
  id              TEXT PRIMARY KEY,
  property_id     TEXT NOT NULL REFERENCES property(id) ON DELETE CASCADE,
  name            TEXT,
  total_inventory REAL
);
CREATE INDEX idx_roomtype_property ON room_type (property_id);

CREATE TABLE channel_map (
  id             TEXT PRIMARY KEY,
  property_id    TEXT NOT NULL REFERENCES property(id) ON DELETE CASCADE,
  channel_name   TEXT,
  local_room_id  TEXT,
  remote_room_id TEXT
);
CREATE INDEX idx_channel_property ON channel_map (property_id);

-- Account-wide monotonic id sequences (src/lib/employeeId.js). Deliberately NOT
-- property-scoped: the payroll de-dupe key carries no property_id, so an id must
-- be unique across the whole account. last_seq is a true integer counter.
CREATE TABLE id_sequence (
  prefix       TEXT PRIMARY KEY,
  last_seq     INTEGER NOT NULL DEFAULT 0,
  updated_date TEXT
);

-- Cross-browser business-data sync. A migration is uploaded into an immutable
-- staging generation; only the single account pointer below makes it visible.
-- This prevents an interrupted upload from exposing a half dataset.
CREATE TABLE business_dataset (
  account_id             TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  generation_id          TEXT NOT NULL,
  status                 TEXT NOT NULL CHECK (status IN ('staging','active','retired','aborted','rolled_back')),
  schema_version         INTEGER NOT NULL,
  manifest_hash          TEXT NOT NULL,
  manifest_json          TEXT NOT NULL,
  expected_chunks        INTEGER NOT NULL,
  expected_records       INTEGER NOT NULL,
  previous_generation_id TEXT,
  created_by             TEXT NOT NULL REFERENCES user(id),
  created_at             TEXT NOT NULL,
  activated_at           TEXT,
  PRIMARY KEY (account_id, generation_id),
  UNIQUE (account_id, manifest_hash)
);
CREATE INDEX idx_business_dataset_status ON business_dataset (account_id, status);

CREATE TABLE business_dataset_pointer (
  account_id           TEXT PRIMARY KEY REFERENCES account(id) ON DELETE CASCADE,
  active_generation_id TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  FOREIGN KEY (account_id, active_generation_id)
    REFERENCES business_dataset(account_id, generation_id)
);

CREATE TABLE business_property_map (
  account_id         TEXT NOT NULL,
  generation_id      TEXT NOT NULL,
  property_key       TEXT NOT NULL,
  server_property_id TEXT NOT NULL,
  property_code      TEXT NOT NULL,
  PRIMARY KEY (account_id, generation_id, property_key),
  UNIQUE (account_id, generation_id, server_property_id),
  FOREIGN KEY (account_id, generation_id)
    REFERENCES business_dataset(account_id, generation_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, server_property_id)
    REFERENCES property(account_id, id) ON DELETE CASCADE
);

CREATE TABLE business_record (
  account_id         TEXT NOT NULL,
  generation_id      TEXT NOT NULL,
  entity_name        TEXT NOT NULL,
  record_key         TEXT NOT NULL,
  property_key       TEXT,
  server_property_id TEXT,
  row_json           TEXT NOT NULL,
  row_hash           TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  PRIMARY KEY (account_id, generation_id, entity_name, record_key),
  FOREIGN KEY (account_id, generation_id)
    REFERENCES business_dataset(account_id, generation_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, server_property_id)
    REFERENCES property(account_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_business_record_snapshot
  ON business_record (account_id, generation_id, entity_name, record_key);
CREATE INDEX idx_business_record_property
  ON business_record (account_id, generation_id, server_property_id, entity_name);

CREATE TABLE business_migration_chunk (
  account_id    TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  chunk_index   INTEGER NOT NULL,
  chunk_hash    TEXT NOT NULL,
  record_count  INTEGER NOT NULL,
  received_at   TEXT NOT NULL,
  PRIMARY KEY (account_id, generation_id, chunk_index),
  FOREIGN KEY (account_id, generation_id)
    REFERENCES business_dataset(account_id, generation_id) ON DELETE CASCADE
);

CREATE TABLE business_sync_state (
  account_id TEXT PRIMARY KEY REFERENCES account(id) ON DELETE CASCADE,
  revision   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE business_change (
  account_id         TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  seq                INTEGER NOT NULL,
  generation_id      TEXT NOT NULL,
  entity_name        TEXT NOT NULL,
  record_key         TEXT NOT NULL,
  server_property_id TEXT,
  operation          TEXT NOT NULL CHECK (operation IN ('upsert','delete','property_delete')),
  row_json           TEXT,
  row_hash           TEXT,
  mutation_id        TEXT NOT NULL,
  request_hash       TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  PRIMARY KEY (account_id, seq),
  UNIQUE (account_id, mutation_id)
);
CREATE INDEX idx_business_change_scope
  ON business_change (account_id, server_property_id, seq);

CREATE TABLE business_mutation_guard (
  account_id   TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  mutation_id  TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  ok           INTEGER NOT NULL CHECK (ok = 1),
  created_at   TEXT NOT NULL,
  PRIMARY KEY (account_id, mutation_id)
);

CREATE TABLE business_id_sequence (
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  prefix     TEXT NOT NULL,
  last_seq   INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, prefix)
);
