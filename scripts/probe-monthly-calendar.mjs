// Probe: the calendar must draw the months it measures, and every revenue number
// on the page must be the same measure.
//
// WHAT THE OWNER SAW (live site, 2026-08-24, /calendar with the default YTD filter):
//   header      "…yield rhythms for August 2026"
//   KPI card    "TOTAL MONTHLY REVENUE  $1,011,258"   sub: "214 days with data"
//   one grid    "August 2026 Calendar", every day after Aug 2 marked "No Data"
//
// Three claims, three different periods. The money is right — $1,011,258.67 is the
// documented room subtotal in RevenueReconciliation.js:46-59 and ties to
// sum(OccupancyDay.room_revenue) to the cent — but 214 days is not August, and a
// card labelled "Total … Revenue" over a room-only figure invites the reader to
// compare it with the Dashboard's $1,020,598.17 total.
//
// ROOT CAUSE. MonthlyCalendar.jsx derived WHICH months to draw from `period`,
// `month` and `year`, while its KPIs aggregate `dateRange`:
//
//     const isMultiMonth = period === "monthly" && months.length > 1;
//
// That is false for ytd, yearly, quarterly, weekly, daily and custom, so all six
// fell into the single-month branch. Section 1 measures the size of that gap
// against the real range shapes the filter provider produces.
//
// SECOND ROOT CAUSE, same page. The grid cells colour by `room_revenue` against the
// thresholds the card subtitle prints, but the performance groups classified by
// `total_revenue` and the day modal displayed it — a field the CSV importer never
// writes (section 5 proves that against the real export). So every imported day was
// grouped "low", and tapping a cell showing $12,000 opened a panel reading $0.00.
//
// Sections 1, 2, 5 and 6 drive real code — the extracted derivation, the real
// scanReport over the owner's real CSV, and the filter provider's own source.
// Sections 3 and 4 are source contracts, because a JSX page cannot be rendered here.
//
// Run: node --import ./scripts/_loader-boot.mjs scripts/probe-monthly-calendar.mjs

await import("fake-indexeddb/auto");
globalThis.crypto ??= (await import("node:crypto")).webcrypto;

const __store = new Map();
const __storage = {
  getItem: (k) => (__store.has(k) ? __store.get(k) : null),
  setItem: (k, v) => __store.set(k, String(v)),
  removeItem: (k) => __store.delete(k),
  clear: () => __store.clear(),
};
globalThis.localStorage = __storage;
globalThis.sessionStorage = __storage;
globalThis.window = globalThis;
if (globalThis.navigator === undefined) {
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "harness", language: "en-US" },
    configurable: true,
  });
}

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const DATA = path.join(HERE, "data");

const { calendarMonths, monthsInRange, daysInMonth, MAX_GRIDS } = await import("@/lib/calendarGrids");
const { scanReport } = await import("@/lib/reportParsers");

let pass = 0;
let fail = 0;
const failures = [];

