// Probe: Monthly Calendar day modal hides event intelligence on no-data days,
// and both of its dialog titles name the WRONG DAY.
//
// Reported symptom (owner, 2026-08-20): a calendar cell badges "1 EVENT", but
// clicking it opens a dialog that says only "No data imported for this day." —
// the event that the cell just advertised is nowhere in the dialog. Separately,
// the dialog header for the cell numbered 6 read "Wednesday, August 5".
//
// Three distinct defects, all in the calendar day surface:
//
//   1. DROPPED EVENTS — in MonthlyCalendar.jsx the "Events Driving Demand"
//      block lives INSIDE the `selectedData ? (...) : (...)` truthy branch, so
//      a night with events but no imported OccupancyDay row renders the else
//      branch and the events are discarded. The demand intel exists in memory
//      (eventsByDate has it, the cell badge proves it) and is thrown away at
//      render time.
//
//   2. OFF-BY-ONE TITLE — `new Date("2026-08-06")` parses a date-ONLY string as
//      UTC midnight per ECMA-262, then `.toLocaleDateString()` renders it in the
//      host zone. In America/New_York (UTC-4) that is 2026-08-05T20:00 local, so
//      the header names the PREVIOUS day. Every US zone is behind UTC, so this
//      mislabels every day of the year for this owner. The cure is to build a
//      LOCAL midnight from the parts, which is what src/lib/exportData.js
//      describeRange() already does — the correct pattern was in the repo, just
//      not shared.
//
//   3. DEAD BADGE — on a no-data day the event badge is rendered as a plain
//      <div>, while data days get a <button> wired to setEventPopupDay. So the
//      richer Event Details popup is unreachable on exactly the days where it
//      is the only information available.
//
// Defect 2 also fires in src/pages/ActionCenter.jsx:406, which prints the
// mislabeled weekday DIRECTLY ABOVE the raw (correct) date string.
//
// Sections 1-2 exercise the real production module. Sections 3-5 are structural
// assertions on the JSX: `vite`/`vitest` binaries cannot run on this mount (the
// node_modules tree is a Windows install and the registry is unreachable), so
// the components cannot be rendered here. These assertions pin the render
// STRUCTURE that produces the behaviour instead, and are written to fail loudly
// if the gating is ever reintroduced.
//
// Run: node --import ./scripts/_loader-boot.mjs scripts/probe-calendar-day-modal.mjs

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

let failures = 0;
let passes = 0;

// `cond` may be a boolean or a thunk; a thunk that throws is recorded as a
// FAILURE rather than aborting the run, so one missing export cannot hide the
// state of every later section.
const check = (label, cond, extra = "") => {
  let ok = false;
  let thrown = "";
  try {
    ok = typeof cond === "function" ? cond() : cond;
  } catch (e) {
    thrown = ` [threw: ${e.message}]`;
  }
  if (ok) {
    passes++;
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ""}${thrown}`);
  }
  return ok;
};

const src = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// Slice a named region out of a source file so an assertion cannot accidentally
// be satisfied by an unrelated part of a 500-line component.
const region = (text, startMarker, endMarker, label) => {
  const a = text.indexOf(startMarker);
  if (a === -1) throw new Error(`region ${label}: start marker not found: ${startMarker}`);
  const b = text.indexOf(endMarker, a);
  if (b === -1) throw new Error(`region ${label}: end marker not found: ${endMarker}`);
  return text.slice(a, b);
};

console.log("=== PROBE: calendar day modal — dropped events, wrong date, dead badge ===");
console.log(`process TZ: ${process.env.TZ || "(host default)"} · resolved: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);

// ---------------------------------------------------------------------------
// SECTION 1 — demonstrate the root cause of the off-by-one title
// ---------------------------------------------------------------------------
console.log("\n[1] Root cause: date-only strings parse as UTC, format as local");

const LABEL_OPTS = { weekday: "long", month: "long", day: "numeric" };
const buggy = (d) => new Date(d).toLocaleDateString("en-US", LABEL_OPTS);

