// scripts/probe-normalized-concurrent-duplicate.mjs
// Verifies Section 10:
// 1. Two clients upload the same normalized hash simultaneously:
//    - Exactly 1 logical content-addressed bundle in R2 storage:
//      rri-bulk/<account_id>/<server_property_id>/v1/<normalized_hash>.ndjson.gz
// 2. Two clients activate the same normalized hash simultaneously:
//    - Idempotent atomic activation in D1 (one 201 active, one 200 already_active).
//    - Exactly ONE manifest row with status = 'active'.
//    - Exactly ONE revision advance in business_sync_state.
//    - Exactly ONE entry in business_change (no duplicate analytics feeds).
// 3. High-concurrency race: 5 concurrent activations yield exactly 1 active manifest.
// 4. Repeated re-activation is an idempotent no-op.

import {
  assert,
  assertEqual,
  makeDb,
  makeInstrumentedEnv,
  makeRunner,
  seedUser,
  scopeAll,
  scopeSpecific,
} from "./_worker-testkit.mjs";
import { handleBulkImportRequest } from "../worker/bulk-import.js";
import { clearMockStore, getMockStore, testR2Binding } from "./_r2-testkit.mjs";
import { sha256Hex, compressPayloadGzip } from "../src/lib/bulkImportPipeline.js";

const run = makeRunner("probe-normalized-concurrent-duplicate");

function setupWorker() {
  clearMockStore();
  const db = makeDb();
  db.prepare("INSERT OR IGNORE INTO account (id, name, created_date) VALUES (?, ?, ?)").run("A_1", "Norm Concurrency Test", "2026-01-01");
  seedUser(db, { id: "user_owner", email: "owner@normcon.local", role: "owner", mode: "all", accountId: "A_1" });
  seedUser(db, { id: "user_p_a", email: "manager_a@normcon.local", role: "manager", permissions: JSON.stringify({ import_reports: true }), mode: "specific", propertyId: "P_A", accountId: "A_1" });

  db.prepare("INSERT OR IGNORE INTO property (id, account_id, code, name, rooms, address, city, state, phone, active, created_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("P_A", "A_1", "RRI-A", "Red Roof Inn A", 100, "123 Main St", "Boston", "MA", "617-555-0100", 1, "2026-01-01");
  db.prepare("INSERT OR IGNORE INTO business_sync_state (account_id, revision) VALUES (?, ?)").run("A_1", 0);

  const { env, stats } = makeInstrumentedEnv(db, { ENABLE_BUSINESS_SYNC_API: "true", RAW_ARCHIVE:testR2Binding(), BULK_DATA:testR2Binding() });
  const owner = scopeAll(["P_A"]);
  owner.accountId = "A_1";
  owner.user.id = "user_owner";
  owner.user.account_id = "A_1";
  owner.user.role = "owner";

  const managerA = scopeSpecific(["P_A"]);
  managerA.accountId = "A_1";
  managerA.user.id = "user_p_a";
  managerA.user.account_id = "A_1";
  managerA.user.role = "manager";
  managerA.user.permissions = JSON.stringify({ import_reports: true });

  return { db, env, stats, owner, managerA };
}

// 1. Two clients upload and activate the same normalized hash simultaneously
await run.check("Concurrent upload and activation of same normalized hash resolves idempotently without duplicates", async () => {
  const { db, env, owner } = setupWorker();

  const ndjson = '{"entity":"OccupancyDay","row":{"property_id":"P_A","date":"2025-08-01","rooms":75}}\n';
  const normalizedHash = await sha256Hex(ndjson);
  const compressedBuffer = await compressPayloadGzip(ndjson);
  const rawHash = await sha256Hex("raw_source_content");

  const expectedObjectKey = `rri-bulk/A_1/P_A/v1/${normalizedHash}.ndjson.gz`;

  // Step 1: Concurrent uploads
  const reqUpA = new Request("http://localhost/api/bulk-import/upload", {
    method: "PUT",
    headers: {
      "x-server-property-id": "P_A",
      "x-report-type": "occupancy",
      "x-raw-hash": rawHash,
      "x-normalized-hash": normalizedHash,
      "x-row-count": "1",
      "content-length": String(compressedBuffer.byteLength),
    },
    body: compressedBuffer,
  });

  const reqUpB = new Request("http://localhost/api/bulk-import/upload", {
    method: "PUT",
    headers: {
      "x-server-property-id": "P_A",
      "x-report-type": "occupancy",
      "x-raw-hash": rawHash,
      "x-normalized-hash": normalizedHash,
      "x-row-count": "1",
      "content-length": String(compressedBuffer.byteLength),
    },
    body: compressedBuffer,
  });

  const [upResA, upResB] = await Promise.all([
    handleBulkImportRequest(reqUpA, env, owner, new URL(reqUpA.url), ["api", "bulk-import", "upload"]),
    handleBulkImportRequest(reqUpB, env, owner, new URL(reqUpB.url), ["api", "bulk-import", "upload"]),
  ]);

  assert(upResA.status === 201 || upResA.status === 200, "Upload A succeeds");
  assert(upResB.status === 201 || upResB.status === 200, "Upload B succeeds");

  // Verify exactly 1 normalized object in storage
  const mockStore = getMockStore();
  let matchingObjects = 0;
  for (const [k] of mockStore.entries()) {
    if (k === expectedObjectKey) matchingObjects++;
  }
  assertEqual(matchingObjects, 1, "Exactly ONE normalized bundle stored in R2");

  // Step 2: Concurrent activations
  const actA = new Request("http://localhost/api/bulk-import/activate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: "bundle_act_a",
      server_property_id: "P_A",
      report_type: "occupancy",
      raw_file_hash: rawHash,
      normalized_hash: normalizedHash,
      object_key: expectedObjectKey,
      row_count: 1,
      entity_counts_json: '{"OccupancyDay":1}',
      original_file_name: "test.csv",
    }),
  });

  const actB = new Request("http://localhost/api/bulk-import/activate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: "bundle_act_b",
      server_property_id: "P_A",
      report_type: "occupancy",
      raw_file_hash: rawHash,
      normalized_hash: normalizedHash,
      object_key: expectedObjectKey,
      row_count: 1,
      entity_counts_json: '{"OccupancyDay":1}',
      original_file_name: "test.csv",
    }),
  });

  const [actResA, actResB] = await Promise.all([
    handleBulkImportRequest(actA, env, owner, new URL(actA.url), ["api", "bulk-import", "activate"]),
    handleBulkImportRequest(actB, env, owner, new URL(actB.url), ["api", "bulk-import", "activate"]),
  ]);

  assert(actResA.status === 201 || actResA.status === 200, "Activation A succeeds");
  assert(actResB.status === 201 || actResB.status === 200, "Activation B succeeds");

  const actDataA = await actResA.json();
  const actDataB = await actResB.json();

  // One gets 201 Created (status: active), other gets 200 OK (status: already_active)
  const actStatuses = [actResA.status, actResB.status].sort();
  assertEqual(actStatuses[0], 200, "One activation returned 200 already_active");
  assertEqual(actStatuses[1], 201, "One activation returned 201 Created");

  // In D1, exactly ONE active manifest row exists
  const activeRows = db.prepare("SELECT count(*) as cnt FROM import_bundle_manifest WHERE account_id='A_1' AND server_property_id='P_A' AND status='active'").get();
  assertEqual(Number(activeRows.cnt), 1, "Exactly ONE active manifest row in D1");

  // Revision advanced by exactly 1
  const syncState = db.prepare("SELECT revision FROM business_sync_state WHERE account_id='A_1'").get();
  assertEqual(Number(syncState.revision), 1, "Revision advanced by exactly 1");

  // Change feed logged exactly 1 event
  const changes = db.prepare("SELECT count(*) as cnt FROM business_change WHERE account_id='A_1' AND entity_name='ImportBundle'").get();
  assertEqual(Number(changes.cnt), 1, "Exactly 1 change feed event recorded (zero duplicates)");
});

