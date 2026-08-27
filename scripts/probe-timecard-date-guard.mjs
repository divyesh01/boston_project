// Probe (audit finding 3.3 residual): the timecard/timesheet punch parser
// accepted a malformed shift date.
//
// Root cause (before fix): scanTimecard (src/lib/reportParsers.js ~1389) guarded
// the punch with a bare truthiness check — `if (!employee || !date || ...)`.
// convertDate returns the RAW input string when it recognises no format (e.g.
// "2026.01.01"), and returns a shape-valid but calendar-impossible string for
// dates like "2026-02-31". Both are truthy, so `!date` let them through and the
// punch was persisted with a junk shift_date — unlike the transaction ledger
// (:896) and the flat-table path (:620), which already require isIsoDate(date).
//
// Fix: the guard is now `!isIsoDate(date)`, routing a non-ISO / impossible punch
// date to the same `rejected` path the other two importers use.
//
// Run: node --import ./scripts/_loader-boot.mjs scripts/probe-timecard-date-guard.mjs

import { register } from "node:module";
register(new URL("./resolve-alias.mjs", import.meta.url));

const { scanReport } = await import("@/lib/reportParsers");
const { convertDate, isIsoDate } = await import("@/lib/csvParser");

let pass = 0, fail = 0;
const T = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`); }
};

// Confirm the exact convertDate behaviour the guard has to defend against.
console.log("\n=== 0. convertDate leaves these dates for the guard to reject ===");
T('"2026.01.01" comes back raw (dotted format unrecognised)', convertDate("2026.01.01") === "2026.01.01");
T('"2026.01.01" is not ISO', !isIsoDate(convertDate("2026.01.01")));
T('"2026-02-31" is shape-valid but not a real date', !isIsoDate(convertDate("2026-02-31")));
T('"2026-01-01" is a real ISO date', isIsoDate(convertDate("2026-01-01")));

const scanCsv = (csvText) =>
  scanReport("timecard", "timecard.csv", { csvText, sourceFile: "timecard.csv" });

console.log("\n=== 1. A malformed (dotted) punch date is rejected, not imported ===");
{
  const csv =
    "Employee,Date,Clock In,Clock Out\n" +
    "Jane,2026-01-01,09:00,17:00\n" +
    "John,2026.01.01,09:00,17:00\n";
  const res = await scanCsv(csv);
  const imported = res.rowsToImport || [];
  T("exactly one punch imported (the ISO one)", imported.length === 1, `got ${imported.length}`);
  T("the kept punch is Jane's ISO shift", imported[0]?.employee_name === "Jane" && imported[0]?.shift_date === "2026-01-01",
    JSON.stringify(imported[0]));
  T("no imported punch carries a non-ISO shift_date",
    imported.every((p) => isIsoDate(p.shift_date)), JSON.stringify(imported.map((p) => p.shift_date)));
  T('"2026.01.01" never reaches rowsToImport',
    !imported.some((p) => String(p.shift_date).includes("2026.01.01")), JSON.stringify(imported));
}

console.log("\n=== 2. A calendar-impossible punch date is rejected too ===");
{
  const csv =
    "Employee,Date,Clock In,Clock Out\n" +
    "Amy,2026-02-31,08:00,16:00\n" +
    "Bob,2026-03-15,08:00,16:00\n";
  const res = await scanCsv(csv);
  const imported = res.rowsToImport || [];
  T("only the real date survives", imported.length === 1 && imported[0]?.shift_date === "2026-03-15",
    JSON.stringify(imported.map((p) => p.shift_date)));
  T('"2026-02-31" was not persisted', !imported.some((p) => p.shift_date === "2026-02-31"), JSON.stringify(imported));
}

console.log("\n=== 3. A fully valid timesheet still imports every punch ===");
{
  const csv =
    "Employee,Date,Clock In,Clock Out\n" +
    "Jane,2026-01-01,09:00,17:00\n" +
    "John,2026-01-02,10:00,18:00\n";
  const res = await scanCsv(csv);
  const imported = res.rowsToImport || [];
  T("both valid punches imported", imported.length === 2, `got ${imported.length}`);
  T("no false rejection of good ISO dates", imported.every((p) => isIsoDate(p.shift_date)),
    JSON.stringify(imported.map((p) => p.shift_date)));
}

console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
