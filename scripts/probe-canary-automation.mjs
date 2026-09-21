// scripts/probe-canary-automation.mjs
// Comprehensive local verification suite for RRI Canary Automation Harness.
// Tests production guard, dry-run safety, secret redaction, deterministic fixtures,
// cleanup registry, telemetry tagging, and end-to-end local mock execution.

import './_loader-boot.mjs';
import 'fake-indexeddb/auto';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import zlib from 'node:zlib';
import {
  assertNotProductionTarget,
  assertIsolationConfirmed,
  assertSafeCanaryEnvironment,
  validateTargetUrl,
  assertSafeRedirect,
  redactSecrets,
  ProductionGuardError,
} from './canary/production-guard.mjs';
import {
  createRng,
  generateSyntheticCsv,
  generateFixtureWithOracle,
  computeIndependentDeterministicRowId,
  GOLDEN_DETERMINISTIC_ROW_ID_VECTORS,
  verifyHydratedRowIds,
  REPORT_TYPES,
} from './canary/fixture-generator.mjs';
import { generateDeterministicRowId } from '../src/lib/bulkImportPipeline.js';
import { CleanupRegistry } from './canary/cleanup-registry.mjs';
import { CanaryClient, CanaryApiError } from './canary/canary-client.mjs';
import { runCanary } from './canary-bulk-import.mjs';
import { makeInstrumentedEnv, scopeAll } from './_worker-testkit.mjs';
import { clearMockStore, testR2Binding } from './_r2-testkit.mjs';
import { handleBulkImportRequest } from '../worker/bulk-import.js';
import { sameOriginMutation } from '../worker/app-auth.js';

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

  // ── 1B. Scheme & Userinfo Safety ───────────────────────────────────────────
  console.log('1B. Scheme & Userinfo Safety');
  assertThrows(
    () => validateTargetUrl('ftp://ftp.example.com'),
    'INVALID_CANARY_URL',
    'rejects ftp scheme'
  );
  assertThrows(
    () => validateTargetUrl('file:///etc/passwd'),
    'INVALID_CANARY_URL',
    'rejects file scheme'
  );
  assertThrows(
    () => validateTargetUrl('http://canary.example.com'),
    'INVALID_CANARY_URL',
    'rejects insecure HTTP on non-localhost'
  );
  assertThrows(
    () => validateTargetUrl('https://admin:secret@canary.test.local'),
    'INVALID_CANARY_URL',
    'rejects embedded userinfo/passwords in URL'
  );
  assertThrows(
    () => validateTargetUrl('https://user@canary.test.local'),
    'INVALID_CANARY_URL',
    'rejects embedded username in URL'
  );

  // Wire verification: assertSafeCanaryEnvironment enforces URL safety
  assertThrows(
    () => assertSafeCanaryEnvironment({ url: 'ftp://ftp.example.com' }, { CANARY_CONFIRM_ISOLATED: 'YES' }),
    'INVALID_CANARY_URL',
    'assertSafeCanaryEnvironment rejects ftp scheme'
  );
  assertThrows(
    () => assertSafeCanaryEnvironment({ url: 'http://remote.example.com' }, { CANARY_CONFIRM_ISOLATED: 'YES' }),
    'INVALID_CANARY_URL',
    'assertSafeCanaryEnvironment rejects remote http scheme'
  );
  assertThrows(
    () => assertSafeCanaryEnvironment({ url: 'https://admin:secret@canary.test.local' }, { CANARY_CONFIRM_ISOLATED: 'YES' }),
    'INVALID_CANARY_URL',
    'assertSafeCanaryEnvironment rejects embedded credentials'
  );

  // Wire verification: CanaryClient constructor enforces URL safety
  assertThrows(
    () => new CanaryClient({ baseUrl: 'ftp://ftp.example.com' }),
    'INVALID_CANARY_URL',
    'CanaryClient constructor rejects ftp scheme'
  );
  assertThrows(
    () => new CanaryClient({ baseUrl: 'http://remote.example.com' }),
    'INVALID_CANARY_URL',
    'CanaryClient constructor rejects remote http scheme'
  );
  assertThrows(
    () => new CanaryClient({ baseUrl: 'https://admin:secret@canary.test.local' }),
    'INVALID_CANARY_URL',
    'CanaryClient constructor rejects embedded credentials'
  );

  // Allowed HTTPS and local HTTP in assertSafeCanaryEnvironment
  try {
    assertSafeCanaryEnvironment({ url: 'https://rri-bulk-canary.workers.dev' }, { CANARY_CONFIRM_ISOLATED: 'YES' });
    assertSafeCanaryEnvironment({ url: 'http://localhost:8787' }, { CANARY_CONFIRM_ISOLATED: 'YES' });
    assertSafeCanaryEnvironment({ url: 'http://127.0.0.1:8787' }, { CANARY_CONFIRM_ISOLATED: 'YES' });
    passed += 3;
  } catch (err) {
    failed++;
    console.error('  FAIL: assertSafeCanaryEnvironment rejected valid canary targets:', err.message);
  }

  // ── 1C. Redirect Inspection & Credential Stripping ─────────────────────────
  console.log('1C. Redirect Inspection & Safe Resolution');
  assertThrows(
    () => assertSafeRedirect('https://canary.example.com/api', 'https://boston-project.divyesh-boston.workers.dev/p'),
    'PRODUCTION_TARGET_FORBIDDEN',
    'rejects redirect targeting production host'
  );
  assertThrows(
    () => assertSafeRedirect('https://canary.example.com/api', 'ftp://evil.com/leak'),
    'INVALID_CANARY_URL',
    'assertSafeRedirect rejects ftp redirect'
  );
  assertThrows(
    () => assertSafeRedirect('https://canary.example.com/api', 'file:///etc/passwd'),
    'INVALID_CANARY_URL',
    'assertSafeRedirect rejects file redirect'
  );
  assertThrows(
    () => assertSafeRedirect('https://canary.example.com/api', 'http://remote.example.com'),
    'INVALID_CANARY_URL',
    'assertSafeRedirect rejects remote http redirect'
  );
  assertThrows(
    () => assertSafeRedirect('https://canary.example.com/api', 'https://admin:secret@canary.test.local'),
    'INVALID_CANARY_URL',
    'assertSafeRedirect rejects userinfo redirect'
  );
  const sameOriginRedir = assertSafeRedirect('https://canary.example.com/api/v1', '/api/v2');
  assertEqual(sameOriginRedir.resolvedUrl, 'https://canary.example.com/api/v2', 'resolves relative redirect');
  assertEqual(sameOriginRedir.isCrossOrigin, false, 'same-origin redirect is not cross-origin');

  const crossOriginRedir = assertSafeRedirect('https://canary.example.com/api', 'https://other-canary.example.com/api');
  assertEqual(crossOriginRedir.isCrossOrigin, true, 'detects cross-origin redirect');

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

  // ── 5B. Deterministic Row IDs Golden Vectors & Mutation Rejection ─────────
  console.log('5B. Deterministic Row IDs Golden Vectors & Parity');
  assertEqual(GOLDEN_DETERMINISTIC_ROW_ID_VECTORS.length, 5, 'covers 5 fixed golden vectors');

  for (const v of GOLDEN_DETERMINISTIC_ROW_ID_VECTORS) {
    const computed = computeIndependentDeterministicRowId(v.bundleHash, v.entityName, v.naturalKeyOrIndex);
    assertEqual(computed, v.expectedId, `golden vector ${v.bundleHash}:${v.entityName}:${v.naturalKeyOrIndex} matches independently`);

    // Verify contract parity with production function
    const prodVal = generateDeterministicRowId(v.bundleHash, v.entityName, v.naturalKeyOrIndex);
    assertEqual(computed, prodVal, `independent implementation matches production contract for ${v.bundleHash}`);
  }

  // Direct hydration verification positive test
  const testManifest = { id: 'm_det_test', server_property_id: 'prop-canary-88' };
  const validHydratedRows = [
    { entity: 'OccupancyDay', id: computeIndependentDeterministicRowId(testManifest.id, 'OccupancyDay', 0), date: '2026-09-01' },
    { entity: 'OccupancyDay', id: computeIndependentDeterministicRowId(testManifest.id, 'OccupancyDay', 1), date: '2026-09-02' },
  ];
  assertEqual(verifyHydratedRowIds(testManifest, validHydratedRows), true, 'verifyHydratedRowIds passes valid rows');

  // Direct hydration verification negative test: mutated valid-looking 53-bit int MUST throw
  assertThrows(
    () => verifyHydratedRowIds(testManifest, [{ ...validHydratedRows[0], id: validHydratedRows[0].id + 1 }]),
    'DETERMINISTIC_ROW_ID_MISMATCH',
    'verifyHydratedRowIds throws on valid-looking incorrect row ID'
  );

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
  reg.trackRawKey('rri-raw/a/p/hash1', true);
  reg.trackBundleKey('rri-data/a/p/hash2', true);
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

  // Unmapped Orphan R2 Tracking
  const orphanReg = new CleanupRegistry('canary-test-orphan-1');
  orphanReg.trackRawKey('rri-raw/a/p/orphan-raw'); // unmapped!
  orphanReg.trackBundleKey('rri-data/a/p/orphan-bundle'); // unmapped!
  const orphanClean = await orphanReg.runCleanup(mockCleanClient);
  assertEqual(orphanClean.verdict, 'FAILED', 'unmapped R2 keys fail cleanup verdict');
  assertEqual(orphanClean.orphanedR2Keys.length, 2, 'reports both unmapped keys in orphanedR2Keys');
  assert(orphanClean.remainingKeys.some((k) => k.includes('unmapped-r2-orphan')), 'remainingKeys identifies unmapped orphans');

  // An uploaded object must remain deletable even when activation never maps it.
  const failedActivationReg = new CleanupRegistry('canary-test-failed-activation-1');
  failedActivationReg.trackBundleKey('rri-data/a/p/uploaded-before-activation');
  failedActivationReg.trackBundleId('raw_canary-test-failed-activation-1', 'rri-data/a/p/uploaded-before-activation');
  const failedActivationClean = await failedActivationReg.runCleanup(mockCleanClient);
  assertEqual(failedActivationClean.verdict, 'CLEAN', 'failed activation cleanup stays clean when exact bundle ID was registered');
  assert(mockCleanClient.deletedBundles.includes('raw_canary-test-failed-activation-1'), 'failed activation still attempts exact bundle deletion');

  // ── 9. Telemetry Classification Tags ──────────────────────────────────────
  console.log('9. Telemetry Classification Tags');
  const validTags = new Set([
    'REAL_CLOUDFLARE_MEASURED',
    'LOCAL_CLIENT_MEASURED',
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

    assertEqual(mockOrchestratorResult.verdict, 'QUALIFIED_PASS (BUCKET_LOCK_SKIPPED)', 'reports QUALIFIED_PASS when bucket lock omitted');
    assert(mockOrchestratorResult.stages.smoke?.ok === true, 'smoke stage passed locally');
    assert(mockOrchestratorResult.stages.import?.ok === true, 'import stage passed locally');
    assert(mockOrchestratorResult.stages.concurrency?.ok === true, 'concurrency stage passed locally');
    assert(mockOrchestratorResult.stages.hydration?.ok === true, 'hydration stage passed locally');
    assert(mockOrchestratorResult.stages.cleanup?.verdict === 'CLEAN', 'cleanup stage completed CLEAN locally');
    assertEqual(mockOrchestratorResult.stages.cleanup?.remainingKeys?.length || 0, 0, 'zero remaining keys after full sweep');
    assertEqual(mockOrchestratorResult.telemetry.requests_dispatched.classification, 'LOCAL_CLIENT_MEASURED', 'requests_dispatched classified LOCAL_CLIENT_MEASURED');
    assert(mockOrchestratorResult.telemetry.requests_dispatched.value > 0, 'dispatched real requests to mock backend');

    // ── 11. Canary Client Redirect & Bucket Lock Opt-In Verification ─────────
    console.log('11. Canary Client Redirect & Bucket Lock Verification');

    // Cross-origin redirect credential stripping test
    const capturedHeaders = [];
    const redirectFetch = async (input, init) => {
      const urlStr = String(input);
      if (urlStr.includes('origin-a.com')) {
        return new Response(null, {
          status: 302,
          headers: { Location: 'https://origin-b.com/target' },
        });
      }
      capturedHeaders.push(new Headers(init?.headers || {}));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const redirectClient = new CanaryClient({
      baseUrl: 'https://origin-a.com',
      authToken: 'probe-chain-secret',
      authCookie: 'session=secret-cookie-67890',
      fetchImpl: redirectFetch,
    });

    await redirectClient._request('/initial');
    assert(capturedHeaders.length === 1, 'received redirected request at destination');
    const destHeaders = capturedHeaders[0];
    assert(!destHeaders.has('authorization'), 'cross-origin redirect stripped Authorization header');
    assert(!destHeaders.has('cookie'), 'cross-origin redirect stripped Cookie header');

    // Bucket lock opt-in test with HTTP 423 assertion
    let lockTested = false;
    const mockLockFetch = async (input, init) => {
      const urlStr = String(input);
      if (urlStr.includes('/raw-destroy') && !lockTested) {
        lockTested = true;
        return new Response(JSON.stringify({ error: 'raw archive is retention locked', code: 'RAW_ARCHIVE_LOCKED' }), {
          status: 423,
          headers: { 'content-type': 'application/json' },
        });
      }
      return mockFetch(input, init);
    };

    const lockOptInResult = await runCanary({
      dryRun: false,
      all: true,
      allowBucketLock: true,
      target: 'http://localhost:8787',
      property: 'canary-prop-1',
      account: 'A_1',
      fetchImpl: mockLockFetch,
    });

    assertEqual(lockOptInResult.verdict, 'PASS', 'unqualified PASS when bucket lock verified');
    assertEqual(lockOptInResult.stages.lock?.ok, true, 'lock stage ok when HTTP 423 verified');
    assertEqual(lockOptInResult.stages.lock?.verifiedLock, true, 'lock stage marked verifiedLock');

    // ── 11B. Canary Mutation Headers & Redirect Hygiene Verification ─────────
    console.log('11B. Canary Mutation Headers & Redirect Hygiene Verification');

    let mutationTestHeaders = null;
    let mutationTestRequest = null;
    const captureFetch = async (input, init) => {
      mutationTestHeaders = new Headers(init?.headers || {});
      mutationTestRequest = new Request(input, init);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const mutClient = new CanaryClient({
      baseUrl: 'http://localhost:8787',
      fetchImpl: captureFetch,
    });

    // 1. PUT gets the required header and passes Worker sameOriginMutation()
    await mutClient.uploadRawArchive({
      serverPropertyId: 'canary-prop-1',
      reportType: 'payments',
      rawFileHash: 'a'.repeat(64),
      rawBytes: new Uint8Array([1, 2, 3]),
    });
    assertEqual(mutationTestHeaders.get('X-Requested-With'), 'XMLHttpRequest', 'PUT auto-attaches X-Requested-With: XMLHttpRequest');
    assert(sameOriginMutation(mutationTestRequest), 'PUT passes Worker sameOriginMutation()');

    // 2. POST / PATCH / DELETE get it and pass Worker sameOriginMutation()
    for (const method of ['POST', 'PATCH', 'DELETE']) {
      await mutClient._request('/api/bulk-import/mutation-probe', { method });
      assertEqual(mutationTestHeaders.get('X-Requested-With'), 'XMLHttpRequest', `${method} auto-attaches X-Requested-With: XMLHttpRequest`);
      assert(sameOriginMutation(mutationTestRequest), `${method} passes Worker sameOriginMutation()`);
    }

    // 3. GET / HEAD do not receive it automatically
    for (const method of ['GET', 'HEAD']) {
      await mutClient._request('/api/bulk-import/read-probe', { method });
      assertEqual(mutationTestHeaders.has('X-Requested-With'), false, `${method} does not receive X-Requested-With automatically`);
    }

    // 4. Caller-provided header behavior is deterministic
    await mutClient._request('/api/bulk-import/custom-mutation', {
      method: 'POST',
      headers: { 'X-Requested-With': 'CustomCanaryAgent' },
    });
    assertEqual(mutationTestHeaders.get('X-Requested-With'), 'CustomCanaryAgent', 'POST preserves custom X-Requested-With without overwrite');

    await mutClient._request('/api/bulk-import/custom-read', {
      method: 'GET',
      headers: { 'X-Requested-With': 'CustomCanaryAgent' },
    });
    assertEqual(mutationTestHeaders.get('X-Requested-With'), 'CustomCanaryAgent', 'GET preserves caller-provided X-Requested-With');

    // 5. Cross-origin redirect does not retain mutation assertion headers
    const redirAssertionHeaders = [];
    const redirAssertionFetch = async (input, init) => {
      const urlStr = String(input);
      if (urlStr.includes('origin-alpha.com')) {
        return new Response(null, {
          status: 307,
          headers: { Location: 'https://origin-beta.com/api/dest' },
        });
      }
      redirAssertionHeaders.push(new Headers(init?.headers || {}));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const crossOriginClient = new CanaryClient({
      baseUrl: 'https://origin-alpha.com',
      fetchImpl: redirAssertionFetch,
    });

    await crossOriginClient._request('/api/src', {
      method: 'POST',
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        'Origin': 'https://origin-alpha.com',
      },
    });
    assert(redirAssertionHeaders.length === 1, 'received request at cross-origin destination');
    assertEqual(redirAssertionHeaders[0].has('X-Requested-With'), false, 'cross-origin redirect strips X-Requested-With');
    assertEqual(redirAssertionHeaders[0].has('Origin'), false, 'cross-origin redirect strips Origin');

    // 6. 303 / POST->GET redirect removes mutation-only headers
    const postGetHeaders = [];
    let postGetDispatchedMethod = null;
    const postGetFetch = async (input, init) => {
      const urlStr = String(input);
      if (urlStr.includes('/api/post-start')) {
        return new Response(null, {
          status: 303,
          headers: { Location: 'http://localhost:8787/api/get-finish' },
        });
      }
      postGetDispatchedMethod = init?.method;
      postGetHeaders.push(new Headers(init?.headers || {}));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const postGetClient = new CanaryClient({
      baseUrl: 'http://localhost:8787',
      fetchImpl: postGetFetch,
    });

    await postGetClient._request('/api/post-start', {
      method: 'POST',
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        'Content-Type': 'application/json',
        'Content-Length': '14',
      },
      body: '{"test":"val"}',
    });
    assertEqual(postGetDispatchedMethod, 'GET', '303 converted POST to GET');
    assertEqual(postGetHeaders[0].has('X-Requested-With'), false, '303 redirect removed X-Requested-With');
    assertEqual(postGetHeaders[0].has('Content-Type'), false, '303 redirect removed Content-Type');
    assertEqual(postGetHeaders[0].has('Content-Length'), false, '303 redirect removed Content-Length');

    // 7. Existing credential stripping still works
    const existingCredHeaders = [];
    const existingCredFetch = async (input, init) => {
      const urlStr = String(input);
      if (urlStr.includes('origin-cred-a.com')) {
        return new Response(null, {
          status: 302,
          headers: { Location: 'https://origin-cred-b.com/target' },
        });
      }
      existingCredHeaders.push(new Headers(init?.headers || {}));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const existingCredClient = new CanaryClient({
      baseUrl: 'https://origin-cred-a.com',
      authToken: 'probe-chain-secret',
      authCookie: '__Host-rri_session=canary-session-token',
      fetchImpl: existingCredFetch,
    });

    await existingCredClient._request('/entry');
    assertEqual(existingCredHeaders[0].has('Authorization'), false, 'cross-origin redirect stripped Authorization');
    assertEqual(existingCredHeaders[0].has('Cookie'), false, 'cross-origin redirect stripped Cookie');

    // 8. Dry-run remains zero-network
    let dryRunNetworkCalls = 0;
    const noNetworkFetch = async () => {
      dryRunNetworkCalls++;
      throw new Error('NETWORK_CALL_FORBIDDEN_IN_DRY_RUN');
    };

    const dryClientCheck = new CanaryClient({
      baseUrl: 'http://localhost:8787',
      dryRun: true,
      fetchImpl: noNetworkFetch,
    });

    await dryClientCheck.uploadRawArchive({
      serverPropertyId: 'canary-prop-1',
      reportType: 'payments',
      rawFileHash: 'c'.repeat(64),
      rawBytes: new Uint8Array([1]),
    });
    await dryClientCheck.recordRawArchive({
      serverPropertyId: 'canary-prop-1',
      reportType: 'payments',
      rawFileHash: 'c'.repeat(64),
      rawArchiveId: 'arch-dry-1',
    });
    await dryClientCheck._request('/api/bulk-import/read-dry', { method: 'GET' });

    assertEqual(dryRunNetworkCalls, 0, 'dry-run made 0 network fetch calls');
    assertEqual(dryClientCheck.requestsDispatched, 0, 'dry-run client requestsDispatched is strictly 0');
    assertEqual(dryClientCheck.plannedRequests.length, 3, 'dry-run client recorded 3 planned requests');
    assertEqual(dryClientCheck.plannedRequests[0].headers['x-requested-with'], 'XMLHttpRequest', 'PUT planned request recorded x-requested-with');
    assertEqual(dryClientCheck.plannedRequests[1].headers['x-requested-with'], 'XMLHttpRequest', 'POST planned request recorded x-requested-with');
    assertEqual(dryClientCheck.plannedRequests[2].headers['x-requested-with'], undefined, 'GET planned request did NOT record x-requested-with');

    // ── 12. Corrupted-Payload / Normalized Hash Mismatch Verification ─────────
    console.log('12. Corrupted-Payload / Normalized Hash Mismatch Verification');

    const tamperedItems = [
      { entity: 'PaymentDay', row: { id: 201, property_id: 'canary-prop-1', amount: 999999 } }
    ];
    const tamperedGzip = zlib.gzipSync(tamperedItems.map((i) => JSON.stringify(i)).join('\n'));
    const expectedHashValue = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    const mockTamperedHydrationFetch = async (input) => {
      const urlStr = String(input);
      if (urlStr.includes('/api/bulk-import/manifest')) {
        if (urlStr.includes('since_revision=1')) {
          return new Response(JSON.stringify({ manifests: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({
          manifests: [{
            id: 'bundle-tampered-1',
            status: 'active',
            row_count: 1,
            revision: 1,
            normalized_hash: expectedHashValue,
          }]
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (urlStr.includes('/api/bulk-import/bundle/')) {
        return new Response(tamperedGzip, {
          status: 200,
          headers: {
            'content-type': 'application/gzip',
            'x-normalized-hash': expectedHashValue,
          },
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const tamperedHydrationResult = await runCanary({
      hydration: true,
      target: 'http://localhost:8787',
      fetchImpl: mockTamperedHydrationFetch,
    });

    assertEqual(tamperedHydrationResult.verdict, 'FAIL', 'fails verdict when bundle payload is corrupted');
    assertEqual(tamperedHydrationResult.stages.hydration?.ok, false, 'hydration stage fails on hash mismatch');
    assert(
      /normalized hash mismatch/i.test(tamperedHydrationResult.stages.hydration?.error || ''),
      'hydration error describes normalized hash mismatch'
    );

    // ── 12B. Valid-Looking Mutated Row ID Rejection in Hydration ─────────────
    console.log('12B. Valid-Looking Mutated Row ID Rejection in Hydration');
    const validTestFixture = await generateFixtureWithOracle({
      reportType: 'occupancy',
      rowCount: 2,
      accountId: 'acc-1',
      propertyId: 'canary-prop-1',
    });

    const mockValidHydrationFetch = async (input) => {
      const urlStr = String(input);
      if (urlStr.includes('/api/bulk-import/manifest')) {
        if (urlStr.includes('since_revision=1')) {
          return new Response(JSON.stringify({ manifests: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({
          manifests: [{
            id: 'bundle-valid-row-id-1',
            status: 'active',
            row_count: validTestFixture.rowCount,
            revision: 1,
            normalized_hash: validTestFixture.normalizedHash,
          }]
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (urlStr.includes('/api/bulk-import/bundle/')) {
        return new Response(validTestFixture.compressedBundle, {
          status: 200,
          headers: {
            'content-type': 'application/gzip',
            'x-normalized-hash': validTestFixture.normalizedHash,
          },
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const mutatedRowIdResult = await runCanary({
      hydration: true,
      _mutateHydratedRowId: true,
      target: 'http://localhost:8787',
      fetchImpl: mockValidHydrationFetch,
    });

    assertEqual(mutatedRowIdResult.verdict, 'FAIL', 'fails verdict when row ID is mutated');
    assertEqual(mutatedRowIdResult.stages.hydration?.ok, false, 'hydration stage fails on mutated row ID');
    assert(
      /deterministic ID mismatch/i.test(mutatedRowIdResult.stages.hydration?.error || ''),
      'hydration error describes deterministic ID mismatch'
    );

    // ── 12C. Missing x-normalized-hash Header Rejection ─────────────────────
    console.log('12C. Missing x-normalized-hash Header Rejection');
    const mockMissingHeaderFetch = async (input) => {
      const urlStr = String(input);
      if (urlStr.includes('/api/bulk-import/manifest')) {
        if (urlStr.includes('since_revision=1')) {
          return new Response(JSON.stringify({ manifests: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({
          manifests: [{
            id: 'bundle-missing-header-1',
            status: 'active',
            row_count: validTestFixture.rowCount,
            revision: 1,
            normalized_hash: validTestFixture.normalizedHash,
          }]
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (urlStr.includes('/api/bulk-import/bundle/')) {
        return new Response(validTestFixture.compressedBundle, {
          status: 200,
          headers: {
            'content-type': 'application/gzip',
            // OMITTED: 'x-normalized-hash'
          },
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const missingHeaderResult = await runCanary({
      hydration: true,
      target: 'http://localhost:8787',
      fetchImpl: mockMissingHeaderFetch,
    });

    assertEqual(missingHeaderResult.verdict, 'FAIL', 'fails verdict when x-normalized-hash is missing');
    assertEqual(missingHeaderResult.stages.hydration?.ok, false, 'hydration stage fails on missing header');
    assert(
      /missing required x-normalized-hash header/i.test(missingHeaderResult.stages.hydration?.error || ''),
      'hydration error describes missing x-normalized-hash header'
    );

    // ── 12D. Incorrect x-normalized-hash Header Rejection ───────────────────
    console.log('12D. Incorrect x-normalized-hash Header Rejection');
    const mockIncorrectHeaderFetch = async (input) => {
      const urlStr = String(input);
      if (urlStr.includes('/api/bulk-import/manifest')) {
        if (urlStr.includes('since_revision=1')) {
          return new Response(JSON.stringify({ manifests: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({
          manifests: [{
            id: 'bundle-bad-header-1',
            status: 'active',
            row_count: validTestFixture.rowCount,
            revision: 1,
            normalized_hash: validTestFixture.normalizedHash,
          }]
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (urlStr.includes('/api/bulk-import/bundle/')) {
        return new Response(validTestFixture.compressedBundle, {
          status: 200,
          headers: {
            'content-type': 'application/gzip',
            'x-normalized-hash': 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
          },
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const incorrectHeaderResult = await runCanary({
      hydration: true,
      target: 'http://localhost:8787',
      fetchImpl: mockIncorrectHeaderFetch,
    });

    assertEqual(incorrectHeaderResult.verdict, 'FAIL', 'fails verdict when x-normalized-hash is incorrect');
    assertEqual(incorrectHeaderResult.stages.hydration?.ok, false, 'hydration stage fails on incorrect header');
    assert(
      /Hydration header hash mismatch/i.test(incorrectHeaderResult.stages.hydration?.error || ''),
      'hydration error describes header hash mismatch'
    );

    // ── 13. Injected Failure After R2 Upload & Failure Cleanup Verification ──
    console.log('13. Injected Failure After R2 Upload & Failure Cleanup Verification');

    let rawUploadDispatched = false;
    const mockFailureFetch = async (input) => {
      const urlStr = String(input);
      if (urlStr.includes('/api/bulk-import/raw-upload')) {
        rawUploadDispatched = true;
        return new Response(JSON.stringify({ ok: true, raw_object_key: 'rri-raw/test-acc/test-prop/injected-orphan-key' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (urlStr.includes('/api/bulk-import/raw-archive')) {
        throw new Error('SIMULATED_D1_ACTIVATION_CRASH');
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const failureRunResult = await runCanary({
      smoke: true,
      target: 'http://localhost:8787',
      fetchImpl: mockFailureFetch,
    });

    assert(rawUploadDispatched, 'raw archive upload was dispatched before injected crash');
    assertEqual(failureRunResult.verdict, 'FAIL', 'run reports FAIL on stage exception');
    assert(failureRunResult.stages.cleanup !== undefined, 'cleanup executed in finally-equivalent path after failure');
    assertEqual(failureRunResult.stages.cleanup?.verdict, 'FAILED', 'cleanup reports FAILED due to unmapped orphan');
    assert(
      failureRunResult.stages.cleanup?.orphanedR2Keys?.includes('rri-raw/test-acc/test-prop/injected-orphan-key'),
      'cleanup tracked unmapped raw upload in orphanedR2Keys'
    );
    assert(
      failureRunResult.stages.cleanup?.remainingKeys?.some((k) => k.includes('injected-orphan-key')),
      'cleanup inventory includes exact orphaned R2 key'
    );
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
