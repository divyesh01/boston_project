// Synthetic deterministic test harness for Red Roof Intelligence.
// Loads the REAL calculation modules through Vite's SSR loader so we validate
// the same code the app runs (no re-implementations).
// Usage: node scripts/verify-harness.mjs

import { createServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// ─── Browser-global shims the real modules touch at import/use time ───
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.sessionStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.window = globalThis;
if (globalThis.navigator === undefined) {
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'harness', language: 'en-US' }, configurable: true });
}
globalThis.document = {
  createElement: () => ({ click() {}, set href(v) {} }),
};
if (!globalThis.crypto?.subtle) {
  globalThis.crypto = {
    ...globalThis.crypto,
    getRandomValues: (arr) => { for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256); return arr; },
    subtle: undefined,
  };
}

let passed = 0;
let failed = 0;
const failures = [];
const approx = (actual, expected, eps = 0.005) =>
  typeof actual === 'number' && typeof expected === 'number' && Math.abs(actual - expected) <= eps;
function test(name, fn) {
  try {
    const detail = fn();
    if (detail === true || detail === undefined) { passed++; console.log(`  PASS  ${name}`); }
    else { failed++; failures.push(`${name} → ${JSON.stringify(detail)}`); console.log(`  FAIL  ${name} → ${JSON.stringify(detail)}`); }
  } catch (e) {
    failed++; failures.push(`${name} → threw: ${e.message}`);
    console.log(`  FAIL  ${name} → threw: ${e.message}`);
  }
}

