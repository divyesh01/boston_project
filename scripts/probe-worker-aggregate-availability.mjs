// scripts/probe-worker-aggregate-availability.mjs
// Server-Authoritative Fast-Path Aggregate Availability & Graceful Fallback Probe
// Exercises worker/aggregates.js getDailySummaries under isolated SQLite/D1 fixtures:
// 1. Both tables absent (production migration baseline 0001..0007) -> HTTP 200 { ok: true, source: 'empty', available: false }
// 2. Primary empty + legacy absent + missing business_sync_state -> skips business_sync_state, returns HTTP 200 empty
// 3. Missing primary + valid legacy -> HTTP 200 { source: 'daily_financial_aggregate', available: true } with integer-cents
// 4. Valid primary current -> HTTP 200 { source: 'property_day_summary', available: true }
// 5. Stale primary + missing legacy -> HTTP 200 { source: 'empty', available: false }
// 6. Stale primary + valid legacy -> falls back to legacy HTTP 200 { source: 'daily_financial_aggregate', available: true }
// 7. Multi-tenant / property / date boundary isolation (Account A_1 vs A_2, P_A vs P_B, date ranges)
// 8. Explicit unauthorized requests (forbidden property access returns HTTP 403)
// 9. Integer cents boundary conditions (zero, negative adjustments, large values)
// 10. Non-missing table fault propagation (disk I/O, D1 quota, syntax, unexpected missing tables)
// 11. Suffix lookalikes rejection (e.g. property_day_summary_backup, daily_financial_aggregate_v2)

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { makeRunner } from "./_worker-testkit.mjs";
import { handleAggregatesRequest } from "../worker/aggregates.js";

const r = makeRunner("probe-worker-aggregate-availability");
const projectRoot = fileURLToPath(new URL("..", import.meta.url));

const MIGRATIONS_0001_TO_0007 = [
  "0001_auth_schema.sql",
  "0002_business_sync.sql",
  "0003_property_columns.sql",
  "0004_staging_and_rollback_schema.sql",
  "0005_bulk_import_manifest.sql",
  "0006_bulk_import_integrity.sql",
  "0007_bulk_import_lineage.sql",
];

function buildBaselineDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  for (const f of MIGRATIONS_0001_TO_0007) {
    const sql = readFileSync(`${projectRoot}/migrations-production/${f}`, "utf8");
    db.exec(sql);
  }
  return db;
}

function seedBaselineEntities(db) {
  const now = new Date().toISOString();
  db.prepare("INSERT INTO account (id, name, created_date) VALUES ('A_1', 'Account 1', ?)").run(now);
  db.prepare("INSERT INTO property (id, account_id, code, name, rooms, city, state, active) VALUES ('P_A', 'A_1', 'PA', 'Prop A', 50, 'Boston', 'MA', 1)").run();
  db.prepare("INSERT INTO property (id, account_id, code, name, rooms, city, state, active) VALUES ('P_B', 'A_1', 'PB', 'Prop B', 30, 'Boston', 'MA', 1)").run();
  db.prepare("INSERT INTO user (id, account_id, username, email, role, property_access_mode, password_hash, salt, created_date, updated_date) VALUES ('U_1', 'A_1', 'owner', 'owner@example.com', 'owner', 'all', 'h', 's', ?, ?)").run(now, now);
  db.prepare("INSERT INTO business_sync_state (account_id, revision) VALUES ('A_1', 1)").run();
}

function makeD1Shim(db, { faultInject } = {}) {
  return {
    DB: {
      prepare(sql) {
        return {
          _sql: sql,
          _params: [],
          bind(...params) {
            this._params = params.map(p => (p === undefined ? null : (typeof p === "boolean" ? (p ? 1 : 0) : p)));
            return this;
          },
          async first() {
            if (faultInject) faultInject(this._sql, this._params);
            const stmt = db.prepare(this._sql);
            const row = stmt.get(...this._params);
            return row === undefined ? null : row;
          },
          async all() {
            if (faultInject) faultInject(this._sql, this._params);
            const stmt = db.prepare(this._sql);
            const results = stmt.all(...this._params);
            return { results };
          },
          async run() {
            if (faultInject) faultInject(this._sql, this._params);
            const stmt = db.prepare(this._sql);
            const info = stmt.run(...this._params);
            return { success: true, meta: { changes: info.changes } };
          },
        };
      },
    },
  };
}

