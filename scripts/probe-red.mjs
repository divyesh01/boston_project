import { toCents, fromCents } from '../src/lib/decimal.js';
import { calculatePay } from '@/lib/payrollCalc';

console.log("--- RED-1: Floating-Point Math in AutoPayroll ---");

let passed = 0;
let failed = 0;

function check(condition, name) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}`);
  }
}

// Test case: 15.15 * 8.5 hours (classic floating-point drift)
const baseRate = 15.15;
const hours = 8.5;
console.log(`\nBase rate: ${baseRate}, Hours: ${hours}`);
console.log("Raw JS (old):          ", baseRate * hours, "→ displayed:", (baseRate * hours).toFixed(2));
const baseRateCents = toCents(baseRate);
const regularPayCents = Math.round(baseRateCents * hours);
console.log("Cents math (new):      ", fromCents(regularPayCents), "→ displayed:", fromCents(regularPayCents).toFixed(2));

// Frozen reference copy of the pre-fix float implementation, retained only to demonstrate the delta
function calculatePayOld({ pay_type, base_rate, hours = 0, overtime_hours = 0, overtime_rate, bonus = 0, deductions = 0 }) {
  const br = Number(base_rate) || 0;
  const hrs = Number(hours) || 0;
  const otHrs = Number(overtime_hours) || 0;
  const otRate = Number(overtime_rate) || br * 1.5;
  const bns = Number(bonus) || 0;
  const ded = Number(deductions) || 0;
  const regularPay = pay_type === "salary" ? br : br * hrs;
  const overtimePay = otHrs * otRate;
  const totalPay = regularPay + overtimePay + bns - ded;
  return { regular_pay: regularPay, overtime_pay: overtimePay, total_pay: totalPay };
}

// Test calculatePay with hourly
console.log("\n--- calculatePay (hourly) ---");
const hourlyNew = calculatePay({
  pay_type: "hourly", base_rate: 15.15, hours: 8.5,
  overtime_hours: 2.5, overtime_rate: 22.725, bonus: 10.01, deductions: 5.55,
});
const hourlyOld = calculatePayOld({
  pay_type: "hourly", base_rate: 15.15, hours: 8.5,
  overtime_hours: 2.5, overtime_rate: 22.725, bonus: 10.01, deductions: 5.55,
});
console.log("New cents-math:");
console.log("  regular_pay:", hourlyNew.regular_pay, "→ displayed:", hourlyNew.regular_pay.toFixed(2));
console.log("  overtime_pay:", hourlyNew.overtime_pay, "→ displayed:", hourlyNew.overtime_pay.toFixed(2));
console.log("  total_pay:", hourlyNew.total_pay, "→ displayed:", hourlyNew.total_pay.toFixed(2));
console.log("Old floating-point:");
console.log("  regular_pay:", hourlyOld.regular_pay, "→ displayed:", hourlyOld.regular_pay.toFixed(2));
console.log("  overtime_pay:", hourlyOld.overtime_pay, "→ displayed:", hourlyOld.overtime_pay.toFixed(2));
console.log("  total_pay:", hourlyOld.total_pay, "→ displayed:", hourlyOld.total_pay.toFixed(2));

// Accumulation test: 200 rows of 15.15 * 8.5
console.log("\n--- Accumulation test: 200 rows ---");
let oldSum = 0;
let newSum = 0;
for (let i = 0; i < 200; i++) {
  oldSum += 15.15 * 8.5;
  newSum += fromCents(Math.round(toCents(15.15) * 8.5));
}
console.log("Old floating-point sum:", oldSum.toFixed(2));
console.log("New cents-math sum:    ", newSum.toFixed(2));
console.log("Difference:            ", Math.abs(oldSum - newSum).toFixed(6));

const expected = fromCents(Math.round(toCents(15.15) * 8.5)) * 200;
console.log("Expected (cents*200):  ", expected.toFixed(2));
check(Math.abs(newSum - expected) < 0.001, "200-row accumulation matches expected cents math");

// Test salary pay type
console.log("\n--- calculatePay (salary) ---");
const salary = calculatePay({
  pay_type: "salary", base_rate: 3500.00, hours: 0, bonus: 100.50, deductions: 250.75,
});
check(salary.regular_pay === 3500, "salary regular_pay is 3500.00");
check(salary.total_pay === 3349.75, "salary total_pay is 3349.75");

// Verify cents math produces clean .2 decimals
console.log("\n--- Precision edge cases ---");
const edge1 = calculatePay({ pay_type: "hourly", base_rate: 0.10, hours: 3 });
check(edge1.regular_pay === 0.30, "$0.10 * 3h regular_pay is 0.30");

const edge2 = calculatePay({ pay_type: "hourly", base_rate: 99.99, hours: 40 });
check(edge2.regular_pay === 3999.60, "$99.99 * 40h regular_pay is 3999.60");

// Explicit new assertions
console.log("\n--- Explicit regression cases ---");
const explicitHourly = calculatePay({ pay_type: "hourly", base_rate: 25, hours: 40 });
check(explicitHourly.regular_pay === 1000, "hourly base_rate 25 * 40h regular_pay is 1000");

const explicitSalary = calculatePay({ pay_type: "salary", base_rate: 3000, hours: 40 });
check(explicitSalary.regular_pay === 3000, "salary base_rate 3000 with 40h regular_pay is 3000 (not 120000)");

if (failed === 0) {
  console.log(`PASSED: ${passed} passed, ${failed} failed`);
} else {
  console.log(`FAILED: ${passed} passed, ${failed} failed`);
}

process.exit(failed > 0 ? 1 : 0);

