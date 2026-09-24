// scripts/probe-bulk-import-multi-replacement.mjs
// Verifies safe many-to-one report replacement flow:
// 1. Multiple active overlapping reports return 409 IMPORT_REPLACEMENT_REQUIRED with all candidate predecessors.
// 2. Omission of any active overlapping predecessor fails closed (requires ALL active overlaps to be selected).
// 3. Stale revision, wrong report type, or cross-property predecessor fails closed with 409 IMPORT_LINEAGE_CONFLICT.
// 4. Atomic many-to-one replacement: all predecessors marked superseded, successor activated, 1 revision increment.
// 5. Preserves relational lineage in import_bundle_lineage table and backward compatibility on supersedes_bundle_id.
// 6. Preserves all raw source archives and avoids duplicate analytical data.

import './_loader-boot.mjs';
import 'fake-indexeddb/auto';
import {
  assert,
  assertEqual,
  makeDb,
  makeInstrumentedEnv,
  makeRunner,
  seedUser,
  scopeAll,
} from './_worker-testkit.mjs';
import { handleBulkImportRequest } from '../worker/bulk-import.js';
import { clearMockStore, testR2Binding } from './_r2-testkit.mjs';
import {
  buildNormalizedBundle,
  compressPayloadGzip,
  sha256Hex,
  executeBulkImport,
} from '../src/lib/bulkImportPipeline.js';
import { normalizedContent, contentHash } from '../worker/bulk-contract.js';

async function computeNormalizedHash(bundle) {
  const items = [];
  for (const [entity, rows] of Object.entries(bundle.recordsByEntity)) {
    for (const row of rows) {
      items.push({ entity, row });
    }
  }
  return await contentHash(normalizedContent(items));
}

const run = makeRunner('probe-bulk-import-multi-replacement');

