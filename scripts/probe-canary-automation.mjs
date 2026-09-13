// scripts/probe-canary-automation.mjs
// Comprehensive local verification suite for RRI Canary Automation Harness.
// Tests production guard, dry-run safety, secret redaction, deterministic fixtures,
// cleanup registry, telemetry tagging, and end-to-end local mock execution.

import './_loader-boot.mjs';
import 'fake-indexeddb/auto';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  assertNotProductionTarget,
  assertIsolationConfirmed,
  assertSafeCanaryEnvironment,
  redactSecrets,
  ProductionGuardError,
} from './canary/production-guard.mjs';
import {
  createRng,
  generateSyntheticCsv,
  generateFixtureWithOracle,
  REPORT_TYPES,
} from './canary/fixture-generator.mjs';
import { CleanupRegistry } from './canary/cleanup-registry.mjs';
import { CanaryClient, CanaryApiError } from './canary/canary-client.mjs';
import { runCanary } from './canary-bulk-import.mjs';
import { makeInstrumentedEnv, scopeAll } from './_worker-testkit.mjs';
import { clearMockStore, testR2Binding } from './_r2-testkit.mjs';
import { handleBulkImportRequest } from '../worker/bulk-import.js';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}

function assertEqual(actual, expected, message) {
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
}

function assertThrows(fn, expectedCode, message) {
  try {
    fn();
    failed++;
    console.error(`  FAIL: Expected exception was not thrown: ${message}`);
  } catch (err) {
    if (expectedCode && err?.code !== expectedCode) {
      failed++;
      console.error(`  FAIL: Wrong error code for ${message} (expected ${expectedCode}, got ${err?.code})`);
    } else {
      passed++;
    }
  }
}

