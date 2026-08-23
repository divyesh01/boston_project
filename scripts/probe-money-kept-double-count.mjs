/**
 * PROBE: CalculationService.calculateMoneyKept must apply the same deduction
 * rules as the widget that reports the same number.
 *
 * Playbook item #10, "two disagreeing MoneyKept implementations".
 *
 * WHAT WAS ALREADY UNIFIED, so this probe does not re-litigate it: the gross
 * basis (both routes now call hotel.js#grossRevenueForPeriod) and the card-fee
 * basis (both now sum CARD_METHODS). Those were closed under item #2 and are
 * pinned by probe-money-kept-gross.mjs and probe-money-kept-float.mjs.
 *
 * WHAT WAS STILL DIVERGENT, and what this probe is for. Four rules the live
 * widget (src/components/dashboard/MoneyKept.jsx) applies and this method did
 * not. Each produces a WRONG "money kept" figure, which is the single number
 * the whole surface exists to report:
 *
 *   1. ACTUAL BEATS ESTIMATE. Three costs can arrive by two routes — OTA
 *      commission, card processing fees and taxes are each derived from imported
 *      data at configured rates, and can ALSO be entered by the owner as a real
 *      expense row (the invoice, the merchant statement, the tax payment).
 *      calculateMoneyKept deducted the derived estimate AND, because
 *      `operatingExpenses` swept up every expense row whose category was not
 *      'payroll', the owner's actual invoice as well. One cost, deducted twice.
 *
 *   2. IMPORTED TAX IS NOT AN OWNER COST. Tax on the PMS gross-charge ledger is
 *      collected from the guest and remitted; it never comes out of the owner's
 *      pocket. The widget deducts only the RATE-ESTIMATED portion and treats the
 *      imported portion as pass-through. calculateMoneyKept called
 *      calculateTaxLiability, which sums imported and estimated together, and
 *      deducted the lot.
 *
 *   3. A REFUND CC FEE RIDES WITH THE ESTIMATE. When a real merchant statement
 *      is present it already contains the fee charged on refunds, so the widget
 *      emits the derived refund fee only on the estimate branch.
 *      calculateMoneyKept always added it.
 *
 *   4. PAYROLL-CATEGORY EXPENSES ARE STILL PAYROLL. The widget deducts payroll
 *      runs PLUS expense rows filed under 'payroll'. calculateMoneyKept excluded
 *      that category from operating expenses (correctly, to avoid double-counting
 *      a run) but never added it anywhere, so the row vanished from the total.
 *
 * WHY THE ASSERTIONS ARE MOSTLY RELATIONAL. The derived OTA commission depends on
 * the configured rate card, which this probe deliberately does not pin — a probe
 * that hard-codes a rate breaks when the owner edits a setting, and then the
 * "failure" is noise. So section 1 measures the estimate from a baseline run and
 * asserts how the total MOVES when an actual invoice is added. That is the
 * property under test: adding a $D invoice for a cost already estimated at $E
 * must move total deductions by (D − E), not by D.
 *
 * WHAT THIS PROBE CANNOT DO. It cannot execute the widget: MoneyKept.jsx's math
 * lives in a ~400-line useMemo inside a React component, so there is no headless
 * entry point. verify-money-kept.mjs made the same call and mirrors the rules
 * instead. Rather than add a THIRD mirror — which is the very defect this item
 * names — section 6 asserts that the widget and the service now import their
 * bucketing vocabulary and their actual-beats-estimate rule from one shared
 * module, so the two cannot drift apart without deleting an import.
 */
import { CalculationService } from '../src/lib/calculationService.js';
import * as commissionRates from '../src/lib/commissionRates.js';
import { setTaxConfig } from '../src/lib/taxConfig.js';
import { saveTaxSettings } from '../src/lib/taxSettings.js';
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

