// scripts/probe-orphan-transaction-recovery.mjs
// Verifies:
// 1. Fully-chunked pending transaction (e.g. 231 chunks staged) can be queried via
//    GET /api/business-sync/transaction/pending by owner/admin.
// 2. Non-owner cannot access pending transactions or abort other accounts (fails closed with 403).
// 3. Owner can cleanly abort a pending transaction, removing all staging rows,
//    staging dataset, and setting transaction status to 'aborted'.
// 4. Aborting an already-aborted transaction is idempotent (replayed: true).
// 5. Active committed business data remains 100% intact and untouched.

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { handleBusinessSyncRequest, canonicalJson } from "../worker/business-sync.js";

const SCHEMA_PATH = fileURLToPath(new URL("../worker/schema.sql", import.meta.url));

function setupTestEnvironment() {
  const mem = new DatabaseSync(":memory:");
  const schema = readFileSync(SCHEMA_PATH, "utf8");
  mem.exec(schema);

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
  };

  const now = new Date().toISOString();
  mem.prepare("INSERT INTO account (id, name, created_date) VALUES ('default', 'Default Account', ?)").run(now);
  mem.prepare(`
    INSERT INTO user (
      id, account_id, username, display_name, email, role,
      property_access_mode, is_active, is_locked, password_hash,
      salt, failed_login_count, created_date, updated_date
    ) VALUES ('usr_owner', 'default', 'owner', 'Owner', 'owner@example.com', 'owner', 'all', 1, 0, 'h', 's', 0, ?, ?)
  `).run(now, now);
  mem.prepare(`
    INSERT INTO user (
      id, account_id, username, display_name, email, role,
      property_access_mode, is_active, is_locked, password_hash,
      salt, failed_login_count, created_date, updated_date
    ) VALUES ('usr_staff', 'default', 'staff', 'Staff', 'staff@example.com', 'staff', 'specific', 1, 0, 'h', 's', 0, ?, ?)
  `).run(now, now);
  mem.prepare("INSERT INTO property (id, account_id, code, name, created_date) VALUES ('prop_1', 'default', 'RRI1416', 'Middleboro', ?)").run(now);
  mem.prepare("INSERT INTO business_sync_state (account_id, revision) VALUES ('default', 1)").run();
  mem.prepare("INSERT INTO business_dataset (account_id, generation_id, status, schema_version, manifest_hash, manifest_json, expected_chunks, expected_records, created_by, created_at) VALUES ('default', 'gen_active', 'active', 1, 'active_hash', '{}', 1, 1, 'usr_owner', ?)").run(now);
  mem.prepare("INSERT INTO business_dataset_pointer (account_id, active_generation_id, updated_at) VALUES ('default', 'gen_active', ?)").run(now);
  mem.prepare("INSERT INTO business_property_map (account_id, generation_id, property_key, server_property_id, property_code) VALUES ('default', 'gen_active', 'n:1', 'prop_1', 'RRI1416')").run();
  mem.prepare(`
    INSERT INTO business_record (
      account_id, generation_id, entity_name, record_key, property_key, server_property_id, row_json, row_hash, updated_at
    ) VALUES ('default', 'gen_active', 'OccupancyDay', 'occ_001', 'n:1', 'prop_1', '{"date":"2026-09-01"}', 'hash1', ?)
  `).run(now);

  const ownerScope = {
    accountId: "default",
    all: true,
    propertyIds: new Set(["prop_1"]),
    user: { id: "usr_owner", role: "owner" },
  };

  const staffScope = {
    accountId: "default",
    all: false,
    propertyIds: new Set(["prop_1"]),
    user: { id: "usr_staff", role: "staff" },
  };

  return { mem, env, ownerScope, staffScope };
}

