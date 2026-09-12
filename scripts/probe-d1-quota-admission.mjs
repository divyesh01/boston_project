// scripts/probe-d1-quota-admission.mjs
// Verifies:
// 1. Exact mathematical write budget formula: 9M + 4*ceil(M/13) + 17.
// 2. Admission decisions for various operation sizes (3k, 7.9k, 10k, 17k).
// 3. Rejection of oversized file BEFORE any staging or transaction writes (0 rows written).
// 4. Remaining daily budget exhaustion correctly rejects subsequent imports.
// 5. Paid tier bypasses free tier limit.

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  estimateAuthoritativeTransactionWrites,
  evaluateImportAdmission,
  FREE_PLAN_SAFE_IMPORT_BUDGET,
  ESSENTIAL_AUTH_RESERVE,
  FREE_PLAN_DAILY_D1_WRITE_CAP,
  getUtcDayKey,
  getNextUtcMidnight,
} from "../worker/budget.js";
import { handleBusinessSyncRequest } from "../worker/business-sync.js";

const SCHEMA_PATH = fileURLToPath(new URL("../worker/schema.sql", import.meta.url));

function setupTestEnvironment() {
  const mem = new DatabaseSync(":memory:");
  const schema = readFileSync(SCHEMA_PATH, "utf8");
  mem.exec(schema);

  let rowsWritten = 0;
  const env = {
    DB: {
      prepare(sql) {
        return {
          bind(...params) {
            const normalized = params.map((p) =>
              p === undefined ? null : typeof p === "boolean" ? (p ? 1 : 0) : p
            );
            return {
              async first() {
                const row = mem.prepare(sql).get(...normalized);
                return row === undefined ? null : row;
              },
              async all() {
                const rows = mem.prepare(sql).all(...normalized);
                return { results: rows };
              },
              async run() {
                const info = mem.prepare(sql).run(...normalized);
                rowsWritten += Number(info.changes);
                return { meta: { changes: Number(info.changes) } };
              },
            };
          },
        };
      },
      async batch(statements) {
        mem.exec("BEGIN");
        try {
          const results = [];
          for (const stmt of statements) {
            const info = await stmt.run();
            results.push(info);
          }
          mem.exec("COMMIT");
          return results;
        } catch (err) {
          mem.exec("ROLLBACK");
          throw err;
        }
      },
    },
    getRowsWritten: () => rowsWritten,
    resetRowsWritten: () => { rowsWritten = 0; },
  };

  const now = new Date().toISOString();
  mem.prepare("INSERT INTO account (id, name, created_date) VALUES ('default', 'Default Account', ?)").run(now);
  mem.prepare(`
    INSERT INTO user (
      id, account_id, username, display_name, email, role,
      property_access_mode, is_active, is_locked, password_hash,
      salt, failed_login_count, created_date, updated_date
    ) VALUES ('usr_admin', 'default', 'admin', 'Admin', 'admin@example.com', 'owner', 'all', 1, 0, 'hash', 'salt', 0, ?, ?)
  `).run(now, now);
  mem.prepare("INSERT INTO property (id, account_id, code, name, created_date) VALUES ('prop_1', 'default', 'RRI1416', 'Middleboro', ?)").run(now);
  mem.prepare("INSERT INTO business_sync_state (account_id, revision) VALUES ('default', 1)").run();
  mem.prepare("INSERT INTO business_dataset (account_id, generation_id, status, schema_version, manifest_hash, manifest_json, expected_chunks, expected_records, created_by, created_at) VALUES ('default', 'gen_init', 'active', 1, 'init', '{}', 1, 1, 'usr_admin', ?)").run(now);
  mem.prepare("INSERT INTO business_dataset_pointer (account_id, active_generation_id, updated_at) VALUES ('default', 'gen_init', ?)").run(now);
  mem.prepare("INSERT INTO business_property_map (account_id, generation_id, property_key, server_property_id, property_code) VALUES ('default', 'gen_init', 'n:1', 'prop_1', 'RRI1416')").run();

  const scope = {
    accountId: "default",
    all: true,
    propertyIds: new Set(["prop_1"]),
    user: { id: "usr_admin", role: "owner" },
  };

  return { mem, env, scope };
}

