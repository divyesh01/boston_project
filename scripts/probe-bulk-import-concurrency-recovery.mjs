// scripts/probe-bulk-import-concurrency-recovery.mjs
// Verifies concurrent activation recovery under high concurrency / race collisions:
// 1. Two concurrent activations with identical content: one commits 201, loser re-evaluates and returns 200 already_active.
// 2. Two concurrent activations with different content & overlapping dates: one commits 201, loser re-evaluates and returns 409 IMPORT_REPLACEMENT_REQUIRED.
// 3. Two concurrent distinct activations (different reports or non-overlapping dates): both succeed with distinct sequential revisions.
// 4. End-to-end executeBulkImport concurrency: parallel raw uploads + parsing, deterministic activation resolution, zero IMPORT_REVISION_CONFLICT failures.
// 5. Strict preservation of D1 mutation guards: CHECK(ok=1), seq uniqueness, no duplicate activations.

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

const run = makeRunner('probe-bulk-import-concurrency-recovery');

function setupTest() {
  clearMockStore();
  const db = makeDb();
  db.prepare('INSERT OR IGNORE INTO account (id, name, created_date) VALUES (?, ?, ?)')
    .run('ACC_CONCURRENCY', 'Concurrency Test Account', '2026-01-01');
  seedUser(db, { id: 'user_owner', email: 'owner@test.local', role: 'owner', mode: 'all', accountId: 'ACC_CONCURRENCY' });
  db.prepare('INSERT OR IGNORE INTO property (id, account_id, code, name, rooms, address, city, state, phone, active, created_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('PROP_1', 'ACC_CONCURRENCY', 'P1', 'Hotel One', 100, '123 Main St', 'Boston', 'MA', '555-0100', 1, '2026-01-01');
  db.prepare('INSERT OR IGNORE INTO business_sync_state (account_id, revision) VALUES (?, ?)')
    .run('ACC_CONCURRENCY', 0);

  const rawStore = testR2Binding();
  const bulkStore = testR2Binding();
  const { env } = makeInstrumentedEnv(db, {
    ENABLE_BUSINESS_SYNC_API: 'true',
    RAW_ARCHIVE: rawStore,
    BULK_DATA: bulkStore,
  });
  const owner = scopeAll(['PROP_1']);
  owner.accountId = 'ACC_CONCURRENCY';
  owner.user.id = 'user_owner';
  owner.user.account_id = 'ACC_CONCURRENCY';

  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(url, 'http://localhost');
    const parts = u.pathname.replace(/^\/+/, '').split('/');
    const req = new Request(u.toString(), options);
    return await handleBulkImportRequest(req, env, owner, u, parts);
  };

  return { db, env, owner, rawStore, bulkStore };
}

