// scripts/probe-bulk-import-archive-resume.mjs
// Verifies 50-file one-shot selection, decoupled archival, and cross-browser resumption:
// 1. Operator selects 50 HotelKey report files at once.
// 2. All 50 original files are permanently archived to R2 immediately.
// 3. Processing completes for files 1-30, then fails/stops (simulating browser close/crash).
// 4. Fresh Browser B opens with empty IndexedDB and 0 local files re-uploaded.
// 5. Browser B discovers the 20 pending raw archives from D1 manifest.
// 6. Browser B processes and normalizes the remaining 20 files directly from R2.
// 7. Verifies 100% data integrity, exact row count parity, and 0 local re-uploads.

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

const run = makeRunner("probe-bulk-import-archive-resume");

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
  db.prepare("INSERT OR IGNORE INTO account (id, name, created_date) VALUES (?, ?, ?)").run("A_1", "Resume Account", "2026-01-01");
  seedUser(db, { id: "user_owner", email: "owner@resume.local", role: "owner", mode: "all", accountId: "A_1" });
  db.prepare("INSERT OR IGNORE INTO property (id, account_id, code, name, rooms, address, city, state, phone, active, created_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("P_A", "A_1", "RRI-RESUME", "Red Roof Inn Resume", 100, "123 Main St", "Boston", "MA", "617-555-0100", 1, "2026-01-01");
  db.prepare("INSERT OR IGNORE INTO business_sync_state (account_id, revision) VALUES (?, ?)").run("A_1", 0);

  const { env, stats } = makeInstrumentedEnv(db, { ENABLE_BUSINESS_SYNC_API: "true", RAW_ARCHIVE: testR2Binding(), BULK_DATA: testR2Binding() });
  const owner = scopeAll(["P_A"]);
  owner.accountId = "A_1";
  owner.user.id = "user_owner";
  owner.user.account_id = "A_1";
  return { db, env, stats, owner };
}