async function runTests() {
  console.log('=== PROBE: CANARY AUTOMATION HARNESS & SAFETY GUARDS ===\n');

  // ── 1. Production Target Guard Rejections ───────────────────────────────────
  console.log('1. Production Guard URL & Resource Rejections');
  const forbiddenUrls = [
    'https://boston-project.divyesh-boston.workers.dev',
    'https://boston-project.divyesh-boston.workers.dev/',
    'https://boston-project.divyesh-boston.workers.dev/api/bulk-import/manifest',
    'https://BOSTON-PROJECT.divyesh-boston.workers.dev:443',
    'http://boston-project.divyesh-boston.workers.dev:8787/api',
    'boston-project.divyesh-boston.workers.dev',
  ];

  for (const url of forbiddenUrls) {
    assertThrows(
      () => assertNotProductionTarget({ url }),
      'PRODUCTION_TARGET_FORBIDDEN',
      `rejects production host: ${url}`
    );
  }

  // Allowed canary URLs
  const allowedUrls = [
    'https://rri-bulk-canary-a61a110.divyesh-boston.workers.dev',
    'http://localhost:8787',
    'http://127.0.0.1:8787',
  ];
  for (const url of allowedUrls) {
    try {
      assertNotProductionTarget({ url });
      passed++;
    } catch (err) {
      failed++;
      console.error(`  FAIL: Erroneously rejected allowed canary URL: ${url}`);
    }
  }

  // Reject production services, D1 names and IDs
  assertThrows(
    () => assertNotProductionTarget({ service: 'boston-project' }),
    'PRODUCTION_TARGET_FORBIDDEN',
    'rejects production service name'
  );
  assertThrows(
    () => assertNotProductionTarget({ service: 'BOSTON-PROJECT' }),
    'PRODUCTION_TARGET_FORBIDDEN',
    'rejects uppercase production service name'
  );
  assertThrows(
    () => assertNotProductionTarget({ d1Name: 'boston-project-production-auth' }),
    'PRODUCTION_TARGET_FORBIDDEN',
    'rejects production D1 database name'
  );
  assertThrows(
    () => assertNotProductionTarget({ d1Id: 'e9008126-d4b4-4588-841c-128eadd94c8d' }),
    'PRODUCTION_TARGET_FORBIDDEN',
    'rejects production D1 database ID'
  );

  // ── 2. Isolation Confirmation Flag ─────────────────────────────────────────
  console.log('2. Isolation Confirmation Guard');
  assertThrows(
    () => assertIsolationConfirmed({}),
    'ISOLATION_CONFIRMATION_REQUIRED',
    'rejects when CANARY_CONFIRM_ISOLATED is missing'
  );
  assertThrows(
    () => assertIsolationConfirmed({ CANARY_CONFIRM_ISOLATED: 'true' }),
    'ISOLATION_CONFIRMATION_REQUIRED',
    'rejects when CANARY_CONFIRM_ISOLATED is not "YES"'
  );
  assertThrows(
    () => assertIsolationConfirmed({ CANARY_CONFIRM_ISOLATED: 'yes' }),
    'ISOLATION_CONFIRMATION_REQUIRED',
    'rejects lowercase "yes"'
  );
  try {
    assertIsolationConfirmed({ CANARY_CONFIRM_ISOLATED: 'YES' });
    passed++;
  } catch {
    failed++;
    console.error('  FAIL: Rejected valid CANARY_CONFIRM_ISOLATED=YES');
  }

  // Set isolation flag for local probe harness tests
  process.env.CANARY_CONFIRM_ISOLATED = 'YES';

  // ── 3. Secret Redaction ───────────────────────────────────────────────────
  console.log('3. Secret Redaction Invariant');
  const secretStr = 'curl -H "Authorization: Bearer super_secret_jwt_token_12345" -H "Cookie: session_id=secret_cookie_abcdef"';
  const redactedStr = redactSecrets(secretStr);
  assert(!redactedStr.includes('super_secret_jwt_token_12345'), 'redacts Bearer JWT');
  assert(!redactedStr.includes('secret_cookie_abcdef'), 'redacts Cookie value');
  assert(redactedStr.includes('[REDACTED]'), 'inserts [REDACTED] marker');

  const secretObj = {
    url: 'https://canary.example.com',
    headers: {
      Authorization: 'Bearer test_token_xyz',
      Cookie: '__Host-session=val123; other=val456',
      'Content-Type': 'application/json',
    },
    ['api' + '_key']: 'test_masked_key_value',
  };
  const redactedObj = redactSecrets(secretObj);
  assertEqual(redactedObj.headers.Authorization, '[REDACTED]', 'redacts Authorization header');
  assertEqual(redactedObj.headers.Cookie, '[REDACTED]', 'redacts Cookie header');
  assertEqual(redactedObj.api_key, '[REDACTED]', 'redacts api_key property');
  assertEqual(redactedObj.headers['Content-Type'], 'application/json', 'preserves safe headers');

  // ── 4. Deterministic Fixture Generator & All 9 Report Families ─────────────
  console.log('4. Deterministic Fixture Generator');
  assertEqual(REPORT_TYPES.length, 9, 'covers all 9 HotelKey report families');

  for (const reportType of REPORT_TYPES) {
    const { rawCsv, scanResult, rowCount } = generateSyntheticCsv(reportType, 4, { seed: 42 });
    assert(typeof rawCsv === 'string' && rawCsv.length > 0, `generates CSV for ${reportType}`);
    assertEqual(rowCount, 4, `generates exact row count for ${reportType}`);
    assertEqual(scanResult.type, reportType, `scanResult type matches ${reportType}`);

    // Determinism test: same seed must produce exact identical CSV
    const repeat = generateSyntheticCsv(reportType, 4, { seed: 42 });
    assertEqual(repeat.rawCsv, rawCsv, `deterministic CSV across runs for ${reportType}`);
  }

  // ── 5. Ugly CSV Edge Cases ────────────────────────────────────────────────
  console.log('5. Ugly CSV Edge Cases');
  // BOM
  const bomFixture = generateSyntheticCsv('transactions', 2, { bom: true });
  assert(bomFixture.rawCsv.startsWith('\uFEFF'), 'prepends UTF-8 BOM');

  // Quoted commas and escaped quotes
  const quotedFixture = generateSyntheticCsv('transactions', 6, {
    quotedCommas: true,
    escapedQuotes: true,
    newlinesInQuotes: true,
    negativeAmounts: true,
  });
  assert(quotedFixture.rawCsv.includes('"'), 'contains quoted fields');
  assert(quotedFixture.rawCsv.includes('-$') || quotedFixture.rawCsv.includes('$-'), 'contains negative amounts');

  // ── 6. Expected Oracle & Canonical Keys ────────────────────────────────────
  console.log('6. Fixture Oracle & Canonical Keys');
  const oracleFixture = await generateFixtureWithOracle({
    reportType: 'payments',
    rowCount: 3,
    accountId: 'acc-canary-99',
    propertyId: 'prop-canary-88',
  });
  assertEqual(
    oracleFixture.rawCanonicalKey,
    `rri-raw/acc-canary-99/prop-canary-88/${oracleFixture.rawSha256}`,
    'canonical raw key matches rri-raw/<account>/<property>/<hash>'
  );
  assertEqual(
    oracleFixture.bundleCanonicalKey,
    `rri-data/acc-canary-99/prop-canary-88/${oracleFixture.normalizedHash}`,
    'canonical bundle key matches rri-data/<account>/<property>/<hash>'
  );
  assert(oracleFixture.compressedBundle.byteLength > 0, 'compresses bundle to gzip buffer');
  assertEqual(oracleFixture.rowCount, 3, 'oracle row count matches');

  // ── 7. Dry-Run Zero Network Dispatches Invariant ──────────────────────────
  console.log('7. Dry-Run Zero Network Calls Invariant');
  const dryClient = new CanaryClient({
    baseUrl: 'https://rri-bulk-canary-a61a110.divyesh-boston.workers.dev',
    dryRun: true,
  });
  await dryClient.preflight();
  await dryClient.uploadRawArchive({
    serverPropertyId: 'prop-1',
    reportType: 'payments',
    rawFileHash: 'a'.repeat(64),
    rawBytes: new Uint8Array([1, 2, 3]),
  });
  await dryClient.recordRawArchive({
    serverPropertyId: 'prop-1',
    reportType: 'payments',
    rawFileHash: 'a'.repeat(64),
  });
  assertEqual(dryClient.requestsDispatched, 0, 'dry-run client dispatches exactly 0 network requests');
  assertEqual(dryClient.plannedRequests.length, 3, 'dry-run client records planned requests');

  // Dry-run orchestrator test
  const dryOrchestrator = await runCanary({
    dryRun: true,
    all: true,
    target: 'https://rri-bulk-canary-a61a110.divyesh-boston.workers.dev',
    property: 'prop-test',
    account: 'acc-test',
  });
  assertEqual(dryOrchestrator.verdict, 'PASS (DRY_RUN)', 'dry-run orchestrator reports PASS (DRY_RUN)');
  assertEqual(dryOrchestrator.telemetry.requests_dispatched.value, 0, 'orchestrator dispatches 0 requests in dry run');

  // ── 8. Cleanup Registry Scoped Tracking & Safety ──────────────────────────
  console.log('8. Cleanup Registry');
  const reg = new CleanupRegistry('canary-test-run-1');
  assertEqual(reg.runId, 'canary-test-run-1', 'preserves runId');
  reg.trackRawKey('rri-raw/a/p/hash1');
  reg.trackBundleKey('rri-data/a/p/hash2');
  reg.trackBundleId('bundle-123');
  reg.trackArchiveId('archive-456');

  // Simulated cleanup with mock client
  const mockCleanClient = {
    deletedBundles: [],
    destroyedArchives: [],
    async deleteBundle(id) {
      this.deletedBundles.push(id);
      return { ok: true };
    },
    async destroyRawArchive({ archiveId }) {
      this.destroyedArchives.push(archiveId);
      return { ok: true };
    },
  };
  const cleanRes = await reg.runCleanup(mockCleanClient);
  assertEqual(cleanRes.verdict, 'CLEAN', 'cleanup succeeds with CLEAN verdict');
  assertEqual(cleanRes.deleted, 2, 'swept both bundle and archive');
  assertEqual(cleanRes.remainingKeys.length, 0, 'zero remaining keys after full sweep');

  // ── 9. Telemetry Classification Tags ──────────────────────────────────────
  console.log('9. Telemetry Classification Tags');
  const validTags = new Set([
    'REAL_CLOUDFLARE_MEASURED',
    'LOCAL_SQLITE_MEASURED',
    'MODELED',
    'ESTIMATED',
    'UNMEASURED',
  ]);

  for (const [k, metric] of Object.entries(dryOrchestrator.telemetry)) {
    assert(
      validTags.has(metric.classification),
      `telemetry ${k} has valid classification: ${metric.classification}`
    );
  }
  assertEqual(
    dryOrchestrator.telemetry.full_import_d1_writes.classification,
    'UNMEASURED',
    'full_import_d1_writes is strictly UNMEASURED prior to Cloudflare execution'
  );

  // ── 10. Local Mock Server End-to-End Simulation ───────────────────────────
  console.log('10. Local Mock Worker End-to-End Execution');
  clearMockStore();
  const db = new DatabaseSync(':memory:');
  try {
    const migrationFiles = readdirSync(new URL('../migrations-production/', import.meta.url))
      .filter((n) => n.endsWith('.sql'))
      .sort();
    for (const name of migrationFiles) {
      db.exec(readFileSync(new URL(`../migrations-production/${name}`, import.meta.url), 'utf8'));
    }
    db.prepare('INSERT INTO account(id,name,created_date) VALUES(?,?,?)').run('A_1', 'Canary Acc', '2026-09-13');
    db.prepare('INSERT INTO business_sync_state(account_id,revision) VALUES(?,0)').run('A_1');

    const env = makeInstrumentedEnv(db, {
      RAW_ARCHIVE: testR2Binding(),
      BULK_DATA: testR2Binding(),
    }).env;
    const scope = scopeAll(['canary-prop-1'], 'owner', 'A_1');

    const mockFetch = async (input, init) => {
      const request = new Request(new URL(String(input), 'http://localhost'), init);
      const routeUrl = new URL(request.url);
      const parts = routeUrl.pathname.split('/').filter(Boolean);
      return handleBulkImportRequest(request, env, scope, routeUrl, parts);
    };

    const mockOrchestratorResult = await runCanary({
      dryRun: false,
      all: true,
      target: 'http://localhost:8787',
      property: 'canary-prop-1',
      account: 'A_1',
      fetchImpl: mockFetch,
    });

    assertEqual(mockOrchestratorResult.verdict, 'PASS', 'end-to-end canary passes against local mock backend');
    assert(mockOrchestratorResult.stages.smoke?.ok === true, 'smoke stage passed locally');
    assert(mockOrchestratorResult.stages.import?.ok === true, 'import stage passed locally');
    assert(mockOrchestratorResult.stages.concurrency?.ok === true, 'concurrency stage passed locally');
    assert(mockOrchestratorResult.stages.hydration?.ok === true, 'hydration stage passed locally');
    assert(mockOrchestratorResult.stages.cleanup?.verdict === 'CLEAN', 'cleanup stage completed CLEAN locally');
    assert(mockOrchestratorResult.telemetry.requests_dispatched.value > 0, 'dispatched real requests to mock backend');
  } finally {
    db.close();
  }

  // ── Summary & Process Exit ────────────────────────────────────────────────
  console.log('\n--------------------------------------------------------------------------------');
  console.log(`${failed === 0 ? 'PASSED' : 'FAILED'}: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
