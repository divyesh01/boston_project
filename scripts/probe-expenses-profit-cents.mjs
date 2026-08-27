// Probe for "Expenses.jsx computes operating profit with uncoerced float
// reduces instead of the cent-exact CalculationService".
//
// Root cause (src/pages/Expenses.jsx, before fix):
//   operatingExpenses = expensesInPeriod
//     .filter(e => e.category !== "payroll")
//     .reduce((a, e) => a + (e.amount || 0), 0);
//
// `e.amount` is never coerced. When an Expense.amount arrives from a CSV import
// as the STRING "1250.00", `a + "1250.00"` turns the accumulator into a string,
// every later row concatenates, and the final money render / toCents() of the
// non-finite result collapses to $0 — operating expenses silently vanish from
// operating profit. The inline code also excludes payroll-category expense rows
// and then adds them back NOWHERE, so a contract-cleaner invoice falls out of
// totalCosts entirely and overstates profit.
//
// CalculationService.calculateProfitMetrics fixes both: it routes amounts through
// sum()/sumCents() (which coerce via toCents) and re-adds the payroll bucket to
// the payroll line. This probe proves the service is correct on exactly the
// inputs that break the inline version, and demonstrates the old pattern failing
// on the same fixture so the fix is not a no-op.
//
// Run: node --import ./scripts/_loader-boot.mjs scripts/probe-expenses-profit-cents.mjs

let pass = 0;
let fail = 0;
const T = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`); }
};

const { CalculationService } = await import("@/lib/calculationService");

const dateRange = { from: "2026-01-01", to: "2026-01-31" };

// One night of room revenue, no refunds.
const occRows = [{ date: "2026-01-10", room_revenue: 10000 }];
const payRows = [];
const payroll = [];

// The dangerous input: an operating expense whose amount is a STRING, exactly as
// a CSV import stores it, plus a numeric one.
const expenses = [
  { expense_date: "2026-01-05", category: "utilities", amount: "1250.00" }, // string
  { expense_date: "2026-01-06", category: "supplies", amount: 750.5 },       // number
];

// ── 1. The old inline pattern silently corrupts on a string amount ───────────
const oldOperatingExpenses = expenses
  .filter((e) => e.category !== "payroll")
  .reduce((a, e) => a + (e.amount || 0), 0);
// 0 + "1250.00" => "01250.00", + 750.5 => "01250.00750.5" — a string, not 2000.5.
T("the old inline reduce does NOT produce the correct 2000.5 (bug reproduced)",
  oldOperatingExpenses !== 2000.5,
  `old reduce yielded ${JSON.stringify(oldOperatingExpenses)} (${typeof oldOperatingExpenses})`);

// ── 2. calculateProfitMetrics coerces the string and sums exactly ────────────
const m = CalculationService.calculateProfitMetrics(occRows, payRows, expenses, payroll, dateRange);
T("operatingExpenses is the exact numeric sum 2000.5",
  m.operatingExpenses === 2000.5,
  `got ${JSON.stringify(m.operatingExpenses)} (${typeof m.operatingExpenses})`);
T("operatingExpenses is a finite number, not a string",
  typeof m.operatingExpenses === "number" && Number.isFinite(m.operatingExpenses));
T("netRevenue is exact (10000, no refunds)", m.netRevenue === 10000, `got ${m.netRevenue}`);
T("totalCosts = payroll(0) + operating(2000.5)", m.totalCosts === 2000.5, `got ${m.totalCosts}`);
T("operatingProfit = 10000 - 2000.5 = 7999.5", m.operatingProfit === 7999.5, `got ${m.operatingProfit}`);

// ── 3. Payroll-category expense rows are re-added, not dropped ───────────────
const withPayrollExpense = [
  { expense_date: "2026-01-05", category: "utilities", amount: 1000 },
  { expense_date: "2026-01-07", category: "payroll", amount: 500 }, // contract cleaner
];
const m2 = CalculationService.calculateProfitMetrics(occRows, payRows, withPayrollExpense, payroll, dateRange);
T("a payroll-category expense lands in totalPayroll, not discarded",
  m2.totalPayroll === 500, `totalPayroll=${m2.totalPayroll}`);
T("operating expenses exclude the payroll-bucket row", m2.operatingExpenses === 1000, `got ${m2.operatingExpenses}`);
T("totalCosts counts both (1000 + 500)", m2.totalCosts === 1500, `got ${m2.totalCosts}`);

// ── 4. No floating-point residue on a value that trips naive subtraction ─────
// 0.10 + 0.20 - 0.30 must be exactly 0, not 5.55e-17.
const cents = CalculationService.calculateProfitMetrics(
  [{ date: "2026-01-10", room_revenue: 0.3 }],
  [], [{ expense_date: "2026-01-05", category: "supplies", amount: 0.1 },
       { expense_date: "2026-01-06", category: "supplies", amount: 0.2 }],
  [], dateRange,
);
T("operatingProfit is exactly 0 (0.30 - 0.10 - 0.20), no float residue",
  cents.operatingProfit === 0, `got ${cents.operatingProfit}`);

console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
