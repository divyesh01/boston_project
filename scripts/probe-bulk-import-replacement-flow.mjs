// scripts/probe-bulk-import-replacement-flow.mjs
// Verifies explicit report replacement and overlap conflict recovery:
// 1. Backend detects active overlap and returns 409 IMPORT_REPLACEMENT_REQUIRED with existing_bundle_id and candidate details.
// 2. Failed replacement attempt leaves existing active report 100% intact.
// 3. User explicit confirmation provides predecessor bundle ID and expected revision.
// 4. Server-archived original is reused without second raw upload.
// 5. Successful activation supersedes existing active report atomically.
// 6. Covers both real production patterns: hotel_statistics and source_summary.

import "fake-indexeddb/auto";
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
  sha256Hex,
  activateBundleOnServer,
} from "../src/lib/bulkImportPipeline.js";
import { normalizedContent, contentHash } from "../worker/bulk-contract.js";

async function computeNormalizedHash(bundle) {
  const items = [];
  for (const [entity, rows] of Object.entries(bundle.recordsByEntity)) {
    for (const row of rows) {
      items.push({ entity, row });
    }
  }
  return await contentHash(normalizedContent(items));
}

const run = makeRunner("probe-bulk-import-replacement-flow");

function setupWorker() {
  clearMockStore();
  const db = makeDb();
  db.prepare("INSERT OR IGNORE INTO account (id, name, created_date) VALUES (?, ?, ?)").run("ACC_REPLACE", "Replacement Account", "2026-01-01");
  seedUser(db, { id: "user_owner", email: "owner@replace.local", role: "owner", mode: "all", accountId: "ACC_REPLACE" });
  db.prepare("INSERT OR IGNORE INTO property (id, account_id, code, name, rooms, address, city, state, phone, active, created_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("PROP_MIDDELBORO", "ACC_REPLACE", "RRI-MIDDEL", "Red Roof Middleboro", 100, "123 Main St", "Middleboro", "MA", "508-555-0100", 1, "2026-01-01");
  db.prepare("INSERT OR IGNORE INTO property (id, account_id, code, name, rooms, address, city, state, phone, active, created_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("PROP_OTHER", "ACC_REPLACE", "RRI-OTHER", "Red Roof Other", 80, "456 Side St", "Boston", "MA", "617-555-0200", 1, "2026-01-01");
  db.prepare("INSERT OR IGNORE INTO business_sync_state (account_id, revision) VALUES (?, ?)").run("ACC_REPLACE", 0);

  const { env, stats } = makeInstrumentedEnv(db, {
    ENABLE_BUSINESS_SYNC_API: "true",
    RAW_ARCHIVE: testR2Binding(),
    BULK_DATA: testR2Binding(),
  });
  const owner = scopeAll(["PROP_MIDDELBORO", "PROP_OTHER"]);
  owner.accountId = "ACC_REPLACE";
  owner.user.id = "user_owner";
  owner.user.account_id = "ACC_REPLACE";
  return { db, env, stats, owner };
}

await run.check("1. Hotel Statistics pattern: overlap returns 409 with existing_bundle_id & candidate details", async () => {
  const { db, env, owner } = setupWorker();
  const propertyId = "PROP_MIDDELBORO";

  // Step 1A: Upload and activate initial active report: "Hotel Statistics (1).csv"
  const v1RawText = "Property,Date,Section,Metric,Period,Value\nPROP_MIDDELBORO,2026-08-01,Revenue,ADR,Day,120.50\nPROP_MIDDELBORO,2026-08-07,Revenue,RevPAR,Day,95.00\n";
  const v1RawBytes = new TextEncoder().encode(v1RawText);
  const v1RawHash = await sha256Hex(v1RawBytes);
  const v1ArchiveId = "raw_hotel_stats_v1";
  const v1BundleId = "bundle_hotel_stats_v1";

  // Upload raw v1
  const upRaw1 = new Request("http://localhost/api/bulk-import/raw-upload", {
    method: "PUT",
    headers: {
      "x-server-property-id": propertyId,
      "x-report-type": "hotel_statistics",
      "x-raw-hash": v1RawHash,
      "x-archive-id": v1ArchiveId,
      "x-file-name": "Hotel Statistics (1).csv",
    },
    body: v1RawBytes,
  });
  const upRawRes1 = await handleBulkImportRequest(upRaw1, env, owner, new URL(upRaw1.url), ["api", "bulk-import", "raw-upload"]);
  assertEqual(upRawRes1.status, 201, "Raw v1 upload succeeded");
  const { raw_object_key: v1RawKey } = await upRawRes1.json();

  // Record raw archive v1
  const rec1 = new Request("http://localhost/api/bulk-import/raw-archive", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: v1BundleId,
      raw_archive_id: v1ArchiveId,
      server_property_id: propertyId,
      report_type: "hotel_statistics",
      raw_file_hash: v1RawHash,
      raw_object_key: v1RawKey,
      original_file_name: "Hotel Statistics (1).csv",
      file_size: v1RawBytes.byteLength,
    }),
  });
  await handleBulkImportRequest(rec1, env, owner, new URL(rec1.url), ["api", "bulk-import", "raw-archive"]);

  // Build normalized bundle v1
  const scanV1 = {
    type: "hotel_statistics",
    metrics: [
      { property_id: propertyId, business_date: "2026-08-01", section: "Revenue", metric_name: "ADR", period: "Day", value: 120.50 },
      { property_id: propertyId, business_date: "2026-08-07", section: "Revenue", metric_name: "RevPAR", period: "Day", value: 95.00 },
    ],
    totalRows: 2,
  };
  const bundleV1 = buildNormalizedBundle(scanV1, { propertyId, propertyName: "Red Roof Middleboro", sourceFile: "Hotel Statistics (1).csv" }, v1BundleId);
  const v1NormHash = await computeNormalizedHash(bundleV1);
  const v1Compressed = await compressPayloadGzip(bundleV1.ndjson);

  const upNorm1 = new Request("http://localhost/api/bulk-import/upload", {
    method: "PUT",
    headers: {
      "x-server-property-id": propertyId,
      "x-report-type": "hotel_statistics",
      "x-raw-hash": v1RawHash,
      "x-normalized-hash": v1NormHash,
      "x-row-count": "2",
      "x-identity-version": "2",
    },
    body: v1Compressed,
  });
  await handleBulkImportRequest(upNorm1, env, owner, new URL(upNorm1.url), ["api", "bulk-import", "upload"]);

  // Activate v1
  const act1 = new Request("http://localhost/api/bulk-import/activate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: v1BundleId,
      server_property_id: propertyId,
      report_type: "hotel_statistics",
      raw_file_hash: v1RawHash,
      normalized_hash: v1NormHash,
      row_count: 2,
    }),
  });
  const actRes1 = await handleBulkImportRequest(act1, env, owner, new URL(act1.url), ["api", "bulk-import", "activate"]);
  assertEqual(actRes1.status, 201, "Activation of v1 succeeded");
  const actJson1 = await actRes1.json();
  const v1Revision = actJson1.revision;
  assertEqual(v1Revision, 1, "Initial active revision is 1");

  // Step 1B: Now archive v2: "Hotel Statistics.csv" (overlapping date range)
  const v2RawText = "Property,Date,Section,Metric,Period,Value\nPROP_MIDDELBORO,2026-08-03,Revenue,ADR,Day,125.00\nPROP_MIDDELBORO,2026-08-05,Revenue,RevPAR,Day,98.00\n";
  const v2RawBytes = new TextEncoder().encode(v2RawText);
  const v2RawHash = await sha256Hex(v2RawBytes);
  const v2ArchiveId = "raw_hotel_stats_v2";
  const v2BundleId = "bundle_hotel_stats_v2";

  const upRaw2 = new Request("http://localhost/api/bulk-import/raw-upload", {
    method: "PUT",
    headers: {
      "x-server-property-id": propertyId,
      "x-report-type": "hotel_statistics",
      "x-raw-hash": v2RawHash,
      "x-archive-id": v2ArchiveId,
      "x-file-name": "Hotel Statistics.csv",
    },
    body: v2RawBytes,
  });
  const upRawRes2 = await handleBulkImportRequest(upRaw2, env, owner, new URL(upRaw2.url), ["api", "bulk-import", "raw-upload"]);
  const { raw_object_key: v2RawKey } = await upRawRes2.json();

  const rec2 = new Request("http://localhost/api/bulk-import/raw-archive", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: v2BundleId,
      raw_archive_id: v2ArchiveId,
      server_property_id: propertyId,
      report_type: "hotel_statistics",
      raw_file_hash: v2RawHash,
      raw_object_key: v2RawKey,
      original_file_name: "Hotel Statistics.csv",
      file_size: v2RawBytes.byteLength,
    }),
  });
  await handleBulkImportRequest(rec2, env, owner, new URL(rec2.url), ["api", "bulk-import", "raw-archive"]);

  const scanV2 = {
    type: "hotel_statistics",
    metrics: [
      { property_id: propertyId, business_date: "2026-08-03", section: "Revenue", metric_name: "ADR", period: "Day", value: 125.00 },
      { property_id: propertyId, business_date: "2026-08-05", section: "Revenue", metric_name: "RevPAR", period: "Day", value: 98.00 },
    ],
    totalRows: 2,
  };
  const bundleV2 = buildNormalizedBundle(scanV2, { propertyId, propertyName: "Red Roof Middleboro", sourceFile: "Hotel Statistics.csv" }, v2BundleId);
  const v2NormHash = await computeNormalizedHash(bundleV2);
  const v2Compressed = await compressPayloadGzip(bundleV2.ndjson);

  const upNorm2 = new Request("http://localhost/api/bulk-import/upload", {
    method: "PUT",
    headers: {
      "x-server-property-id": propertyId,
      "x-report-type": "hotel_statistics",
      "x-raw-hash": v2RawHash,
      "x-normalized-hash": v2NormHash,
      "x-row-count": "2",
      "x-identity-version": "2",
    },
    body: v2Compressed,
  });
  await handleBulkImportRequest(upNorm2, env, owner, new URL(upNorm2.url), ["api", "bulk-import", "upload"]);

  // Step 1C: Attempt to activate v2 WITHOUT replacement -> MUST return 409 IMPORT_REPLACEMENT_REQUIRED
  const act2NoReplace = new Request("http://localhost/api/bulk-import/activate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: v2BundleId,
      server_property_id: propertyId,
      report_type: "hotel_statistics",
      raw_file_hash: v2RawHash,
      normalized_hash: v2NormHash,
      row_count: 2,
    }),
  });
  const act2NoReplaceRes = await handleBulkImportRequest(act2NoReplace, env, owner, new URL(act2NoReplace.url), ["api", "bulk-import", "activate"]);
  assertEqual(act2NoReplaceRes.status, 409, "Activation without replacement returns 409");
  const act2Err = await act2NoReplaceRes.json();
  assertEqual(act2Err.code, "IMPORT_REPLACEMENT_REQUIRED", "Error code is IMPORT_REPLACEMENT_REQUIRED");
  assertEqual(act2Err.existing_bundle_id, v1BundleId, "existing_bundle_id matches active v1 bundle ID");
  assert(act2Err.existing_bundle != null, "existing_bundle details provided");
  assertEqual(act2Err.existing_bundle.original_file_name, "Hotel_Statistics__1_.csv", "existing_bundle file name is provided");
  assertEqual(act2Err.existing_bundle.revision, 1, "existing_bundle revision is provided");

  // Step 1D: Verify old active report remains 100% active and revision is unchanged
  const rowV1AfterFail = db.prepare("SELECT * FROM import_bundle_manifest WHERE id=?").get(v1BundleId);
  assertEqual(rowV1AfterFail.status, "active", "Old active report remains active after failed overlap activation");
  assertEqual(rowV1AfterFail.revision, 1, "Old active report revision remains 1");

  // Step 1E: Now activate with explicit replacement confirmation
  const act2Replace = new Request("http://localhost/api/bulk-import/activate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: v2BundleId,
      server_property_id: propertyId,
      report_type: "hotel_statistics",
      raw_file_hash: v2RawHash,
      normalized_hash: v2NormHash,
      row_count: 2,
      supersedes_bundle_id: v1BundleId,
      expected_revision: v1Revision,
    }),
  });
  const act2ReplaceRes = await handleBulkImportRequest(act2Replace, env, owner, new URL(act2Replace.url), ["api", "bulk-import", "activate"]);
  assertEqual(act2ReplaceRes.status, 201, "Guarded replacement activation succeeds");
  const act2ReplaceJson = await act2ReplaceRes.json();
  assertEqual(act2ReplaceJson.status, "active", "New bundle is active");
  assertEqual(act2ReplaceJson.revision, 2, "Sync state revision is incremented to 2");

  // Step 1F: Assert lineage state in D1
  const rowV1Final = db.prepare("SELECT * FROM import_bundle_manifest WHERE id=?").get(v1BundleId);
  assertEqual(rowV1Final.status, "superseded", "Old bundle is marked superseded");
  assertEqual(rowV1Final.superseded_by_bundle_id, v2BundleId, "Old bundle points to v2 bundle");

  const rowV2Final = db.prepare("SELECT * FROM import_bundle_manifest WHERE id=?").get(v2BundleId);
  assertEqual(rowV2Final.status, "active", "New bundle is active");
  assertEqual(rowV2Final.supersedes_bundle_id, v1BundleId, "New bundle points back to v1 bundle");

  // Step 1G: Assert both raw archives remain intact in storage
  const dl1 = new Request(`http://localhost/api/bulk-import/raw/${v1ArchiveId}`);
  const dlRes1 = await handleBulkImportRequest(dl1, env, owner, new URL(dl1.url), ["api", "bulk-import", "raw", v1ArchiveId]);
  assertEqual(dlRes1.status, 200, "Original v1 raw file remains downloadable");

  const dl2 = new Request(`http://localhost/api/bulk-import/raw/${v2ArchiveId}`);
  const dlRes2 = await handleBulkImportRequest(dl2, env, owner, new URL(dl2.url), ["api", "bulk-import", "raw", v2ArchiveId]);
  assertEqual(dlRes2.status, 200, "Original v2 raw file remains downloadable");
});

