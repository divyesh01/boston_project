// Probe: the MTD Growth page must state a revenue figure that exists, and compare
// it against the right number of prior days.
//
// TWO DEFECTS, both on src/pages/MtdGrowth.jsx, both measured below.
//
// D1 — the headline card read a field the importer never writes (tracker #45).
//
//     const METRICS = [
//       { key: "total_revenue", label: "Total Revenue", fmt: money, ... },
//       ...
//     const calc = (rows, key) => { ...; return sum(rows, key); };
//
// `OccupancyDay` has no bare `total_revenue`. The Occupancy Summary's column headed
// "Total Revenue" is mapped to `total_revenue_with_misc` on purpose, because it is a
// ROOM total; only ManualEntry.jsx ever writes the unsuffixed name. Section 1 proves
// the field is absent from all 214 rows of the owner's real export, so the card
// labelled "Total Revenue" rendered $0 — and, because `pctCh` is 0 whenever `prev` is
// 0, the Owner's Snapshot narrated "Revenue is up 0.0% to $0" and could rank that
// $0 metric as the period's "top driver".
//
// D2 — the previous-period window was computed with local calendar methods.
//
//     const prevFrom = new Date(compareDateRange.from);      // parses as UTC midnight
//     prevToDate.setDate(prevFrom.getDate() + elapsedDays - 1);  // LOCAL field math
//
// A date-only string parses as UTC midnight, but getDate/setDate read and write
// LOCAL calendar fields. In every zone behind UTC the day-of-month is already the
// PREVIOUS day, and advancing by N days also absorbs any DST offset change between
// the two endpoints. Section 3 measures it in the owner's own zone: for the filter
// the live site is showing (2026-01-01 -> 2026-08-02, compared against 2025) the
// window ended 2025-08-01 instead of 2025-08-02. One day of prior-period revenue
// dropped out of every comparison, which inflates growth rather than deflating it —
// the direction nobody questions.
//
// Sections 1 and 2 drive the real parser over the owner's real CSVs. Section 3 drives
// the real helper. Sections 4 and 5 are source contracts, because a JSX page cannot
// be rendered here.
//
// Run: node --import ./scripts/_loader-boot.mjs scripts/probe-mtd-growth.mjs

// Set BEFORE any Date is constructed. The Linux sandbox runs in UTC, where the
// defective expression in D2 happens to be correct — so a probe that did not pin a
// zone would report the page as fine. America/New_York is the owner's zone (and the
// one every US deployment of this app will use).
process.env.TZ = "America/New_York";

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

const hotelMod = await import("@/lib/hotel");
const { scanReport } = await import("@/lib/reportParsers");
const { grossRevenueForPeriod, sum } = hotelMod;

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

// Sections 4 and 5 assert on CODE. Both files carry long comments that quote the
// defective expressions on purpose — that is what stops the next agent reinstating
// them — and a naive regex over the raw file matches the explanation instead of the
// code. Only block comments and whole-line `//` comments are stripped, so no string
// literal containing "//" can be truncated.
const code = (rel) => read(rel)
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^[ \t]*\/\/.*$/gm, "");

const cents = (dollars) => Math.round(Number(dollars) * 100);

// ═══ 1. The field the card was keyed on does not exist in the real export ═════
console.log("\n=== 1. total_revenue on the owner's real Occupancy Summary ===");
let occRows = [];
{
  const file = path.join(DATA, "Occupancy Summary midelboro.csv");
  if (!fs.existsSync(file)) {
    ok("occupancy fixture present", false, `not found: ${file}`);
  } else {
    const scan = await scanReport("occupancy", "Occupancy Summary midelboro.csv", {
      csvText: fs.readFileSync(file, "utf8"),
    });
    occRows = scan.rowsToImport || [];

    ok("the owner's export parses", occRows.length > 200, `rows=${occRows.length}`);
    ok("no blocking validation error on a known-good file",
      (scan.validation?.errors || []).length === 0,
      JSON.stringify((scan.validation?.errors || []).map((e) => e.code)));

    eq("NOT ONE row carries a bare total_revenue",
      occRows.filter((r) => r.total_revenue !== undefined).length, 0);

    // This is the number the card actually rendered.
    eq("so sum(rows, \"total_revenue\") is exactly zero", sum(occRows, "total_revenue"), 0);

    ok("…while room_revenue is populated on every row",
      occRows.filter((r) => Number(r.room_revenue) > 0).length > 200);
    eq("and sums to the documented room leg",
      cents(sum(occRows, "room_revenue")), cents(1011258.67));

    const parsers = read("src/lib/reportParsers.js");
    ok("the column headed \"Total Revenue\" is still mapped to total_revenue_with_misc",
      /"Total Revenue":\s*"total_revenue_with_misc"/.test(parsers),
      "if this mapping changed, re-check every consumer before trusting the name");
  }
}