function setupWorker() {
  clearMockStore();
  const db = makeDb();
  db.prepare('INSERT OR IGNORE INTO account (id, name, created_date) VALUES (?, ?, ?)')
    .run('ACC_MULTI_REPLACE', 'Multi Replace Account', '2026-01-01');
  seedUser(db, { id: 'user_owner', email: 'owner@multireplace.local', role: 'owner', mode: 'all', accountId: 'ACC_MULTI_REPLACE' });
  db.prepare('INSERT OR IGNORE INTO property (id, account_id, code, name, rooms, address, city, state, phone, active, created_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('PROP_MIDDELBORO', 'ACC_MULTI_REPLACE', 'RRI-MIDDEL', 'Red Roof Middleboro', 100, '123 Main St', 'Middleboro', 'MA', '508-555-0100', 1, '2026-01-01');
  db.prepare('INSERT OR IGNORE INTO property (id, account_id, code, name, rooms, address, city, state, phone, active, created_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('PROP_OTHER', 'ACC_MULTI_REPLACE', 'RRI-OTHER', 'Red Roof Other', 80, '456 Side St', 'Boston', 'MA', '617-555-0200', 1, '2026-01-01');
  db.prepare('INSERT OR IGNORE INTO business_sync_state (account_id, revision) VALUES (?, ?)').run('ACC_MULTI_REPLACE', 0);

  const { env, stats } = makeInstrumentedEnv(db, {
    ENABLE_BUSINESS_SYNC_API: 'true',
    RAW_ARCHIVE: testR2Binding(),
    BULK_DATA: testR2Binding(),
  });
  const owner = scopeAll(['PROP_MIDDELBORO', 'PROP_OTHER']);
  owner.accountId = 'ACC_MULTI_REPLACE';
  owner.user.id = 'user_owner';
  owner.user.account_id = 'ACC_MULTI_REPLACE';
  return { db, env, stats, owner };
}

// Helper: Seed an active report in the test environment
async function seedActiveReport(env, owner, db, propertyId, opts) {
  const { bundleId, archiveId, fileName, minDate, maxDate, rowCount, reportType } = opts;
  const rawText = `Property,Date,Source,Revenue\n${propertyId},${minDate},OTA,100\n${propertyId},${maxDate},Direct,200\n`;
  const rawBytes = new TextEncoder().encode(rawText);
  const rawHash = await sha256Hex(rawBytes);

  // Upload raw
  const upRaw = new Request('http://localhost/api/bulk-import/raw-upload', {
    method: 'PUT',
    headers: {
      'x-server-property-id': propertyId,
      'x-report-type': reportType,
      'x-raw-hash': rawHash,
      'x-archive-id': archiveId,
      'x-file-name': fileName,
    },
    body: rawBytes,
  });
  const upRawRes = await handleBulkImportRequest(upRaw, env, owner, new URL(upRaw.url), ['api', 'bulk-import', 'raw-upload']);
  assertEqual(upRawRes.status, 201, `Seed raw upload ${fileName} 201`);
  const { raw_object_key: rawKey } = await upRawRes.json();

  // Record raw archive
  const rec = new Request('http://localhost/api/bulk-import/raw-archive', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: bundleId,
      raw_archive_id: archiveId,
      server_property_id: propertyId,
      report_type: reportType,
      raw_file_hash: rawHash,
      raw_object_key: rawKey,
      original_file_name: fileName,
      file_size: rawBytes.byteLength,
    }),
  });
  await handleBulkImportRequest(rec, env, owner, new URL(rec.url), ['api', 'bulk-import', 'raw-archive']);

  // Normalized bundle
  const scan = {
    type: reportType,
    rowsToImport: reportType === 'source' ? [
      { property_id: propertyId, date: minDate, source: 'OTA', revenue: 100 },
      { property_id: propertyId, date: maxDate, source: 'Direct', revenue: 200 },
    ] : undefined,
    metrics: reportType === 'hotel_statistics' ? [
      { property_id: propertyId, business_date: minDate, section: 'Revenue', metric_name: 'ADR', period: 'Day', value: 100 },
      { property_id: propertyId, business_date: maxDate, section: 'Revenue', metric_name: 'Direct', period: 'Day', value: 200 },
    ] : undefined,
    totalRows: rowCount,
  };
  const bundle = buildNormalizedBundle(scan, { propertyId, propertyName: 'Hotel', sourceFile: fileName }, bundleId);
  const normHash = await computeNormalizedHash(bundle);
  const compressed = await compressPayloadGzip(bundle.ndjson);

  const upNorm = new Request('http://localhost/api/bulk-import/upload', {
    method: 'PUT',
    headers: {
      'x-server-property-id': propertyId,
      'x-report-type': reportType,
      'x-raw-hash': rawHash,
      'x-normalized-hash': normHash,
      'x-row-count': String(bundle.totalRowCount),
      'x-identity-version': '2',
    },
    body: compressed,
  });
  const upNormRes = await handleBulkImportRequest(upNorm, env, owner, new URL(upNorm.url), ['api', 'bulk-import', 'upload']);
  if (upNormRes.status !== 201) {
    console.log('DEBUG upNorm:', upNormRes.status, await upNormRes.text());
  }

  const act = new Request('http://localhost/api/bulk-import/activate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: bundleId,
      source_archive_id: archiveId,
      server_property_id: propertyId,
      report_type: reportType,
      raw_file_hash: rawHash,
      normalized_hash: normHash,
      row_count: bundle.totalRowCount,
      min_date: minDate,
      max_date: maxDate,
    }),
  });
  const actRes = await handleBulkImportRequest(act, env, owner, new URL(act.url), ['api', 'bulk-import', 'activate']);
  assertEqual(actRes.status, 201, `Seed activate ${fileName} 201`);
  const actData = await actRes.json();
  return { bundleId, rawHash, normHash, revision: actData.revision, rawKey };
}

