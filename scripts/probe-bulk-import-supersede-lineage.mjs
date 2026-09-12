// scripts/probe-bulk-import-supersede-lineage.mjs
// Verifies historical report correction and supersede lineage:
// 1. Version 1 (August original) is archived to R2 and activated in D1.
// 2. Version 2 (August corrected) is archived to R2 and supersedes Version 1.
// 3. Both original raw files (v1 and v2) remain permanently in R2 with verified hash parity.
// 4. Lineage pointer (supersedes_bundle_id / superseded_by_bundle_id) is recorded authoritatively in D1.
// 5. Client hydration automatically applies the active corrected version and evicts the obsolete version.

import "fake-indexeddb/auto";
import Dexie from "dexie";
import {
  assert,
  assertEqual,
  makeDb,
  makeInstrumentedEnv,
  makeRunner,
  seedUser,
  scopeAll,
} from "./_worker-testkit.mjs";
import { handleBulkImportRequest } from "../worker/bulk-import.js";
import { clearMockStore, testR2Binding } from "./_r2-testkit.mjs";
import {
  buildNormalizedBundle,
  compressPayloadGzip,
  decompressPayloadGzip,
  sha256Hex,
} from "../src/lib/bulkImportPipeline.js";

const run = makeRunner("probe-bulk-import-supersede-lineage");

function defineDexieStores(dbInstance) {
  dbInstance.version(1).stores({
    OccupancyDay: '++id, date, property_id, import_id, bulk_import_id',
    UploadedReport: '++id, report_type, property_id, import_id',
    BusinessSyncState: 'key',
  });
}