await run.check("2. Source Summary pattern: scope isolation & lineage conflict guards", async () => {
  const { db, env, owner } = setupWorker();
  const propertyId = "PROP_MIDDELBORO";
  const otherPropertyId = "PROP_OTHER";

  // Step 2A: Upload and activate source summary on PROP_OTHER
  const rawOtherText = "Date,Source,Rooms\n2026-08-01,OTA,10\n2026-08-02,Direct,15\n";
  const rawOtherBytes = new TextEncoder().encode(rawOtherText);
  const rawOtherHash = await sha256Hex(rawOtherBytes);
  const archOtherId = "raw_source_other";
  const bundleOtherId = "bundle_source_other";

  const upRawOther = new Request("http://localhost/api/bulk-import/raw-upload", {
    method: "PUT",
    headers: {
      "x-server-property-id": otherPropertyId,
      "x-report-type": "source",
      "x-raw-hash": rawOtherHash,
      "x-archive-id": archOtherId,
      "x-file-name": "Source Summary Other.csv",
    },
    body: rawOtherBytes,
  });
  const upRawOtherRes = await handleBulkImportRequest(upRawOther, env, owner, new URL(upRawOther.url), ["api", "bulk-import", "raw-upload"]);
  const { raw_object_key: otherRawKey } = await upRawOtherRes.json();

  const recOther = new Request("http://localhost/api/bulk-import/raw-archive", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: bundleOtherId,
      raw_archive_id: archOtherId,
      server_property_id: otherPropertyId,
      report_type: "source",
      raw_file_hash: rawOtherHash,
      raw_object_key: otherRawKey,
      original_file_name: "Source Summary Other.csv",
      file_size: rawOtherBytes.byteLength,
    }),
  });
  await handleBulkImportRequest(recOther, env, owner, new URL(recOther.url), ["api", "bulk-import", "raw-archive"]);

  const scanOther = {
    type: "source",
    rowsToImport: [
      { date: "2026-08-01", code: "OTA", rooms: 10 },
      { date: "2026-08-02", code: "Direct", rooms: 15 },
    ],
    totalRows: 2,
  };
  const bundleOther = buildNormalizedBundle(scanOther, { propertyId: otherPropertyId, propertyName: "Red Roof Other", sourceFile: "Source Summary Other.csv" }, bundleOtherId);
  const otherNormHash = await computeNormalizedHash(bundleOther);
  const otherCompressed = await compressPayloadGzip(bundleOther.ndjson);

  const upNormOther = new Request("http://localhost/api/bulk-import/upload", {
    method: "PUT",
    headers: {
      "x-server-property-id": otherPropertyId,
      "x-report-type": "source",
      "x-raw-hash": rawOtherHash,
      "x-normalized-hash": otherNormHash,
      "x-row-count": "2",
      "x-identity-version": "2",
    },
    body: otherCompressed,
  });
  await handleBulkImportRequest(upNormOther, env, owner, new URL(upNormOther.url), ["api", "bulk-import", "upload"]);

  const actOther = new Request("http://localhost/api/bulk-import/activate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: bundleOtherId,
      server_property_id: otherPropertyId,
      report_type: "source",
      raw_file_hash: rawOtherHash,
      normalized_hash: otherNormHash,
      row_count: 2,
    }),
  });
  const actOtherRes = await handleBulkImportRequest(actOther, env, owner, new URL(actOther.url), ["api", "bulk-import", "activate"]);
  assertEqual(actOtherRes.status, 201, "Activation on PROP_OTHER succeeded");

  // Step 2B: Now upload Source Summary on PROP_MIDDELBORO
  const rawMidText = "Date,Source,Rooms\n2026-08-01,OTA,20\n2026-08-02,Direct,25\n";
  const rawMidBytes = new TextEncoder().encode(rawMidText);
  const rawMidHash = await sha256Hex(rawMidBytes);
  const archMidId = "raw_source_mid";
  const bundleMidId = "bundle_source_mid";

  const upRawMid = new Request("http://localhost/api/bulk-import/raw-upload", {
    method: "PUT",
    headers: {
      "x-server-property-id": propertyId,
      "x-report-type": "source",
      "x-raw-hash": rawMidHash,
      "x-archive-id": archMidId,
      "x-file-name": "Source Summary.csv",
    },
    body: rawMidBytes,
  });
  const upRawMidRes = await handleBulkImportRequest(upRawMid, env, owner, new URL(upRawMid.url), ["api", "bulk-import", "raw-upload"]);
  const { raw_object_key: midRawKey } = await upRawMidRes.json();

  const recMid = new Request("http://localhost/api/bulk-import/raw-archive", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: bundleMidId,
      raw_archive_id: archMidId,
      server_property_id: propertyId,
      report_type: "source",
      raw_file_hash: rawMidHash,
      raw_object_key: midRawKey,
      original_file_name: "Source Summary.csv",
      file_size: rawMidBytes.byteLength,
    }),
  });
  await handleBulkImportRequest(recMid, env, owner, new URL(recMid.url), ["api", "bulk-import", "raw-archive"]);

  const scanMid = {
    type: "source",
    rowsToImport: [
      { date: "2026-08-01", code: "OTA", rooms: 20 },
      { date: "2026-08-02", code: "Direct", rooms: 25 },
    ],
    totalRows: 2,
  };
  const bundleMid = buildNormalizedBundle(scanMid, { propertyId, propertyName: "Red Roof Middleboro", sourceFile: "Source Summary.csv" }, bundleMidId);
  const midNormHash = await computeNormalizedHash(bundleMid);
  const midCompressed = await compressPayloadGzip(bundleMid.ndjson);

  const upNormMid = new Request("http://localhost/api/bulk-import/upload", {
    method: "PUT",
    headers: {
      "x-server-property-id": propertyId,
      "x-report-type": "source",
      "x-raw-hash": rawMidHash,
      "x-normalized-hash": midNormHash,
      "x-row-count": "2",
      "x-identity-version": "2",
    },
    body: midCompressed,
  });
  await handleBulkImportRequest(upNormMid, env, owner, new URL(upNormMid.url), ["api", "bulk-import", "upload"]);

  // Cross-property replacement attempt: PROP_MIDDELBORO import trying to supersede bundleOtherId from PROP_OTHER!
  const actCrossProp = new Request("http://localhost/api/bulk-import/activate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: bundleMidId,
      server_property_id: propertyId,
      report_type: "source",
      raw_file_hash: rawMidHash,
      normalized_hash: midNormHash,
      row_count: 2,
      supersedes_bundle_id: bundleOtherId, // wrong property!
      expected_revision: 1,
    }),
  });
  const actCrossPropRes = await handleBulkImportRequest(actCrossProp, env, owner, new URL(actCrossProp.url), ["api", "bulk-import", "activate"]);
  assertEqual(actCrossPropRes.status, 409, "Cross-property replacement fails closed");
  const crossErr = await actCrossPropRes.json();
  assertEqual(crossErr.code, "IMPORT_LINEAGE_CONFLICT", "Cross-property replacement fails with IMPORT_LINEAGE_CONFLICT");

  // Initial activation on PROP_MIDDELBORO succeeds without overlap
  const actMidInitial = new Request("http://localhost/api/bulk-import/activate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: bundleMidId,
      server_property_id: propertyId,
      report_type: "source",
      raw_file_hash: rawMidHash,
      normalized_hash: midNormHash,
      row_count: 2,
    }),
  });
  const actMidInitialRes = await handleBulkImportRequest(actMidInitial, env, owner, new URL(actMidInitial.url), ["api", "bulk-import", "activate"]);
  assertEqual(actMidInitialRes.status, 201, "First source report on PROP_MIDDELBORO activates cleanly");

  // Step 2C: Now upload "Source Summary (1).csv" on PROP_MIDDELBORO (overlapping dates)
  const rawMid1Text = "Date,Source,Rooms\n2026-08-01,OTA,22\n2026-08-02,Direct,28\n";
  const rawMid1Bytes = new TextEncoder().encode(rawMid1Text);
  const rawMid1Hash = await sha256Hex(rawMid1Bytes);
  const archMid1Id = "raw_source_mid_1";
  const bundleMid1Id = "bundle_source_mid_1";

  const upRawMid1 = new Request("http://localhost/api/bulk-import/raw-upload", {
    method: "PUT",
    headers: {
      "x-server-property-id": propertyId,
      "x-report-type": "source",
      "x-raw-hash": rawMid1Hash,
      "x-archive-id": archMid1Id,
      "x-file-name": "Source Summary (1).csv",
    },
    body: rawMid1Bytes,
  });
  const upRawMid1Res = await handleBulkImportRequest(upRawMid1, env, owner, new URL(upRawMid1.url), ["api", "bulk-import", "raw-upload"]);
  const { raw_object_key: mid1RawKey } = await upRawMid1Res.json();

  const recMid1 = new Request("http://localhost/api/bulk-import/raw-archive", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: bundleMid1Id,
      raw_archive_id: archMid1Id,
      server_property_id: propertyId,
      report_type: "source",
      raw_file_hash: rawMid1Hash,
      raw_object_key: mid1RawKey,
      original_file_name: "Source Summary (1).csv",
      file_size: rawMid1Bytes.byteLength,
    }),
  });
  await handleBulkImportRequest(recMid1, env, owner, new URL(recMid1.url), ["api", "bulk-import", "raw-archive"]);

  const scanMid1 = {
    type: "source",
    rowsToImport: [
      { date: "2026-08-01", code: "OTA", rooms: 22 },
      { date: "2026-08-02", code: "Direct", rooms: 28 },
    ],
    totalRows: 2,
  };
  const bundleMid1 = buildNormalizedBundle(scanMid1, { propertyId, propertyName: "Red Roof Middleboro", sourceFile: "Source Summary (1).csv" }, bundleMid1Id);
  const mid1NormHash = await computeNormalizedHash(bundleMid1);
  const mid1Compressed = await compressPayloadGzip(bundleMid1.ndjson);

  const upNormMid1 = new Request("http://localhost/api/bulk-import/upload", {
    method: "PUT",
    headers: {
      "x-server-property-id": propertyId,
      "x-report-type": "source",
      "x-raw-hash": rawMid1Hash,
      "x-normalized-hash": mid1NormHash,
      "x-row-count": "2",
      "x-identity-version": "2",
    },
    body: mid1Compressed,
  });
  await handleBulkImportRequest(upNormMid1, env, owner, new URL(upNormMid1.url), ["api", "bulk-import", "upload"]);

  // Stale expected_revision attempt fails with IMPORT_LINEAGE_CONFLICT
  const actStale = new Request("http://localhost/api/bulk-import/activate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: bundleMid1Id,
      server_property_id: propertyId,
      report_type: "source",
      raw_file_hash: rawMid1Hash,
      normalized_hash: mid1NormHash,
      row_count: 2,
      supersedes_bundle_id: bundleMidId,
      expected_revision: 999, // stale!
    }),
  });
  const actStaleRes = await handleBulkImportRequest(actStale, env, owner, new URL(actStale.url), ["api", "bulk-import", "activate"]);
  assertEqual(actStaleRes.status, 409, "Stale revision fails closed");
  const staleErr = await actStaleRes.json();
  assertEqual(staleErr.code, "IMPORT_LINEAGE_CONFLICT", "Stale revision error code is IMPORT_LINEAGE_CONFLICT");

  // Correct revision replacement succeeds
  const currentMid = db.prepare("SELECT revision FROM import_bundle_manifest WHERE id=?").get(bundleMidId);
  const actCorrect = new Request("http://localhost/api/bulk-import/activate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: bundleMid1Id,
      server_property_id: propertyId,
      report_type: "source",
      raw_file_hash: rawMid1Hash,
      normalized_hash: mid1NormHash,
      row_count: 2,
      supersedes_bundle_id: bundleMidId,
      expected_revision: currentMid.revision,
    }),
  });
  const actCorrectRes = await handleBulkImportRequest(actCorrect, env, owner, new URL(actCorrect.url), ["api", "bulk-import", "activate"]);
  assertEqual(actCorrectRes.status, 201, "Correct replacement of Source Summary succeeded");
});