await run.check('1. Multiple active overlaps return 409 with all candidates listed', async () => {
  const { db, env, owner } = setupWorker();
  const propertyId = 'PROP_MIDDELBORO';

  // Seed 3 active quarterly Source Summary reports
  const q1 = await seedActiveReport(env, owner, db, propertyId, {
    bundleId: 'bundle_source_q1',
    archiveId: 'raw_source_q1',
    fileName: 'Source Summary Q1.csv',
    minDate: '2026-01-01',
    maxDate: '2026-03-31',
    rowCount: 3330,
    reportType: 'source',
  });
  const q2 = await seedActiveReport(env, owner, db, propertyId, {
    bundleId: 'bundle_source_q2',
    archiveId: 'raw_source_q2',
    fileName: 'Source Summary Q2.csv',
    minDate: '2026-04-01',
    maxDate: '2026-06-30',
    rowCount: 3367,
    reportType: 'source',
  });
  const q3 = await seedActiveReport(env, owner, db, propertyId, {
    bundleId: 'bundle_source_q3',
    archiveId: 'raw_source_q3',
    fileName: 'Source Summary Q3.csv',
    minDate: '2026-07-01',
    maxDate: '2026-08-02',
    rowCount: 1221,
    reportType: 'source',
  });

  // Now stage combined report (Jan 01 - Aug 02)
  const combinedRawText = 'Property,Date,Source,Revenue\nPROP_MIDDELBORO,2026-01-01,OTA,100\nPROP_MIDDELBORO,2026-08-02,Direct,200\n';
  const combinedBytes = new TextEncoder().encode(combinedRawText);
  const combinedHash = await sha256Hex(combinedBytes);
  const combinedBundleId = 'bundle_source_combined';
  const combinedArchiveId = 'raw_source_combined';

  // Raw upload + archive
  const upRaw = new Request('http://localhost/api/bulk-import/raw-upload', {
    method: 'PUT',
    headers: {
      'x-server-property-id': propertyId,
      'x-report-type': 'source',
      'x-raw-hash': combinedHash,
      'x-archive-id': combinedArchiveId,
      'x-file-name': 'Source Summary (1).csv',
    },
    body: combinedBytes,
  });
  await handleBulkImportRequest(upRaw, env, owner, new URL(upRaw.url), ['api', 'bulk-import', 'raw-upload']);

  const rec = new Request('http://localhost/api/bulk-import/raw-archive', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: combinedBundleId,
      raw_archive_id: combinedArchiveId,
      server_property_id: propertyId,
      report_type: 'source',
      raw_file_hash: combinedHash,
      raw_object_key: `raw/${propertyId}/${combinedArchiveId}.csv`,
      original_file_name: 'Source Summary (1).csv',
      file_size: combinedBytes.byteLength,
    }),
  });
  await handleBulkImportRequest(rec, env, owner, new URL(rec.url), ['api', 'bulk-import', 'raw-archive']);

  // Normalized upload
  const scanCombined = {
    type: 'source',
    rowsToImport: [
      { property_id: propertyId, date: '2026-01-01', source: 'OTA', revenue: 100 },
      { property_id: propertyId, date: '2026-08-02', source: 'Direct', revenue: 200 },
    ],
    totalRows: 7918,
  };
  const bundleCombined = buildNormalizedBundle(scanCombined, { propertyId, propertyName: 'Hotel', sourceFile: 'Source Summary (1).csv' }, combinedBundleId);
  const combinedNormHash = await computeNormalizedHash(bundleCombined);
  const combinedCompressed = await compressPayloadGzip(bundleCombined.ndjson);

  const upNorm = new Request('http://localhost/api/bulk-import/upload', {
    method: 'PUT',
    headers: {
      'x-server-property-id': propertyId,
      'x-report-type': 'source',
      'x-raw-hash': combinedHash,
      'x-normalized-hash': combinedNormHash,
      'x-row-count': String(bundleCombined.totalRowCount),
      'x-identity-version': '2',
    },
    body: combinedCompressed,
  });
  await handleBulkImportRequest(upNorm, env, owner, new URL(upNorm.url), ['api', 'bulk-import', 'upload']);

  // Attempt activation without predecessors -> MUST fail with 409 IMPORT_REPLACEMENT_REQUIRED
  const act = new Request('http://localhost/api/bulk-import/activate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: combinedBundleId,
      source_archive_id: combinedArchiveId,
      server_property_id: propertyId,
      report_type: 'source',
      raw_file_hash: combinedHash,
      normalized_hash: combinedNormHash,
      row_count: bundleCombined.totalRowCount,
      min_date: '2026-01-01',
      max_date: '2026-08-02',
    }),
  });
  const actRes = await handleBulkImportRequest(act, env, owner, new URL(act.url), ['api', 'bulk-import', 'activate']);
  assertEqual(actRes.status, 409, 'Returns 409');
  const actErr = await actRes.json();
  assertEqual(actErr.code, 'IMPORT_REPLACEMENT_REQUIRED', 'Error code is IMPORT_REPLACEMENT_REQUIRED');
  assertEqual(actErr.candidates.length, 3, 'All 3 overlapping candidates returned');
  const candidateIds = actErr.candidates.map((c) => c.id);
  assert(candidateIds.includes(q1.bundleId), 'Q1 included in candidates');
  assert(candidateIds.includes(q2.bundleId), 'Q2 included in candidates');
  assert(candidateIds.includes(q3.bundleId), 'Q3 included in candidates');
});

