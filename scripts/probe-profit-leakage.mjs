// Regression guard: OwnerIntelligenceService.detectProfitLeakage must not count money
// it has no right to count.
//
// The "High Expense Ratio" leak is rendered on the Dashboard as a headline dollar
// figure (Dashboard.jsx -> generateExecutiveInsights -> money(totalLeakage)). Two
// defects once inflated it, and this probe now holds both closed:
//
//   1. NO COMMITTED FILTER. It used to sum every PayrollRun, including `draft`.
//      payrollCalc.js states the contract explicitly: "Every consumer that deducts
//      payroll from revenue MUST filter through filterCommittedPay/sumCommittedPay".
//      A half-typed draft run silently moved an owner-facing profit number.
//      FIXED — ownerIntelligence.js now calls filterCommittedPay.
//
//   2. NO DATE SCOPE. detectProfitLeakage took no dateRange, so payroll and expenses
//      were summed over ALL TIME while grossRevenue came from period-scoped occRows.
//      Dashboard.jsx fetches PayrollRun with no date filter and a limit of 100000, so
//      with a year of payroll on file a narrow filter fabricated both the ratio and
//      its dollar amount. FIXED — the function takes `dateRange` and scopes both
//      cost arrays through inRange.
//
// Both are now asserted below rather than merely described, so a regression fails here
// instead of reaching an owner. Section 6 additionally pins integer-cent exactness, so
// float drift in the reported overage also fails here.
//
// Run: node --import ./scripts/_loader-boot.mjs scripts/probe-profit-leakage.mjs

