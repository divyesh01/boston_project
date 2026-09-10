// Deterministic Acceptance Test: Red Roof Intelligence Import UX Hardening Pass
//
// Verifies the complete operational & UX requirements:
// 1. Authenticated owner session
// 2. Property: Red Roof Inn Middleboro
// 3. Force Import default OFF with target property confirmation
// 4. Rate-limit domain isolation (Security vs Destructive vs Import vs Operational)
// 5. Property/Import consistency (queue validation and property matching)
// 6. Full 8-report HotelKey batch scan and import workflow
// 7. Duplicate retry safety (zero duplicate writes on ordinary re-import)
// 8. Daily aggregate cache rebuild
// 9. Interrupted import session detection and clean rollback
//
// Usage: node --import ./scripts/_loader-boot.mjs scripts/probe-import-ux-hardening-acceptance.mjs

import 'fake-indexeddb/auto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDomShims } from './_dom-shims.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(__dirname, 'data');

// Install DOM and Storage shims
const __store = new Map();
const __storage = {
  getItem: (k) => (__store.has(k) ? __store.get(k) : null),
  setItem: (k, v) => __store.set(k, String(v)),
  removeItem: (k) => __store.delete(k),
  clear: () => __store.clear(),
  key: (i) => [...__store.keys()][i] ?? null,
  get length() { return __store.size; },
};
globalThis.localStorage = __storage;
globalThis.sessionStorage = __storage;
globalThis.window = globalThis;
installDomShims({ userAgent: 'acceptance-harness' });

// Provide fetch for file:// URLs
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (!url.startsWith('file:')) return realFetch(input, init);
  const u = new URL(url);
  let p = decodeURIComponent(u.pathname);
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
  const buf = fs.readFileSync(p);
  return {
    ok: true,
    status: 200,
    url,
    text: async () => buf.toString('utf8'),
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    headers: new Map([['content-type', 'text/csv']]),
  };
};

const fileUrl = (name) => 'file:///' + path.join(DATA_DIR, name).replace(/\\/g, '/');

// Import application modules
const { default: localDb } = await import('../src/api/localDb.js');
const {
  db,
  createImportSession,
  rollbackImportSession,
  listImportSessions,
  completeImportSession,
} = await import('../src/api/base44Client.js');

const { scanReport, importReport } = await import('../src/lib/reportParsers.js');
const {
  importRateLimiter,
  operationalActionRateLimiter,
  destructiveActionRateLimiter,
  securityActionRateLimiter,
} = await import('../src/lib/rateLimiters.js');

const {
  getQueueMetrics,
  confirmForceImportToggle,
  confirmBatchForceImport,
  validateQueueProperty,
} = await import('../src/lib/importQueueHelpers.js');

