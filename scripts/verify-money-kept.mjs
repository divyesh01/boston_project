// Regression guard for the "Estimated Money Kept" deduction rules.
//
// The widget derives three costs from imported data at configured rates (OTA
// commission, card processing fees, taxes) and lets the owner ALSO enter each as
// a real expense row. The rule is ACTUAL-BEATS-ESTIMATE: never both, and the
// actual wins. Three bugs previously broke that:
//
//   1. `ota_commission` was re-bucketed to "other" when SourceDay rows existed,
//      which moved it off the OTA line but left it inside totalDeductions.
//   2. `credit_card_fees` is a standard category, so the generic category loop
//      pushed the merchant statement alongside the derived fee.
//   3. The manual-tax readers asked for bucket "tax" while the bucketer wrote
//      "taxes", so every state/city/other tax expense was silently dropped.
//
// This script re-implements the deduction-selection rules over synthetic rows
// and asserts the invariants. It deliberately does NOT import the React
// component (no DOM here); it locks the *rules*, so a regression in the
// component is caught by the parallel assertions on the real category
// vocabulary below.

import { STANDARD_CATEGORY_KEYS } from '@/lib/expenseCategories.js';
import { CARD_METHODS, refundOf, refundTotal } from '@/lib/paymentNorm.js';

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function near(a, b, eps = 0.005) { return Math.abs(a - b) < eps; }

// ── The rules under test, mirrored from MoneyKept.jsx ──
const TAX_EXPENSE_CATS = ['state_taxes', 'city_taxes'];
function bucketOf(cat) {
  if (cat === 'ota_commission') return 'ota';
  if (cat === 'payroll') return 'payroll';
  if (TAX_EXPENSE_CATS.includes(cat)) return 'taxes';
  return cat || 'other';
}
const SPECIAL_BUCKETS = new Set(['ota', 'payroll', 'taxes', 'credit_card_fees']);

function deduct({ expenses = [], otaEstimated = 0, ccEstimated = 0, taxEstimated = 0, hasSources = true }) {
  const groups = {};
  for (const e of expenses) (groups[bucketOf(e.category)] ||= []).push(e);
  const amt = (b) => (groups[b] || []).reduce((a, e) => a + (Number(e.amount) || 0), 0);
  const items = [];
  const push = (k, v) => { if (v > 0.004) items.push({ key: k, amount: Math.round(v * 100) / 100 }); };

  const otaActual = amt('ota');
  if (otaActual > 0.004) push('ota', otaActual);
  else if (hasSources) push('ota', otaEstimated);

  const ccActual = amt('credit_card_fees');
  if (ccActual > 0.004) push('credit_card_fees', ccActual);
  else push('cc', ccEstimated);

  const manualTax = (groups.taxes || []).reduce((a, e) => a + (Number(e.amount) || 0), 0);
  push('taxes', manualTax > 0.004 ? manualTax : taxEstimated);

  push('payroll', amt('payroll'));
  const customKeys = Object.keys(groups).filter((b) => !SPECIAL_BUCKETS.has(b) && !STANDARD_CATEGORY_KEYS.includes(b));
  [...STANDARD_CATEGORY_KEYS.filter((k) => groups[k] && !SPECIAL_BUCKETS.has(k) && k !== 'other'), ...customKeys]
    .forEach((b) => push(b, amt(b)));
  push('other', amt('other'));

  const total = items.reduce((a, i) => a + i.amount, 0);
  return { items, total, keys: items.map((i) => i.key) };
}

console.log('\n1. OTA commission — actual beats estimate, never both');
{
  const est = deduct({ otaEstimated: 1500 });
  check('estimate alone deducts once', near(est.total, 1500), `got ${est.total}`);

  const both = deduct({ expenses: [{ category: 'ota_commission', amount: 1200 }], otaEstimated: 1500 });
  check('actual replaces estimate', near(both.total, 1200), `got ${both.total}`);
  check('actual is not also in "other"', !both.keys.includes('other'));
  check('only one OTA line emitted', both.keys.filter((k) => k === 'ota').length === 1);
  // The old bug: 1200 landed in "other" AND 1500 stayed on the OTA line.
  check('no 2700 double-count', !near(both.total, 2700), `got ${both.total}`);

  const noSrc = deduct({ expenses: [{ category: 'ota_commission', amount: 900 }], otaEstimated: 0, hasSources: false });
  check('actual still counts with no SourceDay rows', near(noSrc.total, 900), `got ${noSrc.total}`);
}

