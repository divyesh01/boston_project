import { CalculationService } from '../src/lib/calculationService.js';
import * as commissionRates from '../src/lib/commissionRates.js';

if (!globalThis.localStorage) {
  const store = {};
  globalThis.localStorage = {
    getItem: (k) => store[k] || null,
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; }
  };
}

commissionRates.setCcFeeRate(0.03);
commissionRates.setCcFeeOnRefunds(false);

const payRows = [
  { total: 33.50, cash: 0, check: 0 }
];
const occRows = [
  { room_revenue: 100.00 }
];

const res = CalculationService.calculateMoneyKept(
  occRows, [], [], payRows, [], [], { from: '2023-01-01', to: '2023-01-01' }, 'all'
);

console.log('--- PROBE: MONEY KEPT FLOAT MATH ---');
console.log('Calculated CC Fees: $', res.ccFees);
console.log('Total Deductions:   $', res.totalDeductions);
console.log('Money Kept:         $', res.kept);

if (res.totalDeductions === 1.00) {
    console.error('? FAIL: Penny-shaving precision loss detected! totalDeductions is .00, should be .01');
    process.exit(1);
} else if (res.totalDeductions === 1.01) {
    console.log('? PASS: Float math is correct or using cents.');
    process.exit(0);
} else {
    console.error('? UNKNOWN RESULT:', res.totalDeductions);
    process.exit(1);
}