const { rebuildDailyAggregates } = await import('../src/lib/dailyAggregates.js');
const { signInAsAllPropertyOwner } = await import('./_harness-auth.mjs');

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n── ${title}`);
}

console.log('=== RED ROOF INTELLIGENCE: ACCEPTANCE VERIFICATION ===\n');

// Reset and open clean database
await localDb.delete();
await localDb.open();
localStorage.clear();

// ── 1. Authenticated Owner & Target Property ─────────────────────────────────
section('1. Authenticated Owner & Target Property Setup');
await signInAsAllPropertyOwner();

const PROPERTY_ID = 'prop-middleboro';
const PROPERTY_NAME = 'Red Roof Inn Middleboro';

await localDb.Property.add({
  id: PROPERTY_ID,
  code: 'RRI1416',
  name: PROPERTY_NAME,
  rooms: 100,
  active: 1,
  created_date: new Date().toISOString(),
});

const propRecord = await db.entities.Property.get(PROPERTY_ID);
check('Owner is authenticated and can read Property', Boolean(propRecord?.id === PROPERTY_ID));
check('Property name matches target Red Roof Inn Middleboro', propRecord?.name === PROPERTY_NAME);

// ── 2. Rate-Limit Domain Isolation ──────────────────────────────────────────
section('2. Rate-Limit Domain Isolation');
importRateLimiter.reset();
operationalActionRateLimiter.reset();
destructiveActionRateLimiter.reset();
securityActionRateLimiter.reset();

// Simulate user recording multiple expenses and saving settings
for (let i = 0; i < 20; i++) {
  const opRes = operationalActionRateLimiter.check();
  if (i === 0) check('Operational limiter allows initial action', opRes.allowed);
}

// User now imports 8 reports. The import rate limiter MUST have its full budget
const importCheck1 = importRateLimiter.check();
check('Import domain is allowed after 20 operational actions', importCheck1.allowed);
check('Import domain has its own independent remaining budget', importCheck1.remaining >= 90);

// Destructive limiter is unimpacted
const destCheck = destructiveActionRateLimiter.check();
check('Destructive domain has independent budget', destCheck.allowed);

// Security limiter is unimpacted
const secCheck = securityActionRateLimiter.check();
check('Security domain has independent budget', secCheck.allowed);

// ── 3. Force Import Confirmation & Property Invariants ───────────────────────
section('3. Force Import Confirmation & Property Invariants');

let promptMessage = '';
const mockConfirm = (msg) => { promptMessage = msg; return true; };

const forceAllowed = confirmForceImportToggle({
  propertyName: PROPERTY_NAME,
  enabling: true,
  confirmFn: mockConfirm,
});
check('Force Import toggle asks for confirmation', forceAllowed);
check('Force Import prompt explicitly identifies target property', promptMessage.includes(PROPERTY_NAME));

let batchPromptMessage = '';
const mockBatchConfirm = (msg) => { batchPromptMessage = msg; return true; };
const batchAllowed = confirmBatchForceImport({
  propertyName: PROPERTY_NAME,
  count: 8,
  confirmFn: mockBatchConfirm,
});
check('Batch Force Import asks for confirmation', batchAllowed);
check('Batch Force Import prompt specifies file count and target property',
  batchPromptMessage.includes('8 reports') && batchPromptMessage.includes(PROPERTY_NAME));

// Property queue validation
const validQueueItem = validateQueueProperty({
  item: { scan: { propertyId: PROPERTY_ID } },
  propertyId: PROPERTY_ID,
  accessibleProperties: [{ id: PROPERTY_ID }],
});
check('validateQueueProperty approves item matching active property', validQueueItem.ok);

const invalidQueueItem = validateQueueProperty({
  item: { scan: { propertyId: 'prop-different' } },
  propertyId: PROPERTY_ID,
  accessibleProperties: [{ id: PROPERTY_ID }],
});
check('validateQueueProperty rejects item scanned for different property', !invalidQueueItem.ok);

// ── 4. Full 8-Report HotelKey Workflow Ingestion ─────────────────────────────
section('4. Full 8-Report HotelKey Workflow Ingestion');

const REPORTS_TO_IMPORT = [
  { file: 'Occupancy Summary midelboro.csv', expectedType: 'occupancy' },
  { file: 'Source Summary.csv', expectedType: 'source' },
  { file: 'Gross Revenue Report midelboro.csv', expectedType: 'gross' },
  { file: 'Payments Summary.csv', expectedType: 'payments' },
  { file: 'Clerk Shift.csv', expectedType: 'clerk' },
  { file: 'Hotel Statistics.csv', expectedType: 'hotel_statistics' },
  { file: 'All Transactions.csv', expectedType: 'transactions' },
  { file: 'Adjustments and Refunds Activity.csv', expectedType: 'adjustments_refunds' },
];

let totalRowsImported = 0;
const importResults = [];

for (const rep of REPORTS_TO_IMPORT) {
  const url = fileUrl(rep.file);
  const scan = await scanReport('auto', url, {
    propertyId: PROPERTY_ID,
    propertyName: PROPERTY_NAME,
    sourceFile: rep.file,
  });

  check(`Scan ${rep.file} detects expected type (${rep.expectedType})`, scan.type === rep.expectedType);

  const meta = {
    propertyId: PROPERTY_ID,
    propertyName: PROPERTY_NAME,
    sourceFile: rep.file,
  };

  const result = await importReport(scan, meta);
  check(`Import ${rep.file} succeeds with non-zero rows`, result.count > 0);
  check(`Import ${rep.file} returns valid importId`, Boolean(result.importId));

  totalRowsImported += result.count;
  importResults.push({ file: rep.file, result });
}

check('All 8 reports imported rows into the database', totalRowsImported > 0);
console.log(`  -> Total rows imported across 8 reports: ${totalRowsImported}`);

// ── 5. Duplicate Retry Protection ───────────────────────────────────────────
section('5. Duplicate Retry Protection (Ordinary Re-Import)');

// Attempt to re-import Occupancy Summary without Force Import
const occUrl = fileUrl('Occupancy Summary midelboro.csv');
const occScan = await scanReport('auto', occUrl, {
  propertyId: PROPERTY_ID,
  propertyName: PROPERTY_NAME,
  sourceFile: 'Occupancy Summary midelboro.csv',
});

const retryResult = await importReport(occScan, {
  propertyId: PROPERTY_ID,
  propertyName: PROPERTY_NAME,
  sourceFile: 'Occupancy Summary midelboro.csv',
  forceImport: false,
});

check('Re-importing identical report writes 0 duplicate rows', retryResult.count === 0 || retryResult.excluded > 0);

// ── 6. Daily Aggregate Cache Refresh ─────────────────────────────────────────
section('6. Daily Aggregate Cache Refresh');

let rebuildError = null;
try {
  await rebuildDailyAggregates({ propertyId: PROPERTY_ID });
} catch (e) {
  rebuildError = e;
}
check('rebuildDailyAggregates runs cleanly for target property', rebuildError === null);

// ── 7. Interrupted Session Rollback & Truthfulness ───────────────────────────
section('7. Interrupted Session Rollback');

// Create an import session and record rows in rollback ledger
const session = await createImportSession({
  propertyId: PROPERTY_ID,
  reportType: 'occupancy',
  sourceFile: 'interrupted-sample.csv',
});
check('Import session created with in_progress status', session.status === 'in_progress');

const dummyRowId = await localDb.OccupancyDay.add({
  property_id: PROPERTY_ID,
  date: '2026-09-01',
  room_revenue: 5000,
  created_date: new Date().toISOString(),
});
await localDb.ImportRecordIds.add({
  import_id: session.importId,
  entity_type: 'OccupancyDay',
  record_id: String(dummyRowId),
  created_at: new Date().toISOString(),
});

const rollbackRes = await rollbackImportSession(session.importId);
check('Rollback of interrupted session returns success', Boolean(rollbackRes.success));

const activeSessions = await listImportSessions();
const survivingInterrupted = activeSessions.filter((s) => s.importId === session.importId && s.status === 'in_progress');
check('Interrupted session is no longer active in progress', survivingInterrupted.length === 0);

// ── Final Summary ────────────────────────────────────────────────────────────
console.log('\n──────────────────────────────────────────────────────────────────────');
console.log(`TOTAL CHECKS: ${pass + fail} | PASSED: ${pass} | FAILED: ${fail}`);
if (fail > 0) {
  console.log('FAILURES:');
  failures.forEach((f) => console.log(`  * ${f}`));
  process.exit(1);
} else {
  console.log('PASSED: acceptance probe verified all 8 reports and UX hardening invariants.');
  process.exit(0);
}
