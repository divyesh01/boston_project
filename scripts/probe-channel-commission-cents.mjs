/**
 * PROBE: OTA channel commission/net totals must come from the cent-exact
 * CalculationService.calculateChannelMetrics engine, not a re-implemented float
 * aggregation.
 *
 * ROOT CAUSE (money-math audit, 2026-08-27). Two surfaces re-implemented the
 * documented cent-exact channel engine in raw float on the persisted
 * `net_revenue` field:
 *
 *   src/pages/OtaChannels.jsx  — `cur.gross += Number(r.net_revenue)||0`, then
 *                                 `commission = c.gross * info.rate`, then
 *                                 float `channels.reduce((a,c)=>a+c.gross,0)` etc.
 *                                 feeding the "Total Gross / Commission / Net" KPIs.
 *   src/components/dashboard/OtaMatrix.jsx — the same three float lines feeding the
 *                                 card subtitle "Gross · Commission leakage · Net".
 *
 * CalculationService.calculateChannelMetrics accumulates gross in integer CENTS
 * (toCents) and applies commission with multiply(), specifically because the float
 * form could land a channel's commission on either side of a half-cent. So the two
 * pages could disagree, to the cent, with the reconciled Money-Kept engine on the
 * same data — a BUSINESS-directive violation (owner-facing money must reconcile).
 *
 * WHAT THIS PROBE DOES
 *   §1 EXECUTION — proves the defect was real and the engine is exact: on a fixture
 *      whose net_revenue rows sum to a float value carrying binary residue
 *      (0.1 + 0.2 = 0.30000000000000004), the old inline float algorithm carries
 *      that residue into gross and commission, while the engine returns whole-cent
 *      figures, and the two totals diverge.
 *   §2 SOURCE CONTRACT — pins that both files now delegate to the engine and no
 *      longer contain the float aggregation pattern.
 *
 * RUN WITH THE ALIAS LOADER (calculationService imports via the @/lib alias):
 *   node --import ./scripts/_loader-boot.mjs scripts/probe-channel-commission-cents.mjs
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './_repo-root.mjs';

// ── Environment ──────────────────────────────────────────────────────────────
if (!globalThis.localStorage) {
  const store = {};
  globalThis.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    clear: () => { for (const k of Object.keys(store)) delete store[k]; },
  };
}

const REPO = REPO_ROOT;

let pass = 0;
let fail = 0;
const failures = [];

function ok(label, cond, detail) {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    failures.push(detail ? `${label} — ${detail}` : label);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const { CalculationService } = await import('@/lib/calculationService');
const { toCents, fromCents, sumCents } = await import('@/lib/decimal');
const { commissionFor } = await import('@/lib/hotel');
const { setCommissionRates } = await import('@/lib/commissionRates');

// Deterministic rate card: a percentage channel and a zero-commission direct one.
setCommissionRates({
  EXPEDIA: { type: 'percentage', rate: 0.5, taxExempt: false },
  DIRECT: { type: 'percentage', rate: 0, taxExempt: false },
});

// Rows chosen so the FLOAT accumulation carries IEEE-754 residue: 0.1 + 0.2 in a
// channel's gross is 0.30000000000000004, and a float `gross * 0.5` inherits it.
const srcRows = [
  { source: 'EXPEDIA', net_revenue: 0.1, stays: 1, date: '2026-01-01' },
  { source: 'EXPEDIA', net_revenue: 0.2, stays: 1, date: '2026-01-02' },
  { source: 'DIRECT', net_revenue: 100.1, stays: 1, date: '2026-01-03' },
  { source: 'DIRECT', net_revenue: 0.15, stays: 1, date: '2026-01-04' },
];

// The OLD inline float algorithm, transcribed verbatim from the pre-fix pages.
function floatChannels(rows) {
  const map = new Map();
  rows.forEach((r) => {
    const key = r.source || r.code || 'UNKNOWN';
    const cur = map.get(key) || { source: key, gross: 0, stays: 0 };
    cur.gross += Number(r.net_revenue) || 0;
    cur.stays += Number(r.stays) || 0;
    map.set(key, cur);
  });
  return [...map.values()]
    .filter((c) => c.gross > 0 || c.stays > 0)
    .map((c) => {
      const info = commissionFor(c.source);
      let commission = 0;
      if (info.type === 'percentage') commission = c.gross * info.rate;
      else if (info.type === 'fixed') commission = info.rate * c.stays;
      else if (info.type === 'actual') commission = info.rate;
      return { ...c, ...info, commission, net: c.gross - commission };
    });
}

const floats = floatChannels(srcRows);
const engine = CalculationService.calculateChannelMetrics(srcRows);

const floatExp = floats.find((c) => c.source === 'EXPEDIA');
const engExp = engine.find((c) => c.source === 'EXPEDIA');

console.log('§1 execution — float carries residue, engine is cent-exact');

// The float gross for EXPEDIA is 0.1 + 0.2, which is NOT 0.30 in IEEE-754.
ok('float EXPEDIA gross carries binary residue',
  floatExp.gross !== 0.3,
  `float gross was exactly ${floatExp.gross} (expected the 0.30000000000000004 residue)`);

// The engine gross is a whole number of cents.
ok('engine EXPEDIA gross is cent-exact 0.30',
  toCents(engExp.gross) === 30 && engExp.gross === fromCents(30),
  `engine gross was ${engExp.gross} (${toCents(engExp.gross)} cents)`);

// The engine commission is a whole number of cents (multiply(), not float *).
ok('engine EXPEDIA commission is whole cents',
  Number.isInteger(toCents(engExp.commission)) && toCents(engExp.commission) === 15,
  `engine commission was ${engExp.commission} (${toCents(engExp.commission)} cents)`);

// The float commission inherits the residue and is NOT the exact 0.15.
ok('float EXPEDIA commission drifts off the cent',
  floatExp.commission !== 0.15,
  `float commission was exactly ${floatExp.commission}`);

// The two total-commission figures diverge — the defect is observable, not cosmetic.
const engineTotalCommissionCents = sumCents(engine.map((c) => c.commission));
const floatTotalCommission = floats.reduce((a, c) => a + c.commission, 0);
ok('engine vs float total commission diverge',
  toCents(floatTotalCommission) !== engineTotalCommissionCents
    || floatTotalCommission !== fromCents(engineTotalCommissionCents),
  `float total ${floatTotalCommission}, engine total ${fromCents(engineTotalCommissionCents)}`);

// The engine totals reconcile exactly in cents: gross - commission === net.
const gC = sumCents(engine.map((c) => c.gross));
const cC = sumCents(engine.map((c) => c.commission));
const nC = sumCents(engine.map((c) => c.net));
ok('engine totals reconcile in cents (gross - commission === net)',
  gC - cC === nC,
  `gross ${gC}c - commission ${cC}c = ${gC - cC}c, but net summed to ${nC}c`);

console.log(`  gross ${fromCents(gC)} · commission ${fromCents(cC)} · net ${fromCents(nC)}`);

// ── §2 source contract ───────────────────────────────────────────────────────
console.log('§2 source contract — both surfaces delegate to the engine');

function read(rel) {
  return readFileSync(path.join(REPO, rel), 'utf8');
}

const targets = [
  'src/pages/OtaChannels.jsx',
  'src/components/dashboard/OtaMatrix.jsx',
];

for (const rel of targets) {
  const src = read(rel);
  ok(`${rel} calls CalculationService.calculateChannelMetrics`,
    /CalculationService\.calculateChannelMetrics\s*\(/.test(src),
    'no call to the cent-exact engine found');
  ok(`${rel} dropped the float gross accumulator`,
    !/\.gross\s*\+=\s*Number\(\s*r\.net_revenue/.test(src),
    'still accumulates gross with float += Number(r.net_revenue)');
  ok(`${rel} dropped the float commission = gross * rate`,
    !/=\s*c\.gross\s*\*\s*info\.rate/.test(src),
    'still computes commission with float c.gross * info.rate');
  ok(`${rel} aggregates totals in cents (sumCents/fromCents)`,
    /sumCents\s*\(/.test(src) && /fromCents\s*\(/.test(src),
    'totals are not summed via sumCents/fromCents');
}

// ── Summary ────────────────────────────────────────────────────────────────
console.log(`\nprobe-channel-commission-cents: ${pass} passed, ${fail} failed`);
if (fail) {
  console.log('FAILED: channel commission contract');
  console.log('FAILURES:\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
console.log(`PASSED: ${pass} passed, 0 failed`);
