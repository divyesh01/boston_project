// scripts/probe-bulk-import-immutable-source.mjs
// Verifies write-once immutability, overwrite refusal, and tamper rejection:
// 1. First upload of raw file creates permanent archive (201 Created).
// 2. Duplicate upload of identical raw file is idempotent (200 OK).
// 3. Attempted overwrite of existing object key with DIFFERENT bytes fails closed (409 Conflict).
// 4. Tampered payload checksum (declared hash != computed hash) is rejected (400 Bad Request).
// 5. "Remove from Analytics" (POST /delete) tombstones analytics data, but raw R2 archive is NEVER deleted.
// 6. Direct raw archive destruction is gated by owner authorization and immutability policy.

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
import { handleBulkImportRequest, clearMockStore, getMockStore } from "../worker/bulk-import.js";
import { sha256Hex, compressPayloadGzip } from "../src/lib/bulkImportPipeline.js";

const run = makeRunner("probe-bulk-import-immutable-source");

function setupWorker() {
  clearMockStore();
  const db = makeDb();
  db.prepare("INSERT OR IGNORE INTO account (id, name, created_date) VALUES (?, ?, ?)").run("A_1", "Immutable Account", "2026-01-01");
  seedUser(db, { id: "user_owner", email: "owner@immut.local", role: "owner", mode: "all", accountId: "A_1" });
  seedUser(db, { id: "user_staff", email: "staff@immut.local", role: "manager", mode: "specific", accountId: "A_1" });

  db.prepare("INSERT OR IGNORE INTO property (id, account_id, code, name, rooms, address, city, state, phone, active, created_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("P_A", "A_1", "RRI-IMMUT", "Red Roof Inn Immut", 100, "123 Main St", "Boston", "MA", "617-555-0100", 1, "2026-01-01");
  db.prepare("INSERT OR IGNORE INTO business_sync_state (account_id, revision) VALUES (?, ?)").run("A_1", 0);

  const { env, stats } = makeInstrumentedEnv(db, { ENABLE_BUSINESS_SYNC_API: "true" });
  const owner = scopeAll(["P_A"]);
  owner.accountId = "A_1";
  owner.user.id = "user_owner";
  owner.user.account_id = "A_1";

  const staff = scopeSpecific(["P_A"]);
  staff.accountId = "A_1";
  staff.user.id = "user_staff";
  staff.user.account_id = "A_1";
  staff.user.role = "manager";
  staff.user.permissions = JSON.stringify({ import_reports: true });

  return { db, env, stats, owner, staff };
}

await run.check("Write-once immutability: idempotent 200 on identical file, 409 Conflict on overwrite attempt", async () => {
  const { env, owner } = setupWorker();
  const propertyId = "P_A";

  const contentA = new TextEncoder().encode("Date,Rev\n2025-08-01,1000\n");
  const hashA = await sha256Hex(contentA);

  // 1. Initial upload -> 201 Created
  const upReq1 = new Request("http://localhost/api/bulk-import/raw-upload", {
    method: "PUT",
    headers: {
      "x-server-property-id": propertyId,
      "x-report-type": "occupancy",
      "x-raw-hash": hashA,
      "x-file-name": "august_final.csv",
    },
    body: contentA,
  });
  const upRes1 = await handleBulkImportRequest(upReq1, env, owner, new URL(upReq1.url), ["api", "bulk-import", "raw-upload"]);
  assertEqual(upRes1.status, 201, "First upload creates raw object");
  const data1 = await upRes1.json();
  const objectKey = data1.raw_object_key;

  // 2. Identical re-upload -> 200 OK (idempotent write-once)
  const upReq2 = new Request("http://localhost/api/bulk-import/raw-upload", {
    method: "PUT",
    headers: {
      "x-server-property-id": propertyId,
      "x-report-type": "occupancy",
      "x-raw-hash": hashA,
      "x-file-name": "august_final.csv",
    },
    body: contentA,
  });
  const upRes2 = await handleBulkImportRequest(upReq2, env, owner, new URL(upReq2.url), ["api", "bulk-import", "raw-upload"]);
  assertEqual(upRes2.status, 200, "Identical re-upload returns 200 OK (idempotent)");
  const data2 = await upRes2.json();
  assertEqual(data2.status, "already_archived");

  // 3. Conflict attempt: mutate content in storage to different hash and attempt to put different content at same key
  const mockStore = getMockStore();
  const storedObj = mockStore.get(objectKey);
  // Temporarily tamper stored metadata hash to simulate an external key collision
  storedObj.customMetadata.raw_hash = "f".repeat(64);

  const upReq3 = new Request("http://localhost/api/bulk-import/raw-upload", {
    method: "PUT",
    headers: {
      "x-server-property-id": propertyId,
      "x-report-type": "occupancy",
      "x-raw-hash": hashA,
      "x-file-name": "august_final.csv",
    },
    body: contentA,
  });
  const upRes3 = await handleBulkImportRequest(upReq3, env, owner, new URL(upReq3.url), ["api", "bulk-import", "raw-upload"]);
  assertEqual(upRes3.status, 409, "Object key collision with different content returns 409 Conflict");
  const data3 = await upRes3.json();
  assertEqual(data3.code, "RAW_OBJECT_CONFLICT");

  // Restore stored hash
  storedObj.customMetadata.raw_hash = hashA;
});

await run.check("Checksum tamper rejection: declared hash != byte digest returns 400 Bad Request", async () => {
  const { env, owner } = setupWorker();
  const propertyId = "P_A";

  const realBytes = new TextEncoder().encode("Real Content");
  const fakeHash = "e".repeat(64); // Mismatched hash

  const tamperReq = new Request("http://localhost/api/bulk-import/raw-upload", {
    method: "PUT",
    headers: {
      "x-server-property-id": propertyId,
      "x-raw-hash": fakeHash,
      "x-file-name": "tampered.csv",
    },
    body: realBytes,
  });
  const tamperRes = await handleBulkImportRequest(tamperReq, env, owner, new URL(tamperReq.url), ["api", "bulk-import", "raw-upload"]);
  assertEqual(tamperRes.status, 400, "Tampered payload checksum is rejected with 400 Bad Request");
  const errData = await tamperRes.json();
  assertEqual(errData.code, "RAW_HASH_MISMATCH");
});

await run.check("Delete / Undo semantics: 'Remove from Analytics' leaves raw archive 100% intact in R2", async () => {
  const { env, owner } = setupWorker();
  const propertyId = "P_A";

  const rawBytes = new TextEncoder().encode("Date,Revenue\n2025-08-01,5000\n");
  const rawHash = await sha256Hex(rawBytes);
  const bundleId = "bundle_to_delete";
  const rawArchiveId = "arch_delete_test";

  // Upload raw archive
  const upRaw = new Request("http://localhost/api/bulk-import/raw-upload", {
    method: "PUT",
    headers: {
      "x-server-property-id": propertyId,
      "x-raw-hash": rawHash,
      "x-archive-id": rawArchiveId,
      "x-file-name": "delete_test.csv",
    },
    body: rawBytes,
  });
  const upRawRes = await handleBulkImportRequest(upRaw, env, owner, new URL(upRaw.url), ["api", "bulk-import", "raw-upload"]);
  const { raw_object_key: rawObjectKey } = await upRawRes.json();

  // Record raw archive
  const recReq = new Request("http://localhost/api/bulk-import/raw-archive", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: bundleId,
      raw_archive_id: rawArchiveId,
      server_property_id: propertyId,
      report_type: "occupancy",
      raw_file_hash: rawHash,
      raw_object_key: rawObjectKey,
      original_file_name: "delete_test.csv",
      file_size: rawBytes.byteLength,
    }),
  });
  await handleBulkImportRequest(recReq, env, owner, new URL(recReq.url), ["api", "bulk-import", "raw-archive"]);

  // Upload normalized bundle & activate
  const normPayload = JSON.stringify({ entity: "OccupancyDay", row: { count: 1 } });
  const normHash = await sha256Hex(normPayload);
  const compressed = await compressPayloadGzip(normPayload);

  const upNorm = new Request("http://localhost/api/bulk-import/upload", {
    method: "PUT",
    headers: { "x-server-property-id": propertyId, "x-normalized-hash": normHash },
    body: compressed,
  });
  await handleBulkImportRequest(upNorm, env, owner, new URL(upNorm.url), ["api", "bulk-import", "upload"]);

  const actReq = new Request("http://localhost/api/bulk-import/activate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: bundleId,
      server_property_id: propertyId,
      report_type: "occupancy",
      raw_file_hash: rawHash,
      normalized_hash: normHash,
      row_count: 1,
    }),
  });
  const actRes = await handleBulkImportRequest(actReq, env, owner, new URL(actReq.url), ["api", "bulk-import", "activate"]);
  assertEqual(actRes.status, 201);

  // Execute DELETE / Remove from Analytics
  const delReq = new Request("http://localhost/api/bulk-import/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bundle_id: bundleId }),
  });
  const delRes = await handleBulkImportRequest(delReq, env, owner, new URL(delReq.url), ["api", "bulk-import", "delete"]);
  assertEqual(delRes.status, 200, "Bundle tombstones successfully");

  // Normalized bundle is tombstones and inactive
  const normDlReq = new Request(`http://localhost/api/bulk-import/bundle/${bundleId}`);
  const normDlRes = await handleBulkImportRequest(normDlReq, env, owner, new URL(normDlReq.url), ["api", "bulk-import", "bundle", bundleId]);
  assertEqual(normDlRes.status, 410, "Normalized bundle download returns 410 Gone");

  // CRITICAL ASSERTION: Raw original archive is 100% PRESERVED and downloadable!
  const rawDlReq = new Request(`http://localhost/api/bulk-import/raw/${rawArchiveId}`);
  const rawDlRes = await handleBulkImportRequest(rawDlReq, env, owner, new URL(rawDlReq.url), ["api", "bulk-import", "raw", rawArchiveId]);
  assertEqual(rawDlRes.status, 200, "Raw archive download remains active (200 OK) after analytics deletion");
  const rawDownloadedBuf = await rawDlRes.arrayBuffer();
  assertEqual(rawDownloadedBuf.byteLength, rawBytes.byteLength, "Original raw file size matches");
});