// ═══ 2. What the card must show instead, from both real ledgers ═══════════════
console.log("\n=== 2. grossRevenueForPeriod over both real ledgers ===");
{
  const file = path.join(DATA, "Gross Revenue Report midelboro.csv");
  if (!fs.existsSync(file)) {
    ok("gross fixture present", false, `not found: ${file}`);
  } else {
    const scan = await scanReport("gross", "Gross Revenue Report midelboro.csv", {
      csvText: fs.readFileSync(file, "utf8"),
    });
    const grossRows = scan.rowsToImport || [];
    ok("the gross export parses", grossRows.length > 200, `rows=${grossRows.length}`);

    const total = grossRevenueForPeriod({ grossRows, occRows });

    ok("the assembled total is not zero", total.cents > 0, `$${total.dollars.toFixed(2)}`);
    eq("basis is \"total\" when gross rows are present", total.basis, "total");
    eq("the room leg still comes from the occupancy ledger",
      total.roomCents, cents(1011258.67));
    eq("ancillary is the documented remainder", total.ancillaryCents, cents(9339.50));

    // The figure CLAUDE.md section 10 requires every page to reconcile to.
    eq("total reconciles to the benchmark to the exact cent",
      total.cents, cents(1020598.17));

    ok("…and it is strictly greater than the room-only figure the card used to imply",
      total.cents > total.roomCents,
      `total ${total.cents} > room ${total.roomCents} by ${total.cents - total.roomCents} cents`);

    // With no gross ledger the helper must SAY it is room-only, so the label can.
    const roomOnly = grossRevenueForPeriod({ grossRows: [], occRows });
    eq("basis falls back to \"room\" with no gross rows", roomOnly.basis, "room");
    eq("and then carries no ancillary", roomOnly.ancillaryCents, 0);
  }
}