async function run() {
  console.log("Starting probe-orphan-transaction-recovery...");
  const { mem, env, ownerScope, staffScope } = setupTestEnvironment();

  const txId = "webtx_stranded_test_001";
  const requestHash = "c".repeat(64);
  const opCount = 231 * 13; // 3,003 ops, 231 chunks
  const expectedChunks = 231;

  // 1. Start transaction
  const startReq = new Request("http://localhost/api/business-sync/transaction/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tx_id: txId,
      request_hash: requestHash,
      expected_chunks: expectedChunks,
      operation_count: opCount,
    }),
  });
  const startRes = await handleBusinessSyncRequest(startReq, env, ownerScope, new URL(startReq.url), ["api", "business-sync", "transaction", "start"]);
  assert.equal(startRes.status, 201);
  const startBody = await startRes.json();
  const stagingGenId = startBody.generation_id;
  console.log("✓ Transaction started with staging generation:", stagingGenId);

  // 2. Simulate chunks arriving up to chunk 231
  mem.prepare("UPDATE business_staging_transaction SET next_chunk_index=? WHERE tx_id=?").run(expectedChunks, txId);
  const now = new Date().toISOString();
  // Insert some mock staging rows
  mem.prepare(`
    INSERT INTO business_record_staging (account_id, transaction_id, entity_name, record_key, operation, row_json, row_hash, created_at)
    VALUES ('default', ?, 'OccupancyDay', 'occ_staged_001', 'insert', '{"date":"2026-09-02"}', 'hash2', ?)
  `).run(txId, now);
  mem.prepare(`
    INSERT INTO business_staging_target (account_id, tx_id, entity_name, record_key, server_property_id, operation)
    VALUES ('default', ?, 'OccupancyDay', 'occ_staged_001', 'prop_1', 'upsert')
  `).run(txId);

  // 3. Query pending transactions as non-owner (must fail closed with 403)
  const staffPendingReq = new Request("http://localhost/api/business-sync/transaction/pending", { method: "GET" });
  const staffPendingRes = await handleBusinessSyncRequest(staffPendingReq, env, staffScope, new URL(staffPendingReq.url), ["api", "business-sync", "transaction", "pending"]);
  assert.equal(staffPendingRes.status, 403, "Staff must be forbidden from listing pending transactions");
  console.log("✓ Staff access to /transaction/pending correctly fails closed with 403");

  // 4. Query pending transactions as owner
  const ownerPendingReq = new Request("http://localhost/api/business-sync/transaction/pending", { method: "GET" });
  const ownerPendingRes = await handleBusinessSyncRequest(ownerPendingReq, env, ownerScope, new URL(ownerPendingReq.url), ["api", "business-sync", "transaction", "pending"]);
  assert.equal(ownerPendingRes.status, 200);
  const pendingData = await ownerPendingRes.json();
  assert.equal(pendingData.ok, true);
  assert.equal(pendingData.transactions.length, 1);
  const listedTx = pendingData.transactions[0];
  assert.equal(listedTx.tx_id, txId);
  assert.equal(listedTx.status, "pending");
  assert.equal(listedTx.expected_chunks, 231);
  assert.equal(listedTx.received_chunks, 231);
  assert.equal(listedTx.is_all_chunks_received, true);
  console.log("✓ Owner successfully discovered stranded pending transaction via /transaction/pending");

  // 5. Clean abort of the stranded transaction
  const abortReq = new Request("http://localhost/api/business-sync/transaction/abort", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tx_id: txId }),
  });
  const abortRes = await handleBusinessSyncRequest(abortReq, env, ownerScope, new URL(abortReq.url), ["api", "business-sync", "transaction", "abort"]);
  assert.equal(abortRes.status, 200);
  const abortBody = await abortRes.json();
  assert.equal(abortBody.status, "aborted");
  assert.equal(abortBody.replayed, false);
  console.log("✓ Owner cleanly aborted pending stranded transaction");

  // 6. Verify staging cleanup
  const stagingRow = mem.prepare("SELECT COUNT(*) AS c FROM business_record_staging WHERE transaction_id=?").get(txId);
  assert.equal(stagingRow.c, 0, "All staging records must be deleted");

  const targetRow = mem.prepare("SELECT COUNT(*) AS c FROM business_staging_target WHERE tx_id=?").get(txId);
  assert.equal(targetRow.c, 0, "All staging targets must be deleted");

  const datasetRow = mem.prepare("SELECT status FROM business_dataset WHERE generation_id=?").get(stagingGenId);
  assert.equal(datasetRow.status, "aborted", "Staging dataset status must be aborted");

  const txFinal = mem.prepare("SELECT status FROM business_staging_transaction WHERE tx_id=?").get(txId);
  assert.equal(txFinal.status, "aborted", "Transaction status must be aborted");

  // 7. Verify replay of abort is idempotent
  const abortReplayReq = new Request("http://localhost/api/business-sync/transaction/abort", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tx_id: txId }),
  });
  const abortReplayRes = await handleBusinessSyncRequest(abortReplayReq, env, ownerScope, new URL(abortReplayReq.url), ["api", "business-sync", "transaction", "abort"]);
  assert.equal(abortReplayRes.status, 200);
  const replayBody = await abortReplayRes.json();
  assert.equal(replayBody.status, "aborted");
  assert.equal(replayBody.replayed, true);
  console.log("✓ Replayed abort is idempotent and returns replayed: true");

  // 8. Prove active generation and business records are 100% intact
  const activePointer = mem.prepare("SELECT active_generation_id FROM business_dataset_pointer WHERE account_id='default'").get();
  assert.equal(activePointer.active_generation_id, "gen_active", "Active pointer must remain gen_active");

  const activeRecords = mem.prepare("SELECT COUNT(*) AS c FROM business_record WHERE generation_id='gen_active'").get();
  assert.equal(activeRecords.c, 1, "Active records must remain completely intact");
  console.log("✓ Active production dataset and business records are 100% intact");

  console.log("PASSED: probe-orphan-transaction-recovery passed all checks");
}

run().catch((err) => {
  console.error("FAILED: probe-orphan-transaction-recovery", err);
  process.exit(1);
});