await run.check('1. Concurrent duplicate activations: winner commits 201, loser re-evaluates to 200 already_active', async () => {
  const { env, owner, bulkStore } = setupTest();

  const hash = 'a'.repeat(64);
  const rawHash1 = '1'.repeat(64);
  const rawHash2 = '2'.repeat(64);

  // Store normalized bundle payload in bulkStore
  await bulkStore.put(`rri-bulk/ACC_CONCURRENCY/PROP_1/v1/${hash}.ndjson.gz`, new Uint8Array([1, 2, 3]), {
    customMetadata: {
      account_id: 'ACC_CONCURRENCY',
      server_property_id: 'PROP_1',
      normalized_hash: hash,
      report_type: 'hotel_statistics',
      min_date: '2026-08-08',
      max_date: '2026-08-08',
      row_count: '1',
      entity_counts_json: '{}',
      identity_version: '1',
    },
  });

  const body1 = {
    id: 'bundle_dup_1',
    server_property_id: 'PROP_1',
    report_type: 'hotel_statistics',
    normalized_hash: hash,
    raw_file_hash: rawHash1,
    row_count: 1,
    entity_counts: {},
  };
  const body2 = {
    id: 'bundle_dup_2',
    server_property_id: 'PROP_1',
    report_type: 'hotel_statistics',
    normalized_hash: hash,
    raw_file_hash: rawHash2,
    row_count: 1,
    entity_counts: {},
  };

  async function activate(body) {
    const req = new Request('http://localhost/api/bulk-import/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return await handleBulkImportRequest(req, env, owner, new URL(req.url), ['api', 'bulk-import', 'activate']);
  }

  const [res1, res2] = await Promise.all([activate(body1), activate(body2)]);
  const statuses = [res1.status, res2.status].sort();
  assertEqual(statuses[0], 200, 'Loser re-evaluates and returns 200 already_active');
  assertEqual(statuses[1], 201, 'Winner commits 201');

  const winnerData = res1.status === 201 ? await res1.json() : await res2.json();
  const dupData = res1.status === 200 ? await res1.json() : await res2.json();
  assertEqual(winnerData.status, 'active');
  assertEqual(dupData.status, 'already_active');
  assertEqual(dupData.bundle_id, winnerData.bundle_id);
});

await run.check('2. Concurrent overlapping activations: winner commits 201, loser re-evaluates to 409 IMPORT_REPLACEMENT_REQUIRED', async () => {
  const { env, owner, bulkStore } = setupTest();

  const h1 = '1'.repeat(64);
  const h2 = '2'.repeat(64);
  const r1 = '3'.repeat(64);
  const r2 = '4'.repeat(64);

  await bulkStore.put(`rri-bulk/ACC_CONCURRENCY/PROP_1/v1/${h1}.ndjson.gz`, new Uint8Array([1, 2, 3]), {
    customMetadata: {
      account_id: 'ACC_CONCURRENCY',
      server_property_id: 'PROP_1',
      normalized_hash: h1,
      report_type: 'hotel_statistics',
      min_date: '2026-08-08',
      max_date: '2026-08-08',
      row_count: '1',
      entity_counts_json: '{}',
      identity_version: '1',
    },
  });
  await bulkStore.put(`rri-bulk/ACC_CONCURRENCY/PROP_1/v1/${h2}.ndjson.gz`, new Uint8Array([4, 5, 6]), {
    customMetadata: {
      account_id: 'ACC_CONCURRENCY',
      server_property_id: 'PROP_1',
      normalized_hash: h2,
      report_type: 'hotel_statistics',
      min_date: '2026-08-08',
      max_date: '2026-08-08',
      row_count: '1',
      entity_counts_json: '{}',
      identity_version: '1',
    },
  });

  const body1 = {
    id: 'bundle_overlap_1',
    server_property_id: 'PROP_1',
    report_type: 'hotel_statistics',
    normalized_hash: h1,
    raw_file_hash: r1,
    row_count: 1,
    entity_counts: {},
  };
  const body2 = {
    id: 'bundle_overlap_2',
    server_property_id: 'PROP_1',
    report_type: 'hotel_statistics',
    normalized_hash: h2,
    raw_file_hash: r2,
    row_count: 1,
    entity_counts: {},
  };

  async function activate(body) {
    const req = new Request('http://localhost/api/bulk-import/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return await handleBulkImportRequest(req, env, owner, new URL(req.url), ['api', 'bulk-import', 'activate']);
  }

  const [res1, res2] = await Promise.all([activate(body1), activate(body2)]);
  const statuses = [res1.status, res2.status].sort();
  assertEqual(statuses[0], 201, 'One activation succeeds with 201');
  assertEqual(statuses[1], 409, 'Other activation returns 409 replacement required');

  const conflictRes = res1.status === 409 ? res1 : res2;
  const conflictData = await conflictRes.json();
  assertEqual(conflictData.code, 'IMPORT_REPLACEMENT_REQUIRED', 'Correct conflict code');
  assert(conflictData.existing_bundle_id, 'Provides existing active bundle ID');
  assert(conflictData.candidates?.length > 0, 'Provides candidates list');
});

await run.check('3. Concurrent distinct activations: both succeed with distinct sequential revisions', async () => {
  const { env, owner, bulkStore } = setupTest();

  const h1 = '5'.repeat(64);
  const h2 = '6'.repeat(64);
  const r1 = '7'.repeat(64);
  const r2 = '8'.repeat(64);

  // Two distinct non-overlapping reports (Gross Revenue and Occupancy)
  await bulkStore.put(`rri-bulk/ACC_CONCURRENCY/PROP_1/v1/${h1}.ndjson.gz`, new Uint8Array([1]), {
    customMetadata: {
      account_id: 'ACC_CONCURRENCY',
      server_property_id: 'PROP_1',
      normalized_hash: h1,
      report_type: 'gross_revenue',
      min_date: '2026-08-01',
      max_date: '2026-08-01',
      row_count: '1',
      entity_counts_json: '{}',
      identity_version: '1',
    },
  });
  await bulkStore.put(`rri-bulk/ACC_CONCURRENCY/PROP_1/v1/${h2}.ndjson.gz`, new Uint8Array([2]), {
    customMetadata: {
      account_id: 'ACC_CONCURRENCY',
      server_property_id: 'PROP_1',
      normalized_hash: h2,
      report_type: 'occupancy',
      min_date: '2026-08-01',
      max_date: '2026-08-01',
      row_count: '1',
      entity_counts_json: '{}',
      identity_version: '1',
    },
  });

  const body1 = {
    id: 'distinct_1',
    server_property_id: 'PROP_1',
    report_type: 'gross_revenue',
    normalized_hash: h1,
    raw_file_hash: r1,
    row_count: 1,
    entity_counts: {},
  };
  const body2 = {
    id: 'distinct_2',
    server_property_id: 'PROP_1',
    report_type: 'occupancy',
    normalized_hash: h2,
    raw_file_hash: r2,
    row_count: 1,
    entity_counts: {},
  };

  async function activate(body) {
    const req = new Request('http://localhost/api/bulk-import/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return await handleBulkImportRequest(req, env, owner, new URL(req.url), ['api', 'bulk-import', 'activate']);
  }

  const [res1, res2] = await Promise.all([activate(body1), activate(body2)]);
  assertEqual(res1.status, 201, 'First distinct report succeeds');
  assertEqual(res2.status, 201, 'Second distinct report succeeds');

  const d1 = await res1.json();
  const d2 = await res2.json();
  assertEqual(new Set([d1.revision, d2.revision]).size, 2, 'Distinct revisions allocated');
});

await run.check('4. Pipeline executeBulkImport concurrency: parallel pipeline with deterministic activation', async () => {
  const { db } = setupTest();

  // Create two scans for hotel_statistics: one for Hotel Statistics (1).csv and one for Hotel Statistics.csv
  const scan1 = {
    type: 'hotel_statistics',
    metrics: [{ date: '2026-08-08', metric: 'ADR', value: 100 }],
    totalRows: 1,
    minDate: '2026-08-08',
    maxDate: '2026-08-08',
  };
  const scan2 = {
    type: 'hotel_statistics',
    metrics: [{ date: '2026-08-08', metric: 'RevPAR', value: 95 }],
    totalRows: 1,
    minDate: '2026-08-08',
    maxDate: '2026-08-08',
  };

  const rawBytes1 = new TextEncoder().encode('hotel-stats-1-bytes');
  const rawBytes2 = new TextEncoder().encode('hotel-stats-2-bytes');

  const p1 = executeBulkImport(scan1, {
    propertyId: 'PROP_1',
    propertyName: 'Hotel One',
    sourceFile: 'Hotel Statistics (1).csv',
    rawBytes: rawBytes1,
  });
  const p2 = executeBulkImport(scan2, {
    propertyId: 'PROP_1',
    propertyName: 'Hotel One',
    sourceFile: 'Hotel Statistics.csv',
    rawBytes: rawBytes2,
  });

  const results = await Promise.allSettled([p1, p2]);
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');

  assertEqual(fulfilled.length, 1, 'Exactly one import succeeded');
  assertEqual(rejected.length, 1, 'Exactly one import was rejected with conflict');

  const error = rejected[0].reason;
  assertEqual(error.code, 'IMPORT_REPLACEMENT_REQUIRED', 'Error is IMPORT_REPLACEMENT_REQUIRED, NOT IMPORT_REVISION_CONFLICT');
  assert(error.existing_bundle_id, 'Carries existing bundle ID');
  assert(error.candidates?.length > 0, 'Carries replacement candidates');

  // Verify D1 state integrity: exactly 1 active manifest row
  const activeCount = db.prepare("SELECT COUNT(*) n FROM import_bundle_manifest WHERE status='active'").get().n;
  assertEqual(activeCount, 1, 'Exactly one active manifest row in D1');
});

await run.check('5. Pipeline executeBulkImport duplicate resolution: identical second import becomes duplicate cleanly', async () => {
  const { db } = setupTest();

  const scan = {
    type: 'payments',
    rowsToImport: [{ date: '2026-08-10', total: 500 }],
    totalRows: 1,
    minDate: '2026-08-10',
    maxDate: '2026-08-10',
  };
  const rawBytes = new TextEncoder().encode('same-content-bytes');

  const res1 = await executeBulkImport(scan, {
    propertyId: 'PROP_1',
    propertyName: 'Hotel One',
    sourceFile: 'payments.csv',
    rawBytes,
  });
  assertEqual(res1.duplicate, false, 'First import is not duplicate');
  assertEqual(res1.ok, true, 'First import succeeds');

  // Second import with identical content
  const res2 = await executeBulkImport(scan, {
    propertyId: 'PROP_1',
    propertyName: 'Hotel One',
    sourceFile: 'payments_copy.csv',
    rawBytes,
    forceImport: true, // force to test server-side duplicate resolution in activate
  });
  assertEqual(res2.duplicate, true, 'Second import is resolved as duplicate');
  assertEqual(res2.count, 0, 'Duplicate records 0 rows');
});

await run.check('6. D1 constraint and guard integrity: CHECK(ok=1) and seq uniqueness strictly preserved', async () => {
  const { db } = setupTest();

  // Ensure business_mutation_guard ok=1 constraint is intact
  let caughtGuardError = false;
  try {
    db.prepare('INSERT INTO business_mutation_guard(account_id, mutation_id, request_hash, ok, created_at) VALUES(?, ?, ?, 0, ?)')
      .run('ACC_CONCURRENCY', 'invalid_guard', 'hash', '2026-01-01');
  } catch (err) {
    caughtGuardError = /CHECK constraint failed: ok/.test(String(err));
  }
  assert(caughtGuardError, 'CHECK(ok=1) is strictly enforced on business_mutation_guard');

  // Ensure business_change unique seq constraint is intact
  let caughtSeqError = false;
  try {
    db.prepare(`INSERT INTO business_change(account_id, seq, generation_id, entity_name, record_key, server_property_id, operation, row_json, row_hash, mutation_id, request_hash, created_at)
      VALUES('ACC_CONCURRENCY', 1, 'gen', 'ImportBundle', 'key1', 'PROP_1', 'upsert', '{}', 'h1', 'm1', 'r1', '2026-01-01')`).run();
    db.prepare(`INSERT INTO business_change(account_id, seq, generation_id, entity_name, record_key, server_property_id, operation, row_json, row_hash, mutation_id, request_hash, created_at)
      VALUES('ACC_CONCURRENCY', 1, 'gen', 'ImportBundle', 'key2', 'PROP_1', 'upsert', '{}', 'h2', 'm2', 'r2', '2026-01-01')`).run();
  } catch (err) {
    caughtSeqError = /UNIQUE constraint failed: business_change\.account_id, business_change\.seq/.test(String(err));
  }
  assert(caughtSeqError, 'UNIQUE(account_id, seq) is strictly enforced on business_change');
});

run.done();
if (process.exitCode) process.exit(1);
console.log('PASSED: probe-bulk-import-concurrency-recovery completed all tests successfully.');
process.exit(0);