// ═══ 3. The previous-period window, in the owner's timezone ═══════════════════
console.log("\n=== 3. the elapsed-day window (TZ=America/New_York) ===");
{
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  ok("the probe is running in a zone behind UTC", tz === "America/New_York", `TZ=${tz}`);

  const { isoEpochDay, epochDayToIso } = hotelMod;
  ok("hotel.js exports isoEpochDay", typeof isoEpochDay === "function",
    "the page needs one timezone-immune day primitive; see hotel.js");
  ok("hotel.js exports epochDayToIso", typeof epochDayToIso === "function",
    "the window's END DATE is displayed, so the inverse is needed too");

  if (typeof isoEpochDay === "function" && typeof epochDayToIso === "function") {
    // Known values. The epoch day of 1970-01-01 is 0 by definition.
    eq("1970-01-01 is day 0", isoEpochDay("1970-01-01"), 0);
    eq("1970-01-02 is day 1", isoEpochDay("1970-01-02"), 1);
    ok("a trailing time component is ignored",
      isoEpochDay("2026-08-02T13:45:00Z") === isoEpochDay("2026-08-02"));
    ok("garbage is NaN, not a silent 0", Number.isNaN(isoEpochDay("")) && Number.isNaN(isoEpochDay("nope")));

    // The pair must be inverses, including across both DST boundaries.
    let roundTrips = 0;
    for (const iso of ["1970-01-01", "2024-02-29", "2025-03-09", "2025-11-02", "2026-01-01", "2026-08-02", "2099-12-31"]) {
      if (epochDayToIso(isoEpochDay(iso)) === iso) roundTrips++;
    }
    eq("epochDayToIso round-trips every probed date", roundTrips, 7);
    eq("a non-finite day yields \"\", not \"Invalid Date\"", epochDayToIso(NaN), "");

    // Span arithmetic: the live filter is 214 days inclusive.
    eq("2026-01-01 -> 2026-08-02 is 214 days inclusive",
      isoEpochDay("2026-08-02") - isoEpochDay("2026-01-01") + 1, 214);

    // The heart of D2. Reproduce the shipped expression, then the fixed one.
    const shipped = (curFrom, curTo, prevFrom_) => {
      const from = new Date(curFrom);
      const to = new Date(curTo);
      const elapsedDays = Math.round((to.getTime() - from.getTime()) / 86400000) + 1;
      const prevFrom = new Date(prevFrom_);
      const prevToDate = new Date(prevFrom);
      prevToDate.setDate(prevFrom.getDate() + elapsedDays - 1);
      return prevToDate.toISOString().slice(0, 10);
    };
    // Exactly the expression the page now uses, driven through the real helpers.
    const fixed = (curFrom, curTo, prevFrom_) => {
      const days = isoEpochDay(curTo) - isoEpochDay(curFrom) + 1;
      const startDay = isoEpochDay(prevFrom_);
      return epochDayToIso(startDay + days - 1);
    };

    // Case A: the exact filter the live site is showing right now.
    eq("LIVE FILTER — fixed window ends 2025-08-02",
      fixed("2026-01-01", "2026-08-02", "2025-01-01"), "2025-08-02");
    ok("…and the shipped expression ended a day EARLIER, dropping a day of prior revenue",
      shipped("2026-01-01", "2026-08-02", "2025-01-01") === "2025-08-01",
      `shipped=${shipped("2026-01-01", "2026-08-02", "2025-01-01")}`);

    // Case B: a month that spans US spring-forward.
    eq("March 2026 vs 2025 — fixed window ends 2025-03-31",
      fixed("2026-03-01", "2026-03-31", "2025-03-01"), "2025-03-31");
    ok("…shipped lost a day here too",
      shipped("2026-03-01", "2026-03-31", "2025-03-01") === "2025-03-30",
      `shipped=${shipped("2026-03-01", "2026-03-31", "2025-03-01")}`);

    // Case C: cases where the old code happened to be right must STAY right.
    for (const [name, cf, ct, pf, want] of [
      ["January only", "2026-01-01", "2026-01-31", "2025-01-01", "2025-01-31"],
      ["August only", "2026-08-01", "2026-08-31", "2025-08-01", "2025-08-31"],
      ["a full year", "2026-01-01", "2026-12-31", "2025-01-01", "2025-12-31"],
      ["November", "2026-11-01", "2026-11-30", "2025-11-01", "2025-11-30"],
      ["a single day", "2026-08-02", "2026-08-02", "2025-08-02", "2025-08-02"],
      ["a leap-year February", "2024-02-01", "2024-02-29", "2023-02-01", "2023-03-01"],
    ]) {
      eq(`no regression — ${name}`, fixed(cf, ct, pf), want);
    }

    // The primitive must not consult the host calendar at all.
    const hotelSrc = read("src/lib/hotel.js");
    const body = (hotelSrc.match(/export function isoEpochDay[\s\S]*?\n\}/) || [""])[0]
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");
    ok("isoEpochDay is built on Date.UTC", /Date\.UTC\(/.test(body));
    ok("…and touches no local calendar accessor",
      !/\b(getDate|setDate|getMonth|setMonth|getFullYear|setFullYear|getDay)\(/.test(body),
      "a single local accessor reintroduces the whole defect");
  }
}

// ═══ 4. The page source contract ══════════════════════════════════════════════
console.log("\n=== 4. src/pages/MtdGrowth.jsx ===");
{
  const page = code("src/pages/MtdGrowth.jsx");

  ok("the page no longer does local calendar math",
    !/\.setDate\(/.test(page),
    "setDate() on a date-only parse is exactly the D2 defect");
  ok("the elapsed window is derived with isoEpochDay",
    /isoEpochDay/.test(page),
    "the window must use the timezone-immune primitive");

  ok("the gross ledger is loaded",
    /useGrossRevenue/.test(page),
    "a true total cannot be assembled from the occupancy ledger alone");
  ok("the total comes from the shared helper",
    /grossRevenueForPeriod\(\s*\{/.test(page),
    "Dashboard.jsx:164 uses the same helper — there must be one implementation");

  // A naive "is the literal summed" check PASSES on the pre-fix source, because
  // the defect was `sum(rows, key)` with a variable — measured: that assertion
  // was green before any of this was fixed. Assert the structure instead.
  const metricsBlock = (page.match(/const METRICS = \[[\s\S]*?\n\];/) || [""])[0];
  const revEntry = (metricsBlock.match(/\{[^{}]*key:\s*["']total_revenue["'][^{}]*\}/) || [""])[0];
  ok("METRICS still carries a total_revenue entry", revEntry.length > 0);
  ok("…and THAT ENTRY is flagged derived",
    /derived:\s*true/.test(revEntry),
    revEntry.replace(/\s+/g, " ").trim().slice(0, 110));
  ok("the comparison map branches on m.derived before it can reach calc()",
    /METRICS\.map\(\([^)]*\)\s*=>\s*\{\s*if\s*\(m\.derived\)/.test(page),
    "an unflagged derived metric falls through to sum() and reads $0 again");
  ok("the derived subtraction runs in integer cents",
    /curTotal\.(cents|roomCents)/.test(page) && /prevTotal\.(cents|roomCents)/.test(page),
    "BRAIN_FINANCE.md 12.5 — this is the figure reconciled against a statement");

  ok("the label states its basis instead of overstating",
    /basis\s*===\s*["']room["']/.test(page),
    "grossRevenueForPeriod returns basis precisely so the UI can say which it is");
  ok("mismatched bases fall back to the room leg on BOTH sides",
    /curTotal\.basis\s*!==\s*prevTotal\.basis/.test(page),
    "comparing a total against a room-only prior reports missing ancillary as growth");

  // The page must describe the span it measures — the same class of defect as
  // MonthlyCalendar (BRAIN_FRONTEND.md 16).
  ok("the header prints the TRUNCATED comparison window",
    /prevWindow\?\./.test(page) && !/vs Previous:\s*\{compareDateRange\.from/.test(page),
    "it used to print the full prior period next to a truncated day count");

  // Guard the Owner's Snapshot, which reads the metric by key and narrates it.
  ok("the snapshot still resolves the revenue metric by key",
    /get\(\s*["']total_revenue["']\s*\)/.test(page),
    "the key is an identifier for the card, not a field read");
}

// ═══ 5. The hook the page now depends on ══════════════════════════════════════
console.log("\n=== 5. useGrossRevenue must be gateable ===");
{
  const hooks = code("src/lib/useHotelData.js");

  ok("useGrossRevenue accepts an enabled flag defaulting to true",
    /export function useGrossRevenue\([^)]*enabled\s*=\s*true\s*\)/.test(hooks),
    "an ungated call with an empty range runs GrossRevenueDay.list() — a full table read");
  ok("…and passes it to useQuery",
    /queryKey:\s*\["gross"[\s\S]{0,120}?\n\s*enabled,/.test(hooks),
    "declaring the parameter without wiring it is worse than not having it");
  ok("it still range-filters when a range is given",
    /GrossRevenueDay\.filter\(filter, "date", limit\)/.test(hooks));
  ok("useOccupancy's signature is unchanged",
    /export function useOccupancy\(dateRange, propertyId, months = \[\], enabled = true\)/.test(hooks),
    "the new parameter mirrors this one deliberately");

  // Pre-existing callers must be unaffected by the added parameter.
  for (const f of ["src/pages/Dashboard.jsx", "src/pages/ChartBuilder.jsx"]) {
    const calls = (read(f).match(/useGrossRevenue\([^)]*\)/g) || []);
    ok(`${path.basename(f)} still calls useGrossRevenue`, calls.length > 0, calls.join(" | "));
    ok(`…and relies on the default (no 4th argument)`,
      calls.every((c) => c.split(",").length <= 3),
      calls.join(" | "));
  }
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
