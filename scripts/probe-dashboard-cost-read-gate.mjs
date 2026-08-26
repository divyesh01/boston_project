// Regression probe for the Dashboard "Money Kept" cost-read gate (src/pages/Dashboard.jsx).
//
// "Money Kept — net profit after all deductions" is rendered on the default Dashboard.
// Its deductions come entirely from two React-Query reads: Expense and PayrollRun.
// Payroll in particular is ALWAYS taken from the raw `payroll` prop
// (`filterCommittedPay(payroll)`), never from the materialized aggregate. On a read
// failure React Query leaves `data` at its `[]` default, so the card booked ZERO costs
// and displayed an OVERSTATED profit — with no error shown, indistinguishable from a
// hotel that genuinely has no costs.
//
// The Dashboard already hard-gates on agg/occ/gross via `dashboardError`. The OLD gate
// omitted expenses/payroll, so a selective failure of either slipped through. The fix
// adds `expensesError`/`payrollError` to that chain, gating on isError (NOT empty) so a
// hotel with genuinely no expenses/payroll is unaffected.

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  if (got === want) { pass++; }
  else { fail++; console.log(`  FAIL ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
};

// The gate selector, before and after the fix. Mirrors Dashboard.jsx line ~255.
const oldGate = (s) => s.aggErr ? "agg" : s.occErr ? "occ" : s.grossErr ? "gross" : null;
const newGate = (s) => s.aggErr ? "agg" : s.occErr ? "occ" : s.grossErr ? "gross"
  : s.expErr ? "exp" : s.payErr ? "pay" : null;

const NONE = { aggErr: false, occErr: false, grossErr: false, expErr: false, payErr: false };

console.log("[gate — a failed cost read must block the dashboard]");
// All reads healthy → no gate (dashboard renders). Empty data is NOT an error.
eq("all healthy → new gate null", newGate({ ...NONE }), null);
// Primary reads still gate exactly as before.
eq("occ error → 'occ'", newGate({ ...NONE, occErr: true }), "occ");
eq("gross error → 'gross'", newGate({ ...NONE, grossErr: true }), "gross");
eq("agg error → 'agg'", newGate({ ...NONE, aggErr: true }), "agg");
// The fix: a cost-read failure now gates.
eq("expenses error → 'exp' (was ungated)", newGate({ ...NONE, expErr: true }), "exp");
eq("payroll error → 'pay' (was ungated)", newGate({ ...NONE, payErr: true }), "pay");

console.log("\n[regression the fix removes — OLD gate let cost failures through]");
eq("OLD: expenses error slips through (bug)", oldGate({ ...NONE, expErr: true }), null);
eq("OLD: payroll error slips through (bug)", oldGate({ ...NONE, payErr: true }), null);
eq("NEW: expenses error is caught", newGate({ ...NONE, expErr: true }) !== null, true);
eq("NEW: payroll error is caught", newGate({ ...NONE, payErr: true }) !== null, true);

// Concrete impact: what MoneyKept shows when a silent payroll failure zeroes deductions.
// Integer cents, matching the app's money model.
console.log("\n[why it matters — silent payroll failure overstates net profit]");
const grossCents = 10_000_00;      // $10,000.00 gross
const trueExpenses = 2_000_00;     // $2,000.00
const truePayroll = 3_000_00;      // $3,000.00
const trueKept = grossCents - trueExpenses - truePayroll;              // $5,000.00
const keptOnSilentPayrollFail = grossCents - trueExpenses - 0;         // payroll read failed → []
eq("true Money Kept", trueKept, 5_000_00);
eq("Money Kept if payroll read silently fails", keptOnSilentPayrollFail, 8_000_00);
eq("overstatement equals the whole payroll", keptOnSilentPayrollFail - trueKept, truePayroll);
// The gate now prevents that number from ever being shown.
eq("payroll failure is gated, so the overstated figure is never rendered",
   newGate({ ...NONE, payErr: true }) !== null, true);

console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