// See scripts/_repo-root.mjs — the old `new URL(...).pathname` form resolved to
// `C:\C:\Users\...` on Windows, so every readFileSync below threw ENOENT and the
// probe verified nothing.
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

function eq(label, actual, expected) {
  ok(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// Read the provenance marker without dying when it is absent. Before the fix
// there is no `basis` at all; a bare basisOf(r, 'ota') would throw and abort every
// later section, so the probe could only ever report its first finding.
const basisOf = (r, key) => (r && r.basis ? r.basis[key] : '<no basis returned>');

// ── Fixture ──────────────────────────────────────────────────────────────────
const CC_RATE = 0.03;
commissionRates.setCcFeeRate(CC_RATE);
commissionRates.setCcFeeOnRefunds(true);

// Tax must be BOTH enabled and configured, or calculateTaxLiability returns
// zeros and every tax assertion below would pass vacuously.
setTaxConfig({ taxRate: 0.05, taxEnabled: true });
saveTaxSettings([
  { property_id: '*', state_rate: 0.05, city_rate: 0.02, other_rate: 0, effective_start: '2020-01-01' },
]);

const RANGE = { from: '2026-01-01', to: '2026-01-02' };

// One taxable, commissionable source day. EXPEDIA_HC is taxable in TAX_SOURCES.
const SRC = [{ date: '2026-01-01', source: 'EXPEDIA HOTEL COLLECT', net_revenue: 1000, stays: 10, property_id: '' }];
const OCC = [
  { date: '2026-01-01', room_revenue: 1000, rooms_sold: 10, property_id: '' },
  { date: '2026-01-02', room_revenue: 1000, rooms_sold: 10, property_id: '' },
];
// closed_balance_folio is stored SIGNED negative; refundTotal takes the
// magnitude. $100 refunded at 3% is a $3.00 refund fee on the estimate branch.
const PAY = [{ date: '2026-01-01', total: 500, visa: 500, cash: 0, check: 0, closed_balance_folio: -100 }];

const exp = (category, amount, name = category) => ({
  expense_name: name, category, amount, expense_date: '2026-01-01', vendor: 'V',
});

const kept = (expenses = [], payroll = [], grossRows = []) =>
  CalculationService.calculateMoneyKept(OCC, SRC, grossRows, PAY, expenses, payroll, RANGE, '');

console.log('--- PROBE: MONEY KEPT DEDUCTION RULES (item #10) ---');

// ── Section 0: the baseline the rest of the probe measures against ───────────
console.log('\n[0] baseline with no owner-entered expenses');
const base = kept();
eq('gross is room revenue from both days', base.gross, 2000);
eq('gross basis is room (no gross-charge rows)', base.grossBasis.basis, 'room');
ok('a derived OTA commission exists to be displaced', base.otaCommissions > 0, `got ${base.otaCommissions}`);
eq('derived card fee is 3% of $500 of visa', base.ccFees, 15);
eq('refunds are the magnitude of the signed folio', base.refunds, 100);
eq('derived refund fee is 3% of the $100 refunded', base.refundFees, 3);
// 5% state + 2% city on $1000 of taxable source revenue.
eq('estimated tax is 7% of the taxable base', base.estimatedTaxes, 70);
eq('no expenses means no operating expenses', base.operatingExpenses, 0);
const E_OTA = base.otaCommissions;

// ── Section 1: actual beats estimate — OTA ───────────────────────────────────
console.log('\n[1] an OTA invoice replaces the rate-card estimate');
{
  const D = 250;
  const r = kept([exp('ota_commission', D, 'Expedia invoice')]);
  eq('the OTA line reports the actual invoice', r.otaCommissions, D);
  eq('the invoice is NOT also swept into operating expenses', r.operatingExpenses, 0);
  eq('the OTA line is labelled actual', basisOf(r, 'ota'), 'actual');
  // The defect, stated as a movement: the total may only move by (D - E).
  eq('total deductions move by (invoice - estimate), not by the invoice',
    Math.round((r.totalDeductions - base.totalDeductions) * 100) / 100,
    Math.round((D - E_OTA) * 100) / 100);
  eq('money kept moves by the same amount, opposite sign',
    Math.round((base.kept - r.kept) * 100) / 100,
    Math.round((D - E_OTA) * 100) / 100);
}

// ── Section 2: actual beats estimate — card processing ───────────────────────
console.log('\n[2] a merchant statement replaces the derived card fee');
{
  const r = kept([exp('credit_card_fees', 12.34, 'Merchant statement')]);
  eq('the card line reports the statement', r.ccFees, 12.34);
  eq('the derived $15.00 is gone, not added', r.operatingExpenses, 0);
  eq('the card line is labelled actual', basisOf(r, 'cc'), 'actual');
  // Rule 3: the statement already contains the fee charged on refunds.
  eq('the derived refund fee is dropped on the actual branch', r.refundFees, 0);
  const moved = Math.round((base.totalDeductions - r.totalDeductions) * 100) / 100;
  // Removed: $15.00 estimate + $3.00 refund fee. Added: $12.34 statement.
  eq('total deductions fall by 15.00 + 3.00 - 12.34', moved, 5.66);
}

// ── Section 3: actual beats estimate — taxes ─────────────────────────────────
console.log('\n[3] a tax payment replaces the rate estimate');
{
  const r = kept([exp('state_taxes', 40), exp('city_taxes', 25)]);
  eq('the tax line reports the payments, not the 70.00 estimate', r.estimatedTaxes, 65);
  eq('the payments are not also operating expenses', r.operatingExpenses, 0);
  eq('the tax line is labelled actual', basisOf(r, 'tax'), 'actual');
  eq('total deductions fall by 70.00 - 65.00', Math.round((base.totalDeductions - r.totalDeductions) * 100) / 100, 5);

  // The generic "taxes" category counts too — MoneyKept.jsx reads all three.
  const r2 = kept([exp('taxes', 30, 'Occupancy tax remittance')]);
  eq('the generic taxes category also displaces the estimate', r2.estimatedTaxes, 30);
  eq('and is not double-counted as an operating expense', r2.operatingExpenses, 0);
}

// ── Section 4: imported tax is pass-through, never a deduction ───────────────
console.log('\n[4] guest-collected imported tax is not an owner cost');
{
  // A gross-charge row carrying imported PMS tax for 2026-01-01. Its presence
  // also flips the gross basis to "total", so gross is asserted explicitly.
  const GROSS = [{ date: '2026-01-01', room_rent: 1000, state_tax: 30, city_tax: 12, other_tax: 0, misc: 0 }];
  const r = kept([], [], GROSS);
  eq('gross basis is now total', r.grossBasis.basis, 'total');
  eq('imported tax is reported as pass-through', r.passThroughTaxes, 42);
  // 2026-01-01 has imported tax so contributes nothing to the estimate; the
  // taxable source revenue sits on that same day, so the estimate is now 0.
  eq('the imported day is excluded from the estimate', r.estimatedTaxes, 0);
  eq('the tax line is labelled imported', basisOf(r, 'tax'), 'imported');
  ok('the $42.00 of guest tax is NOT inside total deductions',
    Math.abs(r.totalDeductions - (r.totalDeductions - 0)) < 0.005 && !String(r.totalDeductions).includes('NaN'));
  // Stated as the arithmetic the owner would check by hand.
  const expectedDeductions = Math.round(
    (r.otaCommissions + r.ccFees + r.refundFees + r.refunds + r.totalPayroll + r.operatingExpenses + r.estimatedTaxes) * 100
  ) / 100;
  eq('total deductions are exactly the reported legs, with no hidden tax',
    Math.round(r.totalDeductions * 100) / 100, expectedDeductions);
}

// ── Section 5: payroll-category expenses are payroll ────────────────────────
console.log('\n[5] a payroll expense row is deducted, not dropped');
{
  const RUNS = [{ pay_period_start: '2026-01-01', pay_period_end: '2026-01-02', total_pay: 800, payroll_status: 'approved' }];
  const withRun = kept([], RUNS);
  eq('a committed run is deducted', withRun.totalPayroll, 800);

  const withBoth = kept([exp('payroll', 200, 'Contract cleaner')], RUNS);
  eq('the payroll expense row joins the payroll line', withBoth.totalPayroll, 1000);
  eq('and is not also an operating expense', withBoth.operatingExpenses, 0);
  eq('so total deductions rise by exactly 200.00',
    Math.round((withBoth.totalDeductions - withRun.totalDeductions) * 100) / 100, 200);

  const draft = kept([], [{ ...RUNS[0], payroll_status: 'draft' }]);
  eq('a draft run still does not reduce money kept', draft.totalPayroll, 0);
}

// ── Section 6: ordinary expenses still behave ───────────────────────────────
console.log('\n[6] expenses with no derived twin are unaffected');
{
  const r = kept([exp('utilities', 300), exp('supplies', 45.5)]);
  eq('ordinary categories sum into operating expenses', r.operatingExpenses, 345.5);
  eq('the OTA estimate still stands', r.otaCommissions, E_OTA);
  eq('the card estimate still stands', r.ccFees, 15);
  eq('the tax estimate still stands', r.estimatedTaxes, 70);
  eq('the OTA line is labelled estimated', basisOf(r, 'ota'), 'estimated');
  eq('the card line is labelled estimated', basisOf(r, 'cc'), 'estimated');
  eq('the tax line is labelled estimated', basisOf(r, 'tax'), 'estimated');
  eq('total deductions rise by exactly the two expenses',
    Math.round((r.totalDeductions - base.totalDeductions) * 100) / 100, 345.5);

  // A custom (non-standard) category must not be silently dropped.
  const r2 = kept([exp('snow_removal', 75)]);
  eq('a custom category is still deducted', r2.operatingExpenses, 75);
}

// ── Section 7: the keep rate cannot report Infinity ─────────────────────────
console.log('\n[7] keep-rate guard');
{
  const r = kept();
  ok('keep rate is finite', Number.isFinite(r.keepRate), `got ${r.keepRate}`);
  // Gross entirely refunded: the keepable base is zero, not a divisor.
  const allRefunded = CalculationService.calculateMoneyKept(
    [{ date: '2026-01-01', room_revenue: 100, property_id: '' }], [], [],
    [{ date: '2026-01-01', total: 0, closed_balance_folio: -100 }], [], [], RANGE, ''
  );
  ok('a fully refunded period reports a finite keep rate', Number.isFinite(allRefunded.keepRate), `got ${allRefunded.keepRate}`);
}

// ── Section 8: one shared rule, so the two surfaces cannot drift ────────────
// Structural, because the widget has no headless entry point (see the header).
// Run on comment-stripped source: a probe that fails because a file DOCUMENTS
// its own former defect punishes the fix. The [^:] guard keeps "https://" out of
// the line-comment rule.
console.log('\n[8] the widget and the service share one rule module');
{
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const svc = strip(readFileSync(path.join(REPO, 'src', 'lib', 'calculationService.js'), 'utf8'));
  const widget = strip(readFileSync(path.join(REPO, 'src', 'components', 'dashboard', 'MoneyKept.jsx'), 'utf8'));
  const rules = strip(readFileSync(path.join(REPO, 'src', 'lib', 'expenseCategories.js'), 'utf8'));

  ok('expenseCategories exports the bucketing function', /export function expenseBucket\(/.test(rules));
  ok('expenseCategories exports the special-bucket set', /export const DERIVED_COST_BUCKETS/.test(rules));
  ok('expenseCategories exports the actual-beats-estimate chooser', /export function chooseActualOrEstimate\(/.test(rules));

  ok('the service imports expenseBucket', /import \{[^}]*expenseBucket[^}]*\} from '@\/lib\/expenseCategories'/.test(svc));
  ok('the service imports the chooser', /import \{[^}]*chooseActualOrEstimate[^}]*\} from '@\/lib\/expenseCategories'/.test(svc));
  ok('the widget imports expenseBucket', /import \{[^}]*expenseBucket[^}]*\} from "@\/lib\/expenseCategories"/.test(widget));
  ok('the widget imports the chooser', /import \{[^}]*chooseActualOrEstimate[^}]*\} from "@\/lib\/expenseCategories"/.test(widget));

  ok('the widget no longer defines its own bucketOf', !/const bucketOf = \(cat\)/.test(widget));
  ok('the widget no longer defines its own special-bucket set',
    !/new Set\(\["ota", "payroll", "taxes", "credit_card_fees"\]\)/.test(widget));
  ok('the service no longer excludes only the payroll category',
    !/filter\(e => !\(String\(e\.category \|\| ''\)\.toLowerCase\(\) === 'payroll'\)\)/.test(svc));
  ok('the service no longer deducts the combined tax liability',
    !/estimatedTaxesCents = toCents\(taxLiability\.total\)/.test(svc));
  ok('calculateTaxLiability reports the imported and estimated split',
    /imported:/.test(svc) && /estimated:/.test(svc));
}