// The two cases straight off the owner's screenshots.
console.log(`     new Date("2026-08-06") -> "${buggy("2026-08-06")}"   (cell clicked: 6)`);
console.log(`     new Date("2026-08-01") -> "${buggy("2026-08-01")}"   (cell clicked: 1)`);

check(
  'the buggy expression mislabels 2026-08-06 (reproduces the screenshot)',
  () => buggy("2026-08-06") === "Wednesday, August 5",
  `got "${buggy("2026-08-06")}" — expected the defect to yield "Wednesday, August 5"; if this fails the host is not behind UTC and section 2 is the real test`
);

// ---------------------------------------------------------------------------
// SECTION 2 — the shared helper must be timezone-safe
// ---------------------------------------------------------------------------
console.log("\n[2] src/lib/hotel.js must export a timezone-safe formatDayLabel");

let formatDayLabel = null;
try {
  ({ formatDayLabel } = await import("@/lib/hotel.js"));
} catch (e) {
  console.log(`     import of @/lib/hotel.js failed: ${e.message}`);
}

check("hotel.js exports formatDayLabel", () => typeof formatDayLabel === "function");

const CASES = [
  ["2026-08-06", "Thursday, August 6"],
  ["2026-08-01", "Saturday, August 1"],
  ["2026-07-31", "Friday, July 31"],
  ["2026-01-01", "Thursday, January 1"],
  ["2026-12-31", "Thursday, December 31"],
  // A DST boundary in the owner's zone (2026-03-08 is the US spring-forward).
  ["2026-03-08", "Sunday, March 8"],
  ["2026-11-01", "Sunday, November 1"],
  // Leap day, in a leap year.
  ["2024-02-29", "Thursday, February 29"],
];

for (const [input, expected] of CASES) {
  check(
    `formatDayLabel("${input}") === "${expected}"`,
    () => formatDayLabel(input) === expected,
    () => `got "${formatDayLabel(input)}"`
  );
}

check(
  "formatDayLabel tolerates a full ISO timestamp by taking the date part",
  () => formatDayLabel("2026-08-06T00:00:00.000Z") === "Thursday, August 6",
  () => `got "${formatDayLabel("2026-08-06T00:00:00.000Z")}"`
);

check("formatDayLabel returns empty string for null/empty input", () =>
  formatDayLabel(null) === "" && formatDayLabel("") === "" && formatDayLabel(undefined) === "");

check(
  "formatDayLabel does not invent a date from garbage input",
  () => formatDayLabel("not-a-date") === "",
  () => `got "${formatDayLabel("not-a-date")}"`
);

check(
  "formatDayLabel honours caller-supplied Intl options",
  () => formatDayLabel("2026-08-06", { weekday: "short", month: "short", day: "numeric" }) === "Thu, Aug 6",
  () => `got "${formatDayLabel("2026-08-06", { weekday: "short", month: "short", day: "numeric" })}"`
);

// ---------------------------------------------------------------------------
// SECTION 3 — the day dialog must render events independently of imported data
// ---------------------------------------------------------------------------
console.log("\n[3] MonthlyCalendar day dialog: events must not be gated on selectedData");

const cal = src("src/pages/MonthlyCalendar.jsx");
const dayDialog = region(cal, "{/* Daily Detail Panel */}", "{/* Event Details Popup", "day dialog");

const iEvents = dayDialog.indexOf("selectedEvents.map");
const iTernary = dayDialog.indexOf("selectedData ? (");

check("day dialog renders the selectedEvents list", () => iEvents !== -1);
check("day dialog still has a selectedData branch for the metrics", () => iTernary !== -1);
check(
  "the events block sits OUTSIDE (above) the selectedData ternary",
  () => iEvents !== -1 && iTernary !== -1 && iEvents < iTernary,
  `selectedEvents.map at offset ${iEvents}, "selectedData ? (" at offset ${iTernary} — a larger events offset means the events are nested in the data-present branch and vanish on no-data days`
);