await run.check("Destruction governance: non-owner forbidden (403), immutable archive blocked without explicit confirm", async () => {
  const { db, env, owner, staff } = setupWorker();

  // Seed an immutable archive in D1
  db.prepare(`INSERT INTO import_bundle_manifest (
    id, account_id, server_property_id, report_type, raw_file_hash,
    raw_archive_id, raw_object_key, original_file_name, source_immutable, uploaded_by, status, created_at, revision
  ) VALUES ('b_dest', 'A_1', 'P_A', 'occupancy', 'raw_h', 'arch_dest', 'k_dest', 'file.csv', 1, 'u', 'raw_archived', '2026-01-01', 1)`).run();

  // Non-owner staff attempts to destroy raw archive
  const staffDestroyReq = new Request("http://localhost/api/bulk-import/raw-destroy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ archive_id: "arch_dest" }),
  });
  const staffRes = await handleBulkImportRequest(staffDestroyReq, env, staff, new URL(staffDestroyReq.url), ["api", "bulk-import", "raw-destroy"]);
  assertEqual(staffRes.status, 403, "Non-owner role is forbidden from raw destruction");

  // Owner attempts destruction without confirm_destroy flag on immutable archive
  const unconfirmedReq = new Request("http://localhost/api/bulk-import/raw-destroy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ archive_id: "arch_dest", confirm_destroy: false }),
  });
  const unconfirmedRes = await handleBulkImportRequest(unconfirmedReq, env, owner, new URL(unconfirmedReq.url), ["api", "bulk-import", "raw-destroy"]);
  assertEqual(unconfirmedRes.status, 403, "Destruction without explicit confirmation flag is blocked");
  const unconfData = await unconfirmedRes.json();
  assertEqual(unconfData.code, "CANNOT_DESTROY_IMMUTABLE_ARCHIVE");
});

run.done();
if (process.exitCode) process.exit(1);
console.log("PASSED: probe-bulk-import-immutable-source completed.");
process.exit(0);
