import { toCents, fromCents } from '../src/lib/decimal.js';

console.log("--- RED-1: Floating-Point Math in AutoPayroll ---");

// Test case: 15.15 * 8.5 hours (classic floating-point drift)
const baseRate = 15.15;
const hours = 8.5;
console.log(`\nBase rate: ${baseRate}, Hours: ${hours}`);
console.log("Raw JS (old):          ", baseRate * hours, "→ displayed:", (baseRate * hours).toFixed(2));
const baseRateCents = toCents(baseRate);
const regularPayCents = Math.round(baseRateCents * hours);
console.log("Cents math (new):      ", fromCents(regularPayCents), "→ displayed:", fromCents(regularPayCents).toFixed(2));

// Replicate calculatePay logic with cents math (since Vite alias doesn't work in Node)
function calculatePayFixed({ pay_type, base_rate, hours = 0, overtime_hours = 0, overtime_rate, bonus = 0, deductions = 0 }) {
  const br = Number(base_rate) || 0;
  const hrs = Number(hours) || 0;
  const otHrs = Number(overtime_hours) || 0;
  const otRate = Number(overtime_rate) || br * 1.5;
  const bns = Number(bonus) || 0;
  const ded = Number(deductions) || 0;

  const baseRateCents = toCents(br);
  const regularPayCents = pay_type === "salary" ? baseRateCents : Math.round(baseRateCents * hrs);
  const overtimePayCents = Math.round(toCents(otRate) * otHrs);
  const bonusCents = toCents(bns);
  const deductionsCents = toCents(ded);
  const totalPayCents = regularPayCents + overtimePayCents + bonusCents - deductionsCents;

  return {
    base_rate: br, hours: hrs, overtime_hours: otHrs, overtime_rate: otRate,
    regular_pay: fromCents(regularPayCents), overtime_pay: fromCents(overtimePayCents),
    bonus: bns, deductions: ded, total_pay: fromCents(totalPayCents),
  };
}

// Old floating-point version for comparison
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
const hourlyNew = calculatePayFixed({
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
console.log("Match:", Math.abs(newSum - expected) < 0.001 ? "PASS ✓" : "FAIL ✗");

// Test salary pay type
console.log("\n--- calculatePay (salary) ---");
const salary = calculatePayFixed({
  pay_type: "salary", base_rate: 3500.00, hours: 0, bonus: 100.50, deductions: 250.75,
});
console.log("regular_pay:", salary.regular_pay, "→ expected 3500.00", salary.regular_pay === 3500 ? "PASS ✓" : "FAIL ✗");
console.log("total_pay:", salary.total_pay, "→ expected 3349.75", salary.total_pay === 3349.75 ? "PASS ✓" : "FAIL ✗");

// Verify cents math produces clean .2 decimals
console.log("\n--- Precision edge cases ---");
const edge1 = calculatePayFixed({ pay_type: "hourly", base_rate: 0.10, hours: 3 });
console.log("$0.10 × 3h =", edge1.regular_pay, "→ expected 0.30", edge1.regular_pay === 0.30 ? "PASS ✓" : "FAIL ✗");

const edge2 = calculatePayFixed({ pay_type: "hourly", base_rate: 99.99, hours: 40 });
console.log("$99.99 × 40h =", edge2.regular_pay, "→ expected 3999.60", edge2.regular_pay === 3999.60 ? "PASS ✓" : "FAIL ✗");

console.log("\n--- All RED-1 checks completed ---");
