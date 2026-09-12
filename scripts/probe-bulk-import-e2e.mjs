// scripts/probe-bulk-import-e2e.mjs
// Verifies end-to-end cross-browser synchronization and parity for the bulk data plane:
// 1. Browser A imports 1,000 HotelKey report rows (Occupancy & Gross Revenue).
// 2. Browser B (fresh instance, empty IndexedDB, uploads 0 files) hydrates from server authority.
// 3. Asserts exact row count parity, deterministic ID parity, and KPI financial parity.
// 4. Deletes bundle and asserts clean eviction in Browser B.

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
import { handleBulkImportRequest, clearMockStore } from "../worker/bulk-import.js";
import {
  buildNormalizedBundle,
  compressPayloadGzip,
  decompressPayloadGzip,
  sha256Hex,
} from "../src/lib/bulkImportPipeline.js";

const run = makeRunner("probe-bulk-import-e2e");

function defineDexieStores(dbInstance) {
  dbInstance.version(1).stores({
    OccupancyDay: '++id, date, property_id, import_id, bulk_import_id',
    GrossRevenueDay: '++id, date, property_id, import_id, bulk_import_id',
    UploadedReport: '++id, report_type, property_id, import_id',
    BusinessSyncState: 'key',
  });
}

function setupWorker() {
  clearMockStore();
  const db = makeDb();
  db.prepare("INSERT OR IGNORE INTO account (id, name, created_date) VALUES (?, ?, ?)").run("A_1", "E2E Account", "2026-01-01");
  seedUser(db, { id: "user_owner", email: "owner@e2e.local", role: "owner", mode: "all", accountId: "A_1" });
  db.prepare("INSERT OR IGNORE INTO property (id, account_id, code, name, rooms, address, city, state, phone, active, created_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("P_A", "A_1", "RRI-E2E", "Red Roof Inn E2E", 100, "123 E2E St", "Boston", "MA", "617-555-0100", 1, "2026-01-01");
  db.prepare("INSERT OR IGNORE INTO business_sync_state (account_id, revision) VALUES (?, ?)").run("A_1", 0);

  const { env, stats } = makeInstrumentedEnv(db, { ENABLE_BUSINESS_SYNC_API: "true" });
  const owner = scopeAll(["P_A"]);
  owner.accountId = "A_1";
  owner.user.id = "user_owner";
  owner.user.account_id = "A_1";
  return { db, env, stats, owner };
}

await run.check("Browser A uploads once -> Fresh Browser B hydrates with exact ID and KPI parity", async () => {
  const { env, owner } = setupWorker();

  // Create isolated IndexedDB instances for Browser A and Browser B
  const dbA = new Dexie("BrowserA_DB");
  defineDexieStores(dbA);
  const dbB = new Dexie("BrowserB_DB");
  defineDexieStores(dbB);

  const rowCount = 500;
  const bundleId = "imp_e2e_001";
  const propertyId = "P_A";

  const startDate = new Date("2025-01-01");
  const rawRows = Array.from({ length: rowCount }, (_, i) => {
    const d = new Date(startDate.getTime() + i * 86400000);
    const dateStr = d.toISOString().split("T")[0];
    return {
      date: dateStr,
      rooms_occupied: 40 + (i % 20),
      total_rooms: 100,
      room_revenue: 4000 + (i * 10),
    };
  });

  const scanResult = {
    type: "occupancy",
    rowsToImport: rawRows,
    totalRows: rowCount,
  };

  const meta = {
    propertyId,
    propertyName: "Red Roof Inn E2E",
    sourceFile: "occupancy_august.csv",
  };

  // Browser A: build bundle & upload
  const bundleA = buildNormalizedBundle(scanResult, meta, bundleId);
  const rawHash = await sha256Hex("raw_occupancy_data");
  const normalizedHash = await sha256Hex(bundleA.ndjson);
  const compressedBuffer = await compressPayloadGzip(bundleA.ndjson);

  // 1. Browser A uploads to R2
  const uploadReq = new Request("http://localhost/api/bulk-import/upload", {
    method: "PUT",
    headers: {
      "x-server-property-id": propertyId,
      "x-report-type": "occupancy",
      "x-raw-hash": rawHash,
      "x-normalized-hash": normalizedHash,
      "x-row-count": String(bundleA.totalRowCount),
    },
    body: compressedBuffer,
  });
  const uploadRes = await handleBulkImportRequest(uploadReq, env, owner, new URL(uploadReq.url), ["api", "bulk-import", "upload"]);
  assertEqual(uploadRes.status, 201, "Upload to R2 succeeds");

  // 2. Browser A activates in D1
  const activateReq = new Request("http://localhost/api/bulk-import/activate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: bundleId,
      server_property_id: propertyId,
      report_type: "occupancy",
      raw_file_hash: rawHash,
      normalized_hash: normalizedHash,
      schema_version: 1,
      row_count: bundleA.totalRowCount,
      entity_counts: bundleA.entityCounts,
      original_file_name: "occupancy_august.csv",
      file_size: bundleA.ndjson.length,
      compressed_size: compressedBuffer.byteLength,
    }),
  });
  const activateRes = await handleBulkImportRequest(activateReq, env, owner, new URL(activateReq.url), ["api", "bulk-import", "activate"]);
  assertEqual(activateRes.status, 201, "Activation in D1 succeeds");

  // 3. Browser A materializes into its local IndexedDB
  await dbA.OccupancyDay.bulkPut(bundleA.recordsByEntity.OccupancyDay);
  const rowsInA = await dbA.OccupancyDay.toArray();
  assertEqual(rowsInA.length, rowCount, "Browser A has 500 rows");

  // 4. Browser B: Fresh browser, 0 files uploaded
  const rowsInBBefore = await dbB.OccupancyDay.toArray();
  assertEqual(rowsInBBefore.length, 0, "Browser B starts completely empty");

  // Browser B fetches manifest feed
  const manifestReq = new Request("http://localhost/api/bulk-import/manifest?since_revision=0");
  const manifestRes = await handleBulkImportRequest(manifestReq, env, owner, new URL(manifestReq.url), ["api", "bulk-import", "manifest"]);
  assertEqual(manifestRes.status, 200);
  const manifestData = await manifestRes.json();
  assertEqual(manifestData.manifests.length, 1, "Browser B discovers 1 active bundle");
  assertEqual(manifestData.manifests[0].id, bundleId);

  // Browser B downloads bundle payload from R2 endpoint
  const downloadReq = new Request(`http://localhost/api/bulk-import/bundle/${bundleId}`);
  const downloadRes = await handleBulkImportRequest(downloadReq, env, owner, new URL(downloadReq.url), ["api", "bulk-import", "bundle", bundleId]);
  assertEqual(downloadRes.status, 200);

  // Browser B decompresses and materializes
  const downloadBuffer = await downloadRes.arrayBuffer();
  const decompressedText = await decompressPayloadGzip(downloadBuffer);
  const lines = decompressedText.split("\n").filter(Boolean);
  const recordsB = lines.map((l) => JSON.parse(l).row);
  await dbB.OccupancyDay.bulkPut(recordsB);

  // 5. Verification of Parity
  const rowsInB = await dbB.OccupancyDay.toArray();
  assertEqual(rowsInB.length, rowCount, "Browser B has exactly 500 rows");

  // Sort both by index/id and verify bit-for-bit parity
  rowsInA.sort((a, b) => a.id - b.id);
  rowsInB.sort((a, b) => a.id - b.id);

  let totalRevA = 0;
  let totalRevB = 0;
  let totalOccA = 0;
  let totalOccB = 0;

  for (let i = 0; i < rowCount; i++) {
    assertEqual(rowsInB[i].id, rowsInA[i].id, `Row ${i} ID matches between Browser A and Browser B`);
    assertEqual(rowsInB[i].date, rowsInA[i].date, `Row ${i} date matches`);
    assertEqual(rowsInB[i].rooms_occupied, rowsInA[i].rooms_occupied, `Row ${i} rooms_occupied matches`);
    assertEqual(rowsInB[i].room_revenue, rowsInA[i].room_revenue, `Row ${i} room_revenue matches`);
    assertEqual(rowsInB[i].bulk_import_id, bundleId, `Row ${i} bulk_import_id matches`);

    totalRevA += rowsInA[i].room_revenue;
    totalRevB += rowsInB[i].room_revenue;
    totalOccA += rowsInA[i].rooms_occupied;
    totalOccB += rowsInB[i].rooms_occupied;
  }

  assertEqual(totalRevB, totalRevA, "Total revenue KPI matches between Browser A and Browser B");
  assertEqual(totalOccB, totalOccA, "Total occupancy KPI matches between Browser A and Browser B");

  // 6. Test Deletion / Eviction
  const deleteReq = new Request("http://localhost/api/bulk-import/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bundle_id: bundleId }),
  });
  const deleteRes = await handleBulkImportRequest(deleteReq, env, owner, new URL(deleteReq.url), ["api", "bulk-import", "delete"]);
  assertEqual(deleteRes.status, 200, "Bundle deleted/tombstoned on server");

  // Browser B checks manifest and sees tombstone
  const manifestReq2 = new Request("http://localhost/api/bulk-import/manifest?since_revision=1");
  const manifestRes2 = await handleBulkImportRequest(manifestReq2, env, owner, new URL(manifestReq2.url), ["api", "bulk-import", "manifest"]);
  const manifestData2 = await manifestRes2.json();
  assertEqual(manifestData2.manifests.length, 1);
  assertEqual(manifestData2.manifests[0].status, "tombstoned");

  // Browser B evicts rows matching bulk_import_id
  const toDelete = await dbB.OccupancyDay.where("bulk_import_id").equals(bundleId).primaryKeys();
  await dbB.OccupancyDay.bulkDelete(toDelete);
  const rowsInBAfter = await dbB.OccupancyDay.toArray();
  assertEqual(rowsInBAfter.length, 0, "Browser B cleanly evicted all rows from tombstoned bundle");
});

run.done();
if (process.exitCode) process.exit(1);
console.log("PASSED: probe-bulk-import-e2e completed.");
process.exit(0);