function ok(label, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  PASS ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    failures.push(label);
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function eq(label, actual, expected) {
  ok(label, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// Sections 3 and 4 assert on CODE. The page carries long comments that quote the
// defective expressions on purpose — that is what stops the next agent reinstating
// them — and a naive regex over the raw file matches the explanation instead of the
// code. Only block comments and whole-line `//` comments are removed, so no string
// literal containing "//" can be truncated.
const code = (rel) => read(rel)
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^[ \t]*\/\/.*$/gm, "");
const shape = (list) => list.map((p) => `${p.year}-${String(p.month + 1).padStart(2, "0")}`).join(",");

// ═══ 1. The derivation, over the range shapes the real provider produces ═════
//
// Every literal below is a range computeRange()/computeRangeFromMonths() emits for
// that period; section 6 asserts those functions still emit this shape, so these
// fixtures cannot quietly stop describing the product.
console.log("\n=== 1. months drawn == months measured ===");
{
  // YTD, exactly what the owner had on screen: Jan 1 through the latest imported day.
  const ytd = calendarMonths({ period: "ytd", months: [], year: 2026, dateRange: { from: "2026-01-01", to: "2026-08-15" } });
  eq("YTD Jan 1 – Aug 15 draws 8 grids", ytd.length, 8);
  eq("…starting at January 2026", shape(ytd.slice(0, 1)), "2026-01");
  eq("…ending at August 2026", shape(ytd.slice(-1)), "2026-08");
  ok("…and every pair carries its own year",
    ytd.every((p) => p.year === 2026), shape(ytd));

  // The defect, stated as a number: the page drew one of these eight.
  ok("the single-month branch was short by 7 grids", ytd.length - 1 === 7);

  const yearly = calendarMonths({ period: "yearly", months: [], year: 2025, dateRange: { from: "2025-01-01", to: "2025-12-31" } });
  eq("a full year draws 12 grids", yearly.length, 12);
  eq("…and stays in its own year", shape(yearly.slice(-1)), "2025-12");

  const q4 = calendarMonths({ period: "quarterly", months: [], year: 2026, dateRange: { from: "2026-10-01", to: "2026-12-31" } });
  eq("Q4 draws 3 grids", q4.length, 3);
  eq("…Oct, Nov, Dec", shape(q4), "2026-10,2026-11,2026-12");

  const daily = calendarMonths({ period: "daily", months: [], year: 2026, dateRange: { from: "2026-08-15", to: "2026-08-15" } });
  eq("a single day draws 1 grid", daily.length, 1);
  eq("…the month that day is in", shape(daily), "2026-08");

  // A week is the case that used to render Dec 2025 as "December 2026".
  const week = calendarMonths({ period: "weekly", months: [], year: 2025, dateRange: { from: "2025-11-30", to: "2025-12-06" } });
  eq("a week straddling a month draws 2 grids", week.length, 2);
  eq("…Nov 2025 and Dec 2025", shape(week), "2025-11,2025-12");

  const yearEnd = calendarMonths({ period: "custom", months: [], year: 2026, dateRange: { from: "2025-12-15", to: "2026-01-14" } });
  eq("a custom range across New Year draws 2 grids", yearEnd.length, 2);
  eq("…each with its OWN year", shape(yearEnd), "2025-12,2026-01");

  // The multi-month picker: months[] wins, because the provider hands back a
  // contiguous range while the row filter keeps only the picked months.
  const picked = calendarMonths({ period: "monthly", months: [6, 3], year: 2026, dateRange: { from: "2026-04-01", to: "2026-07-31" } });
  eq("April + July draws exactly 2 grids, not 4", picked.length, 2);
  eq("…sorted, and only the picked months", shape(picked), "2026-04,2026-07");

  const one = calendarMonths({ period: "monthly", months: [7], year: 2026, dateRange: { from: "2026-08-01", to: "2026-08-15" } });
  eq("a single picked month draws 1 grid", one.length, 1);
  eq("…that month", shape(one), "2026-08");

  const pastYear = calendarMonths({ period: "monthly", months: [11], year: 2024, dateRange: { from: "2024-12-01", to: "2024-12-31" } });
  eq("a picked month in an earlier year keeps that year", shape(pastYear), "2024-12");
}

// ═══ 2. Degenerate ranges cannot crash the page or invent months ══════════════
//
// The page indexes displayMonths[0] to build its event window, so an empty list is
// a crash, not a blank calendar.
console.log("\n=== 2. degenerate ranges ===");
{
  eq("a blank custom range yields no derived months", monthsInRange("", "").length, 0);
  eq("an inverted range yields none", monthsInRange("2026-08-01", "2026-01-01").length, 0);
  eq("a non-string yields none", monthsInRange(null, undefined).length, 0);
  eq("a malformed date yields none", monthsInRange("15/08/2026", "16/08/2026").length, 0);
  eq("month 13 is rejected rather than wrapped", monthsInRange("2026-13-01", "2026-13-05").length, 0);

  const blank = calendarMonths({ period: "custom", months: [], year: 2026, dateRange: { from: "", to: "" } });
  eq("but the page still gets exactly one month to draw", blank.length, 1);
  eq("…in the selected year", blank[0].year, 2026);
  ok("…and a real month index", Number.isInteger(blank[0].month) && blank[0].month >= 0 && blank[0].month <= 11,
    String(blank[0].month));

  const past = calendarMonths({ period: "custom", months: [], year: 2023, dateRange: {} });
  eq("an earlier year with nothing selected falls back to January", shape(past), "2023-01");

  const junk = calendarMonths({ period: "monthly", months: [99, -1, null], year: 2026, dateRange: { from: "2026-05-01", to: "2026-05-31" } });
  eq("out-of-range month indices are dropped, not drawn", shape(junk), "2026-05");
  eq("no arguments at all still returns one month", calendarMonths().length, 1);

  // Bounded work: a mistyped century must not build a 1,500-element list per render.
  const absurd = monthsInRange("1900-01-01", "2026-08-15");
  ok("a runaway range is bounded", absurd.length <= 1200, `got ${absurd.length}`);
  ok("…and the page caps what it renders", MAX_GRIDS === 24, `MAX_GRIDS=${MAX_GRIDS}`);

  eq("Feb 2024 has 29 days", daysInMonth(2024, 1), 29);
  eq("Feb 2026 has 28", daysInMonth(2026, 1), 28);
  eq("Dec has 31", daysInMonth(2026, 11), 31);
}

// ═══ 3. The page uses the derivation, and no longer guesses the year ══════════
console.log("\n=== 3. MonthlyCalendar.jsx wiring ===");
{
  const raw = read("src/pages/MonthlyCalendar.jsx");
  const page = code("src/pages/MonthlyCalendar.jsx");

  // Non-vacuity: if the strip silently matched nothing, the negative assertions
  // below would be testing the prose again.
  ok("comments were stripped before these checks", page.length < raw.length,
    `raw ${raw.length} vs stripped ${page.length}`);
  ok("…and the page still explains why the old rule was wrong",
    /period === "monthly" && months\.length > 1/.test(raw),
    "the comment recording the defect is gone — the next agent has nothing to stop them reinstating it");

  ok("the page imports the shared derivation",
    /import\s*\{[^}]*calendarMonths[^}]*\}\s*from\s*["']@\/lib\/calendarGrids["']/.test(page),
    "calendarMonths is not imported — the page is deciding this inline again");
  ok("the old period-only rule is gone",
    !/period\s*===\s*["']monthly["']\s*&&\s*months\.length\s*>\s*1/.test(page),
    'the `period === "monthly" && months.length > 1` branch is back');
  ok("multi-month is decided by how many months are drawn",
    /isMultiMonth\s*=\s*\w+\.length\s*>\s*1/.test(page));
  ok("the hardcoded calendar year is gone",
    !/calYear/.test(page),
    "calYear reappeared — a grid can now be titled with a year the range does not cover");
  ok("no date-only string is parsed with new Date(\"YYYY-MM-DD\")",
    !/new Date\(`\$\{/.test(page),
    "a template date string is being fed to new Date() — that names the previous day");

  // Each grid must be keyed and titled by ITS pair, or two Januaries collide.
  ok("grids are keyed by year and month",
    /key=\{`\$\{grid\.year\}-\$\{grid\.month\}`\}/.test(page),
    "key={grid.month} alone collides when a range spans two years");
  ok("grid titles carry the grid's own year",
    /MONTHS_LONG\[grid\.month\]\}\s*\$\{grid\.year\}/.test(page));

  // Truncation has to be visible, or the label and the KPIs disagree past 24 months.
  ok("a truncated selection is reported to the owner",
    /hiddenGrids/.test(page) && /MAX_GRIDS/.test(page),
    "the grid list is capped with no notice, so the KPIs would cover months no grid shows");
}

// ═══ 4. One page, one measure ════════════════════════════════════════════════
console.log("\n=== 4. every revenue number on the page is the same measure ===");
{
  const page = code("src/pages/MonthlyCalendar.jsx");

  ok("performance groups classify by the same field the cells colour by",
    /getRevenueGroup\(\s*c\.data\.room_revenue\s*\|\|\s*0\s*\)/.test(page),
    "getRevenueGroup is not reading room_revenue — the legend under each grid then describes thresholds applied to something else");
  ok("no bare total_revenue is read anywhere on the page",
    !/(?<!_)\btotal_revenue\b(?!_)/.test(page),
    "total_revenue is never written by the CSV importer (section 5) — reading it shows $0.00");
  ok("the day modal shows the day's room revenue",
    /current=\{selectedData\.room_revenue\s*\|\|\s*0\}/.test(page),
    "the modal disagrees with the cell that opened it");
  // Anchored to the KpiCard, not to any "Room Revenue" string on the page: an
  // earlier version of this assertion matched the day modal's own label and passed
  // against the unfixed page.
  ok("the revenue KPI is labelled by what it measures",
    /<KpiCard label="Total Room Revenue"/.test(page),
    'occupancyStats().revenue is room-only, so a card labelled "Total Monthly Revenue" invites comparison with the $1,020,598.17 ledger total');
  ok("the peak/trough cards name the same measure",
    /sub="Peak room revenue"/.test(page) && /sub="Lowest room revenue"/.test(page),
    "Highest/Lowest Day show Math.max/min of room_revenue");

  // occupancyStats is the engine behind that card; if it ever starts summing a
  // different field, the label above becomes wrong again.
  const hotel = read("src/lib/hotel.js");
  ok("occupancyStats still sums room_revenue",
    /revenue\s*=\s*sum\(rows,\s*["']room_revenue["']\)/.test(hotel),
    "occupancyStats().revenue changed field — re-check the KPI label");
}

// ═══ 5. Why total_revenue could not be used: the real export never carries it ═
console.log("\n=== 5. the real Occupancy Summary, through the real parser ===");
{
  const file = path.join(DATA, "Occupancy Summary midelboro.csv");
  if (!fs.existsSync(file)) {
    ok("fixture present", false, `not found: ${file}`);
  } else {
    const csvText = fs.readFileSync(file, "utf8");
    const scan = await scanReport("occupancy", "Occupancy Summary midelboro.csv", { csvText });
    const rows = scan.rowsToImport || [];

    ok("the owner's export parses", rows.length > 200, `rows=${rows.length}`);
    ok("no blocking validation error on a known-good file",
      (scan.validation?.errors || []).length === 0,
      JSON.stringify((scan.validation?.errors || []).map((e) => e.code)));

    const withRoom = rows.filter((r) => Number(r.room_revenue) > 0);
    ok("rows carry room_revenue", withRoom.length > 200, `${withRoom.length} rows`);

    const anyTotal = rows.filter((r) => r.total_revenue !== undefined);
    eq("NOT ONE row carries total_revenue", anyTotal.length, 0);

    const withMisc = rows.filter((r) => Number(r.total_revenue_with_misc) > 0);
    ok("the column the PMS calls \"Total Revenue\" is stored as total_revenue_with_misc",
      withMisc.length > 200, `${withMisc.length} rows`);

    // Named so the field split cannot be mistaken for a parser bug: the mapping is
    // deliberate, it is the consumers that were reading the wrong name.
    const parsers = read("src/lib/reportParsers.js");
    ok("the parser maps the column deliberately",
      /"Total Revenue":\s*"total_revenue_with_misc"/.test(parsers),
      "reportParsers.js:160 no longer maps Total Revenue -> total_revenue_with_misc — re-check every consumer");
  }
}

// ═══ 6. The provider contract the fixtures in section 1 rest on ══════════════
console.log("\n=== 6. useGlobalFilters still emits what section 1 assumes ===");
{
  const provider = read("src/lib/useGlobalFilters.jsx");

  ok("dateRange is built from ISO date strings",
    /const iso = \(y, m, d\) => `\$\{y\}-\$\{pad\(m \+ 1\)\}-\$\{pad\(d\)\}`/.test(provider),
    "iso() changed shape — monthsInRange parses YYYY-MM by slicing");
  ok("ytd still starts at January 1 of the selected year",
    /if \(period === "ytd"\)[\s\S]{0,120}const from = iso\(y, 0, 1\)/.test(provider));
  ok("yearly still spans Jan 1 – Dec 31",
    /if \(period === "yearly"\) return \{ from: iso\(y, 0, 1\), to: iso\(y, 11, 31\) \}/.test(provider));
  ok("quarterly still spans three months",
    /if \(period === "quarterly"\)[\s\S]{0,200}iso\(y, m \+ 2, lastDay\(y, m \+ 2\)\)/.test(provider));
  ok("weekly still returns a 7-day span that may cross a month",
    /if \(period === "weekly"\)[\s\S]{0,400}end\.setDate\(start\.getDate\(\) \+ 6\)/.test(provider));
  ok("custom still passes the owner's raw strings through",
    /if \(period === "custom"\) return \{ from: customFrom \|\| "", to: customTo \|\| "" \}/.test(provider));
  ok("monthly is still the multi-month picker",
    /return computeRangeFromMonths\(year, months, latestDate\)/.test(provider),
    "monthly no longer routes through months[] — the branch in calendarMonths() must follow");
  ok("…and its range is contiguous min..max, which is why months[] wins",
    /const minM = Math\.min\(\.\.\.months\)[\s\S]{0,900}return \{ from: iso\(year, minM, 1\), to \}/.test(provider),
    "computeRangeFromMonths changed — re-check the monthly branch of calendarMonths()");
  ok("the empty-selection fallback is still current-month / January",
    /const m = year === today\.getFullYear\(\) \? today\.getMonth\(\) : 0/.test(provider),
    "fallbackMonth() in calendarGrids.js mirrors this rule");
}

console.log("\n" + "─".repeat(70));
console.log(`PASS ${pass}   FAIL ${fail}`);
if (fail > 0) {
  console.log(`\nFAILED: ${pass} passed, ${fail} failed`);
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
console.log(`\nPASSED: ${pass} passed, 0 failed`);
process.exit(0);
