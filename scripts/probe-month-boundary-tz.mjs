// Regression probe for audit-2 claim #18:
// useGlobalFilters.isMonthSelected() classified a YYYY-MM-DD row by
// `new Date(str).getMonth()`. `new Date("2026-02-01")` parses at UTC midnight,
// and .getMonth() reads it in LOCAL time, so in any US timezone (UTC-5..-10) the
// 1st of every month rolls back into the PREVIOUS month and its rows silently
// drop out of a multi-month selection.
//
// The shipped fix parses the month directly from the string:
//   const m = Number(String(dateStr).slice(5, 7)) - 1;   // 0-indexed
//
// Run under a US timezone to reproduce:  TZ=America/New_York node scripts/probe-month-boundary-tz.mjs

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  if (got === want) { pass++; }
  else { fail++; console.log(`  FAIL ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
};

// --- the OLD (buggy) classifier and the NEW (shipped) classifier ---
const oldMonth = (dateStr) => new Date(String(dateStr).slice(0, 10)).getMonth();
const newMonth = (dateStr) => Number(String(dateStr).slice(5, 7)) - 1;

console.log(`TZ = ${process.env.TZ || '(system default)'}`);
console.log(`offset(min) at 2026-02-01 = ${new Date("2026-02-01").getTimezoneOffset()}`);

// Every month's 1st-of-month date. 0-indexed month is what months[] stores.
const firsts = [
  ["2026-01-01", 0], ["2026-02-01", 1], ["2026-03-01", 2], ["2026-04-01", 3],
  ["2026-05-01", 4], ["2026-06-01", 5], ["2026-07-01", 6], ["2026-08-01", 7],
  ["2026-09-01", 8], ["2026-10-01", 9], ["2026-11-01", 10], ["2026-12-01", 11],
];

// The NEW classifier must return the correct 0-indexed month for the 1st of EVERY
// month, in ANY timezone.
console.log("\n[new classifier — must always be correct]");
for (const [d, want] of firsts) eq(`newMonth(${d})`, newMonth(d), want);

// mid-month + last-day sanity (these never crossed a boundary, both agree)
eq("newMonth(2026-02-15)", newMonth("2026-02-15"), 1);
eq("newMonth(2026-02-28)", newMonth("2026-02-28"), 1);
eq("newMonth(2026-12-31)", newMonth("2026-12-31"), 11);

// Simulate the real selection test: user selects February (months=[1]); a Feb-1 row
// must be INCLUDED.
const isMonthSelected = (dateStr, months, fn) => months.includes(fn(dateStr));
eq("Feb selected includes Feb-1 (NEW)", isMonthSelected("2026-02-01", [1], newMonth), true);

// Demonstrate the bug the fix removes: in a negative-offset (US) tz the OLD
// classifier drops Feb-1 out of a February selection. In UTC it would not — so we
// only assert the bug when the environment actually reproduces it.
const usTz = new Date("2026-02-01").getTimezoneOffset() > 0; // west of UTC
console.log(`\n[old classifier — buggy only when west of UTC: ${usTz}]`);
if (usTz) {
  eq("OLD drops Feb-1 from Feb selection (bug reproduced)",
     isMonthSelected("2026-02-01", [1], oldMonth), false);
  eq("OLD misclassifies Feb-1 as Jan (bug reproduced)", oldMonth("2026-02-01"), 0);
} else {
  console.log("  (skipped: environment is UTC/east-of-UTC, bug does not manifest here)");
}

// --- goToLatestData(): year+month parsed from the latestDate literal (same fix) ---
// `new Date(latestDate).getFullYear()/.getMonth()` rolled the 1st of a month (and
// Jan 1 → prior YEAR) backwards in US timezones. The shipped fix slices the literal.
const yearFromISO = (s) => Number(String(s).slice(0, 4));
console.log("\n[goToLatestData parse — year + 0-indexed month from literal]");
eq("year(2026-01-01)", yearFromISO("2026-01-01"), 2026);
eq("month(2026-01-01)", newMonth("2026-01-01"), 0);
eq("year(2026-08-01)", yearFromISO("2026-08-01"), 2026);
eq("month(2026-08-01)", newMonth("2026-08-01"), 7);
eq("year(2026-12-31)", yearFromISO("2026-12-31"), 2026);

console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