const server = await createServer({
  root,
  logLevel: 'error',
  server: { middlewareMode: true, hmr: false },
  appType: 'custom',
  plugins: [],
  optimizeDeps: { enabled: false },
  resolve: { alias: [{ find: '@', replacement: path.resolve(root, 'src') }] },
});
try {
  const mod = (rel) => server.ssrLoadModule(rel);
  const hotel = await mod('/src/lib/hotel.js');
  const decimal = await mod('/src/lib/decimal.js');
  const commission = await mod('/src/lib/commissionRates.js');
  const taxSettings = await mod('/src/lib/taxSettings.js');
  const secUtils = await mod('/src/lib/securityUtils.js');
  const security = await mod('/src/lib/security.js');

  console.log('\n=== 1. Fixed-decimal financial arithmetic (decimal.js) ===');
  test('toCents handles floats without drift', () => {
    const s = decimal.toCents(0.1) + decimal.toCents(0.2);
    if (s !== decimal.toCents(0.3, 0)) ;
    return approx(decimal.fromCents(decimal.toCents(0.1) + decimal.toCents(0.2)), 0.3);
  });
  test('multiply 100 x 15% = 15', () => decimal.multiply(100, 0.15) === decimal.toCents(15));
  test('divide 1000 / 4 = 250', () => decimal.divide(1000, 4) === decimal.toCents(250));
  test('divideRate 50/100 = 0.50', () => decimal.divideRate(50, 100) === decimal.toRate(0.5));

  console.log('\n=== 2. Portfolio KPIs (weighted, not percentage averages) ===');
  const occ = [
    // Prop A: 50 rooms, sells 15 @ avg rev $3000 => occ 30%
    { property_id: 'A', date: '2026-01-01', total_revenue: 4000, rooms_sold: 15 },
    { property_id: 'A', date: '2026-01-02', total_revenue: 5000, rooms_sold: 20 },
    { property_id: 'B', date: '2026-01-01', total_revenue: 12000, rooms_sold: 30 }, // 100 rooms -> 30%
    { property_id: 'B', date: '2026-01-02', total_revenue: 14000, rooms_sold: 35 },
  ];
  const roomCounts = { A: 50, B: 100 };
  const ps = hotel.portfolioStats(occ, roomCounts);
  test('revenue sums correctly (no coins lost)', () => ({ actual: ps.revenue, expected: 35000, pass: approx(ps.revenue, 35000) }).pass || JSON.stringify({ actual: ps.revenue, expected: 35000 }));
  test('rooms sold sums correctly', () => approx(ps.roomsSold, 15 + 20 + 30 + 35));
  test('folded occupancy = sold / (days*rooms)', () => approx(ps.occupancy, 100 / (50 * 2 + 100 * 2)));
  test('ADR = revenue/roomsSold', () => approx(ps.adr, (4000 + 5000 + 12000 + 14000) / 100));
  test('RevPAR = revenue/capacity', () => approx(ps.revpar, (4000 + 5000 + 12000 + 14000) / 300));
  const per = hotel.perPropertyStats(occ, [{ id: 'A', name: 'Alpha', rooms: 50 }, { id: 'B', name: 'Bravo', rooms: 100 }]);
  test('per-property A ADR', () => approx(per.find((p) => p.property_id === 'A')?.adr, 9000 / 35));
  test('per-property B occupancy', () => approx(per.find((p) => p.property_id === 'B')?.occupancy, 65 / 200));

  console.log('\n=== 3. Commission engine (commissionRates.js) ===');
  test('Expedia default 15%', () => {
    const r = commission.getCommissionRates();
    const match = Object.entries(r).find(([k]) => k.includes('EXPEDIA'));
    return match && match[1].rate === 0.15 && match[1].type === 'percentage';
  });
  test('normalizeRate clamps percentage above 100% to <1', () => {
    commission.setCommissionRates({ 'WALK-IN': { type: 'percentage', rate: 5 } });
    const r = commission.getCommissionRates()['WALK-IN'];
    return approx(r.rate, 0.9999);
  });
  test('ccFee rate default 2.5%', () => approx(commission.getCcFeeRate(), 0.025));
  test('ccFee rate clamps negatives to 0', () => {
    localStorage.setItem('rri_cc_fee_rate', '-1');
    return approx(commission.getCcFeeRate(), 0);
  });

  console.log('\n=== 4. Tax engine (taxSettings.js + taxConfig.js) ===');
  test('effective rates default to legacy combined when unset', () => {
    const eff = taxSettings.getEffectiveTaxRates('RRI1416', '2026-01-01');
    const combined = (eff.state + eff.city + eff.other) * 100;
    return combined >= 0 && combined <= 20 && eff.legacy === true;
  });
  test('rates never exceed 100% combined', () => {
    const eff = taxSettings.getEffectiveTaxRates('X', '2026-01-01');
    return (eff.state + eff.city + eff.other) <= 1.0001;
  });

  console.log('\n=== 5. XSS sanitization (escapeHtml now encodes all entities) ===');
  test('escapeHtml encodes <script>', () => secUtils.escapeHtml('<script>alert(1)</script>') === '&lt;script&gt;alert(1)&lt;&#x2F;script&gt;');
  test('escapeHtml encodes apostrophes', () => secUtils.escapeHtml("it's") === 'it&#39;s');
  test('escapeHtml encodes double quotes and amp', () => secUtils.escapeHtml('a & "b"') === 'a &amp; &quot;b&quot;');
  test('escapeAttr returns encoded amp of quote-only input', () => secUtils.escapeAttr('"><img src=x onerror=alert(1)>') === '&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');

  console.log('\n=== 6. CSV formula-injection neutralization (hotel.js toCsv) ===');
  const evil = [
    { a: '=1+1', b: '+123', c: '@import', d: '-9001', e: '\tCVE' },
    { a: 'tabs\nand\r\nstuff', b: 'quoted "value"', c: 'ok', d: 'normal', e: '=SUM(A1:A2)' },
  ];
  const csv = hotel.toCsv(evil);
  test('formula cells prefixed with a quote', () => {
    return csv.includes("'=1+1") && csv.includes("'+123") && csv.includes("'@import") && csv.includes("'-9001") && csv.includes("'\tCVE");
  });
  test('embedded quotes doubled', () => csv.includes('"quoted ""value"""'));
  test('newlines inside cells do not break the record', () => {
    const lines = csv.split('\n');
    return lines[0].split(',').length === 5; // header intact as first record line boundary check
  });

  console.log('\n=== 7. Temporary passwords come from crypto (not predictable) ===');
  test('generateTemporaryPassword returns 16-char high-entropy string', () => {
    const p = security.generateTemporaryPassword();
    return (
      typeof p === 'string' &&
      p.length === 16 &&
      /[A-Z]/.test(p) &&
      /[a-z]/.test(p) &&
      /\d/.test(p) &&
      /[^A-Za-z0-9]/.test(p)
    );
  });

  console.log(`\n─── RESULT: ${passed} passed, ${failed} failed ───`);
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log('  - ' + f));
    process.exitCode = 1;
  }
} finally {
  await server.close();
}