check(
  "the events block is not itself conditioned on selectedData",
  () => !/selectedData\s*&&\s*selectedEvents/.test(dayDialog) && !/selectedEvents[\s\S]{0,40}&&\s*selectedData/.test(dayDialog)
);

check(
  "the no-data branch still tells the owner revenue is missing",
  () => /No revenue data imported|No data imported/.test(dayDialog)
);

check(
  "the no-data branch still links to the importer",
  () => /to="\/upload"/.test(dayDialog)
);

// ---------------------------------------------------------------------------
// SECTION 4 — both dialog titles must use the shared helper
// ---------------------------------------------------------------------------
console.log("\n[4] No raw new Date(dateString).toLocaleDateString in the calendar surface");

for (const rel of ["src/pages/MonthlyCalendar.jsx", "src/pages/ActionCenter.jsx"]) {
  const text = src(rel);
  const offenders = [...text.matchAll(/new Date\([^)]*\)\s*\.toLocaleDateString/g)];
  check(
    `${rel} has no raw new Date(...).toLocaleDateString`,
    () => offenders.length === 0,
    `found ${offenders.length}: ${offenders.map((m) => m[0]).join(" | ")}`
  );
  check(`${rel} imports formatDayLabel`, () => /formatDayLabel/.test(text));
}

const titles = [...cal.matchAll(/formatDayLabel\(/g)];
check(
  "MonthlyCalendar calls formatDayLabel at least twice (both dialog titles)",
  () => titles.length >= 2,
  `found ${titles.length}`
);

// ---------------------------------------------------------------------------
// SECTION 5 — the event badge must be tappable on every day, data or not
// ---------------------------------------------------------------------------
console.log("\n[5] Day-cell event badge must open the Event Details popup on no-data days too");

const dayCell = region(
  cal,
  "const cellEvents = eventsByDate.get(cell.date)",
  "{/* Performance Groups */}",
  "day cell"
);

check(
  "no badge variant is gated on !cell.data",
  () => !/cellEvents\.length\s*>\s*0\s*&&\s*!cell\.data/.test(dayCell),
  "a !cell.data-gated badge is the dead <div> variant"
);

check(
  "no badge variant is gated on cell.data",
  () => !/cell\.data\s*&&\s*cellEvents\.length\s*>\s*0/.test(dayCell),
  "a cell.data-gated badge means no-data days fall through to a different, non-interactive variant"
);

const handlers = [...dayCell.matchAll(/setEventPopupDay\(cell\.date\)/g)];
check(
  "exactly one badge element, wired to setEventPopupDay",
  () => handlers.length === 1,
  `found ${handlers.length} setEventPopupDay(cell.date) call sites — expected a single unified badge`
);

check(
  "the badge is a <button type=\"button\"> (keyboard reachable, not a <div>)",
  () => {
    const i = dayCell.indexOf("setEventPopupDay(cell.date)");
    if (i === -1) return false;
    const before = dayCell.slice(Math.max(0, i - 400), i);
    const lastButton = before.lastIndexOf("<button");
    const lastDiv = before.lastIndexOf("<div");
    return lastButton !== -1 && lastButton > lastDiv && /type="button"/.test(before.slice(lastButton));
  }
);

check(
  "the badge stops propagation so it does not also open the day dialog",
  () => /stopPropagation\(\)[^}]*setEventPopupDay|setEventPopupDay[\s\S]{0,80}stopPropagation/.test(dayCell)
    || /e\.stopPropagation\(\);\s*setEventPopupDay/.test(dayCell)
);

// ---------------------------------------------------------------------------
console.log(`\n=== RESULT: ${passes} passed, ${failures} failed ===`);
if (failures > 0) {
  console.log("DEFECTS PRESENT — see failures above.");
  process.exit(1);
}
console.log("All calendar day-modal invariants hold.");
process.exit(0);