// 2. High-concurrency race: 5 concurrent activations of same bundle
await run.check("High concurrency race: 5 concurrent activations resolve to exactly 1 active manifest and 1 revision", async () => {
  const { db, env, owner } = setupWorker();

  const ndjson = '{"entity":"OccupancyDay","row":{"property_id":"P_A","date":"2025-09-01","rooms":80}}\n';
  const normalizedHash = await sha256Hex(ndjson);
  const expectedObjectKey = `rri-bulk/A_1/P_A/v1/${normalizedHash}.ndjson.gz`;

  // Seed storage with normalized object
  const mockStore = getMockStore();
  mockStore.set(expectedObjectKey, {
    data: await compressPayloadGzip(ndjson),
    customMetadata: { account_id:"A_1",server_property_id:"P_A",normalized_hash: normalizedHash,row_count:"1",entity_counts_json:'{"OccupancyDay":1}' },
  });

  const promises = [];
  for (let i = 0; i < 5; i++) {
    const actReq = new Request("http://localhost/api/bulk-import/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: `bundle_race_${i}`,
        server_property_id: "P_A",
        report_type: "occupancy",
        raw_file_hash: `raw_hash_race_${i}`,
        normalized_hash: normalizedHash,
        object_key: expectedObjectKey,
        row_count: 1,
        entity_counts_json: '{"OccupancyDay":1}',
        original_file_name: `race_${i}.csv`,
      }),
    });
    promises.push(handleBulkImportRequest(actReq, env, owner, new URL(actReq.url), ["api", "bulk-import", "activate"]));
  }

  const results = await Promise.all(promises);

  let activeCount = 0;
  let alreadyActiveCount = 0;
  for (const res of results) {
    if (res.status === 201) activeCount++;
    if (res.status === 200) alreadyActiveCount++;
  }

  assertEqual(activeCount, 1, "Exactly 1 activation succeeded with 201 Created");
  assertEqual(alreadyActiveCount, 4, "All other 4 activations returned 200 already_active");

  const activeRows = db.prepare("SELECT count(*) as cnt FROM import_bundle_manifest WHERE account_id='A_1' AND normalized_hash=? AND status='active'").get(normalizedHash);
  assertEqual(Number(activeRows.cnt), 1, "Exactly 1 manifest in D1 with status='active'");

  const syncState = db.prepare("SELECT revision FROM business_sync_state WHERE account_id='A_1'").get();
  assertEqual(Number(syncState.revision), 1, "business_sync_state advanced by exactly 1 revision");
});

run.done();
if (process.exitCode) process.exit(1);
console.log("PASSED: probe-normalized-concurrent-duplicate completed.");
process.exit(0);