const defaultScope = {
  accountId: "A_1",
  all: true,
  propertyIds: ["P_A", "P_B"],
  user: { id: "U_1", role: "owner" },
};

// ===========================================================================
// CASE 1: Both primary and legacy tables absent (Production Baseline)
// ===========================================================================
await r.check("Case 1: Both tables absent returns HTTP 200 with available=false & source=empty", async () => {
  const db = buildBaselineDb();
  seedBaselineEntities(db);
  const env = makeD1Shim(db);

  const url = new URL("https://worker.local/api/aggregates/daily?property_id=P_A");
  const req = new Request(url);
  const res = await handleAggregatesRequest(req, env, defaultScope, url, ["api", "aggregates", "daily"]);

  assert.equal(res.status, 200, "Must return HTTP 200");
  const data = await res.json();
  assert.equal(data.ok, true, "data.ok is true");
  assert.equal(data.count, 0, "count is 0");
  assert.deepEqual(data.summaries, [], "summaries is empty array");
  assert.equal(data.source, "empty", "source is 'empty'");
  assert.equal(data.available, false, "available is explicitly false");
});

// ===========================================================================
// CASE 2: Primary empty + legacy absent + missing business_sync_state table
// ===========================================================================
await r.check("Case 2: Primary empty skips business_sync_state query and returns empty without error", async () => {
  const db = buildBaselineDb();
  seedBaselineEntities(db);

  // Apply migration 0008 to create property_day_summary (with 0 rows)
  const m0008Sql = readFileSync(`${projectRoot}/migrations-production/0008_property_day_summary.sql`, "utf8");
  db.exec(m0008Sql);

  // Drop business_sync_state table entirely
  db.exec("DROP TABLE business_sync_state;");

  const env = makeD1Shim(db);
  const url = new URL("https://worker.local/api/aggregates/daily?property_id=P_A");
  const req = new Request(url);
  const res = await handleAggregatesRequest(req, env, defaultScope, url, ["api", "aggregates", "daily"]);

  assert.equal(res.status, 200, "Must return HTTP 200");
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.count, 0);
  assert.deepEqual(data.summaries, []);
  assert.equal(data.source, "empty");
  assert.equal(data.available, false);
});

// ===========================================================================
// CASE 3: Missing primary + valid legacy daily_financial_aggregate
// ===========================================================================
await r.check("Case 3: Missing primary with valid legacy returns HTTP 200 available=true and integer-cents", async () => {
  const db = buildBaselineDb();
  seedBaselineEntities(db);

  // Create legacy daily_financial_aggregate table
  db.exec(`
    CREATE TABLE daily_financial_aggregate (
      id TEXT PRIMARY KEY,
      property_id TEXT NOT NULL REFERENCES property(id) ON DELETE CASCADE,
      business_date TEXT,
      total_revenue REAL,
      room_revenue REAL,
      other_revenue REAL,
      payments_total REAL,
      expenses_total REAL,
      created_date TEXT
    );
  `);

  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO daily_financial_aggregate (id, property_id, business_date, total_revenue, room_revenue, other_revenue, payments_total, expenses_total, created_date)
    VALUES ('dfa_1', 'P_A', '2026-03-01', 500.50, 400.25, 100.25, 500.50, 60.0, ?)
  `).run(now);

  const env = makeD1Shim(db);
  const url = new URL("https://worker.local/api/aggregates/daily?property_id=P_A");
  const req = new Request(url);
  const res = await handleAggregatesRequest(req, env, defaultScope, url, ["api", "aggregates", "daily"]);

  assert.equal(res.status, 200, "Must return HTTP 200");
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.count, 1);
  assert.equal(data.source, "daily_financial_aggregate");
  assert.equal(data.available, true, "available must be true for valid legacy data");

  const row = data.summaries[0];
  assert.equal(row.property_id, "P_A");
  assert.equal(row.business_date, "2026-03-01");
  assert.equal(row.room_revenue_cents, 40025, "Room revenue exact cents");
  assert.equal(row.ancillary_revenue_cents, 10025, "Ancillary revenue exact cents");
  assert.equal(row.total_revenue_cents, 50050, "Total revenue exact cents");
  assert.equal(row.payment_total_cents, 50050, "Payment total exact cents");
  assert.equal(row.id, "A_1:P_A:2026-03-01");
});

// ===========================================================================
// CASE 4: Valid primary current (not stale)
// ===========================================================================
await r.check("Case 4: Valid current primary returns HTTP 200 available=true and unchanged rows", async () => {
  const db = buildBaselineDb();
  seedBaselineEntities(db);

  const m0008Sql = readFileSync(`${projectRoot}/migrations-production/0008_property_day_summary.sql`, "utf8");
  db.exec(m0008Sql);

  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO property_day_summary (
      id, account_id, property_id, business_date,
      room_revenue_cents, ancillary_revenue_cents, total_revenue_cents,
      rooms_sold, available_rooms, adr_cents, occupancy_rate, revpar_cents,
      gross_ota_revenue_cents, direct_revenue_cents, ota_commission_cents,
      refund_cents, payment_total_cents, channel_summary_json,
      data_health_score, source_manifest_revision, updated_at
    ) VALUES (
      'A_1:P_A:2026-03-01', 'A_1', 'P_A', '2026-03-01',
      120000, 15000, 135000,
      12, 24, 10000, 0.5, 5625,
      70000, 50000, 10500,
      0, 135000, '{"OTA":70000}',
      100, 1, ?
    )
  `).run(now);

  const env = makeD1Shim(db);
  const url = new URL("https://worker.local/api/aggregates/daily?property_id=P_A");
  const req = new Request(url);
  const res = await handleAggregatesRequest(req, env, defaultScope, url, ["api", "aggregates", "daily"]);

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.count, 1);
  assert.equal(data.source, "property_day_summary");
  assert.equal(data.available, true);

  const row = data.summaries[0];
  assert.equal(row.property_id, "P_A");
  assert.equal(row.total_revenue_cents, 135000);
  assert.equal(row.rooms_sold, 12);
  assert.equal(row.available_rooms, 24);
  assert.equal(row.occupancy_rate, 0.5);
});

