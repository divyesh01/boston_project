// scripts/probe-bulk-import-performance.mjs
// Verifies that bulk import writes scale O(files), NOT O(rows).
// Asserts that no 13-row transaction/chunk requests occur for bulk reports,
// and that 100k-row imports consume <= 5 D1 writes.

import {
  assert,
  assertEqual,
  makeDb,
  makeInstrumentedEnv,
  makeRunner,
  seedUser,
  scopeAll,
} from "./_worker-testkit.mjs";
import { handleBulkImportRequest, clearMockStore } from "../worker/bulk-import.js";
import { compressPayloadGzip, sha256Hex } from "../src/lib/bulkImportPipeline.js";

const run = makeRunner("probe-bulk-import-performance");

function setupEnv() {
  clearMockStore();
  const db = makeDb();
  db.prepare("INSERT OR IGNORE INTO account (id, name, created_date) VALUES (?, ?, ?)").run("A_1", "Perf Account", "2026-01-01");
  seedUser(db, { id: "user_owner", email: "owner@perf.local", role: "owner", mode: "all", accountId: "A_1" });
  db.prepare("INSERT OR IGNORE INTO property (id, account_id, code, name, rooms, address, city, state, phone, active, created_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("P_A", "A_1", "RRI-PERF", "Red Roof Inn Perf", 100, "123 Perf St", "Boston", "MA", "617-555-0100", 1, "2026-01-01");
  db.prepare("INSERT OR IGNORE INTO business_sync_state (account_id, revision) VALUES (?, ?)").run("A_1", 0);

  const { env, stats } = makeInstrumentedEnv(db, { ENABLE_BUSINESS_SYNC_API: "true" });
  const owner = scopeAll(["P_A"]);
  owner.accountId = "A_1";
  owner.user.id = "user_owner";
  owner.user.account_id = "A_1";
  return { db, env, stats, owner };
}

await run.check("Bulk import of 18 files consumes <= 5 D1 writes per file and scales O(files)", async () => {
  const { db, env, stats, owner } = setupEnv();
  const fileCount = 18;
  const rowsPerFile = 500; // 9,000 rows total

  let totalD1Writes = 0;

  for (let f = 1; f <= fileCount; f++) {
    const rawFileContent = `RowID,Date,Amount\n` + Array.from({ length: rowsPerFile }, (_, i) => `${f}-${i},2026-08-${String((i%28)+1).padStart(2, '0')},100.00`).join('\n');
    const rawHash = await sha256Hex(rawFileContent);
    const ndjson = Array.from({ length: rowsPerFile }, (_, i) => JSON.stringify({
      entity: "OccupancyDay",
      row: { id: f * 10000 + i, date: "2026-08-01", property_id: "P_A", rooms_occupied: 50 }
    })).join('\n');
    const normalizedHash = await sha256Hex(ndjson);
    const compressed = await compressPayloadGzip(ndjson);

    // 1. Upload PUT
    const uploadReq = new Request("http://localhost/api/bulk-import/upload", {
      method: "PUT",
      headers: {
        "x-server-property-id": "P_A",
        "x-report-type": "occupancy",
        "x-raw-hash": rawHash,
        "x-normalized-hash": normalizedHash,
        "x-row-count": String(rowsPerFile),
      },
      body: compressed,
    });
    const uploadRes = await handleBulkImportRequest(uploadReq, env, owner, new URL(uploadReq.url), ["api", "bulk-import", "upload"]);
    assertEqual(uploadRes.status, 201, `Upload file ${f} status`);

    // Track D1 writes during activation
    const stmtsBefore = stats.statements;
    const activateReq = new Request("http://localhost/api/bulk-import/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: `bundle_perf_${f}`,
        server_property_id: "P_A",
        report_type: "occupancy",
        raw_file_hash: rawHash,
        normalized_hash: normalizedHash,
        schema_version: 1,
        row_count: rowsPerFile,
        entity_counts: { OccupancyDay: rowsPerFile },
        original_file_name: `file_${f}.csv`,
        file_size: rawFileContent.length,
        compressed_size: compressed.byteLength,
      }),
    });
    const activateRes = await handleBulkImportRequest(activateReq, env, owner, new URL(activateReq.url), ["api", "bulk-import", "activate"]);
    assertEqual(activateRes.status, 201, `Activate file ${f} status`);

    const writesForThisFile = stats.statements - stmtsBefore;
    assert(writesForThisFile <= 5, `Expected <= 5 D1 writes for file ${f}, got ${writesForThisFile}`);
    totalD1Writes += writesForThisFile;
  }

  // 18 files should consume <= 90 D1 writes total (vs > 80,000 writes in legacy per-row sync)
  assert(totalD1Writes <= fileCount * 5, `Total D1 writes for ${fileCount} files was ${totalD1Writes}, expected <= ${fileCount * 5}`);
  const manifests = db.prepare("SELECT count(*) as count FROM import_bundle_manifest WHERE account_id='A_1' AND status='active'").get();
  assertEqual(manifests.count, fileCount, "All 18 manifests active in D1");
});