await run.check("50-file one-shot archive -> processing failure on file 31 -> Browser B resumes 20 files from R2 with 0 local re-uploads", async () => {
  const { db, env, owner } = setupWorker();

  const propertyId = "P_A";
  const totalFiles = 50;
  const processedBeforeFailure = 30;
  const rowsPerFile = 20;

  // Generate 50 simulated CSV report files
  const fileFixtures = [];
  for (let f = 1; f <= totalFiles; f++) {
    const fileName = `Occupancy_Report_2025_Part_${String(f).padStart(2, "0")}.csv`;
    const rows = [];
    let csvContent = "Date,Rooms Occupied,Total Rooms,Room Revenue\n";
    for (let r = 0; r < rowsPerFile; r++) {
      const day = ((f - 1) * rowsPerFile + r) % 28 + 1;
      const month = Math.floor(((f - 1) * rowsPerFile + r) / 28) + 1;
      const dateStr = `2025-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const occupied = 50 + (r % 30);
      const rev = occupied * 100;
      csvContent += `${dateStr},${occupied},100,${rev}\n`;
      rows.push({
        date: dateStr,
        rooms_occupied: occupied,
        total_rooms: 100,
        room_revenue: rev,
      });
    }
    const rawBytes = new TextEncoder().encode(csvContent);
    const rawHash = await sha256Hex(rawBytes);
    fileFixtures.push({
      f,
      fileName,
      rawBytes,
      rawHash,
      rows,
    });
  }

  // PHASE 1: Browser A selects 50 files. All 50 original files are uploaded to R2 raw archive immediately.
  const archivedArchives = [];
  for (const item of fileFixtures) {
    const rawArchiveId = `raw_arch_${item.f}`;
    const uploadReq = new Request("http://localhost/api/bulk-import/raw-upload", {
      method: "PUT",
      headers: {
        "x-server-property-id": propertyId,
        "x-report-type": "occupancy",
        "x-raw-hash": item.rawHash,
        "x-archive-id": rawArchiveId,
        "x-file-name": item.fileName,
        "content-type": "text/csv",
      },
      body: item.rawBytes,
    });
    const uploadRes = await handleBulkImportRequest(uploadReq, env, owner, new URL(uploadReq.url), ["api", "bulk-import", "raw-upload"]);
    assertEqual(uploadRes.status, 201, `Raw archive upload succeeds for file ${item.f}`);
    const uploadData = await uploadRes.json();

    const recordReq = new Request("http://localhost/api/bulk-import/raw-archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: `bundle_${item.f}`,
        raw_archive_id: rawArchiveId,
        server_property_id: propertyId,
        report_type: "occupancy",
        raw_file_hash: item.rawHash,
        raw_object_key: uploadData.raw_object_key,
        original_file_name: item.fileName,
        file_size: item.rawBytes.byteLength,
        mime_type: "text/csv",
      }),
    });
    const recordRes = await handleBulkImportRequest(recordReq, env, owner, new URL(recordReq.url), ["api", "bulk-import", "raw-archive"]);
    assertEqual(recordRes.status, 201, `D1 manifest records raw archive for file ${item.f}`);
    archivedArchives.push({ ...item, rawArchiveId, rawObjectKey: uploadData.raw_object_key });
  }

  // Assert all 50 files are recorded as raw_archived
  const totalArchived = db.prepare("SELECT count(*) as cnt FROM import_bundle_manifest WHERE account_id='A_1' AND status='raw_archived'").get();
  assertEqual(totalArchived.cnt, 50, "All 50 original files safely archived in R2 and registered in D1");

  // PHASE 2: Browser A processes files 1 to 30 into normalized analytics bundles
  const dbA = new Dexie("BrowserA_DB");
  defineDexieStores(dbA);

  for (let i = 0; i < processedBeforeFailure; i++) {
    const item = archivedArchives[i];
    const bundleId = `bundle_${item.f}`;
    const scanResult = { type: "occupancy", rowsToImport: item.rows, totalRows: rowsPerFile };
    const meta = { propertyId, propertyName: "Red Roof Inn Resume", sourceFile: item.fileName };
    const bundle = buildNormalizedBundle(scanResult, meta, bundleId);
    const normHash = await sha256Hex(bundle.ndjson);
    const compressed = await compressPayloadGzip(bundle.ndjson);

    // Upload normalized bundle
    const upNormReq = new Request("http://localhost/api/bulk-import/upload", {
      method: "PUT",
      headers: { "x-server-property-id": propertyId, "x-normalized-hash": normHash, "x-report-type": "occupancy" },
      body: compressed,
    });
    const upNormRes = await handleBulkImportRequest(upNormReq, env, owner, new URL(upNormReq.url), ["api", "bulk-import", "upload"]);
    assertEqual(upNormRes.status, 201);

    // Activate in D1
    const actReq = new Request("http://localhost/api/bulk-import/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: bundleId,
        server_property_id: propertyId,
        report_type: "occupancy",
        raw_file_hash: item.rawHash,
        normalized_hash: normHash,
        row_count: rowsPerFile,
        original_file_name: item.fileName,
      }),
    });
    const actRes = await handleBulkImportRequest(actReq, env, owner, new URL(actReq.url), ["api", "bulk-import", "activate"]);
    assertEqual(actRes.status, 201);

    await dbA.OccupancyDay.bulkPut(bundle.recordsByEntity.OccupancyDay);
  }

  const activeAfterA = db.prepare("SELECT count(*) as cnt FROM import_bundle_manifest WHERE account_id='A_1' AND status='active'").get();
  assertEqual(activeAfterA.cnt, 30, "30 bundles activated by Browser A");

  // SIMULATE FAILURE / DISCONNECTION:
  // Browser A crashes / closes. Browser A IndexedDB is destroyed.
  await dbA.delete();

  // Fresh Browser B arrives. 0 local files. Empty IndexedDB.
  const dbB = new Dexie("BrowserB_DB");
  defineDexieStores(dbB);
  const rowsInBStart = await dbB.OccupancyDay.toArray();
  assertEqual(rowsInBStart.length, 0, "Browser B starts completely empty");

  // Step 1: Browser B discovers pending server-archived files
  const pendingReq = new Request("http://localhost/api/bulk-import/pending?server_property_id=P_A");
  const pendingRes = await handleBulkImportRequest(pendingReq, env, owner, new URL(pendingReq.url), ["api", "bulk-import", "pending"]);
  assertEqual(pendingRes.status, 200);
  const pendingData = await pendingRes.json();
  assertEqual(pendingData.pending.length, 20, "Browser B discovers exactly 20 pending raw archives");

  // Step 2: Browser B resumes processing of remaining 20 files WITHOUT re-uploading from disk!
  for (const pending of pendingData.pending) {
    // Download original raw bytes from R2
    const dlReq = new Request(`http://localhost/api/bulk-import/raw/${pending.raw_archive_id}`);
    const dlRes = await handleBulkImportRequest(dlReq, env, owner, new URL(dlReq.url), ["api", "bulk-import", "raw", pending.raw_archive_id]);
    assertEqual(dlRes.status, 200, `Downloaded raw archive ${pending.raw_archive_id} from R2`);
    const rawBuffer = await dlRes.arrayBuffer();

    // Verify hash parity
    const dlHash = await sha256Hex(rawBuffer);
    assertEqual(dlHash, pending.raw_file_hash, "Downloaded raw bytes match original SHA-256");

    // Parse downloaded CSV in Browser B
    const text = new TextDecoder().decode(rawBuffer);
    const lines = text.trim().split("\n").slice(1);
    const parsedRows = lines.map((l) => {
      const [date, rooms_occupied, total_rooms, room_revenue] = l.split(",");
      return { date, rooms_occupied: Number(rooms_occupied), total_rooms: Number(total_rooms), room_revenue: Number(room_revenue) };
    });
    assertEqual(parsedRows.length, rowsPerFile);

    // Build normalized bundle & upload
    const bundleId = pending.id;
    const scanResult = { type: "occupancy", rowsToImport: parsedRows, totalRows: rowsPerFile };
    const meta = { propertyId, propertyName: "Red Roof Inn Resume", sourceFile: pending.original_file_name };
    const bundle = buildNormalizedBundle(scanResult, meta, bundleId);
    const normHash = await sha256Hex(bundle.ndjson);
    const compressed = await compressPayloadGzip(bundle.ndjson);

    const upReq = new Request("http://localhost/api/bulk-import/upload", {
      method: "PUT",
      headers: { "x-server-property-id": propertyId, "x-normalized-hash": normHash, "x-report-type": "occupancy" },
      body: compressed,
    });
    const upRes = await handleBulkImportRequest(upReq, env, owner, new URL(upReq.url), ["api", "bulk-import", "upload"]);
    assertEqual(upRes.status, 201);

    // Activate in D1 (updating existing raw_archived row)
    const actReq = new Request("http://localhost/api/bulk-import/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: bundleId,
        server_property_id: propertyId,
        report_type: "occupancy",
        raw_file_hash: pending.raw_file_hash,
        normalized_hash: normHash,
        row_count: rowsPerFile,
        original_file_name: pending.original_file_name,
      }),
    });
    const actRes = await handleBulkImportRequest(actReq, env, owner, new URL(actReq.url), ["api", "bulk-import", "activate"]);
    assertEqual(actRes.status, 201);

    await dbB.OccupancyDay.bulkPut(bundle.recordsByEntity.OccupancyDay);
  }

  // Step 3: Browser B hydates the initial 30 active bundles from manifest feed
  const manifestReq = new Request("http://localhost/api/bulk-import/manifest?since_revision=0");
  const manifestRes = await handleBulkImportRequest(manifestReq, env, owner, new URL(manifestReq.url), ["api", "bulk-import", "manifest"]);
  const manifestData = await manifestRes.json();
  assertEqual(manifestData.manifests.length, 50, "All 50 bundles are now active on server");

  for (const m of manifestData.manifests) {
    const fileNum = parseInt(m.id.replace("bundle_", ""), 10);
    if (fileNum <= processedBeforeFailure) {
      const dlBundleReq = new Request(`http://localhost/api/bulk-import/bundle/${m.id}`);
      const dlBundleRes = await handleBulkImportRequest(dlBundleReq, env, owner, new URL(dlBundleReq.url), ["api", "bulk-import", "bundle", m.id]);
      assertEqual(dlBundleRes.status, 200);
      const buf = await dlBundleRes.arrayBuffer();
      const ndjson = await decompressPayloadGzip(buf);
      const records = ndjson.split("\n").filter(Boolean).map((l) => JSON.parse(l).row);
      await dbB.OccupancyDay.bulkPut(records);
    }
  }

  // Step 4: Final validation in Browser B
  const finalRowsB = await dbB.OccupancyDay.toArray();
  assertEqual(finalRowsB.length, totalFiles * rowsPerFile, `Browser B has exactly ${totalFiles * rowsPerFile} rows (1,000 rows across 50 files)`);

  // Verify pending count is now zero
  const pendingReqAfter = new Request("http://localhost/api/bulk-import/pending?server_property_id=P_A");
  const pendingResAfter = await handleBulkImportRequest(pendingReqAfter, env, owner, new URL(pendingReqAfter.url), ["api", "bulk-import", "pending"]);
  const pendingDataAfter = await pendingResAfter.json();
  assertEqual(pendingDataAfter.pending.length, 0, "Zero pending archives remaining — all 50 files fully processed");
});

run.done();
if (process.exitCode) process.exit(1);
console.log("PASSED: probe-bulk-import-archive-resume completed.");
process.exit(0);
