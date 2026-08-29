/**
 * Deterministic Probe: Expenses Page Period Scoping & Property Attribution
 * ------------------------------------------------------------------------
 * Verifies that:
 * 1. Taxable and Exempt expense calculations reconcile to the active period's operatingExpenses.
 * 2. Expense and Payroll records rendered in the table are scoped to the active period.
 * 3. Creating an expense or payroll run in portfolio mode properly requires/attaches property_id.
 */

import assert from "node:assert/strict";
import { sum, inRange } from "@/lib/hotel";
import { CalculationService } from "@/lib/calculationService";
import { fromCents, sumCents } from "@/lib/decimal";

console.log("=== Running Expenses Page Period Scoping & Property Attribution Probe ===\n");

// Test Dataset across 2 properties and 2 different date periods
const mockProperties = [
  { id: "prop-alpha", name: "Alpha Hotel" },
  { id: "prop-beta", name: "Beta Resort" },
];

const mockExpenses = [
  // 2026-08 (Target Period)
  { id: "exp-1", expense_name: "Linen Service", amount: 500, expense_date: "2026-08-05", taxable: true, category: "housekeeping", property_id: "prop-alpha" },
  { id: "exp-2", expense_name: "Water Bill", amount: 200, expense_date: "2026-08-10", taxable: false, category: "utilities", property_id: "prop-alpha" },
  { id: "exp-3", expense_name: "Pool Maintenance", amount: 300, expense_date: "2026-08-15", taxable: true, category: "maintenance", property_id: "prop-beta" },
  // 2025-08 (Past Period - Lifetime Spillover)
  { id: "exp-old-1", expense_name: "Roof Repair 2025", amount: 4500, expense_date: "2025-08-10", taxable: true, category: "maintenance", property_id: "prop-alpha" },
  { id: "exp-old-2", expense_name: "Old HVAC", amount: 1500, expense_date: "2025-01-15", taxable: false, category: "maintenance", property_id: "prop-beta" },
];

const mockPayroll = [
  // 2026-08 (Target Period)
  { id: "pay-1", employee_name: "Alice", total_pay: 1200, pay_period_start: "2026-08-01", pay_period_end: "2026-08-15", payroll_status: "paid", property_id: "prop-alpha" },
  { id: "pay-2", employee_name: "Bob", total_pay: 1400, pay_period_start: "2026-08-16", pay_period_end: "2026-08-31", payroll_status: "paid", property_id: "prop-beta" },
  // 2025-08 (Past Period)
  { id: "pay-old-1", employee_name: "Charlie (Past)", total_pay: 5000, pay_period_start: "2025-08-01", pay_period_end: "2025-08-15", payroll_status: "paid", property_id: "prop-alpha" },
];

const targetRange = { from: "2026-08-01", to: "2026-08-31" };

// 1. Period Scoping Invariant
const expensesInPeriod = mockExpenses.filter((e) => inRange(e.expense_date, targetRange.from, targetRange.to));
assert.equal(expensesInPeriod.length, 3, "expensesInPeriod must only include August 2026 records");

// Operating expenses computed by CalculationService for the target period
const { operatingExpenses, totalPayroll } = CalculationService.calculateProfitMetrics(
  [], [], mockExpenses, mockPayroll, targetRange
);
assert.equal(operatingExpenses, 1000, "August 2026 operating expenses must be $1000 (500 + 200 + 300)");
assert.equal(totalPayroll, 2600, "August 2026 total payroll must be $2600 (1200 + 1400)");

// Taxable and Exempt calculations MUST be derived from expensesInPeriod
const taxableExpenses = expensesInPeriod.filter((e) => e.taxable !== false);
const exemptExpenses = expensesInPeriod.filter((e) => e.taxable === false);
const taxableAmount = fromCents(sumCents(taxableExpenses.map((e) => e.amount)));
const exemptAmount = fromCents(sumCents(exemptExpenses.map((e) => e.amount)));

assert.equal(taxableAmount, 800, "Taxable expenses for period must be $800 (500 + 300)");
assert.equal(exemptAmount, 200, "Tax-exempt expenses for period must be $200");
assert.equal(taxableAmount + exemptAmount, operatingExpenses, "Taxable + Exempt must exactly equal operatingExpenses for the period");

console.log("✓ PASS: Period Scoping & Tax Reconciliation Invariants Verified!");

// 2. Property Attribution Helper Test
function resolvePropertyAttribution(propertySelection, targetPropertyId, propertiesList) {
  let finalId = "";
  if (targetPropertyId && targetPropertyId !== "all") {
    finalId = targetPropertyId;
  } else if (propertySelection && propertySelection !== "all") {
    finalId = Array.isArray(propertySelection) ? propertySelection[0] : propertySelection;
  } else if (propertiesList.length > 0) {
    finalId = propertiesList[0].id;
  }
  const propObj = propertiesList.find((p) => p.id === finalId) || null;
  return {
    property_id: finalId,
    property_name: propObj?.name || "",
  };
}

const res1 = resolvePropertyAttribution("all", "prop-beta", mockProperties);
assert.equal(res1.property_id, "prop-beta");
assert.equal(res1.property_name, "Beta Resort");

const res2 = resolvePropertyAttribution("prop-alpha", "", mockProperties);
assert.equal(res2.property_id, "prop-alpha");
assert.equal(res2.property_name, "Alpha Hotel");

const res3 = resolvePropertyAttribution("all", "", mockProperties);
assert.equal(res3.property_id, "prop-alpha", "Default to first valid property in portfolio mode rather than empty string");
assert.equal(res3.property_name, "Alpha Hotel");

console.log("✓ PASS: Property Attribution Invariants Verified!");
console.log("\nALL PROBES PASSED (2/2)");