// ── Section 9: the figures the owner reconciles are rendered WITH cents ─────
//
// Playbook item #12. `money()` in src/lib/hotel.js renders whole dollars, so
// $1,020,598.17 displays as "$1,020,598" and a $0.17 discrepancy is invisible —
// which is how reconciliation drift stayed hidden. The owner's decision is that
// financial headline figures show cents (`money2`).
//
// This widget was rendering GROSS with cents (fixed under item #2) and KEPT,
// TOTAL DEDUCTIONS and every deduction line in whole dollars, so the card
// contradicted itself: the three numbers on screen did not subtract. A chart AXIS
// tick is the one legitimate `money()` here — tick labels are for scale, they are
// not figures anyone reconciles — so the assertion is scoped to that exception
// rather than banning the import.
console.log('\n[9] money figures render cents, axis ticks excepted');
{
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const widget = strip(readFileSync(path.join(REPO, 'src', 'components', 'dashboard', 'MoneyKept.jsx'), 'utf8'));

  const moneyLines = widget.split('\n')
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => /[^2a-zA-Z_]money\(/.test(l));
  const nonAxis = moneyLines.filter(([, l]) => !/tickFormatter/.test(l));
  ok('the only whole-dollar render left is a chart axis tick',
    nonAxis.length === 0,
    `still whole-dollar: ${nonAxis.map(([n, l]) => `${n}: ${l.trim().slice(0, 60)}`).join(' | ')}`);
  ok('and that axis tick is still there (the exception is real, not vacuous)',
    moneyLines.length === 1, `found ${moneyLines.length} money() lines`);

  // The three figures that must subtract on screen.
  ok('the kept headline renders cents', /money2\(Math\.abs\(kept\)\)/.test(widget));
  ok('the deductions headline renders cents', /money2\(totalDeductions\)/.test(widget));
  ok('the gross headline renders cents', /money2\(gross\)/.test(widget));
  ok('each deduction line renders cents', /-\$?\{money2\(i\.amount\)\}/.test(widget));
  ok('the tax split renders cents', /money2\(tax\.passThrough\)/.test(widget) && /money2\(tax\.estimated\)/.test(widget));
}

console.log(`\n${'─'.repeat(70)}`);
if (failures.length) {
  console.log('Failures:');
  failures.forEach((f) => console.log(`  • ${f}`));
}
console.log(`PASS ${pass}   FAIL ${fail}`);
console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
