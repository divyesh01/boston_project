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
 *   §1 EXECUTION — proves the engine is cent-exact under the authoritative model:
 *      persisted `net_revenue` IS the gross booked revenue, so the engine derives
 *      commission = round(net * rate) per channel and net kept = gross − commission.
 *      On a fixture whose net rows carry IEEE-754 residue (0.1 + 0.2 =
 *      0.30000000000000004), a naive float accumulation drifts off the cent, while
 *      the engine sums net in integer cents (toCents) first, so gross, commission,
 *      and net are all whole-cent and reconcile exactly.
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
const { setCommissionRates } = await import('@/lib/commissionRates');

// Deterministic rate card: a percentage channel and a zero-commission direct one.
setCommissionRates({
  EXPEDIA: { type: 'percentage', rate: 0.5, taxExempt: false },
  DIRECT: { type: 'percentage', rate: 0, taxExempt: false },
});

// Rows chosen so a naive FLOAT accumulation of net carries IEEE-754 residue:
// EXPEDIA's two net rows are 0.1 + 0.2 = 0.30000000000000004 in float, but the
// engine sums net in integer cents (10 + 20 = 30c) before grossing up.
const srcRows = [
  { source: 'EXPEDIA', net_revenue: 0.1, stays: 1, date: '2026-01-01' },
  { source: 'EXPEDIA', net_revenue: 0.2, stays: 1, date: '2026-01-02' },
  { source: 'DIRECT', net_revenue: 100.1, stays: 1, date: '2026-01-03' },
  { source: 'DIRECT', net_revenue: 0.15, stays: 1, date: '2026-01-04' },
];

const engine = CalculationService.calculateChannelMetrics(srcRows);
const engExp = engine.find((c) => c.source === 'EXPEDIA');
const engDir = engine.find((c) => c.source === 'DIRECT');

console.log('§1 execution — engine is cent-exact; net_revenue IS gross booked revenue');

// A naive float accumulation of EXPEDIA's net rows carries binary residue.
const floatNet = (Number(srcRows[0].net_revenue) || 0) + (Number(srcRows[1].net_revenue) || 0);
ok('naive float net accumulation carries binary residue',
  floatNet !== 0.3,
  `float net was exactly ${floatNet} (expected the 0.30000000000000004 residue)`);

// net_revenue IS the gross booked revenue; the engine sums it in integer cents:
// 10c + 20c = 30c → exactly 0.30, not the 0.30000000000000004 float residue.
ok('engine EXPEDIA gross is cent-exact 0.30 (= net_revenue)',
  toCents(engExp.gross) === 30 && engExp.gross === fromCents(30),
  `engine gross was ${engExp.gross} (${toCents(engExp.gross)} cents)`);

// commission is a cost = round(net * rate) = round(30c * 0.5) = 15c, whole cents.
ok('engine EXPEDIA commission = round(net * rate) = 0.15',
  toCents(engExp.commission) === 15 && engExp.commission === fromCents(15),
  `engine commission was ${engExp.commission} (${toCents(engExp.commission)} cents)`);

// net kept = gross − commission = 30c − 15c = 15c, a whole number of cents.
ok('engine EXPEDIA net kept = gross − commission = 0.15',
  toCents(engExp.net) === 15 && engExp.net === fromCents(15),
  `engine net was ${engExp.net} (${toCents(engExp.net)} cents)`);

// A 0% channel is NOT grossed up: gross === net, commission === 0.
ok('engine DIRECT (0%) gross === net, commission === 0',
  toCents(engDir.gross) === toCents(engDir.net) && toCents(engDir.commission) === 0,
  `DIRECT gross ${engDir.gross}, net ${engDir.net}, commission ${engDir.commission}`);

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

// ── §3 CommissionsPanel delegation ───────────────────────────────────────────
// CommissionsPanel re-implemented the same float channel aggregation under
// different variable names (`e.revenue += Number(r.net_revenue)`, then
// `commission = e.revenue * rule.rate`) feeding the "Channel commission" and
// "Total cost of sale" KPIs. It must now delegate to the same engine so its
// numbers reconcile to the cent with the OTA Channels page.
console.log('§3 source contract — CommissionsPanel delegates to the engine');

{
  const rel = 'src/components/transactions/CommissionsPanel.jsx';
  const src = read(rel);
  ok(`${rel} calls CalculationService.calculateChannelMetrics`,
    /CalculationService\.calculateChannelMetrics\s*\(/.test(src),
    'no call to the cent-exact engine found');
  ok(`${rel} dropped the float revenue accumulator`,
    !/\.revenue\s*\+=\s*Number\(\s*r\.net_revenue/.test(src),
    'still accumulates revenue with float += Number(r.net_revenue)');
  ok(`${rel} dropped the float commission = revenue * rule.rate`,
    !/=\s*e\.revenue\s*\*\s*rule\.rate/.test(src),
    'still computes commission with float e.revenue * rule.rate');
  ok(`${rel} aggregates totals in cents (sumCents/fromCents)`,
    /sumCents\s*\(/.test(src) && /fromCents\s*\(/.test(src),
    'totals are not summed via sumCents/fromCents');
  ok(`${rel} dropped the float channel total reduce`,
    !/channels\.reduce\(\s*\(a,\s*c\)\s*=>\s*a\s*\+\s*c\.(commission|revenue)/.test(src),
    'still reduces channel totals in float');
}

// ── Summary ────────────────────────────────────────────────────────────────
console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
if (fail) {
  console.log('FAILURES:\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