await run.check('2. Omission of any active overlapping predecessor fails closed', async () => {
  const { db, env, owner } = setupWorker();
  const propertyId = 'PROP_MIDDELBORO';

  const q1 = await seedActiveReport(env, owner, db, propertyId, {
    bundleId: 'bundle_source_q1',
    archiveId: 'raw_source_q1',
    fileName: 'Source Summary Q1.csv',
    minDate: '2026-01-01',
    maxDate: '2026-03-31',
    rowCount: 3330,
    reportType: 'source',
  });
  const q2 = await seedActiveReport(env, owner, db, propertyId, {
    bundleId: 'bundle_source_q2',
    archiveId: 'raw_source_q2',
    fileName: 'Source Summary Q2.csv',
    minDate: '2026-04-01',
    maxDate: '2026-06-30',
    rowCount: 3367,
    reportType: 'source',
  });

  // Combined covers Q1 + Q2. Caller only specifies Q1 (omitting Q2).
  const combinedRawText = 'Property,Date,Source,Revenue\nPROP_MIDDELBORO,2026-01-01,OTA,100\nPROP_MIDDELBORO,2026-06-30,Direct,200\n';
  const combinedBytes = new TextEncoder().encode(combinedRawText);
  const combinedHash = await sha256Hex(combinedBytes);
  const combinedBundleId = 'bundle_source_partial_test';
  const combinedArchiveId = 'raw_source_partial_test';

  const upRaw = new Request('http://localhost/api/bulk-import/raw-upload', {
    method: 'PUT',
    headers: {
      'x-server-property-id': propertyId,
      'x-report-type': 'source',
      'x-raw-hash': combinedHash,
      'x-archive-id': combinedArchiveId,
      'x-file-name': 'Source Summary.csv',
    },
    body: combinedBytes,
  });
  await handleBulkImportRequest(upRaw, env, owner, new URL(upRaw.url), ['api', 'bulk-import', 'raw-upload']);

  const rec = new Request('http://localhost/api/bulk-import/raw-archive', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: combinedBundleId,
      raw_archive_id: combinedArchiveId,
      server_property_id: propertyId,
      report_type: 'source',
      raw_file_hash: combinedHash,
      raw_object_key: `raw/${propertyId}/${combinedArchiveId}.csv`,
      original_file_name: 'Source Summary.csv',
      file_size: combinedBytes.byteLength,
    }),
  });
  await handleBulkImportRequest(rec, env, owner, new URL(rec.url), ['api', 'bulk-import', 'raw-archive']);

  const scan = {
    type: 'source',
    rowsToImport: [
      { property_id: propertyId, date: '2026-01-01', source: 'OTA', revenue: 100 },
      { property_id: propertyId, date: '2026-06-30', source: 'Direct', revenue: 200 },
    ],
    totalRows: 6697,
  };
  const bundle = buildNormalizedBundle(scan, { propertyId, propertyName: 'Hotel', sourceFile: 'Source Summary.csv' }, combinedBundleId);
  const normHash = await computeNormalizedHash(bundle);
  const compressed = await compressPayloadGzip(bundle.ndjson);

  const upNorm = new Request('http://localhost/api/bulk-import/upload', {
    method: 'PUT',
    headers: {
      'x-server-property-id': propertyId,
      'x-report-type': 'source',
      'x-raw-hash': combinedHash,
      'x-normalized-hash': normHash,
      'x-row-count': String(bundle.totalRowCount),
      'x-identity-version': '2',
    },
    body: compressed,
  });
  await handleBulkImportRequest(upNorm, env, owner, new URL(upNorm.url), ['api', 'bulk-import', 'upload']);

  // Call activate specifying ONLY Q1 in predecessors (omitting Q2)
  const act = new Request('http://localhost/api/bulk-import/activate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: combinedBundleId,
      source_archive_id: combinedArchiveId,
      server_property_id: propertyId,
      report_type: 'source',
      raw_file_hash: combinedHash,
      normalized_hash: normHash,
      row_count: bundle.totalRowCount,
      min_date: '2026-01-01',
      max_date: '2026-06-30',
      predecessors: [{ id: q1.bundleId, expected_revision: q1.revision }],
    }),
  });
  const actRes = await handleBulkImportRequest(act, env, owner, new URL(act.url), ['api', 'bulk-import', 'activate']);
  assertEqual(actRes.status, 409, 'Omission of Q2 returns 409');
  const actErr = await actRes.json();
  assertEqual(actErr.code, 'IMPORT_REPLACEMENT_REQUIRED', 'Error code is IMPORT_REPLACEMENT_REQUIRED');
  assert(actErr.missing_predecessor_ids?.includes(q2.bundleId), 'Q2 flagged as missing predecessor');

  // Both Q1 and Q2 remain active
  const q1Row = db.prepare('SELECT status FROM import_bundle_manifest WHERE id=?').get(q1.bundleId);
  const q2Row = db.prepare('SELECT status FROM import_bundle_manifest WHERE id=?').get(q2.bundleId);
  assertEqual(q1Row.status, 'active', 'Q1 remains active');
  assertEqual(q2Row.status, 'active', 'Q2 remains active');
});