async function run() {
  console.log("Starting probe-d1-quota-admission...");

  // 1. Test canonical formula 9M + 4*ceil(M/13) + 17
  const testPoints = [
    [1, 30],
    [3, 48],
    [100, 949],
    [1000, 9325],
    [3000, 27941],
    [7918, 73719],
    [10000, 93097],
    [17000, 158249],
  ];

  for (const [m, expected] of testPoints) {
    const calculated = estimateAuthoritativeTransactionWrites(m);
    assert.equal(calculated, expected, `Mismatch for M=${m}: expected ${expected}, got ${calculated}`);
  }
  console.log("✓ Canonical write estimation formula matches all calibration points");

  // 2. Test admission evaluation decisions
  assert.equal(FREE_PLAN_DAILY_D1_WRITE_CAP, 100_000);
  assert.equal(ESSENTIAL_AUTH_RESERVE, 20_000);
  assert.equal(FREE_PLAN_SAFE_IMPORT_BUDGET, 80_000);

  // 3,000 ops (27,941 writes) on clean day: admitted
  const res3k = evaluateImportAdmission(3000, 0, 0, "free");
  assert.equal(res3k.admitted, true);
  assert.equal(res3k.projectedWrites, 27941);

  // 7,918 ops (73,719 writes) on clean day: admitted
  const res7k = evaluateImportAdmission(7918, 0, 0, "free");
  assert.equal(res7k.admitted, true);
  assert.equal(res7k.projectedWrites, 73719);

  // 10,000 ops (93,097 writes) on clean day: rejected (exceeds 80,000 budget)
  const res10k = evaluateImportAdmission(10000, 0, 0, "free");
  assert.equal(res10k.admitted, false);
  assert.match(res10k.rejectionReason, /exceeding the maximum safe Free plan import limit/);

  // 17,000 ops (158,249 writes) on clean day: rejected
  const res17k = evaluateImportAdmission(17000, 0, 0, "free");
  assert.equal(res17k.admitted, false);
  assert.match(res17k.rejectionReason, /exceeding the maximum safe Free plan import limit/);

  // Remaining budget rejection: 3,000 ops when 60,000 writes already committed
  const res3kRemaining = evaluateImportAdmission(3000, 60000, 0, "free");
  assert.equal(res3kRemaining.admitted, false);
  assert.match(res3kRemaining.rejectionReason, /only 20,000 writes remain/);

  // Paid plan allows large imports
  const res17kPaid = evaluateImportAdmission(17000, 0, 0, "paid");
  assert.equal(res17kPaid.admitted, true);
  console.log("✓ Admission control logic correctly enforces free limits and paid bypass");

  // 3. Server-side startTransaction Integration Test: Rejection with 0 Writes
  {
    const { mem, env, scope } = setupTestEnvironment();
    env.resetRowsWritten();

    const largeOpCount = 17000;
    const expectedChunks = Math.ceil(largeOpCount / 13);
    const body = {
      tx_id: "webtx_test_admission_large_001",
      request_hash: "a".repeat(64),
      expected_chunks: expectedChunks,
      operation_count: largeOpCount,
    };

    const req = new Request("http://localhost/api/business-sync/transaction/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const url = new URL(req.url);
    const response = await handleBusinessSyncRequest(req, env, scope, url, ["api", "business-sync", "transaction", "start"]);
    assert.equal(response.status, 409, `Expected 409, got ${response.status}`);

    const resJson = await response.json();
    assert.match(resJson.error, /exceeding the maximum safe Free plan import limit/);
    assert.equal(resJson.code, "D1_IMPORT_WRITE_BUDGET_EXCEEDED");

    // CRITICAL: Prove that ZERO rows were written to the database!
    assert.equal(env.getRowsWritten(), 0, "Zero rows must be written when transaction is rejected by admission control");

    const txRow = mem.prepare("SELECT * FROM business_staging_transaction WHERE tx_id=?").get("webtx_test_admission_large_001");
    assert.equal(txRow, undefined, "No staging transaction row must be created");

    const datasetRows = mem.prepare("SELECT COUNT(*) AS c FROM business_dataset WHERE status='staging'").get();
    assert.equal(datasetRows.c, 0, "No staging dataset must be created");
    console.log("✓ Server-side startTransaction rejected 17,000-op transaction with 0 database writes");
  }

  // 4. Server-side startTransaction Integration Test: Admitting 3,000 Ops
  {
    const { mem, env, scope } = setupTestEnvironment();
    const opCount = 3000;
    const expectedChunks = Math.ceil(opCount / 13);
    const body = {
      tx_id: "webtx_test_admission_admit_002",
      request_hash: "b".repeat(64),
      expected_chunks: expectedChunks,
      operation_count: opCount,
    };

    const req = new Request("http://localhost/api/business-sync/transaction/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const url = new URL(req.url);
    const response = await handleBusinessSyncRequest(req, env, scope, url, ["api", "business-sync", "transaction", "start"]);
    assert.equal(response.status, 201, `Expected 201, got ${response.status}`);

    const resJson = await response.json();
    assert.equal(resJson.tx_id, "webtx_test_admission_admit_002");
    assert.equal(resJson.status, "pending");
    console.log("✓ Server-side startTransaction safely admitted 3,000-op transaction");
  }

  console.log("PASSED: probe-d1-quota-admission passed all checks");
}

run().catch((err) => {
  console.error("FAILED: probe-d1-quota-admission", err);
  process.exit(1);
});