await run.check("3. Pipeline error fidelity: activateBundleOnServer preserves existing_bundle_id & candidates", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => {
      return new Response(JSON.stringify({
        error: "Report overlaps an active import; select its replacement explicitly",
        code: "IMPORT_REPLACEMENT_REQUIRED",
        existing_bundle_id: "active_hotel_stats_999",
        existing_bundle: {
          id: "active_hotel_stats_999",
          original_file_name: "Hotel Statistics (old).csv",
          revision: 3,
          min_date: "2026-08-01",
          max_date: "2026-08-07",
          row_count: 14,
        },
        candidates: [
          { id: "active_hotel_stats_999", original_file_name: "Hotel Statistics (old).csv", revision: 3 },
        ],
      }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      });
    };

    let caught = null;
    try {
      await activateBundleOnServer({ id: "new_bundle" });
    } catch (err) {
      caught = err;
    }

    assert(caught != null, "activateBundleOnServer threw on 409");
    assertEqual(caught.code, "IMPORT_REPLACEMENT_REQUIRED", "Error code preserved");
    assertEqual(caught.status, 409, "HTTP status 409 preserved");
    assertEqual(caught.existing_bundle_id, "active_hotel_stats_999", "existing_bundle_id preserved on error");
    assert(caught.existing_bundle != null, "existing_bundle preserved on error");
    assertEqual(caught.existing_bundle.original_file_name, "Hotel Statistics (old).csv", "existing_bundle original_file_name preserved");
    assert(Array.isArray(caught.candidates), "candidates array preserved on error");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

run.done();
if (process.exitCode) process.exit(1);
console.log("PASSED: probe-bulk-import-replacement-flow completed all tests successfully.");
process.exit(0);
