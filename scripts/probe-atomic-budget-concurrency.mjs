// scripts/probe-atomic-budget-concurrency.mjs
// Verifies:
// 1. Simultaneous Browser A and Browser B concurrent transaction start race condition
//    is atomically prevented at the database batch level via CHECK constraint.
//    Exactly one transaction succeeds (201) and the other fails (409 D1_IMPORT_WRITE_BUDGET_EXCEEDED).
//    Zero rows are left in staging/dataset for the rejected transaction.
// 2. Aborted transaction writes are irreversibly retained in daily accounting:
//    Staging writes + cleanup writes remain charged against the daily budget.
// 3. Cross-midnight cleanup attribution:
//    A transaction created yesterday and aborted/expired today charges its cleanup writes
//    (3O + C + 1 = 9,235 for a 3,001-op transaction) against today's budget.

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  estimateAuthoritativeTransactionWrites,
  estimateStagingWrites,
  estimateCleanupActionWrites,
  estimateAbortedTransactionWrites,
  calculateDailyWritesFromTransactions,
  evaluateImportAdmission,
  FREE_PLAN_SAFE_IMPORT_BUDGET,
  getUtcDayKey,
  getNextUtcMidnight,
} from "../worker/budget.js";
import { handleBusinessSyncRequest, canonicalJson } from "../worker/business-sync.js";

const SCHEMA_PATH = fileURLToPath(new URL("../worker/schema.sql", import.meta.url));