// ===========================================================================
// CASE 5: Stale primary + missing legacy
// ===========================================================================
await r.check("Case 5: Stale primary with missing legacy returns HTTP 200 source=empty available=false", async () => {
  const db = buildBaselineDb();
  seedBaselineEntities(db);

  const m0008Sql = readFileSync(`${projectRoot}/migrations-production/0008_property_day_summary.sql`, "utf8");
  db.exec(m0008Sql);

  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO property_day_summary (
      id, account_id, property_id, business_date,
      room_revenue_cents, ancillary_revenue_cents, total_revenue_cents,
      rooms_sold, available_rooms, adr_cents, occupancy_rate, revpar_cents,
      gross_ota_revenue_cents, direct_revenue_cents, ota_commission_cents,
      refund_cents, payment_total_cents, channel_summary_json,
      data_health_score, source_manifest_revision, updated_at
    ) VALUES (
      'A_1:P_A:2026-03-01', 'A_1', 'P_A', '2026-03-01',
      100000, 10000, 110000,
      10, 20, 10000, 0.5, 5500,
      60000, 40000, 9000,
      0, 110000, '{}',
      100, 1, ?
    )
  `).run(now);

  // Bump business_sync_state revision to 2 to make summary stale
  db.prepare("UPDATE business_sync_state SET revision = 2 WHERE account_id = 'A_1'").run();

  const env = makeD1Shim(db);
  const url = new URL("https://worker.local/api/aggregates/daily?property_id=P_A");
  const req = new Request(url);
  const res = await handleAggregatesRequest(req, env, defaultScope, url, ["api", "aggregates", "daily"]);

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.count, 0);
  assert.deepEqual(data.summaries, []);
  assert.equal(data.source, "empty");
  assert.equal(data.available, false);
});

// ===========================================================================
// CASE 6: Stale primary + valid legacy fallback
// ===========================================================================
await r.check("Case 6: Stale primary falls back to legacy table when available", async () => {
  const db = buildBaselineDb();
  seedBaselineEntities(db);

  const m0008Sql = readFileSync(`${projectRoot}/migrations-production/0008_property_day_summary.sql`, "utf8");
  db.exec(m0008Sql);

  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO property_day_summary (
      id, account_id, property_id, business_date,
      room_revenue_cents, ancillary_revenue_cents, total_revenue_cents,
      rooms_sold, available_rooms, adr_cents, occupancy_rate, revpar_cents,
      gross_ota_revenue_cents, direct_revenue_cents, ota_commission_cents,
      refund_cents, payment_total_cents, channel_summary_json,
      data_health_score, source_manifest_revision, updated_at
    ) VALUES (
      'A_1:P_A:2026-03-01', 'A_1', 'P_A', '2026-03-01',
      100000, 10000, 110000,
      10, 20, 10000, 0.5, 5500,
      60000, 40000, 9000,
      0, 110000, '{}',
      100, 1, ?
    )
  `).run(now);

  db.prepare("UPDATE business_sync_state SET revision = 2 WHERE account_id = 'A_1'").run();

  // Create legacy daily_financial_aggregate table with historical row
  db.exec(`
    CREATE TABLE daily_financial_aggregate (
      id TEXT PRIMARY KEY,
      property_id TEXT NOT NULL REFERENCES property(id) ON DELETE CASCADE,
      business_date TEXT,
      total_revenue REAL,
      room_revenue REAL,
      other_revenue REAL,
      payments_total REAL,
      expenses_total REAL,
      created_date TEXT
    );
  `);
  db.prepare(`
    INSERT INTO daily_financial_aggregate (id, property_id, business_date, total_revenue, room_revenue, other_revenue, payments_total, expenses_total, created_date)
    VALUES ('dfa_stale_fallback', 'P_A', '2026-03-01', 300.0, 250.0, 50.0, 300.0, 40.0, ?)
  `).run(now);

  const env = makeD1Shim(db);
  const url = new URL("https://worker.local/api/aggregates/daily?property_id=P_A");
  const req = new Request(url);
  const res = await handleAggregatesRequest(req, env, defaultScope, url, ["api", "aggregates", "daily"]);

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.count, 1);
  assert.equal(data.source, "daily_financial_aggregate");
  assert.equal(data.available, true);
  assert.equal(data.summaries[0].total_revenue_cents, 30000);
});