function setupWorker() {
  clearMockStore();
  const db = makeDb();
  db.prepare("INSERT OR IGNORE INTO account (id, name, created_date) VALUES (?, ?, ?)").run("A_1", "Lineage Account", "2026-01-01");
  seedUser(db, { id: "user_owner", email: "owner@lineage.local", role: "owner", mode: "all", accountId: "A_1" });
  db.prepare("INSERT OR IGNORE INTO property (id, account_id, code, name, rooms, address, city, state, phone, active, created_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("P_A", "A_1", "RRI-LINEAGE", "Red Roof Inn Lineage", 100, "123 Main St", "Boston", "MA", "617-555-0100", 1, "2026-01-01");
  db.prepare("INSERT OR IGNORE INTO business_sync_state (account_id, revision) VALUES (?, ?)").run("A_1", 0);

  const { env, stats } = makeInstrumentedEnv(db, { ENABLE_BUSINESS_SYNC_API: "true", RAW_ARCHIVE: testR2Binding(), BULK_DATA: testR2Binding() });
  const owner = scopeAll(["P_A"]);
  owner.accountId = "A_1";
  owner.user.id = "user_owner";
  owner.user.account_id = "A_1";
  return { db, env, stats, owner };
}

await run.check("Supersede lineage: corrected export replaces active bundle while preserving both raw archives", async () => {
  const { db, env, owner } = setupWorker();
  const propertyId = "P_A";

  // Step 1: Version 1 (August original with revenue $100/room)
  const v1RawText = "Date,Rooms Occupied,Total Rooms,Room Revenue\n2025-08-01,50,100,5000\n2025-08-02,60,100,6000\n";
  const v1RawBytes = new TextEncoder().encode(v1RawText);
  const v1RawHash = await sha256Hex(v1RawBytes);
  const v1ArchiveId = "arch_august_v1";
  const v1BundleId = "bundle_august_v1";

  const upRaw1 = new Request("http://localhost/api/bulk-import/raw-upload", {
    method: "PUT",
    headers: { "x-server-property-id": propertyId, "x-report-type": "occupancy", "x-raw-hash": v1RawHash, "x-archive-id": v1ArchiveId, "x-file-name": "august_v1.csv" },
    body: v1RawBytes,
  });
  const upRawRes1 = await handleBulkImportRequest(upRaw1, env, owner, new URL(upRaw1.url), ["api", "bulk-import", "raw-upload"]);
  const { raw_object_key: v1RawKey } = await upRawRes1.json();

  const recReq1 = new Request("http://localhost/api/bulk-import/raw-archive", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: v1BundleId,
      raw_archive_id: v1ArchiveId,
      server_property_id: propertyId,
      report_type: "occupancy",
      raw_file_hash: v1RawHash,
      raw_object_key: v1RawKey,
      original_file_name: "august_v1.csv",
      file_size: v1RawBytes.byteLength,
    }),
  });
  await handleBulkImportRequest(recReq1, env, owner, new URL(recReq1.url), ["api", "bulk-import", "raw-archive"]);

  const scanV1 = {
    type: "occupancy",
    rowsToImport: [
      { date: "2025-08-01", rooms_occupied: 50, total_rooms: 100, room_revenue: 5000 },
      { date: "2025-08-02", rooms_occupied: 60, total_rooms: 100, room_revenue: 6000 },
    ],
    totalRows: 2,
  };
  const bundleV1 = buildNormalizedBundle(scanV1, { propertyId, propertyName: "Red Roof Inn Lineage", sourceFile: "august_v1.csv" }, v1BundleId);
  const v1NormHash = await sha256Hex(bundleV1.ndjson);
  const v1Compressed = await compressPayloadGzip(bundleV1.ndjson);

  const upNorm1 = new Request("http://localhost/api/bulk-import/upload", {
    method: "PUT",
    headers: { "x-server-property-id": propertyId, "x-normalized-hash": v1NormHash, "x-report-type": "occupancy" },
    body: v1Compressed,
  });
  await handleBulkImportRequest(upNorm1, env, owner, new URL(upNorm1.url), ["api", "bulk-import", "upload"]);

  const act1 = new Request("http://localhost/api/bulk-import/activate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: v1BundleId,
      server_property_id: propertyId,
      report_type: "occupancy",
      raw_file_hash: v1RawHash,
      normalized_hash: v1NormHash,
      row_count: 2,
    }),
  });
  await handleBulkImportRequest(act1, env, owner, new URL(act1.url), ["api", "bulk-import", "activate"]);

  // Step 2: Version 2 (Corrected August export with adjusted revenue $120/room) arrives
  const v2RawText = "Date,Rooms Occupied,Total Rooms,Room Revenue\n2025-08-01,50,100,6000\n2025-08-02,60,100,7200\n";
  const v2RawBytes = new TextEncoder().encode(v2RawText);
  const v2RawHash = await sha256Hex(v2RawBytes);
  const v2ArchiveId = "arch_august_v2";
  const v2BundleId = "bundle_august_v2";

  const upRaw2 = new Request("http://localhost/api/bulk-import/raw-upload", {
    method: "PUT",
    headers: { "x-server-property-id": propertyId, "x-report-type": "occupancy", "x-raw-hash": v2RawHash, "x-archive-id": v2ArchiveId, "x-file-name": "august_v2_corrected.csv" },
    body: v2RawBytes,
  });
  const upRawRes2 = await handleBulkImportRequest(upRaw2, env, owner, new URL(upRaw2.url), ["api", "bulk-import", "raw-upload"]);
  const { raw_object_key: v2RawKey } = await upRawRes2.json();

  const recReq2 = new Request("http://localhost/api/bulk-import/raw-archive", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: v2BundleId,
      raw_archive_id: v2ArchiveId,
      server_property_id: propertyId,
      report_type: "occupancy",
      raw_file_hash: v2RawHash,
      raw_object_key: v2RawKey,
      original_file_name: "august_v2_corrected.csv",
      file_size: v2RawBytes.byteLength,
    }),
  });
  await handleBulkImportRequest(recReq2, env, owner, new URL(recReq2.url), ["api", "bulk-import", "raw-archive"]);

  const scanV2 = {
    type: "occupancy",
    rowsToImport: [
      { date: "2025-08-01", rooms_occupied: 50, total_rooms: 100, room_revenue: 6000 },
      { date: "2025-08-02", rooms_occupied: 60, total_rooms: 100, room_revenue: 7200 },
    ],
    totalRows: 2,
  };
  const bundleV2 = buildNormalizedBundle(scanV2, { propertyId, propertyName: "Red Roof Inn Lineage", sourceFile: "august_v2_corrected.csv" }, v2BundleId);
  const v2NormHash = await sha256Hex(bundleV2.ndjson);
  const v2Compressed = await compressPayloadGzip(bundleV2.ndjson);

  const upNorm2 = new Request("http://localhost/api/bulk-import/upload", {
    method: "PUT",
    headers: { "x-server-property-id": propertyId, "x-normalized-hash": v2NormHash, "x-report-type": "occupancy" },
    body: v2Compressed,
  });
  await handleBulkImportRequest(upNorm2, env, owner, new URL(upNorm2.url), ["api", "bulk-import", "upload"]);

  const act2 = new Request("http://localhost/api/bulk-import/activate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: v2BundleId,
      server_property_id: propertyId,
      report_type: "occupancy",
      raw_file_hash: v2RawHash,
      normalized_hash: v2NormHash,
      row_count: 2,
      supersedes_bundle_id: v1BundleId,
      expected_revision: db.prepare("SELECT revision FROM import_bundle_manifest WHERE id=?").get(v1BundleId).revision,
    }),
  });
  const replacement = await handleBulkImportRequest(act2, env, owner, new URL(act2.url), ["api", "bulk-import", "activate"]);
  assertEqual(replacement.status, 201, "Atomic replacement succeeds");

  // Step 3: Assert D1 Lineage State
  const rowV1 = db.prepare("SELECT * FROM import_bundle_manifest WHERE id=?").get(v1BundleId);
  assertEqual(rowV1.status, "superseded", "Old bundle v1 is marked superseded");
  assertEqual(rowV1.superseded_by_bundle_id, v2BundleId, "Old bundle points to new bundle");

  const rowV2 = db.prepare("SELECT * FROM import_bundle_manifest WHERE id=?").get(v2BundleId);
  assertEqual(rowV2.status, "active", "New bundle v2 is active");
  assertEqual(rowV2.supersedes_bundle_id, v1BundleId, "New bundle points back to superseded bundle");

  // Step 4: CRITICAL ASSERTION — Both raw original files remain 100% downloadable from R2!
  const dlRaw1 = new Request(`http://localhost/api/bulk-import/raw/${v1ArchiveId}`);
  const dlRes1 = await handleBulkImportRequest(dlRaw1, env, owner, new URL(dlRaw1.url), ["api", "bulk-import", "raw", v1ArchiveId]);
  assertEqual(dlRes1.status, 200, "Original v1 raw file remains downloadable");
  const buf1 = await dlRes1.arrayBuffer();
  assertEqual(await sha256Hex(buf1), v1RawHash, "Original v1 hash matches byte-for-byte");

  const dlRaw2 = new Request(`http://localhost/api/bulk-import/raw/${v2ArchiveId}`);
  const dlRes2 = await handleBulkImportRequest(dlRaw2, env, owner, new URL(dlRaw2.url), ["api", "bulk-import", "raw", v2ArchiveId]);
  assertEqual(dlRes2.status, 200, "Corrected v2 raw file is downloadable");
  const buf2 = await dlRes2.arrayBuffer();
  assertEqual(await sha256Hex(buf2), v2RawHash, "Corrected v2 hash matches byte-for-byte");

  // Step 5: Client Hydration in Browser B
  const dbB = new Dexie("BrowserB_Lineage_DB");
  defineDexieStores(dbB);

  // Manifest feed query returns only active bundles for normal query
  const manReq = new Request("http://localhost/api/bulk-import/manifest?since_revision=0");
  const manRes = await handleBulkImportRequest(manReq, env, owner, new URL(manReq.url), ["api", "bulk-import", "manifest"]);
  const manData = await manRes.json();

  // Hydrate each manifest according to status
  for (const m of manData.manifests) {
    if (m.status === "active") {
      const dlReq = new Request(`http://localhost/api/bulk-import/bundle/${m.id}`);
      const dlRes = await handleBulkImportRequest(dlReq, env, owner, new URL(dlReq.url), ["api", "bulk-import", "bundle", m.id]);
      const buf = await dlRes.arrayBuffer();
      const text = await decompressPayloadGzip(buf);
      const rows = text.split("\n").filter(Boolean).map(l => JSON.parse(l).row);
      await dbB.OccupancyDay.bulkPut(rows);
    } else if (m.status === "superseded" || m.status === "tombstoned") {
      // Evict old rows
      const toDelete = await dbB.OccupancyDay.where("bulk_import_id").equals(m.id).primaryKeys();
      if (toDelete.length > 0) await dbB.OccupancyDay.bulkDelete(toDelete);
    }
  }

  const rowsB = await dbB.OccupancyDay.toArray();
  assertEqual(rowsB.length, 2, "Browser B holds exactly the 2 active rows");
  const totalRev = rowsB.reduce((acc, r) => acc + r.room_revenue, 0);
  assertEqual(totalRev, 13200, "KPI revenue reflects corrected v2 numbers ($6,000 + $7,200 = $13,200, not old $11,000)");
});

run.done();
if (process.exitCode) process.exit(1);
console.log("PASSED: probe-bulk-import-supersede-lineage completed.");
process.exit(0);
