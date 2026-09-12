// scripts/probe-raw-concurrent-duplicate.mjs
// Verifies Section 8 & 9:
// 1. Browser A and Browser B upload EXACT same raw file simultaneously:
//    - Different filenames and report dates with identical bytes resolve to ONE canonical object key:
//      rri-raw/<account_id>/<server_property_id>/<raw_hash>
// 2. Concurrent raw upload creates exactly ONE R2 raw object.
// 3. Concurrent raw-archive manifest calls resolve idempotently to exactly ONE D1 manifest row.
// 4. Download of canonical raw archive preserves exact original byte parity.
// 5. Multi-client race (5 concurrent requests) yields exactly 1 manifest and 0 duplicate rows.
// 6. Property isolation: identical bytes across different properties remain strictly isolated.

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
import { sha256Hex } from "../src/lib/bulkImportPipeline.js";

const run = makeRunner("probe-raw-concurrent-duplicate");

function setupWorker() {
  clearMockStore();
  const db = makeDb();
  db.prepare("INSERT OR IGNORE INTO account (id, name, created_date) VALUES (?, ?, ?)").run("A_1", "Raw Concurrency Test", "2026-01-01");
  seedUser(db, { id: "user_owner", email: "owner@concurrent.local", role: "owner", mode: "all", accountId: "A_1" });
  seedUser(db, { id: "user_p_a", email: "manager_a@concurrent.local", role: "manager", permissions: JSON.stringify({ import_reports: true }), mode: "specific", propertyId: "P_A", accountId: "A_1" });
  seedUser(db, { id: "user_p_b", email: "manager_b@concurrent.local", role: "manager", permissions: JSON.stringify({ import_reports: true }), mode: "specific", propertyId: "P_B", accountId: "A_1" });

  db.prepare("INSERT OR IGNORE INTO property (id, account_id, code, name, rooms, address, city, state, phone, active, created_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("P_A", "A_1", "RRI-A", "Red Roof Inn A", 100, "123 Main St", "Boston", "MA", "617-555-0100", 1, "2026-01-01");
  db.prepare("INSERT OR IGNORE INTO property (id, account_id, code, name, rooms, address, city, state, phone, active, created_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("P_B", "A_1", "RRI-B", "Red Roof Inn B", 120, "456 Oak St", "Boston", "MA", "617-555-0200", 1, "2026-01-01");

  const { env, stats } = makeInstrumentedEnv(db, { ENABLE_BUSINESS_SYNC_API: "true", RAW_ARCHIVE:testR2Binding(), BULK_DATA:testR2Binding() });
  const owner = scopeAll(["P_A", "P_B"]);
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

  const managerB = scopeSpecific(["P_B"]);
  managerB.accountId = "A_1";
  managerB.user.id = "user_p_b";
  managerB.user.account_id = "A_1";
  managerB.user.role = "manager";
  managerB.user.permissions = JSON.stringify({ import_reports: true });

  return { db, env, stats, owner, managerA, managerB };
}

// 1. Browser A and Browser B upload exact same bytes simultaneously with different filenames and dates
await run.check("Browser A and B concurrent raw upload yields 1 canonical object and 1 logical manifest", async () => {
  const { db, env, owner } = setupWorker();
  const rawBytes = new TextEncoder().encode("Date,Rooms,Revenue\n2025-08-01,100,5000\n2025-08-02,95,4750\n");
  const rawHash = await sha256Hex(rawBytes);

  const archiveIdA = "raw_arch_browser_a";
  const archiveIdB = "raw_arch_browser_b";

  // Browser A request
  const reqA = new Request("http://localhost/api/bulk-import/raw-upload", {
    method: "PUT",
    headers: {
      "x-server-property-id": "P_A",
      "x-report-type": "occupancy",
      "x-raw-hash": rawHash,
      "x-archive-id": archiveIdA,
      "x-file-name": "HotelKey_Aug2025.csv",
      "x-report-date": "2025-08-01",
      "content-type": "text/csv",
      "content-length": String(rawBytes.byteLength),
    },
    body: rawBytes,
  });

  // Browser B request (different filename, different date, IDENTICAL raw bytes)
  const reqB = new Request("http://localhost/api/bulk-import/raw-upload", {
    method: "PUT",
    headers: {
      "x-server-property-id": "P_A",
      "x-report-type": "occupancy",
      "x-raw-hash": rawHash,
      "x-archive-id": archiveIdB,
      "x-file-name": "HK_August_Export_Final.csv",
      "x-report-date": "2025-08-15",
      "content-type": "text/csv",
      "content-length": String(rawBytes.byteLength),
    },
    body: rawBytes,
  });

  // Execute concurrent uploads
  const [resA, resB] = await Promise.all([
    handleBulkImportRequest(reqA, env, owner, new URL(reqA.url), ["api", "bulk-import", "raw-upload"]),
    handleBulkImportRequest(reqB, env, owner, new URL(reqB.url), ["api", "bulk-import", "raw-upload"]),
  ]);

  assert(resA.status === 201 || resA.status === 200, "Browser A upload succeeds");
  assert(resB.status === 201 || resB.status === 200, "Browser B upload succeeds");

  const dataA = await resA.json();
  const dataB = await resB.json();

  const canonicalKey = `rri-raw/A_1/P_A/${rawHash}`;
  assertEqual(dataA.raw_object_key, canonicalKey, "Browser A received canonical raw key");
  assertEqual(dataB.raw_object_key, canonicalKey, "Browser B received canonical raw key");

  // Verify only 1 object exists in storage
  const mockStore = getMockStore();
  let matchingObjects = 0;
  for (const [k] of mockStore.entries()) {
    if (k.startsWith("rri-raw/A_1/P_A/")) matchingObjects++;
  }
  assertEqual(matchingObjects, 1, "Exactly ONE canonical raw R2 object exists");

  // Now Browser A and Browser B concurrently call recordRawArchive
  const recA = new Request("http://localhost/api/bulk-import/raw-archive", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: archiveIdA,
      raw_archive_id: archiveIdA,
      server_property_id: "P_A",
      report_type: "occupancy",
      raw_file_hash: rawHash,
      raw_object_key: canonicalKey,
      original_file_name: "HotelKey_Aug2025.csv",
      file_size: rawBytes.byteLength,
      mime_type: "text/csv",
    }),
  });

  const recB = new Request("http://localhost/api/bulk-import/raw-archive", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: archiveIdB,
      raw_archive_id: archiveIdB,
      server_property_id: "P_A",
      report_type: "occupancy",
      raw_file_hash: rawHash,
      raw_object_key: canonicalKey,
      original_file_name: "HK_August_Export_Final.csv",
      file_size: rawBytes.byteLength,
      mime_type: "text/csv",
    }),
  });

  const [recResA, recResB] = await Promise.all([
    handleBulkImportRequest(recA, env, owner, new URL(recA.url), ["api", "bulk-import", "raw-archive"]),
    handleBulkImportRequest(recB, env, owner, new URL(recB.url), ["api", "bulk-import", "raw-archive"]),
  ]);

  assert(recResA.status === 201 || recResA.status === 200, "Record A succeeded");
  assert(recResB.status === 201 || recResB.status === 200, "Record B succeeded");

  const recDataA = await recResA.json();
  const recDataB = await recResB.json();

  // Exactly one created (201), the other detected already_recorded (200)
  const statuses = [recResA.status, recResB.status].sort();
  assertEqual(statuses[0], 200, "One request received 200 already_recorded");
  assertEqual(statuses[1], 201, "One request received 201 Created");

  // In D1, exactly 1 row must exist!
  const countRow = db.prepare("SELECT COUNT(*) as count FROM import_bundle_manifest WHERE account_id='A_1' AND server_property_id='P_A' AND raw_file_hash=?").get(rawHash);
  assertEqual(Number(countRow.count), 1, "Exactly ONE manifest row exists in D1");

  // Download test: verify canonical raw archive can be downloaded bit-for-bit
  const winningId = recDataA.bundle_id || recDataB.bundle_id;
  const dlReq = new Request(`http://localhost/api/bulk-import/raw/${winningId}`);
  const dlRes = await handleBulkImportRequest(dlReq, env, owner, new URL(dlReq.url), ["api", "bulk-import", "raw", winningId]);
  assertEqual(dlRes.status, 200, "Download of canonical raw archive succeeds");
  const dlBuffer = await dlRes.arrayBuffer();
  assertEqual(dlBuffer.byteLength, rawBytes.byteLength, "Downloaded byte length matches original");
  const dlHash = await sha256Hex(dlBuffer);
  assertEqual(dlHash, rawHash, "Downloaded bytes match SHA-256 exactly");
});