// ===========================================================================
// CASE 7: Multi-tenant, multi-property, and date range isolation
// ===========================================================================
await r.check("Case 7: Property A/B, Account A/B, and date boundary isolation", async () => {
  const db = buildBaselineDb();
  seedBaselineEntities(db);

  // Seed secondary tenant Account A_2
  const now = new Date().toISOString();
  db.prepare("INSERT INTO account (id, name, created_date) VALUES ('A_2', 'Account 2', ?)").run(now);
  db.prepare("INSERT INTO property (id, account_id, code, name, rooms, city, state, active) VALUES ('P_A2', 'A_2', 'PA2', 'Prop A2', 40, 'Boston', 'MA', 1)").run();

  const m0008Sql = readFileSync(`${projectRoot}/migrations-production/0008_property_day_summary.sql`, "utf8");
  db.exec(m0008Sql);

  const insertStmt = db.prepare(`
    INSERT INTO property_day_summary (
      id, account_id, property_id, business_date,
      room_revenue_cents, ancillary_revenue_cents, total_revenue_cents,
      rooms_sold, available_rooms, adr_cents, occupancy_rate, revpar_cents,
      gross_ota_revenue_cents, direct_revenue_cents, ota_commission_cents,
      refund_cents, payment_total_cents, channel_summary_json,
      data_health_score, source_manifest_revision, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `);

  // P_A across 3 dates
  insertStmt.run("A_1:P_A:2026-03-01", "A_1", "P_A", "2026-03-01", 10000, 1000, 11000, 1, 10, 10000, 0.1, 1100, 6000, 4000, 900, 0, 11000, "{}", 100, now);
  insertStmt.run("A_1:P_A:2026-03-02", "A_1", "P_A", "2026-03-02", 20000, 2000, 22000, 2, 10, 10000, 0.2, 2200, 12000, 8000, 1800, 0, 22000, "{}", 100, now);
  insertStmt.run("A_1:P_A:2026-03-03", "A_1", "P_A", "2026-03-03", 30000, 3000, 33000, 3, 10, 10000, 0.3, 3300, 18000, 12000, 2700, 0, 33000, "{}", 100, now);

  // P_B on 2026-03-02
  insertStmt.run("A_1:P_B:2026-03-02", "A_1", "P_B", "2026-03-02", 15000, 1500, 16500, 2, 10, 7500, 0.2, 1650, 9000, 6000, 1350, 0, 16500, "{}", 100, now);

  // Foreign tenant row in A_2
  insertStmt.run("A_2:P_A2:2026-03-02", "A_2", "P_A2", "2026-03-02", 99000, 9000, 108000, 5, 10, 19800, 0.5, 10800, 50000, 49000, 7500, 0, 108000, "{}", 100, now);

  const env = makeD1Shim(db);

  // 7A: Scoped query for P_A only
  const urlPA = new URL("https://worker.local/api/aggregates/daily?property_id=P_A");
  const resPA = await handleAggregatesRequest(new Request(urlPA), env, defaultScope, urlPA, ["api", "aggregates", "daily"]);
  const dataPA = await resPA.json();
  assert.equal(dataPA.count, 3, "P_A has 3 dates");
  assert.ok(dataPA.summaries.every(s => s.property_id === "P_A"), "All returned rows belong to P_A");

  // 7B: Date filtering from=2026-03-02&to=2026-03-02 on P_A
  const urlDate = new URL("https://worker.local/api/aggregates/daily?property_id=P_A&from=2026-03-02&to=2026-03-02");
  const resDate = await handleAggregatesRequest(new Request(urlDate), env, defaultScope, urlDate, ["api", "aggregates", "daily"]);
  const dataDate = await resDate.json();
  assert.equal(dataDate.count, 1, "Only 1 date returned");
  assert.equal(dataDate.summaries[0].business_date, "2026-03-02");

  // 7C: Portfolio query property_id=all
  const urlAll = new URL("https://worker.local/api/aggregates/daily?property_id=all&from=2026-03-02&to=2026-03-02");
  const resAll = await handleAggregatesRequest(new Request(urlAll), env, defaultScope, urlAll, ["api", "aggregates", "daily"]);
  const dataAll = await resAll.json();
  assert.equal(dataAll.count, 2, "Portfolio has P_A and P_B on 2026-03-02");
  const pids = dataAll.summaries.map(s => s.property_id).sort();
  assert.deepEqual(pids, ["P_A", "P_B"]);

  // 7D: Cross-tenant isolation (A_1 cannot see A_2)
  const allRows = dataAll.summaries;
  assert.ok(!allRows.some(s => s.property_id === "P_A2"), "A_1 must NEVER see foreign tenant A_2 properties");
});