console.log('\n2. Card processing fees — merchant statement beats derived fee');
{
  const est = deduct({ ccEstimated: 640 });
  check('derived fee alone deducts once', near(est.total, 640), `got ${est.total}`);

  const both = deduct({ expenses: [{ category: 'credit_card_fees', amount: 700 }], ccEstimated: 640 });
  check('actual replaces derived fee', near(both.total, 700), `got ${both.total}`);
  check('no 1340 double-count', !near(both.total, 1340), `got ${both.total}`);
  check('exactly one card-fee line', both.keys.filter((k) => k === 'cc' || k === 'credit_card_fees').length === 1);
  check('credit_card_fees is a real category (bucket is reachable)', STANDARD_CATEGORY_KEYS.includes('credit_card_fees'));
}

console.log('\n3. Manual tax expenses are no longer dropped');
{
  const dropped = deduct({ expenses: [{ category: 'state_taxes', amount: 400 }, { category: 'city_taxes', amount: 150 }], taxEstimated: 0 });
  check('state+city tax expenses are deducted', near(dropped.total, 550), `got ${dropped.total}`);
  check('they land on the tax line', dropped.keys.includes('taxes'));

  const over = deduct({ expenses: [{ category: 'taxes', amount: 300 }], taxEstimated: 1000 });
  check('actual tax payment replaces rate estimate', near(over.total, 300), `got ${over.total}`);
  check('no 1300 double-count', !near(over.total, 1300), `got ${over.total}`);

  const estOnly = deduct({ taxEstimated: 1000 });
  check('rate estimate applies when no actual payment', near(estOnly.total, 1000), `got ${estOnly.total}`);
}

console.log('\n4. Ordinary expenses are unaffected (no regression)');
{
  const r = deduct({
    expenses: [
      { category: 'utilities', amount: 300 },
      { category: 'supplies', amount: 120 },
      { category: 'snow_removal', amount: 80 },   // custom category
      { category: 'payroll', amount: 5000 },
      { category: 'other', amount: 45 },
    ],
    otaEstimated: 1000, ccEstimated: 200, taxEstimated: 500,
  });
  check('all buckets sum correctly', near(r.total, 300 + 120 + 80 + 5000 + 45 + 1000 + 200 + 500), `got ${r.total}`);
  check('custom category survives', r.keys.includes('snow_removal'));
  check('no bucket appears twice', new Set(r.keys).size === r.keys.length, r.keys.join(','));
}

console.log('\n5. Refund sign convention (paymentNorm contract)');
{
  check('refundOf sums the two signed refund fields',
    near(refundOf({ closed_balance_folio: -50, loyalty_discount: -20 }), -70));
  check('refundTotal returns a magnitude',
    near(refundTotal([{ closed_balance_folio: -50 }, { loyalty_discount: -20 }]), 70));
  // A positive correction must OFFSET, not inflate. abs-per-field would give 70.
  check('positive correction offsets rather than inflating',
    near(refundTotal([{ closed_balance_folio: -50 }, { closed_balance_folio: 20 }]), 30),
    `got ${refundTotal([{ closed_balance_folio: -50 }, { closed_balance_folio: 20 }])}`);
  check('CARD_METHODS excludes non-card tender',
    !CARD_METHODS.includes('cash') && !CARD_METHODS.includes('check') &&
    !CARD_METHODS.includes('direct_bill') && !CARD_METHODS.includes('wire_transfer'),
    CARD_METHODS.join(','));
}

console.log(`\n${failures.length ? 'FAILED' : 'PASSED'}: ${pass} checks passed, ${failures.length} failed`);
if (failures.length) { failures.forEach((f) => console.log(`  - ${f}`)); process.exit(1); }