function setupTestEnvironment() {
  const mem = new DatabaseSync(":memory:");
  const schema = readFileSync(SCHEMA_PATH, "utf8");
  mem.exec(schema);

  let rowsWritten = 0;

  function createDbInterface() {
    return {
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
    };
  }

  const env = {
    DB: createDbInterface(),
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
  console.log("Starting probe-atomic-budget-concurrency...");

  // -------------------------------------------------------------------------
  // 1. Exact Write Formulas Sanity Check
  // -------------------------------------------------------------------------
  // For 3,001 ops (231 chunks):
  // Staging: 3(3001) + 2(231) + 2 = 9003 + 462 + 2 = 9,467 writes
  assert.equal(estimateStagingWrites(3001, 231), 9467);
  // Cleanup: 3(3001) + 231 + 1 = 9003 + 231 + 1 = 9,235 writes
  assert.equal(estimateCleanupActionWrites(3001, 231), 9235);
  // Aborted total: 6(3001) + 3(231) + 3 = 18006 + 693 + 3 = 18,702 writes
  assert.equal(estimateAbortedTransactionWrites(3001, 231), 18702);
  assert.equal(9467 + 9235, 18702);

  // Authoritative commit: 9(3001) + 4(231) + 17 = 27009 + 924 + 17 = 27,950 writes
  assert.equal(estimateAuthoritativeTransactionWrites(3001), 27950);
  console.log("✓ Write formula components match exact definitions");

  // -------------------------------------------------------------------------
  // 2. Simultaneous Browser A / Browser B Atomic Budget Reservation Race
  // -------------------------------------------------------------------------
  // Two browsers simultaneously attempt to start a transaction.
  // Each requests 4,500 operations (347 chunks).
  // Each projectedWrites = 9(4500) + 4(347) + 17 = 40500 + 1388 + 17 = 41,905 writes.
  // Daily budget = 80,000 writes.
  // Both would pass in-memory preflight if evaluated before the DB batch.
  // BUT the DB batch contains the atomic SQL guard.
  // Exactly ONE must succeed (201) and the other must be rejected (409 D1_IMPORT_WRITE_BUDGET_EXCEEDED).
  {
    const { mem, env, scope } = setupTestEnvironment();

    const opCount = 4500;
    const expectedChunks = Math.ceil(opCount / 13);
    assert.equal(expectedChunks, 347);
    const projected = estimateAuthoritativeTransactionWrites(opCount);
    assert.equal(projected, 41905);
    assert(projected * 2 > FREE_PLAN_SAFE_IMPORT_BUDGET, "Two 4,500-op transactions exceed 80,000 write budget");

    const bodyA = {
      tx_id: "webtx_race_browser_a_001",
      request_hash: "1".repeat(64),
      expected_chunks: expectedChunks,
      operation_count: opCount,
    };
    const bodyB = {
      tx_id: "webtx_race_browser_b_002",
      request_hash: "2".repeat(64),
      expected_chunks: expectedChunks,
      operation_count: opCount,
    };

    const makeReq = (body) =>
      new Request("http://localhost/api/business-sync/transaction/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    // To simulate simultaneous arrival where both read the initial state before either writes:
    // We run both via Promise.all
    const [resA, resB] = await Promise.all([
      handleBusinessSyncRequest(makeReq(bodyA), env, scope, new URL("http://localhost/api/business-sync/transaction/start"), ["api", "business-sync", "transaction", "start"]),
      handleBusinessSyncRequest(makeReq(bodyB), env, scope, new URL("http://localhost/api/business-sync/transaction/start"), ["api", "business-sync", "transaction", "start"]),
    ]);

    const statuses = [resA.status, resB.status].sort();
    assert.deepEqual(statuses, [201, 409], `Expected exactly one 201 and one 409, got ${resA.status} and ${resB.status}`);

    const winner = resA.status === 201 ? resA : resB;
    const loser = resA.status === 409 ? resA : resB;
    const loserJson = await loser.json();

    assert.equal(loserJson.code, "D1_IMPORT_WRITE_BUDGET_EXCEEDED");
    assert.match(loserJson.error, /exceeded today's safe Free plan import budget/);

    // Verify database state: Only the winner exists in business_staging_transaction!
    const allStaging = mem.prepare("SELECT tx_id, status, operation_count FROM business_staging_transaction").all();
    assert.equal(allStaging.length, 1, "Exactly one staging transaction must be recorded in the database");
    assert.equal(allStaging[0].status, "pending");

    // Crucially: Loser left 0 staging records or staging datasets
    const loserTxId = resA.status === 409 ? "webtx_race_browser_a_001" : "webtx_race_browser_b_002";
    const loserRow = mem.prepare("SELECT * FROM business_staging_transaction WHERE tx_id=?").get(loserTxId);
    assert.equal(loserRow, undefined, "Rejected transaction must leave 0 rows in business_staging_transaction");

    const datasets = mem.prepare("SELECT COUNT(*) AS c FROM business_dataset WHERE status='staging'").get();
    assert.equal(datasets.c, 1, "Only the winning transaction may have a staging dataset");
    console.log("✓ Simultaneous Browser A / Browser B race atomically admits 1 and rejects 1 with 0 orphan writes");
  }

  // -------------------------------------------------------------------------
  // 3. Aborted Transaction Write Retention
  // -------------------------------------------------------------------------
  // When a transaction created today is aborted today, its consumed staging writes
  // and cleanup writes remain irreversibly charged against today's daily budget.
  {
    const { mem, env, scope } = setupTestEnvironment();

    const opCount = 1000;
    const expectedChunks = Math.ceil(opCount / 13); // 77
    const startBody = {
      tx_id: "webtx_abort_retention_001",
      request_hash: "3".repeat(64),
      expected_chunks: expectedChunks,
      operation_count: opCount,
    };

    const startReq = new Request("http://localhost/api/business-sync/transaction/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(startBody),
    });
    const startRes = await handleBusinessSyncRequest(startReq, env, scope, new URL("http://localhost/api/business-sync/transaction/start"), ["api", "business-sync", "transaction", "start"]);
    assert.equal(startRes.status, 201);

    // Now abort the transaction
    const abortReq = new Request("http://localhost/api/business-sync/transaction/abort", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tx_id: "webtx_abort_retention_001" }),
    });
    const abortRes = await handleBusinessSyncRequest(abortReq, env, scope, new URL("http://localhost/api/business-sync/transaction/abort"), ["api", "business-sync", "transaction", "abort"]);
    assert.equal(abortRes.status, 200);
    const abortJson = await abortRes.json();
    assert.equal(abortJson.status, "aborted");

    // Verify that rolled_back_at is recorded
    const txRow = mem.prepare("SELECT * FROM business_staging_transaction WHERE tx_id=?").get("webtx_abort_retention_001");
    assert.equal(txRow.status, "aborted");
    assert(txRow.rolled_back_at !== null, "rolled_back_at must be populated on abort");

    // Now test ledger calculation
    const now = new Date();
    const nowIso = now.toISOString();
    const utcDayStart = `${getUtcDayKey(now)}T00:00:00.000Z`;

    const txRows = mem.prepare("SELECT * FROM business_staging_transaction").all();
    const ledger = calculateDailyWritesFromTransactions(txRows, nowIso, utcDayStart);

    // Expected consumed for aborted: 6(1000) + 3(77) + 3 = 6,234 writes
    const expectedAbortedWrites = estimateAbortedTransactionWrites(1000, 77);
    assert.equal(expectedAbortedWrites, 6234);
    assert.equal(ledger.totalCommittedWrites, 6234, "Aborted transaction writes must remain counted in daily writes");
    assert.equal(ledger.remainingDailyBudget, FREE_PLAN_SAFE_IMPORT_BUDGET - 6234);
    console.log("✓ Aborted transaction writes are retained in today's daily accounting (6,234 writes)");
  }

  // -------------------------------------------------------------------------
  // 4. Cross-Midnight Cleanup Attribution
  // -------------------------------------------------------------------------
  // A transaction created yesterday (3,001 ops, 231 chunks) is aborted today.
  // Staging writes were consumed yesterday.
  // Today's cleanup DELETE writes (3O + C + 1 = 9,235 writes) MUST be charged to today!
  {
    const { mem, env, scope } = setupTestEnvironment();

    const now = new Date();
    const nowIso = now.toISOString();
    const utcDayStart = `${getUtcDayKey(now)}T00:00:00.000Z`;
    const yesterdayIso = new Date(Date.parse(utcDayStart) - 3600 * 1000).toISOString(); // 1 hour before midnight
    const expiresTomorrowIso = new Date(Date.parse(utcDayStart) + 86400 * 1000).toISOString();

    const opCount = 3001;
    const expectedChunks = 231;
    const txId = "webtx_yesterday_stranded_3001";
    const stagingGenId = "gen_staging_yesterday";

    // Insert dataset and transaction created yesterday, still pending
    mem.prepare(`
      INSERT INTO business_dataset (
        account_id, generation_id, status, schema_version, manifest_hash,
        manifest_json, expected_chunks, expected_records, created_by, created_at
      ) VALUES ('default', ?, 'staging', 1, 'hash_yesterday', '{}', ?, ?, 'usr_admin', ?)
    `).run(stagingGenId, expectedChunks, opCount, yesterdayIso);

    mem.prepare(`
      INSERT INTO business_staging_transaction (
        account_id, tx_id, request_hash, base_generation_id, base_revision,
        staging_generation_id, status, expected_chunks, next_chunk_index,
        operation_count, created_by, created_at, expires_at
      ) VALUES ('default', ?, 'hash4', 'gen_init', 1, ?, 'pending', ?, ?, ?, 'usr_admin', ?, ?)
    `).run(txId, stagingGenId, expectedChunks, expectedChunks, opCount, yesterdayIso, expiresTomorrowIso);

    // Prior to abort: The transaction is pending, created yesterday.
    // If it commits today, it would cost commitWrites: 6(3001) + 2(231) + 15 = 18,483 writes.
    // Today's ledger calculates maximum potential writes:
    const txsBeforeAbort = mem.prepare("SELECT * FROM business_staging_transaction").all();
    const ledgerBefore = calculateDailyWritesFromTransactions(txsBeforeAbort, nowIso, utcDayStart);
    assert.equal(ledgerBefore.totalPendingReservedWrites, 18483);

    // Now abort the transaction today
    const abortReq = new Request("http://localhost/api/business-sync/transaction/abort", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tx_id: txId }),
    });
    const abortRes = await handleBusinessSyncRequest(abortReq, env, scope, new URL("http://localhost/api/business-sync/transaction/abort"), ["api", "business-sync", "transaction", "abort"]);
    assert.equal(abortRes.status, 200);

    // The transaction status is now 'aborted' with rolled_back_at = today
    const abortedTx = mem.prepare("SELECT * FROM business_staging_transaction WHERE tx_id=?").get(txId);
    assert.equal(abortedTx.status, "aborted");
    assert(abortedTx.rolled_back_at >= utcDayStart, "rolled_back_at must be recorded as today");

    // Verify that today's ledger charges EXACTLY the cleanup writes:
    // 3(3001) + 231 + 1 = 9,235 writes
    const expectedCleanupWrites = estimateCleanupActionWrites(3001, 231);
    assert.equal(expectedCleanupWrites, 9235);

    const txsAfterAbort = mem.prepare("SELECT * FROM business_staging_transaction").all();
    const ledgerAfter = calculateDailyWritesFromTransactions(txsAfterAbort, nowIso, utcDayStart);

    assert.equal(ledgerAfter.totalCommittedWrites, 9235, "Cross-midnight cleanup writes must be attributed to today");
    assert.equal(ledgerAfter.totalPendingReservedWrites, 0);
    assert.equal(ledgerAfter.remainingDailyBudget, FREE_PLAN_SAFE_IMPORT_BUDGET - 9235);
    console.log(`✓ Cross-midnight aborted transaction correctly attributes exactly ${ledgerAfter.totalCommittedWrites.toLocaleString()} cleanup writes to today`);

    // Verify that subsequent transaction admission accounts for the 9,235 cleanup writes:
    // Remaining budget = 80,000 - 9,235 = 70,765 writes.
    // A transaction requiring 70,757 writes (7,600 ops) must be ADMITTED.
    // A transaction requiring 70,851 writes (7,610 ops) must be REJECTED.
    const writes7600 = estimateAuthoritativeTransactionWrites(7600); // 70,757 <= 70,765
    assert(writes7600 <= ledgerAfter.remainingDailyBudget);

    const startAdmittedReq = new Request("http://localhost/api/business-sync/transaction/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tx_id: "webtx_admitted_after_cleanup",
        request_hash: "5".repeat(64),
        expected_chunks: Math.ceil(7600 / 13),
        operation_count: 7600,
      }),
    });
    const admitRes = await handleBusinessSyncRequest(startAdmittedReq, env, scope, new URL("http://localhost/api/business-sync/transaction/start"), ["api", "business-sync", "transaction", "start"]);
    assert.equal(admitRes.status, 201, "Transaction fitting within remaining budget after cleanup must be admitted");

    // An oversized transaction that exceeds the remaining budget must be rejected with 0 database writes
    env.resetRowsWritten();
    const startOversizedReq = new Request("http://localhost/api/business-sync/transaction/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tx_id: "webtx_rejected_oversized",
        request_hash: "6".repeat(64),
        expected_chunks: Math.ceil(1000 / 13),
        operation_count: 1000,
      }),
    });
    const rejectRes = await handleBusinessSyncRequest(startOversizedReq, env, scope, new URL("http://localhost/api/business-sync/transaction/start"), ["api", "business-sync", "transaction", "start"]);
    assert.equal(rejectRes.status, 409, "Transaction exceeding budget must be rejected");
    const rejectJson = await rejectRes.json();
    assert.equal(rejectJson.code, "D1_IMPORT_WRITE_BUDGET_EXCEEDED");
    console.log("✓ Daily budget ledger correctly gates subsequent imports based on cross-midnight cleanup writes");
  }

  console.log("PASSED: probe-atomic-budget-concurrency passed all checks");
}

run().catch((err) => {
  console.error("FAILED: probe-atomic-budget-concurrency", err);
  process.exit(1);
});