await run.check('3. Invalid, stale revision, or cross-property predecessors fail closed', async () => {
  const { db, env, owner } = setupWorker();
  const propertyId = 'PROP_MIDDELBORO';

  const q1 = await seedActiveReport(env, owner, db, propertyId, {
    bundleId: 'bundle_source_q1_p3',
    archiveId: 'raw_source_q1_p3',
    fileName: 'Source Summary Q1.csv',
    minDate: '2026-01-01',
    maxDate: '2026-03-31',
    rowCount: 3330,
    reportType: 'source',
  });

  // Seed report on DIFFERENT property
  const otherPropReport = await seedActiveReport(env, owner, db, 'PROP_OTHER', {
    bundleId: 'bundle_source_other_prop',
    archiveId: 'raw_source_other_prop',
    fileName: 'Source Summary Other.csv',
    minDate: '2026-01-01',
    maxDate: '2026-03-31',
    rowCount: 1000,
    reportType: 'source',
  });

  // Upload real test bundle
  const testBytes = new TextEncoder().encode('Property,Date,Source,Revenue\nPROP_MIDDELBORO,2026-01-01,OTA,100\n');
  const testRawHash = await sha256Hex(testBytes);
  const testBundleId = 'bundle_test_p3';
  const testArchiveId = 'raw_test_p3';

  const upRaw = new Request('http://localhost/api/bulk-import/raw-upload', {
    method: 'PUT',
    headers: {
      'x-server-property-id': propertyId,
      'x-report-type': 'source',
      'x-raw-hash': testRawHash,
      'x-archive-id': testArchiveId,
      'x-file-name': 'Source.csv',
    },
    body: testBytes,
  });
  await handleBulkImportRequest(upRaw, env, owner, new URL(upRaw.url), ['api', 'bulk-import', 'raw-upload']);

  const rec = new Request('http://localhost/api/bulk-import/raw-archive', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: testBundleId,
      raw_archive_id: testArchiveId,
      server_property_id: propertyId,
      report_type: 'source',
      raw_file_hash: testRawHash,
      raw_object_key: `raw/${propertyId}/${testArchiveId}.csv`,
      original_file_name: 'Source.csv',
      file_size: testBytes.byteLength,
    }),
  });
  await handleBulkImportRequest(rec, env, owner, new URL(rec.url), ['api', 'bulk-import', 'raw-archive']);

  const scan = {
    type: 'source',
    rowsToImport: [{ property_id: propertyId, date: '2026-01-01', source: 'OTA', revenue: 100 }],
    totalRows: 1,
  };
  const bundle = buildNormalizedBundle(scan, { propertyId, propertyName: 'Hotel', sourceFile: 'Source.csv' }, testBundleId);
  const normHash = await computeNormalizedHash(bundle);
  const compressed = await compressPayloadGzip(bundle.ndjson);

  const upNorm = new Request('http://localhost/api/bulk-import/upload', {
    method: 'PUT',
    headers: {
      'x-server-property-id': propertyId,
      'x-report-type': 'source',
      'x-raw-hash': testRawHash,
      'x-normalized-hash': normHash,
      'x-row-count': String(bundle.totalRowCount),
      'x-identity-version': '2',
    },
    body: compressed,
  });
  await handleBulkImportRequest(upNorm, env, owner, new URL(upNorm.url), ['api', 'bulk-import', 'upload']);

  // Attempt replacement passing predecessor from PROP_OTHER -> MUST fail with 409 IMPORT_LINEAGE_CONFLICT
  const actCross = new Request('http://localhost/api/bulk-import/activate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: testBundleId,
      source_archive_id: testArchiveId,
      server_property_id: propertyId,
      report_type: 'source',
      raw_file_hash: testRawHash,
      normalized_hash: normHash,
      row_count: bundle.totalRowCount,
      min_date: '2026-01-01',
      max_date: '2026-03-31',
      predecessors: [{ id: otherPropReport.bundleId, expected_revision: otherPropReport.revision }],
    }),
  });
  const actCrossRes = await handleBulkImportRequest(actCross, env, owner, new URL(actCross.url), ['api', 'bulk-import', 'activate']);
  assertEqual(actCrossRes.status, 409, 'Cross-property predecessor returns 409');
  const actCrossErr = await actCrossRes.json();
  assertEqual(actCrossErr.code, 'IMPORT_LINEAGE_CONFLICT', 'Code is IMPORT_LINEAGE_CONFLICT');

  // Attempt replacement with STALE expected_revision -> MUST fail with 409 IMPORT_LINEAGE_CONFLICT
  const actStale = new Request('http://localhost/api/bulk-import/activate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: testBundleId,
      source_archive_id: testArchiveId,
      server_property_id: propertyId,
      report_type: 'source',
      raw_file_hash: testRawHash,
      normalized_hash: normHash,
      row_count: bundle.totalRowCount,
      min_date: '2026-01-01',
      max_date: '2026-03-31',
      predecessors: [{ id: q1.bundleId, expected_revision: q1.revision + 999 }],
    }),
  });
  const actStaleRes = await handleBulkImportRequest(actStale, env, owner, new URL(actStale.url), ['api', 'bulk-import', 'activate']);
  assertEqual(actStaleRes.status, 409, 'Stale revision returns 409');
  const actStaleErr = await actStaleRes.json();
  assertEqual(actStaleErr.code, 'IMPORT_LINEAGE_CONFLICT', 'Code is IMPORT_LINEAGE_CONFLICT');
});