// ===========================================================================
// CASE 8: Explicit unauthorized request
// ===========================================================================
await r.check("Case 8: Explicit unauthorized property access returns HTTP 403", async () => {
  const db = buildBaselineDb();
  seedBaselineEntities(db);
  const env = makeD1Shim(db);

  // User scoped strictly to P_A only
  const specificScope = {
    accountId: "A_1",
    all: false,
    propertyIds: ["P_A"],
    user: { id: "U_staff", role: "staff" },
  };

  // Requesting P_B when only granted P_A
  const urlForbidden = new URL("https://worker.local/api/aggregates/daily?property_id=P_B");
  const reqForbidden = new Request(urlForbidden);
  const resForbidden = await handleAggregatesRequest(reqForbidden, env, specificScope, urlForbidden, ["api", "aggregates", "daily"]);

  assert.equal(resForbidden.status, 403, "Must return HTTP 403 forbidden");
  const dataForbidden = await resForbidden.json();
  assert.match(dataForbidden.error, /forbidden: property access denied/);
});

// ===========================================================================
// CASE 9: Integer cents conversions (zero, negative adjustments, large values)
// ===========================================================================
await r.check("Case 9: Integer cents boundaries: zero, negative refunds, and large values", async () => {
  const db = buildBaselineDb();
  seedBaselineEntities(db);

  db.exec(`
    CREATE TABLE daily_financial_aggregate (
      id TEXT PRIMARY KEY,
      property_id TEXT NOT NULL REFERENCES property(id) ON DELETE CASCADE,
      business_date TEXT,
      total_revenue REAL,
      room_revenue REAL,
      other_revenue REAL,
      payments_total REAL,
      expenses_total REAL,
      created_date TEXT
    );
  `);

  const now = new Date().toISOString();
  // Row 1: Zero
  db.prepare(`
    INSERT INTO daily_financial_aggregate (id, property_id, business_date, total_revenue, room_revenue, other_revenue, payments_total, expenses_total, created_date)
    VALUES ('dfa_zero', 'P_A', '2026-03-01', 0.0, 0.0, 0.0, 0.0, 0.0, ?)
  `).run(now);

  // Row 2: Negative adjustment / refund
  db.prepare(`
    INSERT INTO daily_financial_aggregate (id, property_id, business_date, total_revenue, room_revenue, other_revenue, payments_total, expenses_total, created_date)
    VALUES ('dfa_neg', 'P_A', '2026-03-02', -150.25, -100.0, -50.25, -150.25, 0.0, ?)
  `).run(now);

  // Row 3: Large value ($12,345,678.90)
  db.prepare(`
    INSERT INTO daily_financial_aggregate (id, property_id, business_date, total_revenue, room_revenue, other_revenue, payments_total, expenses_total, created_date)
    VALUES ('dfa_large', 'P_A', '2026-03-03', 12345678.90, 10000000.00, 2345678.90, 12345678.90, 50000.0, ?)
  `).run(now);

  const env = makeD1Shim(db);
  const url = new URL("https://worker.local/api/aggregates/daily?property_id=P_A");
  const req = new Request(url);
  const res = await handleAggregatesRequest(req, env, defaultScope, url, ["api", "aggregates", "daily"]);

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.count, 3);

  const zeroRow = data.summaries.find(s => s.business_date === "2026-03-01");
  assert.equal(zeroRow.total_revenue_cents, 0);
  assert.equal(zeroRow.room_revenue_cents, 0);
  assert.equal(zeroRow.ancillary_revenue_cents, 0);

  const negRow = data.summaries.find(s => s.business_date === "2026-03-02");
  assert.equal(negRow.total_revenue_cents, -15025);
  assert.equal(negRow.room_revenue_cents, -10000);
  assert.equal(negRow.ancillary_revenue_cents, -5025);

  const largeRow = data.summaries.find(s => s.business_date === "2026-03-03");
  assert.equal(largeRow.total_revenue_cents, 1234567890);
  assert.equal(largeRow.room_revenue_cents, 1000000000);
  assert.equal(largeRow.ancillary_revenue_cents, 234567890);
});