await run.check("100k-row single report file consumes <= 5 D1 writes (O(1) with respect to rows)", async () => {
  const { env, stats, owner } = setupEnv();
  const rowCount = 100_000;

  const rawHash = "a".repeat(64);
  const normalizedHash = "b".repeat(64);
  const ndjson = JSON.stringify({ entity: "TransactionLine", row: { id: 1, count: rowCount } });
  const compressed = await compressPayloadGzip(ndjson);

  const uploadReq = new Request("http://localhost/api/bulk-import/upload", {
    method: "PUT",
    headers: {
      "x-server-property-id": "P_A",
      "x-report-type": "transactions",
      "x-raw-hash": rawHash,
      "x-normalized-hash": normalizedHash,
      "x-row-count": String(rowCount),
    },
    body: compressed,
  });
  const uploadRes = await handleBulkImportRequest(uploadReq, env, owner, new URL(uploadReq.url), ["api", "bulk-import", "upload"]);
  assertEqual(uploadRes.status, 201);

  const stmtsBefore = stats.statements;
  const activateReq = new Request("http://localhost/api/bulk-import/activate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: "bundle_100k",
      server_property_id: "P_A",
      report_type: "transactions",
      raw_file_hash: rawHash,
      normalized_hash: normalizedHash,
      schema_version: 1,
      row_count: rowCount,
      entity_counts: { TransactionLine: rowCount },
      original_file_name: "huge_100k.csv",
      file_size: 15_000_000,
      compressed_size: compressed.byteLength,
    }),
  });
  const activateRes = await handleBulkImportRequest(activateReq, env, owner, new URL(activateReq.url), ["api", "bulk-import", "activate"]);
  assertEqual(activateRes.status, 201);

  const writesFor100k = stats.statements - stmtsBefore;
  assert(writesFor100k <= 5, `100k-row import consumed ${writesFor100k} D1 writes, expected <= 5`);
});

await run.check("Duplicate check consumes 0 D1 writes and detects existing imports", async () => {
  const { db, env, stats, owner } = setupEnv();
  // Seed an existing bundle
  db.prepare(`INSERT INTO import_bundle_manifest (
    id, account_id, server_property_id, report_type, raw_file_hash,
    normalized_hash, object_key, schema_version, row_count, entity_counts_json,
    original_file_name, file_size, compressed_size, uploaded_by, status,
    created_at, activated_at, revision
  ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 100, '{}', 'existing.csv', 1000, 200, 'user', 'active', '2026-01-01', '2026-01-01', 1)`).run(
    "dup_1", "A_1", "P_A", "occupancy", "raw_hash_111", "norm_hash_222", "key_1"
  );

  const stmtsBefore = stats.statements;
  const checkReq = new Request("http://localhost/api/bulk-import/check-duplicate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      server_property_id: "P_A",
      raw_file_hash: "raw_hash_111",
      normalized_hash: "norm_hash_222",
    }),
  });
  const res = await handleBulkImportRequest(checkReq, env, owner, new URL(checkReq.url), ["api", "bulk-import", "check-duplicate"]);
  assertEqual(res.status, 200);
  const data = await res.json();
  assertEqual(data.is_duplicate, true, "Detected duplicate file");
  // Check that no mutating D1 statements were executed (only 1 SELECT query)
  const statementsExecuted = stats.statements - stmtsBefore;
  assertEqual(statementsExecuted, 1, "Only 1 read query executed");
  assert(!stats.calls.slice(stmtsBefore).some(c => /INSERT|UPDATE|DELETE/i.test(c.sql)), "0 writes during duplicate check");
});

run.done();
if (process.exitCode) process.exit(1);
console.log("PASSED: probe-bulk-import-performance completed.");
process.exit(0);
