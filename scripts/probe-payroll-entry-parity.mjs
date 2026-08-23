// scripts/probe-payroll-entry-parity.mjs — the two manual payroll entry forms must
// compute pay the SAME way, through the one shared function.
//
// WHY THIS EXISTS. This repo has two places an owner can type a payroll run by hand:
// src/pages/Payroll.jsx ("Add Entry") and src/pages/Expenses.jsx ("Add Payroll").
// Payroll.jsx routed its arithmetic through calculatePay in src/lib/payrollCalc.js.
// Expenses.jsx hand-rolled its own three lines instead, and they were not equivalent:
//
//     const reg   = (Number(form.base_rate) || 0) * (Number(form.hours) || 0);
//     const otPay = (Number(form.base_rate) || 0) * 1.5 * (Number(form.overtime_hours) || 0);
//     const total = reg + otPay + (Number(form.bonus) || 0) - (Number(form.deductions) || 0);
//
// There is no pay_type branch in that code. The form offers a Salary option, and its
// hours field defaults to "40" and is rendered for every pay type. So an owner
// recording a salaried employee at $3,000 got regular_pay = 3000 * 40 = $120,000
// written to the ledger — the period salary multiplied by the hours box, a 40x
// overstatement — stored alongside pay_type: "salary", which asserts the opposite.
// calculatePay's documented contract is that "salary" treats base_rate as the WHOLE
// period amount. Two further defects rode along in the same create() call: the
// arithmetic was raw float `*` and `+` on dollars, and overtime_hours was the one
// numeric field the handler never coerced, so it persisted as the string "0" against
// a schema that declares it `"type": "number"`.
//
// The fix is not better arithmetic here — it is deleting the arithmetic and calling
// the shared function. This suite therefore checks two things a unit test of
// calculatePay alone cannot: the NUMBERS the contract requires, and STATICALLY that
// both entry points actually go through it. A React event handler cannot be invoked
// headlessly, so the static half is what stops the hand-rolled version coming back.

import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./_repo-root.mjs";
import { calculatePay } from "@/lib/payrollCalc";

let pass = 0;
let fail = 0;
const failures = [];

function ok(label, cond, detail = "") {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    const line = detail ? `${label} — ${detail}` : label;
    failures.push(line);
    console.log(`  FAIL  ${line}`);
  }
}