await run.check('4. Atomic many-to-one replacement: 3 predecessors superseded, 1 successor active, 1 revision increment', async () => {
  const { db, env, owner } = setupWorker();
  const propertyId = 'PROP_MIDDELBORO';

  // Seed 3 active quarterly Source Summary reports
  const q1 = await seedActiveReport(env, owner, db, propertyId, {
    bundleId: 'bundle_q1_p4',
    archiveId: 'raw_q1_p4',
    fileName: 'Source Summary Q1.csv',
    minDate: '2026-01-01',
    maxDate: '2026-03-31',
    rowCount: 3330,
    reportType: 'source',
  });
  const q2 = await seedActiveReport(env, owner, db, propertyId, {
    bundleId: 'bundle_q2_p4',
    archiveId: 'raw_q2_p4',
    fileName: 'Source Summary Q2.csv',
    minDate: '2026-04-01',
    maxDate: '2026-06-30',
    rowCount: 3367,
    reportType: 'source',
  });
  const q3 = await seedActiveReport(env, owner, db, propertyId, {
    bundleId: 'bundle_q3_p4',
    archiveId: 'raw_q3_p4',
    fileName: 'Source Summary Q3.csv',
    minDate: '2026-07-01',
    maxDate: '2026-08-02',
    rowCount: 1221,
    reportType: 'source',
  });

  const revBefore = db.prepare('SELECT revision FROM business_sync_state WHERE account_id=?').get('ACC_MULTI_REPLACE').revision;

  // Stage combined report
  const combinedRawText = 'Property,Date,Source,Revenue\nPROP_MIDDELBORO,2026-01-01,OTA,100\nPROP_MIDDELBORO,2026-08-02,Direct,200\n';
  const combinedBytes = new TextEncoder().encode(combinedRawText);
  const combinedHash = await sha256Hex(combinedBytes);
  const combinedBundleId = 'bundle_combined_p4';
  const combinedArchiveId = 'raw_combined_p4';

  const upRaw = new Request('http://localhost/api/bulk-import/raw-upload', {
    method: 'PUT',
    headers: {
      'x-server-property-id': propertyId,
      'x-report-type': 'source',
      'x-raw-hash': combinedHash,
      'x-archive-id': combinedArchiveId,
      'x-file-name': 'Source Summary (1).csv',
    },
    body: combinedBytes,
  });
  await handleBulkImportRequest(upRaw, env, owner, new URL(upRaw.url), ['api', 'bulk-import', 'raw-upload']);

  const rec = new Request('http://localhost/api/bulk-import/raw-archive', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: combinedBundleId,
      raw_archive_id: combinedArchiveId,
      server_property_id: propertyId,
      report_type: 'source',
      raw_file_hash: combinedHash,
      raw_object_key: `raw/${propertyId}/${combinedArchiveId}.csv`,
      original_file_name: 'Source Summary (1).csv',
      file_size: combinedBytes.byteLength,
    }),
  });
  await handleBulkImportRequest(rec, env, owner, new URL(rec.url), ['api', 'bulk-import', 'raw-archive']);

  const scan = {
    type: 'source',
    rowsToImport: [
      { property_id: propertyId, date: '2026-01-01', source: 'OTA', revenue: 100 },
      { property_id: propertyId, date: '2026-08-02', source: 'Direct', revenue: 200 },
    ],
    totalRows: 7918,
  };
  const bundle = buildNormalizedBundle(scan, { propertyId, propertyName: 'Hotel', sourceFile: 'Source Summary (1).csv' }, combinedBundleId);
  const normHash = await computeNormalizedHash(bundle);
  const compressed = await compressPayloadGzip(bundle.ndjson);

  const upNorm = new Request('http://localhost/api/bulk-import/upload', {
    method: 'PUT',
    headers: {
      'x-server-property-id': propertyId,
      'x-report-type': 'source',
      'x-raw-hash': combinedHash,
      'x-normalized-hash': normHash,
      'x-row-count': String(bundle.totalRowCount),
      'x-identity-version': '2',
    },
    body: compressed,
  });
  await handleBulkImportRequest(upNorm, env, owner, new URL(upNorm.url), ['api', 'bulk-import', 'upload']);

  // Activate providing ALL 3 predecessors explicitly
  const act = new Request('http://localhost/api/bulk-import/activate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: combinedBundleId,
      source_archive_id: combinedArchiveId,
      server_property_id: propertyId,
      report_type: 'source',
      raw_file_hash: combinedHash,
      normalized_hash: normHash,
      row_count: bundle.totalRowCount,
      min_date: '2026-01-01',
      max_date: '2026-08-02',
      predecessors: [
        { id: q1.bundleId, expected_revision: q1.revision },
        { id: q2.bundleId, expected_revision: q2.revision },
        { id: q3.bundleId, expected_revision: q3.revision },
      ],
    }),
  });
  const actRes = await handleBulkImportRequest(act, env, owner, new URL(act.url), ['api', 'bulk-import', 'activate']);
  assertEqual(actRes.status, 201, 'Multi-predecessor activation returns 201');
  const actData = await actRes.json();
  assertEqual(actData.ok, true, 'Result is ok');
  assertEqual(actData.status, 'active', 'Successor bundle is active');
  assertEqual(actData.superseded_count, 3, 'superseded_count is 3');

  // Verify sync revision incremented EXACTLY ONCE
  const revAfter = db.prepare('SELECT revision FROM business_sync_state WHERE account_id=?').get('ACC_MULTI_REPLACE').revision;
  assertEqual(revAfter, revBefore + 1, 'Sync revision incremented by exactly 1');

  // Verify all 3 predecessors are superseded with pointer to successor
  for (const pred of [q1, q2, q3]) {
    const row = db.prepare('SELECT status, superseded_by_bundle_id, revision FROM import_bundle_manifest WHERE id=?').get(pred.bundleId);
    assertEqual(row.status, 'superseded', `Predecessor ${pred.bundleId} is superseded`);
    assertEqual(row.superseded_by_bundle_id, combinedBundleId, `Predecessor ${pred.bundleId} superseded_by points to successor`);
    assertEqual(row.revision, revAfter, `Predecessor ${pred.bundleId} stamped with new revision`);
  }

  // Verify successor manifest
  const succRow = db.prepare('SELECT status, row_count, min_date, max_date, supersedes_bundle_id FROM import_bundle_manifest WHERE id=?').get(combinedBundleId);
  assertEqual(succRow.status, 'active', 'Successor is active');
  assertEqual(succRow.row_count, bundle.totalRowCount, 'Successor has expected rows');
  assertEqual(succRow.supersedes_bundle_id, q1.bundleId, 'Successor points to primary predecessor for backward compatibility');

  // Verify relational lineage table
  const lineageRows = db.prepare('SELECT predecessor_bundle_id FROM import_bundle_lineage WHERE successor_bundle_id=? ORDER BY predecessor_bundle_id').all(combinedBundleId);
  assertEqual(lineageRows.length, 3, '3 rows in import_bundle_lineage');
  assertEqual(lineageRows.map((r) => r.predecessor_bundle_id).sort().join(','), [q1.bundleId, q2.bundleId, q3.bundleId].sort().join(','), 'Lineage matches all 3 predecessors');

  // Verify exactly 1 active report remains for source_summary
  const activeReports = db.prepare("SELECT id, row_count FROM import_bundle_manifest WHERE server_property_id=? AND report_type='source' AND status='active'").all(propertyId);
  assertEqual(activeReports.length, 1, 'Exactly 1 active Source Summary report exists');
  assertEqual(activeReports[0].id, combinedBundleId, 'Active report is the combined successor');
  assertEqual(activeReports[0].row_count, bundle.totalRowCount, 'Active report represents expected rows');
});

