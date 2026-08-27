// Probe for "Payroll.jsx aggregates persisted pay dollars with float `reduce`".
//
// Root cause (src/pages/Payroll.jsx, before fix): the KPI row and the "Actual"
// month breakdown summed stored PayrollRun dollar fields with raw float `+`:
//
//   const totalPay = payroll.reduce((a, p) => a + (p.total_pay || 0), 0);
//   const totalOT  = payroll.reduce((a, p) => a + (p.overtime_pay || 0), 0);
//   regular: actual.reduce((a, p) => a + (p.regular_pay || 0), 0), ...
//   const postedTotal = recordsToCreate.reduce((a, r) => a + (Number(r.total_pay)||0), 0);
//
// total_pay/overtime_pay/bonus/deductions are recorded dollars that must total
// to the exact cent (they feed the "Total Payroll"/"Deductions" KPIs and the
// audit-log posted total). Float accumulation reintroduces IEEE-754 residue.
// The fix routes each through fromCents(sumCents(rows.map(...))) — the same
// cent-exact pattern payrollCalc.sumCommittedPay already uses. This probe
// reproduces the residue and proves the replacement removes it.
//
// Run: node --import ./scripts/_loader-boot.mjs scripts/probe-payroll-cent-aggregation.mjs

let pass = 0;
let fail = 0;
const T = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`); }
};

const { sumCents, fromCents } = await import("@/lib/decimal");

// Three runs whose total_pay values are individually cent-exact but sum with
// float residue: 0.1 + 0.2 = 0.30000000000000004.
const payroll = [
  { total_pay: 0.1, overtime_pay: 0.1, bonus: 0.1, deductions: 0.1, regular_pay: 0.1 },
  { total_pay: 0.2, overtime_pay: 0.2, bonus: 0.2, deductions: 0.2, regular_pay: 0.2 },
];

const oldTotalPay = payroll.reduce((a, p) => a + (p.total_pay || 0), 0);
T("old float reduce does NOT yield an exact 0.3 (residue reproduced)",
  oldTotalPay !== 0.3, `old totalPay = ${oldTotalPay}`);

const field = (rows, k) => fromCents(sumCents(rows.map((p) => p[k] || 0)));
T("cent-exact totalPay is exactly 0.3", field(payroll, "total_pay") === 0.3, `got ${field(payroll, "total_pay")}`);
T("cent-exact totalOT is exactly 0.3", field(payroll, "overtime_pay") === 0.3);
T("cent-exact totalBonus is exactly 0.3", field(payroll, "bonus") === 0.3);
T("cent-exact totalDeductions is exactly 0.3", field(payroll, "deductions") === 0.3);
T("cent-exact regular is exactly 0.3", field(payroll, "regular_pay") === 0.3);
T("all results are finite numbers",
  ["total_pay", "overtime_pay", "bonus", "deductions", "regular_pay"].every((k) => {
    const v = field(payroll, k);
    return typeof v === "number" && Number.isFinite(v);
  }));

// String amounts from an import must coerce, not concatenate.
const strung = [{ total_pay: "0.10" }, { total_pay: "0.20" }];
T("string total_pay coerces to 0.3, not a concatenated string",
  field(strung, "total_pay") === 0.3, `got ${field(strung, "total_pay")}`);

console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