function eq(label, actual, expected) {
  ok(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");

// The body of one arrow-function handler, from its declaration to the closing `};`
// at two-space indent. Slicing the handler rather than searching the whole 660-line
// file matters: `calculatePay` could appear anywhere in Expenses.jsx and satisfy a
// naive whole-file grep while this handler still did its own multiplication.
function handlerBody(source, declaration) {
  const start = source.indexOf(declaration);
  if (start === -1) return null;
  const end = source.indexOf("\n  };", start);
  return end === -1 ? null : source.slice(start, end + 5);
}

// Comments are not code, and the fix deliberately QUOTES the arithmetic it replaced so
// the next reader knows what was wrong. Without this, the regression guards below fire
// on that documentation — measured: the `base_rate * hours` guard failed against the
// fixed file purely because the comment names the expression. Relaxing the guard was
// the wrong answer; excluding comments from it is the precise one.
//
// Only whole-line `//` comments and block comments are removed, so a `//` inside a
// string literal mid-line cannot be mangled into a truncated line.
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
}

const expensesSrc = read("src/pages/Expenses.jsx");
const payrollSrc = read("src/pages/Payroll.jsx");
// Code shape is asserted against the comment-free text; presence of the import is
// asserted against the whole file, where a commented-out import would be a real defect.
const addPayroll = handlerBody(stripComments(expensesSrc), "const handleAddPayroll = async () => {");
const addEntry = handlerBody(stripComments(payrollSrc), "const handleAdd = async () => {");

console.log("1. the salary contract — what the ledger must record");

// The exact shape the defect produced: a $3,000 monthly salary, hours left at the
// form's default of "40". Strings on purpose — these are raw <input> values.
const salary = calculatePay({ pay_type: "salary", base_rate: "3000", hours: "40" });
eq("a $3,000 salary with hours=40 books regular_pay 3000, not 120000", salary.regular_pay, 3000);
eq("...and total_pay 3000", salary.total_pay, 3000);
ok("REGRESSION: the salaried figure is not the 40x product",
  salary.regular_pay !== 120000, `regular_pay came back as ${salary.regular_pay}`);

const hourly = calculatePay({ pay_type: "hourly", base_rate: "25", hours: "40" });
eq("an hourly rate is still multiplied by hours", hourly.regular_pay, 1000);
eq("...and totals the same", hourly.total_pay, 1000);

// pay_type is the ONLY thing that switches the branch, so an unset value must keep
// the hourly behaviour every pre-existing row was written with.
eq("an absent pay_type behaves as hourly", calculatePay({ base_rate: "25", hours: "40" }).regular_pay, 1000);
eq("an empty pay_type behaves as hourly", calculatePay({ pay_type: "", base_rate: "25", hours: "40" }).regular_pay, 1000);

console.log("\n2. the magnitude of the defect, measured against the replaced code");

// The replaced arithmetic, verbatim, so the size of the error is a measurement and
// not a claim in a comment. If someone re-derives this handler by hand, the number
// they get is this one.
function handRolled(form) {
  const reg = (Number(form.base_rate) || 0) * (Number(form.hours) || 0);
  const otPay = (Number(form.base_rate) || 0) * 1.5 * (Number(form.overtime_hours) || 0);
  return reg + otPay + (Number(form.bonus) || 0) - (Number(form.deductions) || 0);
}

const salaryForm = { pay_type: "salary", base_rate: "3000", hours: "40", overtime_hours: "0", bonus: "0", deductions: "0" };
eq("the replaced code produced 120000 for that entry", handRolled(salaryForm), 120000);
eq("the shared function produces 3000", calculatePay(salaryForm).total_pay, 3000);
eq("the overstatement was exactly 40x, the hours default", handRolled(salaryForm) / calculatePay(salaryForm).total_pay, 40);

// Same input, hourly: the two agree, which is why the defect was invisible to anyone
// entering hourly staff and why it survived to launch review.
const hourlyForm = { pay_type: "hourly", base_rate: "25", hours: "40", overtime_hours: "5", bonus: "100", deductions: "50" };
eq("on hourly input the replaced code and the shared function agreed",
  handRolled(hourlyForm), calculatePay(hourlyForm).total_pay);

console.log("\n3. money is integer cents, which the replaced float math was not");

// 0.1 * 3 is 0.30000000000000004 in float. A cent-exact path returns 0.3. This is the
// smallest input that separates the two, and BUSINESS.md forbids the float form.
const fractional = { pay_type: "hourly", base_rate: "0.1", hours: "3" };
eq("0.1/hr x 3h is exactly 0.3", calculatePay(fractional).total_pay, 0.3);
ok("REGRESSION: the replaced float arithmetic drifted on the same input",
  handRolled(fractional) !== 0.3, `float path returned ${handRolled(fractional)}, which is why this must not come back`);

// A cent that only exists after rounding: 33.333/hr x 3h. Cents-first gives 3333 * 3.
eq("a repeating rate rounds once, at the cent", calculatePay({ base_rate: "33.333", hours: "3" }).total_pay, 99.99);

console.log("\n4. Expenses.jsx must route through the shared function, not its own math");

ok("the handleAddPayroll handler was located", addPayroll !== null,
  "src/pages/Expenses.jsx no longer contains `const handleAddPayroll = async () => {` — update this probe deliberately, do not delete the assertion");
const body = addPayroll || "";

ok("the handler calls calculatePay", /calculatePay\s*\(/.test(body));
ok("calculatePay is imported from the shared module",
  /import\s*\{[^}]*\bcalculatePay\b[^}]*\}\s*from\s*["']@\/lib\/payrollCalc["']/.test(expensesSrc));
ok("the computed fields are spread from the result, not assigned one by one",
  /\.\.\.payCalc\b/.test(body));

// The three specific expressions that were wrong. Each is asserted separately so a
// failure names which one returned.
ok("REGRESSION: no `base_rate * hours` product is computed in this handler",
  !/base_rate[^;]*\)\s*\*\s*\(Number\([^)]*hours/.test(body),
  "the hand-rolled regular-pay product is back");
ok("REGRESSION: no hardcoded 1.5 overtime multiplier in this handler",
  !/\*\s*1\.5/.test(body),
  "overtime rate is derived by calculatePay; a literal 1.5 here means the math was re-inlined");
ok("REGRESSION: no regular_pay/overtime_pay/total_pay computed inline",
  !/(regular_pay|overtime_pay|total_pay)\s*:\s*(reg|otPay|total)\b/.test(body),
  "a locally computed pay figure is being written to the record");

console.log("\n5. every numeric field written must come from the shared function");

// The schema (base44/entities/PayrollRun.jsonc) types these as "number". The old
// handler coerced four of them by hand and forgot overtime_hours, so a run created
// from this page carried the STRING "0" while the identical run from Payroll.jsx
// carried 0. The spread order is what guarantees all of them are numbers now:
// ...payrollForm first (raw <input> strings), then ...payCalc over the top.
const spreadOrder = /\.\.\.payrollForm[\s\S]*\.\.\.payCalc/.test(body);
ok("payCalc is spread AFTER payrollForm so coerced numbers win", spreadOrder,
  "with the spreads in the other order the raw form strings overwrite the numbers");

for (const field of ["base_rate", "hours", "overtime_hours", "overtime_rate", "bonus", "deductions"]) {
  ok(`${field} is not re-coerced by hand in the record literal`,
    !new RegExp(`${field}\\s*:\\s*Number\\(`).test(body),
    "hand coercion next to a spread is how the two paths drifted apart");
  eq(`calculatePay returns ${field} as a number`, typeof calculatePay(salaryForm)[field], "number");
}
eq("overtime_hours specifically is a number, not the string it used to be",
  calculatePay({ ...salaryForm, overtime_hours: "0" }).overtime_hours, 0);

console.log("\n6. the record must declare its payroll status");

// Money Kept only moves on approved/paid (COMMITTED_PAYROLL_STATUSES). A row written
// with no status at all was treated as draft by the `|| "draft"` fallbacks, so this is
// money-neutral — but the schema declares an enum, and a row that omits it is invalid.
ok("a status is written explicitly", /payroll_status\s*:\s*["']draft["']/.test(body),
  "the created run has no payroll_status, so it relies on every reader's fallback");

console.log("\n7. both manual entry points use the one function");

ok("Payroll.jsx's Add Entry still routes through calculatePay", addEntry !== null && /calculatePay\s*\(/.test(addEntry || ""));
ok("neither manual handler hardcodes an overtime multiplier",
  !/\*\s*1\.5/.test(body) && !/\*\s*1\.5/.test(addEntry || ""));

// KNOWN AND DELIBERATELY UNCHANGED, asserted so it cannot change by accident:
// calculatePay computes overtime for a salaried run at base_rate * 1.5, which for a
// $3,000 monthly salary is $4,500/hour. That is calculatePay's own long-standing
// behaviour, shared with Payroll.jsx, and the correct treatment of salaried overtime
// is a business question for the owner — exempt staff usually earn none, and where it
// is owed the rate derives from an annualised hourly equivalent, not the period
// amount. Changing it here would silently alter every existing run. This assertion
// pins today's behaviour so whoever answers that question sees this note first.
eq("PINNED, NOT ENDORSED: salaried overtime is currently period-amount x 1.5 per hour",
  calculatePay({ pay_type: "salary", base_rate: "3000", overtime_hours: "1" }).overtime_pay, 4500);

console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("\nFailures:");
  failures.forEach((f) => console.log(`  - ${f}`));
}
process.exit(fail > 0 ? 1 : 0);
