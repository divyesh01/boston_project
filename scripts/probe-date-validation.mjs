// Probe: convertDate / isIsoDate accept dates that do not exist.
//
// Both functions check the SHAPE of a date and never the calendar. So a cell reading
// "13/45/2026" is assembled into "2026-13-45", which then satisfies every
// `isIsoDate()` guard in the codebase (reportParsers.js:490, :509, :747,
// dataScanner.js:209) because that guard is only /^\d{4}-\d{2}-\d{2}/. The row imports
// with a month that does not exist, and its revenue is filed under a period no report
// will ever total.
//
// The same holds for "2026-02-31", "29-Feb-26" (2026 is not a leap year) and
// "31/01/2026" (a D/M/Y file read as M/D/Y, giving month 31).
//
// Run: node scripts/probe-date-validation.mjs

import { register } from "node:module";
register(new URL("./resolve-alias.mjs", import.meta.url));

const { convertDate, isIsoDate } = await import("../src/lib/csvParser.js");
const { parseManualEntryCsv } = await import("../src/lib/manualEntryImport.js");

let pass = 0, fail = 0;
const T = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`); }
};

console.log("\n=== 1. Real dates still convert exactly as before ===");
{
  // These four are asserted by scripts/acceptance-harness.mjs as well; they must not move.
  const good = [
    ["1-Jan-26", "2026-01-01"],
    ["Apr 01, 2026", "2026-04-01"],
    ["2-Aug-26", "2026-08-02"],
    ["Jul 1, 2026", "2026-07-01"],
    ["01-Jan-2026", "2026-01-01"],
    ["2026-01-01", "2026-01-01"],
    ["1/1/2026", "2026-01-01"],
    ["12/31/2026", "2026-12-31"],
    ["Wed, Apr 01, 2026", "2026-04-01"],
    ["2026-03-07 03:21 PM", "2026-03-07"],
    ["29-Feb-24", "2024-02-29"],   // 2024 IS a leap year
    ["2/29/2024", "2024-02-29"],
    ["30-Apr-26", "2026-04-30"],
    ["31-Dec-26", "2026-12-31"],
  ];
  for (const [inp, want] of good) {
    const got = convertDate(inp);
    T(`"${inp}" → ${want}`, got === want, `got="${got}"`);
  }
}

console.log("\n=== 2. Impossible dates are not dressed up as valid ISO ===");
{
  // Each of these currently returns a well-formed-looking ISO string.
  const impossible = [
    ["13/45/2026", "month 13, day 45"],
    ["31/01/2026", "a D/M/Y file read as M/D/Y — month 31"],
    ["2026-02-31", "February has no 31st"],
    ["2026-13-01", "there is no month 13"],
    ["2026-00-10", "there is no month 0"],
    ["2026-01-00", "there is no day 0"],
    ["2026-04-31", "April has no 31st"],
    ["29-Feb-26", "2026 is not a leap year"],
    ["32-Jan-26", "January has no 32nd"],
    ["0000-01-01", "year zero"],
    ["Feb 30, 2026", "February has no 30th"],
  ];
  for (const [inp, why] of impossible) {
    const got = convertDate(inp);
    T(`"${inp}" is refused (${why})`, !isIsoDate(got), `convertDate="${got}" isIsoDate=${isIsoDate(got)}`);
  }
}

console.log("\n=== 3. isIsoDate rejects an impossible date already in storage ===");
{
  // The guard has to catch these on its own: rows written before this fix, and
  // reportParsers.js:509 / :747 which test r.date without re-converting it.
  T("2026-13-45 is not a date", !isIsoDate("2026-13-45"), String(isIsoDate("2026-13-45")));
  T("2026-02-31 is not a date", !isIsoDate("2026-02-31"), String(isIsoDate("2026-02-31")));
  T("2026-31-01 is not a date", !isIsoDate("2026-31-01"), String(isIsoDate("2026-31-01")));
  T("2026-00-00 is not a date", !isIsoDate("2026-00-00"), String(isIsoDate("2026-00-00")));

  // ...while still accepting what it accepted before, including a trailing time.
  T("2026-03-07 is a date", isIsoDate("2026-03-07"));
  T("2026-03-07 03:21 PM keeps passing", isIsoDate("2026-03-07 03:21 PM"));
  T("2026-02-29 is refused, 2024-02-29 is not",
    !isIsoDate("2026-02-29") && isIsoDate("2024-02-29"));
  T("empty and null are not dates", !isIsoDate("") && !isIsoDate(null) && !isIsoDate(undefined));
}

console.log("\n=== 4. Unrecognised shapes behave as they always did ===");
{
  // convertDate returns the input untouched when no pattern matches; callers reject it
  // via isIsoDate. Changing that would alter which rows get skipped, so it is pinned.
  T('"N/A" comes back unchanged', convertDate("N/A") === "N/A", convertDate("N/A"));
  T('"Total" comes back unchanged', convertDate("Total") === "Total");
  T('"" stays ""', convertDate("") === "");
  T("null becomes \"\"", convertDate(null) === "");
  T('a single-digit ISO "2026-8-2" is not silently accepted', !isIsoDate(convertDate("2026-8-2")));
}

console.log("\n=== 5. The importer reports an impossible date instead of storing it ===");
{
  const fields = [
    { key: "date", label: "Date", type: "date" },
    { key: "net_revenue", label: "Net Revenue", type: "number" },
  ];
  const { rows, warnings } = parseManualEntryCsv(
    "date,net_revenue\n2026-02-31,100.00\n2026-03-01,200.00\n",
    fields
  );
  T("both rows are kept for the operator to correct", rows.length === 2, `rows=${rows.length}`);
  T("the impossible date is named in a warning",
    warnings.some((w) => w.includes("2026-02-31")), JSON.stringify(warnings));
  T("the revenue on that row is NOT silently zeroed", rows[0].net_revenue === 100,
    JSON.stringify(rows[0]));
  T("the valid row is untouched", rows[1].date === "2026-03-01", JSON.stringify(rows[1]));
}

console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