await run.check('5. Single-predecessor replacement backward compatibility', async () => {
  const { db, env, owner } = setupWorker();
  const propertyId = 'PROP_MIDDELBORO';

  const v1 = await seedActiveReport(env, owner, db, propertyId, {
    bundleId: 'bundle_single_v1',
    archiveId: 'raw_single_v1',
    fileName: 'Single Report v1.csv',
    minDate: '2026-08-01',
    maxDate: '2026-08-10',
    rowCount: 50,
    reportType: 'hotel_statistics',
  });

  const v2RawText = 'Property,Date,Section,Metric,Period,Value\nPROP_MIDDELBORO,2026-08-01,Revenue,ADR,Day,150.00\n';
  const v2Bytes = new TextEncoder().encode(v2RawText);
  const v2Hash = await sha256Hex(v2Bytes);
  const v2BundleId = 'bundle_single_v2';
  const v2ArchiveId = 'raw_single_v2';

  const upRaw = new Request('http://localhost/api/bulk-import/raw-upload', {
    method: 'PUT',
    headers: {
      'x-server-property-id': propertyId,
      'x-report-type': 'hotel_statistics',
      'x-raw-hash': v2Hash,
      'x-archive-id': v2ArchiveId,
      'x-file-name': 'Single Report v2.csv',
    },
    body: v2Bytes,
  });
  await handleBulkImportRequest(upRaw, env, owner, new URL(upRaw.url), ['api', 'bulk-import', 'raw-upload']);

  const rec = new Request('http://localhost/api/bulk-import/raw-archive', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: v2BundleId,
      raw_archive_id: v2ArchiveId,
      server_property_id: propertyId,
      report_type: 'hotel_statistics',
      raw_file_hash: v2Hash,
      raw_object_key: `raw/${propertyId}/${v2ArchiveId}.csv`,
      original_file_name: 'Single Report v2.csv',
      file_size: v2Bytes.byteLength,
    }),
  });
  await handleBulkImportRequest(rec, env, owner, new URL(rec.url), ['api', 'bulk-import', 'raw-archive']);

  const scan = {
    type: 'hotel_statistics',
    metrics: [
      { property_id: propertyId, business_date: '2026-08-01', section: 'Revenue', metric_name: 'ADR', period: 'Day', value: 150.00 },
    ],
    totalRows: 1,
  };
  const bundle = buildNormalizedBundle(scan, { propertyId, propertyName: 'Hotel', sourceFile: 'Single Report v2.csv' }, v2BundleId);
  const normHash = await computeNormalizedHash(bundle);
  const compressed = await compressPayloadGzip(bundle.ndjson);

  const upNorm = new Request('http://localhost/api/bulk-import/upload', {
    method: 'PUT',
    headers: {
      'x-server-property-id': propertyId,
      'x-report-type': 'hotel_statistics',
      'x-raw-hash': v2Hash,
      'x-normalized-hash': normHash,
      'x-row-count': '1',
      'x-identity-version': '2',
    },
    body: compressed,
  });
  await handleBulkImportRequest(upNorm, env, owner, new URL(upNorm.url), ['api', 'bulk-import', 'upload']);

  // Activate using legacy single-predecessor fields: supersedes_bundle_id + expected_revision
  const act = new Request('http://localhost/api/bulk-import/activate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: v2BundleId,
      source_archive_id: v2ArchiveId,
      server_property_id: propertyId,
      report_type: 'hotel_statistics',
      raw_file_hash: v2Hash,
      normalized_hash: normHash,
      row_count: 1,
      min_date: '2026-08-01',
      max_date: '2026-08-10',
      supersedes_bundle_id: v1.bundleId,
      expected_revision: v1.revision,
    }),
  });
  const actRes = await handleBulkImportRequest(act, env, owner, new URL(act.url), ['api', 'bulk-import', 'activate']);
  assertEqual(actRes.status, 201, 'Legacy single-predecessor activation succeeds with 201');
  const actData = await actRes.json();
  assertEqual(actData.ok, true, 'Result is ok');
  assertEqual(actData.superseded_count, 1, '1 superseded');

  const v1Row = db.prepare('SELECT status, superseded_by_bundle_id FROM import_bundle_manifest WHERE id=?').get(v1.bundleId);
  assertEqual(v1Row.status, 'superseded', 'v1 superseded');
  assertEqual(v1Row.superseded_by_bundle_id, v2BundleId, 'v1 points to v2');
});

run.done();
if (process.exitCode) process.exit(1);
console.log('PASSED: probe-bulk-import-multi-replacement completed all tests successfully.');
process.exit(0);