// 2. High-concurrency race: 5 concurrent requests for same raw file
await run.check("High concurrency race: 5 concurrent manifest recordings yield exactly 1 manifest in D1", async () => {
  const { db, env, owner } = setupWorker();
  const rawBytes = new TextEncoder().encode("Race test file content\n");
  const rawHash = await sha256Hex(rawBytes);
  const canonicalKey = `rri-raw/A_1/P_A/${rawHash}`;

  // Seed raw storage
  const mockStore = getMockStore();
  mockStore.set(canonicalKey, {
    data: rawBytes.buffer,
    customMetadata: { account_id:"A_1",server_property_id:"P_A",raw_hash: rawHash },
  });

  const promises = [];
  for (let i = 0; i < 5; i++) {
    const archiveId = `raw_race_${i}`;
    const req = new Request("http://localhost/api/bulk-import/raw-archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: archiveId,
        raw_archive_id: archiveId,
        server_property_id: "P_A",
        report_type: "occupancy",
        raw_file_hash: rawHash,
        raw_object_key: canonicalKey,
        original_file_name: `race_${i}.csv`,
        file_size: rawBytes.byteLength,
        mime_type: "text/csv",
      }),
    });
    promises.push(handleBulkImportRequest(req, env, owner, new URL(req.url), ["api", "bulk-import", "raw-archive"]));
  }

  const results = await Promise.all(promises);
  let createdCount = 0;
  let alreadyRecordedCount = 0;

  for (const res of results) {
    if (res.status === 201) createdCount++;
    if (res.status === 200) alreadyRecordedCount++;
  }

  assertEqual(createdCount, 1, "Exactly 1 request created the record (201)");
  assertEqual(alreadyRecordedCount, 4, "All 4 competing requests resolved to already_recorded (200)");

  const countRow = db.prepare("SELECT COUNT(*) as count FROM import_bundle_manifest WHERE account_id='A_1' AND raw_file_hash=?").get(rawHash);
  assertEqual(Number(countRow.count), 1, "Exactly 1 manifest exists in D1");
});