let pass = 0, fail = 0;
const T = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`); }
};

const { OwnerIntelligenceService } = await import("@/lib/ownerIntelligence");
const { sumCommittedPay } = await import("@/lib/payrollCalc");

const RANGE = { from: "2026-03-01", to: "2026-03-31" };

// $100,000 of revenue inside the period.
//
// The revenue field is `room_revenue`, NOT `total_revenue`. Known problem #3 was
// exactly this typo in product code ("Money Kept shows $0"), and this fixture kept
// the pre-fix spelling long after `detectProfitLeakage` was corrected to read
// `room_revenue`. The effect was a probe that reported a product defect that did not
// exist: gross came out 0, so the expense-ratio branch could never fire and 10 of 14
// assertions failed with `NaN%` / `amount=undefined`. Keep this spelling aligned with
// src/lib/ownerIntelligence.js:250 (`sumCents(occRows.map(r => r.room_revenue))`).
const occRows = [
  { property_id: "P1", date: "2026-03-10", room_revenue: 50000, rooms_sold: 100, occupancy: 0.8 },
  { property_id: "P1", date: "2026-03-20", room_revenue: 50000, rooms_sold: 100, occupancy: 0.8 },
];

// Payment rows that collect exactly the revenue, so the unrelated "Payment
// Variance" branch stays quiet and cannot be confused with the ratio branch.
const payRows = [
  { property_id: "P1", date: "2026-03-10", total: 50000, cash: 0, check: 0 },
  { property_id: "P1", date: "2026-03-20", total: 50000, cash: 0, check: 0 },
];

const ratioLeak = (leaks) => leaks.find((l) => l.type === "High Expense Ratio");
const pct = (leak) => {
  const m = /costs are ([\d.]+)% of revenue/.exec(leak?.description || "");
  return m ? Number(m[1]) : NaN;
};

console.log("\n=== 1. A draft payroll run must not move an owner-facing profit number ===");
const draftOnly = [
  { property_id: "P1", pay_period_start: "2026-03-01", total_pay: 70000, payroll_status: "draft" },
];
T("sanity: the contract helper agrees a draft commits nothing",
  sumCommittedPay(draftOnly) === 0, `got ${sumCommittedPay(draftOnly)}`);

const leaksDraft = OwnerIntelligenceService.detectProfitLeakage(
  occRows, payRows, [], draftOnly, [], [], RANGE,
);
T("no High Expense Ratio leak fires for a draft-only payroll",
  ratioLeak(leaksDraft) === undefined,
  `fired with amount=${ratioLeak(leaksDraft)?.amount} desc="${ratioLeak(leaksDraft)?.description}"`);

console.log("\n=== 2. Approved and paid runs DO count ===");
for (const status of ["approved", "paid"]) {
  const committed = [
    { property_id: "P1", pay_period_start: "2026-03-01", total_pay: 70000, payroll_status: status },
  ];
  const leaks = OwnerIntelligenceService.detectProfitLeakage(
    occRows, payRows, [], committed, [], [], RANGE,
  );
  const leak = ratioLeak(leaks);
  T(`${status}: leak fires`, leak !== undefined);
  T(`${status}: ratio is 70.0% of revenue`, Math.abs(pct(leak) - 70) < 0.05, `got ${pct(leak)}%`);
  // 70,000 - (100,000 * 0.65) = 5,000 over the target.
  T(`${status}: amount is the $5,000 overage, to the cent`,
    leak && Math.abs(leak.amount - 5000) < 0.005, `got ${leak?.amount}`);
}

console.log("\n=== 3. A draft mixed with committed runs contributes nothing ===");
const mixed = [
  { property_id: "P1", pay_period_start: "2026-03-01", total_pay: 70000, payroll_status: "paid" },
  { property_id: "P1", pay_period_start: "2026-03-05", total_pay: 999999, payroll_status: "draft" },
];
const leaksMixed = ratioLeak(OwnerIntelligenceService.detectProfitLeakage(
  occRows, payRows, [], mixed, [], [], RANGE,
));
T("the draft is excluded from the ratio", Math.abs(pct(leaksMixed) - 70) < 0.05, `got ${pct(leaksMixed)}%`);
T("the draft is excluded from the dollar amount",
  leaksMixed && Math.abs(leaksMixed.amount - 5000) < 0.005, `got ${leaksMixed?.amount}`);

console.log("\n=== 4. Payroll outside the period must not count against period revenue ===");
const outOfPeriod = [
  { property_id: "P1", pay_period_start: "2026-03-01", total_pay: 30000, payroll_status: "paid" },
  { property_id: "P1", pay_period_start: "2025-08-01", total_pay: 500000, payroll_status: "paid" }, // last year
];
const leaksOut = ratioLeak(OwnerIntelligenceService.detectProfitLeakage(
  occRows, payRows, [], outOfPeriod, [], [], RANGE,
));
// 30,000 / 100,000 = 30% -> under the 65% target, so NO leak may fire.
T("last year's payroll does not fabricate a leak against this month's revenue",
  leaksOut === undefined,
  `fired with amount=${leaksOut?.amount} desc="${leaksOut?.description}"`);

console.log("\n=== 5. Expenses are period-scoped the same way ===");
const expenses = [
  { property_id: "P1", expense_date: "2026-03-15", amount: 70000, category: "supplies" },
  { property_id: "P1", expense_date: "2025-08-15", amount: 500000, category: "supplies" },
];
const leaksExp = ratioLeak(OwnerIntelligenceService.detectProfitLeakage(
  occRows, payRows, expenses, [], [], [], RANGE,
));
T("only the in-period expense counts", Math.abs(pct(leaksExp) - 70) < 0.05, `got ${pct(leaksExp)}%`);

console.log("\n=== 6. Integer-cent exactness on the reported overage ===");
// Three thirds of a cent apiece: float addition of these drifts, cents do not.
const centsPayroll = [
  { property_id: "P1", pay_period_start: "2026-03-02", total_pay: 21666.67, payroll_status: "paid" },
  { property_id: "P1", pay_period_start: "2026-03-03", total_pay: 21666.67, payroll_status: "paid" },
  { property_id: "P1", pay_period_start: "2026-03-04", total_pay: 21666.66, payroll_status: "approved" },
];
const leakCents = ratioLeak(OwnerIntelligenceService.detectProfitLeakage(
  occRows, payRows, [], centsPayroll, [], [], RANGE,
));
// 65,000.00 total - 65,000.00 target = exactly 0, so the ratio is exactly 65%
// and must NOT trip the strictly-greater-than test.
T("65,000.00 of committed pay against 100,000.00 is exactly 65% and does not fire",
  leakCents === undefined, `fired with amount=${leakCents?.amount} pct=${pct(leakCents)}`);

const overBy1c = [
  { property_id: "P1", pay_period_start: "2026-03-02", total_pay: 65000.01, payroll_status: "paid" },
];
const leak1c = ratioLeak(OwnerIntelligenceService.detectProfitLeakage(
  occRows, payRows, [], overBy1c, [], [], RANGE,
));
T("one cent over the target fires, and the overage is exactly $0.01",
  leak1c !== undefined && Math.abs(leak1c.amount - 0.01) < 0.0005,
  `amount=${leak1c?.amount}`);

console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