// ===========================================================================
// CASE 10: Non-missing table fault propagation (I/O, Quota, Syntax, Unexpected Table)
// ===========================================================================
await r.check("Case 10: Fault propagation: disk I/O, D1 quota, syntax, and unexpected table errors rethrow", async () => {
  const db = buildBaselineDb();
  seedBaselineEntities(db);

  const faults = [
    new Error("SqliteError: disk I/O error"),
    new Error("D1_ERROR: database quota exceeded"),
    new Error("SqliteError: syntax error near 'SELECT'"),
    new Error("no such table: property"),
  ];

  for (const fault of faults) {
    const env = makeD1Shim(db, {
      faultInject() {
        throw fault;
      },
    });

    const url = new URL("https://worker.local/api/aggregates/daily?property_id=P_A");
    const req = new Request(url);

    await assert.rejects(
      async () => {
        await handleAggregatesRequest(req, env, defaultScope, url, ["api", "aggregates", "daily"]);
      },
      (err) => err === fault || String(err?.message || err).includes(fault.message),
      `Handler must rethrow fault: ${fault.message}`
    );
  }
});

// ===========================================================================
// CASE 11: Suffix, punctuation, schema lookalikes rejection, true wrapped acceptance,
//          and actual native quoted-table-name regressions
// ===========================================================================
await r.check("Case 11: Suffix lookalikes are strictly rejected and rethrown", async () => {
  const db = buildBaselineDb();
  seedBaselineEntities(db);

  // 11A: Punctuation, suffix, quoted, foreign schema, and bare-parenthesis lookalikes that MUST rethrow
  const lookalikes = [
    new Error("no such table: property_day_summary_backup"),
    new Error("no such table: property_day_summary_archived"),
    new Error("no such table: property_day_summary_v2"),
    new Error("no such table: daily_financial_aggregate_bak"),
    new Error("no such table: daily_financial_aggregates"),
    new Error("no such table: property_day_summary-history"),
    new Error('no such table: "property_day_summary"-history'),
    new Error("no such table: property_day_summary.backup"),
    new Error('no such table: "property_day_summary".backup'),
    new Error("no such table: main.property_day_summary(backup)"),
    new Error("no such table: main.property_day_summary:backup"),
    new Error("no such table: property_day_summary(backup)"),
    new Error("no such table: property_day_summary:backup"),
    new Error("no such table: property_day_summary:"),
    new Error("no such table: main.property_day_summary:"),
    new Error("no such table: property_day_summary(1)"),
    new Error("no such table: main.property_day_summary(1)"),
    new Error("no such table: foreign_schema.property_day_summary"),
    new Error("no such view: property_day_summary"),
    // Bare "(code 1)" / "(1)" without ": SQLITE_ERROR" — ambiguous with real table identifiers
    new Error("no such table: property_day_summary (code 1)"),
    new Error("no such table: property_day_summary (1)"),
    // Naked ": SQLITE_ERROR" on its own (no D1_ERROR/D1_EXEC_ERROR wrapper prefix)
    new Error("no such table: property_day_summary: SQLITE_ERROR"),
    // Naked ": SQLITE_ERROR (code N)" without a D1 wrapper prefix — ambiguous with a
    // real quoted identifier; only D1-prefixed wrappers prove engine metadata
    new Error("no such table: property_day_summary: SQLITE_ERROR (code 1)"),
    // Bare "(code: N)" without ": SQLITE_ERROR" or a D1 wrapper prefix is NOT engine metadata
    new Error("no such table: property_day_summary (code: 1001)"),
  ];

  for (const lookalike of lookalikes) {
    const env = makeD1Shim(db, {
      faultInject(sql) {
        if (sql.includes("property_day_summary")) {
          throw lookalike;
        }
        if (sql.includes("daily_financial_aggregate")) {
          throw new Error("no such table: daily_financial_aggregate");
        }
      },
    });

    const url = new URL("https://worker.local/api/aggregates/daily?property_id=P_A");
    const req = new Request(url);

    await assert.rejects(
      async () => {
        await handleAggregatesRequest(req, env, defaultScope, url, ["api", "aggregates", "daily"]);
      },
      (err) => err === lookalike || String(err?.message || err).includes(lookalike.message),
      `Lookalike or view error must not be swallowed: ${lookalike.message}`
    );
  }

  // 11B: True wrapped, quoted, and schema-qualified missing table errors that MUST be accepted
  const trueAbsences = [
    new Error("D1_ERROR: no such table: property_day_summary: SQLITE_ERROR"),
    new Error("D1_ERROR: no such table: main.property_day_summary: SQLITE_ERROR"),
    new Error("Error: D1_EXEC_ERROR: no such table: property_day_summary: SQLITE_ERROR"),
    new Error("no such table: main.property_day_summary"),
    new Error("no such table: temp.property_day_summary"),
    new Error('no such table: "property_day_summary"'),
    new Error('no such table: "main"."property_day_summary"'),
    new Error('no such table: main."property_day_summary"'),
    new Error("no such table: 'property_day_summary'"),
    // D1-prefixed wrapper controls remain accepted — the D1_ERROR/D1_EXEC_ERROR
    // prefix proves the trailing engine metadata is genuine
  ];

  for (const absence of trueAbsences) {
    const env = makeD1Shim(db, {
      faultInject(sql) {
        if (sql.includes("property_day_summary")) {
          throw absence;
        }
        if (sql.includes("daily_financial_aggregate")) {
          throw new Error("no such table: daily_financial_aggregate");
        }
      },
    });

    const url = new URL("https://worker.local/api/aggregates/daily?property_id=P_A");
    const req = new Request(url);
    const res = await handleAggregatesRequest(req, env, defaultScope, url, ["api", "aggregates", "daily"]);

    assert.equal(res.status, 200, `True absence must return 200: ${absence.message}`);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.count, 0);
    assert.equal(data.source, "empty");
    assert.equal(data.available, false);
  }

  // 11C: Actual native SQLite broken VIEW depending on absent underlying table
  const viewDb = buildBaselineDb();
  seedBaselineEntities(viewDb);
  viewDb.exec(`CREATE VIEW property_day_summary AS SELECT * FROM absent_dependency_table;`);
  const viewEnv = makeD1Shim(viewDb);
  const viewUrl = new URL("https://worker.local/api/aggregates/daily?property_id=P_A");
  await assert.rejects(
    async () => {
      await handleAggregatesRequest(new Request(viewUrl), viewEnv, defaultScope, viewUrl, ["api", "aggregates", "daily"]);
    },
    /no such table:.*absent_dependency_table/i,
    "Broken VIEW depending on absent table must rethrow and never be swallowed"
  );

  // 11D: Actual native SQLite broken VIEW depending on quoted absent table "property_day_summary:"
  const viewColonDb = buildBaselineDb();
  seedBaselineEntities(viewColonDb);
  viewColonDb.exec(`CREATE VIEW property_day_summary AS SELECT * FROM "property_day_summary:";`);
  const viewColonEnv = makeD1Shim(viewColonDb);
  const viewColonUrl = new URL("https://worker.local/api/aggregates/daily?property_id=P_A");
  await assert.rejects(
    async () => {
      await handleAggregatesRequest(new Request(viewColonUrl), viewColonEnv, defaultScope, viewColonUrl, ["api", "aggregates", "daily"]);
    },
    /no such table:.*property_day_summary:/i,
    'Broken VIEW depending on quoted "property_day_summary:" must rethrow and never be swallowed'
  );

  // 11E: Actual native SQLite broken VIEW depending on quoted absent table "property_day_summary(1)"
  const viewParenDb = buildBaselineDb();
  seedBaselineEntities(viewParenDb);
  viewParenDb.exec(`CREATE VIEW property_day_summary AS SELECT * FROM "property_day_summary(1)";`);
  const viewParenEnv = makeD1Shim(viewParenDb);
  const viewParenUrl = new URL("https://worker.local/api/aggregates/daily?property_id=P_A");
  await assert.rejects(
    async () => {
      await handleAggregatesRequest(new Request(viewParenUrl), viewParenEnv, defaultScope, viewParenUrl, ["api", "aggregates", "daily"]);
    },
    /no such table:.*property_day_summary\(1\)/i,
    'Broken VIEW depending on quoted "property_day_summary(1)" must rethrow and never be swallowed'
  );

  // 11F: Actual native SQLite quoted absent table with space+parenthesized suffix
  // These produce native errors like: 'no such table: main.property_day_summary (1)'
  // which must NOT be swallowed as mere "missing table with error code" metadata.
  // validlegacy sentinel: fallback to legacy is observable if handler wrongly accepts.
  const spacedQuotedNames = [
    'property_day_summary (1)',
    'property_day_summary (code 1)',
  ];
  for (const quotedName of spacedQuotedNames) {
    const spDb = buildBaselineDb();
    seedBaselineEntities(spDb);
    // Create valid legacy table so masked fallback is observable
    spDb.exec(`CREATE TABLE daily_financial_aggregate (
      id TEXT PRIMARY KEY,
      property_id TEXT NOT NULL REFERENCES property(id) ON DELETE CASCADE,
      business_date TEXT, total_revenue REAL, room_revenue REAL, other_revenue REAL,
      payments_total REAL, expenses_total REAL, created_date TEXT
    );`);
    spDb.prepare(`INSERT INTO daily_financial_aggregate (id, property_id, business_date,
      total_revenue, room_revenue, other_revenue, payments_total, expenses_total, created_date)
      VALUES ('validlegacy', 'P_A', '2026-03-01', 777.0, 700.0, 77.0, 777.0, 0.0, '2026-03-01T00:00:00Z')`).run();

    // Create VIEW depending on quoted absent table with space+parenthesized suffix
    spDb.exec(`CREATE VIEW property_day_summary AS SELECT * FROM "${quotedName}";`);

    const spEnv = makeD1Shim(spDb);
    const spUrl = new URL("https://worker.local/api/aggregates/daily?property_id=P_A");
    await assert.rejects(
      async () => {
        await handleAggregatesRequest(new Request(spUrl), spEnv, defaultScope, spUrl, ["api", "aggregates", "daily"]);
      },
      (err) => {
        const m = String(err?.message || err);
        return m.includes(quotedName.replace(/[()]/g, '')) || m.includes(quotedName);
      },
      `Actual native quoted table "${quotedName}" must rethrow, not mask with legacy fallback`
    );
  }
});

r.done();
if (process.exitCode) {
  console.error("FAILED: Worker aggregate availability contract completed with failures.");
  process.exit(1);
}
console.log("PASSED: Worker aggregate availability contract completed.");