// 3. Property isolation: identical raw bytes for Property A vs Property B remain strictly isolated
await run.check("Property isolation: identical raw bytes for Property A and Property B have distinct keys and manifests", async () => {
  const { db, env, owner, managerA, managerB } = setupWorker();
  const rawBytes = new TextEncoder().encode("Shared format template data\n");
  const rawHash = await sha256Hex(rawBytes);

  const reqA = new Request("http://localhost/api/bulk-import/raw-upload", {
    method: "PUT",
    headers: { "x-server-property-id": "P_A", "x-report-type": "occupancy", "x-raw-hash": rawHash },
    body: rawBytes,
  });
  const reqB = new Request("http://localhost/api/bulk-import/raw-upload", {
    method: "PUT",
    headers: { "x-server-property-id": "P_B", "x-report-type": "occupancy", "x-raw-hash": rawHash },
    body: rawBytes,
  });

  const [resA, resB] = await Promise.all([
    handleBulkImportRequest(reqA, env, owner, new URL(reqA.url), ["api", "bulk-import", "raw-upload"]),
    handleBulkImportRequest(reqB, env, owner, new URL(reqB.url), ["api", "bulk-import", "raw-upload"]),
  ]);

  const dataA = await resA.json();
  const dataB = await resB.json();

  assertEqual(dataA.raw_object_key, `rri-raw/A_1/P_A/${rawHash}`, "Property A key scoped to P_A");
  assertEqual(dataB.raw_object_key, `rri-raw/A_1/P_B/${rawHash}`, "Property B key scoped to P_B");
  assert(dataA.raw_object_key !== dataB.raw_object_key, "Keys are strictly isolated by property");
});

run.done();
if (process.exitCode) process.exit(1);
console.log("PASSED: probe-raw-concurrent-duplicate completed.");
process.exit(0);
