/**
 * PROBE: owner-facing money aggregates that must reconcile to the cent were
 * summed with a float `reduce((a, x) => a + x.field, 0)` over cent-exact dollar
 * values, re-introducing IEEE-754 residue into the total.
 *
 * ROOT CAUSE (money-math audit, 2026-08-27). Two surfaces float-summed
 * per-row cent-exact dollars into an owner-facing headline:
 *
 *   src/components/dashboard/PropertyRanking.jsx
 *     const totalRev = stats.reduce((a, s) => a + s.revenue, 0);
 *     → "Portfolio Total" revenue cell (money()), plus portfolioAdr/RevPar.
 *
 *   src/pages/Transactions.jsx
 *     const humanRevenue = employeeStats(...).reduce((a, e) => a + e.revenue, 0);
 *     const automatedRevenue = stats.revenue - humanRevenue;   // float a - b
 *     → "Written by people" / "Written by automation" KPIs (money2 — cents shown).
 *
 * A float sum of N cent-exact dollar values can land a fraction of a cent off
 * the integer-cent total, and the two halves of the people/automation split can
 * then fail to add back to stats.revenue. Both are owner-facing money, so both
 * must be summed in integer cents (sumCents/fromCents) and the remainder derived
 * with subtract().
 *
 * WHAT THIS PROBE DOES
 *   §1 EXECUTION — proves the defect was real and the cent path is exact: on a
 *      fixture of per-row values carrying binary residue, the old float reduce
 *      drifts off the whole-cent total while sumCents/fromCents lands on it, and
 *      the people/automation split reconciles exactly via subtract().
 *   §2 SOURCE CONTRACT — pins that both files dropped the float reduce over a
 *      money field and now aggregate via sumCents/fromCents (+ subtract).
 *
 * RUN (imports @/lib/decimal via the alias loader):
 *   node --import ./scripts/_loader-boot.mjs scripts/probe-owner-money-float-sums.mjs
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './_repo-root.mjs';

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

const { toCents, fromCents, sumCents, subtract } = await import('@/lib/decimal');

// ── §1 execution ─────────────────────────────────────────────────────────────
console.log('§1 execution — float reduce drifts, cent path is exact');

// Per-property revenues whose RAW float sum carries residue: 0.1 + 0.2 in
// IEEE-754 is 0.30000000000000004, not 0.30. Display rounding (toCents) later
// masks it, but any intermediate use of the raw total (e.g. portfolioAdr =
// totalRev / roomsSold) divides the drifting value.
const perProperty = [0.1, 0.2];

const floatTotal = perProperty.reduce((a, v) => a + v, 0);
const centTotal = fromCents(sumCents(perProperty));

ok('raw float portfolio total carries binary residue',
  floatTotal !== centTotal && floatTotal !== 0.3,
  `float ${floatTotal} vs cent-exact ${centTotal}`);

ok('cent portfolio total is whole cents (0.30)',
  sumCents(perProperty) === 30 && centTotal === fromCents(30),
  `cent total ${centTotal} (${sumCents(perProperty)} cents)`);

// People / automation split: humanRevenue summed in cents, automated as the
// remainder via subtract(). The two halves must add back to the whole exactly.
const totalRevenue = 250.05;
const employeeRevenues = [0.1, 0.2, 33.33, 66.66];
const humanRevenue = fromCents(sumCents(employeeRevenues));
const automatedRevenue = fromCents(subtract(totalRevenue, humanRevenue));

ok('people + automation reconcile to total in cents',
  toCents(humanRevenue) + toCents(automatedRevenue) === toCents(totalRevenue),
  `human ${humanRevenue} + automated ${automatedRevenue} != total ${totalRevenue}`);

// The old float remainder would inherit residue from the float humanRevenue.
const floatHuman = employeeRevenues.reduce((a, v) => a + v, 0);
const floatAutomated = totalRevenue - floatHuman;
ok('old float split could drift off the cent',
  toCents(floatHuman) + toCents(floatAutomated) !== toCents(totalRevenue)
    || floatHuman !== humanRevenue,
  `float human ${floatHuman}, cent human ${humanRevenue}`);

console.log(`  portfolio ${centTotal} · human ${humanRevenue} · automated ${automatedRevenue}`);

// ── §2 source contract ───────────────────────────────────────────────────────
console.log('§2 source contract — both surfaces sum owner money in cents');

function read(rel) {
  return readFileSync(path.join(REPO, rel), 'utf8');
}

{
  const rel = 'src/components/dashboard/PropertyRanking.jsx';
  const src = read(rel);
  ok(`${rel} dropped the float revenue reduce`,
    !/=\s*stats\.reduce\(\s*\(a,\s*s\)\s*=>\s*a\s*\+\s*s\.revenue/.test(src),
    'still sums revenue with a float reduce');
  ok(`${rel} sums revenue via sumCents/fromCents`,
    /fromCents\s*\(\s*sumCents\s*\(/.test(src),
    'totalRev is not fromCents(sumCents(...))');
}

{
  const rel = 'src/pages/Transactions.jsx';
  const src = read(rel);
  ok(`${rel} dropped the float employee-revenue reduce`,
    !/reduce\(\s*\(a,\s*e\)\s*=>\s*a\s*\+\s*e\.revenue/.test(src),
    'still sums humanRevenue with a float reduce');
  ok(`${rel} derives automatedRevenue via subtract()`,
    /automatedRevenue\s*=\s*fromCents\s*\(\s*subtract\s*\(/.test(src),
    'automatedRevenue is not fromCents(subtract(...))');
  ok(`${rel} sums humanRevenue via sumCents/fromCents`,
    /humanRevenue[\s\S]{0,120}fromCents\s*\(\s*sumCents\s*\(/.test(src),
    'humanRevenue is not fromCents(sumCents(...))');
}

// ── Summary ────────────────────────────────────────────────────────────────
console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
if (fail) {
  console.log('FAILURES:\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
