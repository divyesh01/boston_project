/**
 * PROBE: the credit-card fee must round half-up on the exact cent, and it must
 * be charged on CARD volume only.
 *
 * $33.50 at 3% is 1.005 dollars exactly. A float pipeline that formats to two
 * decimals shaves that to $1.00 and quietly under-reports the fee on every
 * settlement; the integer-cent path rounds half-up to $1.01. That original
 * intent is unchanged and is still asserted below.
 *
 * FIXTURE UPDATED 2026-08-20 — and why the probe was stale, not the product:
 * ---------------------------------------------------------------------------
 * This fixture used to be `{ total: 33.50, cash: 0, check: 0 }`, which expressed
 * "there was $33.50 of card volume" by relying on calculateMoneyKept deriving
 * card volume as `total - cash - check`. That derivation was the defect: it
 * charged a card processing fee on direct_bill, corpay, wire_transfer, loyalty
 * certificates, vip passes and closed-balance folios — none of which touch a card
 * processor. The basis is now CARD_METHODS (visa/master/amex/discover), which is
 * what MoneyKept.jsx:187, actionCenter.js and verify-money-kept.mjs already
 * agreed on; this one line was the outlier. So the fixture now says $33.50 of
 * VISA, which is what it always meant.
 *
 * BEST OUTCOME NOTE: the second scenario below is new and makes the probe
 * strictly stronger than the version it replaces — it pins the basis as well as
 * the rounding, so re-deriving card volume from `total` fails here instead of
 * passing. Charging on named card methods also fails SAFE: an unrecognised
 * payment method attracts no fee rather than a fabricated one.
 */
import { CalculationService } from '../src/lib/calculationService.js';
import * as commissionRates from '../src/lib/commissionRates.js';

if (!globalThis.localStorage) {
  const store = {};
  globalThis.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
}

commissionRates.setCcFeeRate(0.03);
commissionRates.setCcFeeOnRefunds(false);

const RANGE = { from: '2023-01-01', to: '2023-01-01' };
const moneyKept = (payRows) => CalculationService.calculateMoneyKept(
  [{ room_revenue: 100.0 }], [], [], payRows, [], [], RANGE, 'all',
);

let failed = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failed += 1;
};

console.log('--- PROBE: MONEY KEPT CARD-FEE ROUNDING AND BASIS ---');

console.log('\n1. a half-cent card fee rounds up, not down');
{
  const res = moneyKept([{ total: 33.5, visa: 33.5, cash: 0, check: 0 }]);
  check('$33.50 of visa at 3% is $1.01, not $1.00', res.ccFees === 1.01, `got ${res.ccFees}`);
  check('the fee reaches totalDeductions unrounded-down', res.totalDeductions === 1.01, `got ${res.totalDeductions}`);
  check('money kept is exactly 100.00 - 1.01', res.kept === 98.99, `got ${res.kept}`);
}

console.log('\n2. the fee is charged on card volume only');
{
  // Same $33.50 settled, but through a channel no card processor sees. Under the
  // old `total - cash - check` basis this produced an identical $1.01 fee.
  const res = moneyKept([{ total: 33.5, direct_bill: 33.5, cash: 0, check: 0 }]);
  check('a direct-bill settlement attracts no card fee', res.ccFees === 0, `got ${res.ccFees}`);
  check('so nothing is deducted from the owner', res.kept === 100, `got ${res.kept}`);
}

console.log('\n3. many small card charges do not drift');
{
  // 1000 x $0.07 of amex is exactly $70.00 of volume; 3% of that is exactly $2.10.
  // A float accumulator reaches 69.99999999999966 here (measured).
  const rows = Array.from({ length: 1000 }, () => ({ total: 0.07, amex: 0.07, cash: 0, check: 0 }));
  const res = moneyKept(rows);
  check('1000 x $0.07 of amex is billed as exactly $2.10', res.ccFees === 2.1, `got ${res.ccFees}`);
}

if (failed > 0) {
  console.error(`\nFAIL: ${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nPASSED: all checks passed');
process.exit(0);
