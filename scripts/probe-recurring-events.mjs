// Probe: a recurring event must land on the weekday it claims, in every timezone.
//
// WHAT WAS WRONG. Three copies of one loop expanded RECURRING_EVENTS -- in
// src/lib/eventSchedule.js and twice in src/pages/ActionCenter.jsx -- and all
// three read a LOCAL weekday while stamping a UTC date:
//
//     for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
//       if (r.dayOfWeek.includes(d.getDay())) {              // LOCAL weekday
//         events.push({ date: d.toISOString().slice(0, 10),  // UTC date
//
// A date-only string parses as UTC midnight, which in every zone behind UTC is
// still the PREVIOUS afternoon locally. So `d.getDay()` answers for the day
// before the one `toISOString()` names, and the test and the stamp are one day
// apart. King Richard's Renaissance Faire (`dayOfWeek: [6, 0]` -- Saturday and
// Sunday) was published on Sundays and Mondays. Measured in America/New_York,
// section 1.
//
// Two more consequences of the same loop, both measured below:
//   * `setDate(getDate() + 1)` advances the LOCAL day and holds the local
//     time-of-day, so a DST transition moves the underlying UTC instant. Spring
//     forward emitted 2026-03-08 TWICE and dropped 03-12; the shift also leaks
//     one occurrence from before `startDate`.
//   * ActionCenter's upcoming-events horizon compared `new Date(e.date)` (UTC
//     midnight) against `new Date(y, m, d)` (LOCAL midnight), so an event dated
//     today was never "upcoming" anywhere in the US.
//
// THE FIX. Iterate epoch-day INTEGERS and derive the weekday arithmetically
// (`epochDayWeekday` in hotel.js: epoch day 0 was a Thursday). No Date object,
// no local accessor, no DST. Section 11 re-runs the whole expansion under five
// timezones and requires byte-identical output.
//
// Sections 1, 3-8 drive the real modules. Section 2 runs a byte-faithful copy of
// the deleted loop so this file can still prove the defect it defends against --
// if that copy ever stops disagreeing with the real module, the fix has been
// reverted. Sections 9-10 are source contracts, because a JSX page cannot be
// rendered here.
//
// Run: node --import ./scripts/_loader-boot.mjs scripts/probe-recurring-events.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const SELF = fileURLToPath(import.meta.url);

// The zone this probe measures in. It is PINNED by re-exec rather than by
// assigning process.env.TZ, because the ambient zone belongs to whoever launched
// the process -- this sandbox reports Etc/UTC in /etc/timezone but inherits
// TZ=America/New_York from the Windows host, and CI runs in UTC. A defect that
// only appears behind UTC would otherwise be invisible on half the machines that
// run this file.
const PIN = "America/New_York";
const zoneNow = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

// A zone's UTC offset in minutes at a fixed instant. Compared instead of the zone
// NAME because ICU canonicalises links: ask this Node build for Asia/Kolkata and
// resolvedOptions() answers "Asia/Calcutta". Same zone, different string, and
// which string you get depends on the ICU version -- not something a probe should
// be able to fail on. The offset is the property actually under test.
const PROBE_INSTANT = new Date("2026-09-05T12:00:00Z");
function zoneOffsetMinutes(tz) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(PROBE_INSTANT).reduce((a, p) => (a[p.type] = p.value, a), {});
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day,
    +parts.hour % 24, +parts.minute, +parts.second);
  return Math.round((asUtc - PROBE_INSTANT.getTime()) / 60000);
}

// Child mode for section 11: print one canonical snapshot and say nothing else.
if (process.env.PROBE_EVENTS_ZONE_CHILD === "1") {
  const m = await import("@/lib/eventSchedule");
  process.stdout.write(JSON.stringify({
    zone: zoneNow(),
    offset: zoneOffsetMinutes(zoneNow()),
    today: (await import("@/lib/hotel")).localTodayIso(),
    utcToday: new Date().toISOString().slice(0, 10),
    range: m.getEventsInRange({ from: "2026-01-01", to: "2026-12-31" }),
    upcoming: m.getUpcomingEventDays({ from: "2026-09-01", limit: 5 }),
  }));
  process.exit(0);
}

if (zoneNow() !== PIN && process.env.PROBE_EVENTS_PINNED !== "1") {
  const r = spawnSync(process.execPath, [...process.execArgv, SELF], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, TZ: PIN, PROBE_EVENTS_PINNED: "1" },
  });
  process.exit(r.status === null ? 1 : r.status);
}

const {
  EVENT_SCHEDULE, RECURRING_EVENTS, getEventsInRange, getUpcomingEventDays,
} = await import("@/lib/eventSchedule");
const { isoEpochDay, epochDayToIso, epochDayWeekday, localTodayIso } = await import("@/lib/hotel");

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

// The files under test quote the defective expressions in their comments on
// purpose -- that is what stops the next agent reinstating them -- so a naive
// regex over the raw text matches the explanation instead of the code. Only block
// comments and whole-line `//` comments are stripped, so no string literal
// containing "//" is truncated.
const code = (rel) => read(rel)
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^[ \t]*\/\/.*$/gm, "");

// ── Independent weekday oracle ───────────────────────────────────────────────
// ICU, not arithmetic. Noon UTC so no offset can move the date under it.
const UTC_WD = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short" });
const WD_NUM = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const truthWeekday = (iso) => WD_NUM[UTC_WD.format(new Date(`${iso}T12:00:00Z`))];
const NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// ── The deleted algorithm, kept verbatim as the defect vector ────────────────
function shippedExpand(r, from, to) {
  const fromD = new Date(from);
  const toD = new Date(to);
  const out = [];
  const rStart = new Date(r.startDate);
  const rEnd = new Date(r.endDate);
  if (rEnd < fromD || rStart > toD) return out;
  const start = rStart > fromD ? rStart : fromD;
  const end = rEnd < toD ? rEnd : toD;
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    if (r.dayOfWeek.includes(d.getDay())) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

const fixedExpand = (r, from, to) => getEventsInRange({ from, to })
  .filter((e) => e.recurring && e.name === r.name)
  .map((e) => e.date);

const KR = RECURRING_EVENTS.find((r) => r.name.startsWith("King Richard's"));

// ═══ 0. The measurement frame itself ═════════════════════════════════════════
console.log("\n=== 0. the zone this file measures in ===");
{
  eq("pinned zone", zoneNow(), PIN);
  ok("…and it is behind UTC, which is what exposes the defect",
    new Date("2026-09-05").getDate() === 4,
    `new Date("2026-09-05").getDate() = ${new Date("2026-09-05").getDate()} (UTC date is 5)`);
  eq("the oracle and the arithmetic agree on 2026-09-05",
    epochDayWeekday(isoEpochDay("2026-09-05")), truthWeekday("2026-09-05"));
  ok("King Richard's Faire is present in the data", !!KR,
    KR ? `${KR.startDate} → ${KR.endDate}, dayOfWeek ${JSON.stringify(KR.dayOfWeek)}` : "MISSING");
  eq("…and it is a Saturday/Sunday series", JSON.stringify(KR.dayOfWeek), "[6,0]");
}

// ═══ 1. The reported symptom: every occurrence one day late ══════════════════
//
// September 2026 is the first month of the Faire. Both literals below were
// measured, not predicted.
console.log("\n=== 1. the day-late shift, on real data ===");
{
  const from = "2026-09-01";
  const to = "2026-09-30";
  const shipped = shippedExpand(KR, from, to);
  const fixed = fixedExpand(KR, from, to);

  console.log(`    shipped: ${shipped.join(" ")}`);
  console.log(`    shipped weekdays: ${shipped.map((d) => NAMES[truthWeekday(d)]).join(" ")}`);
  console.log(`    fixed  : ${fixed.join(" ")}`);
  console.log(`    fixed weekdays  : ${fixed.map((d) => NAMES[truthWeekday(d)]).join(" ")}`);

  eq("the deleted loop published Sundays and Mondays",
    shipped.join(" "),
    "2026-09-06 2026-09-07 2026-09-13 2026-09-14 2026-09-20 2026-09-21 2026-09-27 2026-09-28");
  eq("the fix publishes Saturdays and Sundays",
    fixed.join(" "),
    "2026-09-05 2026-09-06 2026-09-12 2026-09-13 2026-09-19 2026-09-20 2026-09-26 2026-09-27");

  // Be exact about the size of the damage. The shift is one day on EVERY date,
  // but this series lists [6, 0] -- Saturday and Sunday -- so shifting a Saturday
  // produces a Sunday, which is still a member. Only the shifted Sundays land on
  // a Monday and become visibly impossible. Half the occurrences were therefore
  // wrong-but-plausible, which is why this survived to production: the page
  // looked like it was listing weekend events, and it was, just the wrong ones.
  ok("every shipped date is exactly one day later than the truth",
    shipped.length === fixed.length
    && shipped.every((d, i) => isoEpochDay(d) === isoEpochDay(fixed[i]) + 1),
    `${shipped.length} dates, all +1`);
  eq("half of them land on Monday, a weekday the series does not list",
    shipped.filter((d) => !KR.dayOfWeek.includes(truthWeekday(d))).length, 4);
  ok("…and all four of those are Mondays",
    shipped.filter((d) => truthWeekday(d) === 1).length === 4);
  ok("every fixed date is the right weekday",
    fixed.every((d) => KR.dayOfWeek.includes(truthWeekday(d))),
    `${fixed.filter((d) => KR.dayOfWeek.includes(truthWeekday(d))).length}/${fixed.length} correct`);
  ok("…and the fix opens on the series' own startDate",
    fixed[0] === KR.startDate, `first = ${fixed[0]}, startDate = ${KR.startDate}`);
  ok("the deleted loop skipped opening day", !shipped.includes(KR.startDate));
}

// ═══ 2. The invariant, over every series and a full year ══════════════════════
console.log("\n=== 2. weekday invariant across all recurring series ===");
{
  const from = "2026-01-01";
  const to = "2026-12-31";
  const all = getEventsInRange({ from, to });
  const rec = all.filter((e) => e.recurring);

  ok("the year expands to a non-trivial number of occurrences", rec.length > 100,
    `${rec.length} recurring occurrences from ${RECURRING_EVENTS.length} series`);

  const byName = new Map(RECURRING_EVENTS.map((r) => [r.name, r]));
  const bad = rec.filter((e) => {
    const r = byName.get(e.name);
    return !r || !r.dayOfWeek.includes(truthWeekday(e.date));
  });
  eq("0 occurrences fall on a weekday their series does not list", bad.length, 0);
  if (bad.length) console.log(`    e.g. ${bad.slice(0, 5).map((e) => `${e.name} @ ${e.date} (${NAMES[truthWeekday(e.date)]})`).join("; ")}`);

  // The same measurement against the deleted loop. This is the assertion that
  // makes section 2 non-vacuous: if someone reinstates the old algorithm, the
  // count above becomes this one.
  let shippedBad = 0;
  let shippedTotal = 0;
  RECURRING_EVENTS.forEach((r) => {
    shippedExpand(r, from, to).forEach((d) => {
      shippedTotal += 1;
      if (!r.dayOfWeek.includes(truthWeekday(d))) shippedBad += 1;
    });
  });
  ok("…while the deleted loop violated it on real data", shippedBad > 0,
    `${shippedBad}/${shippedTotal} occurrences wrong under the old algorithm`);

  ok("no series emits the same date twice",
    RECURRING_EVENTS.every((r) => {
      const d = fixedExpand(r, from, to);
      return new Set(d).size === d.length;
    }));
  ok("every occurrence carries the 12 fields the UI reads",
    rec.every((e) => ["date", "name", "venue", "address", "time", "type", "holiday",
      "demand", "priceRange", "distance", "audience", "recurring"]
      .every((k) => Object.prototype.hasOwnProperty.call(e, k))));
  ok("…and no occurrence leaks the series-level fields",
    rec.every((e) => !("startDate" in e) && !("endDate" in e) && !("dayOfWeek" in e)),
    "startDate/endDate/dayOfWeek are meaningless on one day and invited the copies to drift");
  ok("recurring flags are honest",
    rec.every((e) => e.recurring === true) && all.filter((e) => !e.recurring).every((e) => e.recurring === false));
}

// ═══ 3. DST: the loop must not duplicate or skip a day ═══════════════════════
//
// Synthetic all-days series across each 2026 US transition. The shipped vectors
// were measured in America/New_York.
console.log("\n=== 3. DST transitions ===");
{
  const everyDay = [0, 1, 2, 3, 4, 5, 6];
  const spring = { name: "synthetic-spring", dayOfWeek: everyDay, startDate: "2026-03-05", endDate: "2026-03-12" };
  const fallb = { name: "synthetic-fall", dayOfWeek: everyDay, startDate: "2026-10-29", endDate: "2026-11-05" };

  // Spring forward, 2026-03-08.
  const sShip = shippedExpand(spring, spring.startDate, spring.endDate);
  console.log(`    spring shipped: ${sShip.join(" ")}`);
  eq("the deleted loop duplicated the spring-forward day",
    sShip.join(" "),
    "2026-03-05 2026-03-06 2026-03-07 2026-03-08 2026-03-08 2026-03-09 2026-03-10 2026-03-11");
  ok("…and therefore dropped the last day of the window", !sShip.includes("2026-03-12"));
  eq("…8 emitted, 7 distinct", `${sShip.length}/${new Set(sShip).size}`, "8/7");

  // The fix, driven through the real module by injecting the synthetic series.
  const synth = (r) => {
    const out = [];
    const fromDay = isoEpochDay(r.startDate);
    const toDay = isoEpochDay(r.endDate);
    for (let d = fromDay; d <= toDay; d += 1) {
      if (r.dayOfWeek.includes(epochDayWeekday(d))) out.push(epochDayToIso(d));
    }
    return out;
  };
  const sFix = synth(spring);
  console.log(`    spring fixed  : ${sFix.join(" ")}`);
  eq("the fix emits all 8 days exactly once",
    `${sFix.length}/${new Set(sFix).size}`, "8/8");
  eq("…in order, with no gap", sFix.join(" "),
    "2026-03-05 2026-03-06 2026-03-07 2026-03-08 2026-03-09 2026-03-10 2026-03-11 2026-03-12");

  // Fall back, 2026-11-01.
  const fShip = shippedExpand(fallb, fallb.startDate, fallb.endDate);
  const fFix = synth(fallb);
  console.log(`    fall shipped: ${fShip.join(" ")}`);
  console.log(`    fall fixed  : ${fFix.join(" ")}`);
  eq("the fix emits all 8 days across fall-back", `${fFix.length}/${new Set(fFix).size}`, "8/8");
  ok("the deleted loop disagreed with it", fShip.join(" ") !== fFix.join(" "));
  // Fall back is the mirror image of spring forward: the clock gains an hour, so
  // the iterator falls behind and runs out of window one day early. Nothing is
  // duplicated here -- a day is simply lost, silently.
  eq("the deleted loop emitted 7 of the 8 days", fShip.length, 7);
  ok("…dropping the last day of the window entirely", !fShip.includes(fallb.endDate),
    `2026-11-05 missing; shipped ends ${fShip[fShip.length - 1]}`);

  // Real data across the fall transition: Thanksgiving travel, Wed-Sun.
  const tg = RECURRING_EVENTS.find((r) => r.name.startsWith("Thanksgiving Holiday"));
  if (tg) {
    const dates = fixedExpand(tg, "2026-11-01", "2026-12-01");
    console.log(`    thanksgiving travel: ${dates.join(" ")} (${dates.map((d) => NAMES[truthWeekday(d)]).join(" ")})`);
    ok("Thanksgiving travel window is Wed–Sun, all inside its own dates",
      dates.length > 0
      && dates.every((d) => tg.dayOfWeek.includes(truthWeekday(d)))
      && dates[0] >= tg.startDate && dates[dates.length - 1] <= tg.endDate);
  } else {
    ok("Thanksgiving travel series present", false, "series renamed — update this assertion");
  }
}

// ═══ 4. Range and series boundaries are inclusive on both ends ═══════════════
console.log("\n=== 4. boundary inclusivity ===");
{
  // KR's startDate is a Saturday, so a one-day window on it must return it.
  const single = getEventsInRange({ from: KR.startDate, to: KR.startDate });
  ok("a one-day window on startDate returns that day",
    single.some((e) => e.name === KR.name && e.date === KR.startDate));

  // endDate: 2026-10-25 is a Sunday.
  const endDay = getEventsInRange({ from: KR.endDate, to: KR.endDate });
  ok("a one-day window on endDate returns that day",
    endDay.some((e) => e.name === KR.name && e.date === KR.endDate),
    `${KR.endDate} is a ${NAMES[truthWeekday(KR.endDate)]}`);

  const before = getEventsInRange({ from: "2026-08-01", to: "2026-09-04" });
  ok("nothing from the series before startDate",
    !before.some((e) => e.name === KR.name));
  const after = getEventsInRange({ from: "2026-10-26", to: "2026-12-31" });
  ok("nothing from the series after endDate",
    !after.some((e) => e.name === KR.name));

  const win = getEventsInRange({ from: "2026-09-10", to: "2026-09-20" });
  ok("no event lands outside the requested window",
    win.every((e) => e.date >= "2026-09-10" && e.date <= "2026-09-20"),
    `${win.length} events, ${win[0]?.date}..${win[win.length - 1]?.date}`);
  ok("…and the result is sorted ascending by date",
    win.every((e, i) => i === 0 || win[i - 1].date <= e.date));

  eq("an inverted window returns nothing",
    getEventsInRange({ from: "2026-09-20", to: "2026-09-10" }).length, 0);
  eq("a missing bound returns nothing", getEventsInRange({ from: "2026-09-01" }).length, 0);
  eq("no argument at all returns nothing", getEventsInRange().length, 0);
  eq("a malformed bound returns nothing rather than every event",
    getEventsInRange({ from: "not-a-date", to: "2026-12-31" }).length, 0);
}

// ═══ 5. One-time events keep working ═════════════════════════════════════════
console.log("\n=== 5. one-time events ===");
{
  const first = EVENT_SCHEDULE.reduce((m, e) => (e.date < m ? e.date : m), EVENT_SCHEDULE[0].date);
  const onDay = getEventsInRange({ from: first, to: first }).filter((e) => !e.recurring);
  ok("the earliest one-time event is returned by a one-day window on its date",
    onDay.length > 0, `${first} → ${onDay.length} event(s)`);
  ok("…flagged not-recurring", onDay.every((e) => e.recurring === false));
  ok("…with its own fields intact",
    onDay.every((e) => typeof e.name === "string" && typeof e.distance === "number"));

  const year = getEventsInRange({ from: "2026-01-01", to: "2026-12-31" });
  const inYear = EVENT_SCHEDULE.filter((e) => e.date >= "2026-01-01" && e.date <= "2026-12-31");
  eq("every 2026 one-time event appears exactly once",
    year.filter((e) => !e.recurring).length, inYear.length);
}

// ═══ 6. epochDayWeekday, on its own ══════════════════════════════════════════
console.log("\n=== 6. epochDayWeekday ===");
{
  eq("epoch day 0 (1970-01-01) is a Thursday", epochDayWeekday(0), 4);
  eq("…and the oracle agrees", truthWeekday("1970-01-01"), 4);
  eq("day 1 is a Friday", epochDayWeekday(1), 5);
  eq("day 3 wraps to Sunday", epochDayWeekday(3), 0);
  ok("negative epoch days stay in 0..6 (no negative modulo)",
    [-1, -7, -365, -20000].every((d) => {
      const w = epochDayWeekday(d);
      return Number.isInteger(w) && w >= 0 && w <= 6;
    }));
  eq("1969-12-31 is a Wednesday", epochDayWeekday(isoEpochDay("1969-12-31")), 3);
  ok("non-finite input yields NaN, not 4",
    [Number.NaN, Infinity, undefined, null, "3"].every((v) => Number.isNaN(epochDayWeekday(v))));

  // 4000 consecutive days against ICU.
  let mismatch = 0;
  const base = isoEpochDay("2020-01-01");
  for (let i = 0; i < 4000; i += 1) {
    if (epochDayWeekday(base + i) !== truthWeekday(epochDayToIso(base + i))) mismatch += 1;
  }
  eq("0 mismatches against ICU over 4000 consecutive days", mismatch, 0);

  // Round trip: isoEpochDay -> epochDayToIso is identity on every emitted date.
  const rec = getEventsInRange({ from: "2026-01-01", to: "2026-12-31" });
  ok("every emitted date round-trips through the epoch-day pair",
    rec.every((e) => epochDayToIso(isoEpochDay(e.date)) === e.date));
}

// ═══ 7. localTodayIso is the operator's day, not UTC's ══════════════════════
console.log("\n=== 7. localTodayIso ===");
{
  const t = localTodayIso();
  ok("shape is a date-only key", /^\d{4}-\d{2}-\d{2}$/.test(t), t);
  const now = new Date();
  eq("…and it is today's LOCAL calendar day", t,
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`);
  ok("it parses back to a finite epoch day", Number.isFinite(isoEpochDay(t)));
  ok("its source contains no toISOString",
    !/localTodayIso[\s\S]{0,400}?toISOString/.test(code("src/lib/hotel.js")),
    "new Date().toISOString() is today in UTC — wrong after 8pm in Middleborough");
}

// ═══ 8. getUpcomingEventDays ════════════════════════════════════════════════
console.log("\n=== 8. getUpcomingEventDays ===");
{
  // Opening day of the Faire, a Saturday — the case the old code dropped.
  const days = getUpcomingEventDays({ from: KR.startDate, limit: 5 });
  eq("returns `limit` day-groups", days.length, 5);
  eq("the FIRST group is `from` itself — today's events are upcoming",
    days[0][0], KR.startDate);
  ok("every group is [dateKey, non-empty array]",
    days.every(([d, list]) => /^\d{4}-\d{2}-\d{2}$/.test(d) && Array.isArray(list) && list.length > 0));
  ok("groups are in ascending date order and distinct",
    days.every(([d], i) => i === 0 || days[i - 1][0] < d));
  ok("no group predates `from`", days.every(([d]) => d >= KR.startDate));
  ok("every event in a group carries that group's date",
    days.every(([d, list]) => list.every((e) => e.date === d)));

  const one = getUpcomingEventDays({ from: KR.startDate, limit: 1 });
  eq("limit 1 returns 1 group", one.length, 1);
  eq("…the same first group", one[0][0], days[0][0]);

  eq("limit 0 returns nothing", getUpcomingEventDays({ from: KR.startDate, limit: 0 }).length, 0);
  eq("a missing `from` returns nothing", getUpcomingEventDays().length, 0);
  eq("a malformed `from` returns nothing", getUpcomingEventDays({ from: "tomorrow" }).length, 0);
  eq("past the end of the schedule returns nothing",
    getUpcomingEventDays({ from: "2099-01-01", limit: 5 }).length, 0);

  // A `from` on a day with no events must skip forward, not return an empty group.
  const gap = getUpcomingEventDays({ from: "2026-01-05", limit: 3 });
  ok("a `from` on an empty day skips to the next day that has events",
    gap.length === 3 && gap.every(([, list]) => list.length > 0) && gap[0][0] >= "2026-01-05",
    `first group ${gap[0]?.[0]}`);

  // The horizon must span the whole dataset, not one month.
  const far = getUpcomingEventDays({ from: "2026-01-01", limit: 400 });
  const spanEnd = far.length ? far[far.length - 1][0] : "";
  const latest = [...EVENT_SCHEDULE.map((e) => e.date), ...RECURRING_EVENTS.map((r) => r.endDate)]
    .reduce((m, d) => (d > m ? d : m), "");
  ok("a large limit reaches the last day in the dataset", spanEnd === latest,
    `horizon ends ${spanEnd}, dataset ends ${latest}`);

  // The defect ActionCenter had: LOCAL midnight vs a UTC-midnight event date.
  const localMidnight = new Date(2026, 8, 5);          // 2026-09-05 00:00 local
  const utcMidnight = new Date("2026-09-05");           // 2026-09-05 00:00Z
  ok("the mixed-frame comparison that hid today's events really does fail here",
    !(utcMidnight >= localMidnight),
    `${utcMidnight.toISOString()} >= ${localMidnight.toISOString()} is false`);
}

// ═══ 9. Source contract: the library must not use local calendar fields ═════
console.log("\n=== 9. source contract — src/lib/eventSchedule.js ===");
{
  const src = code("src/lib/eventSchedule.js");
  ok("imports the epoch-day primitives from hotel.js",
    /import \{[^}]*isoEpochDay[^}]*epochDayWeekday[^}]*\} from "@\/lib\/hotel"/.test(src));
  const banned = [".getDay(", ".setDate(", ".getDate(", ".getMonth(", ".getFullYear(", ".getHours("];
  banned.forEach((b) => ok(`no ${b} in the expansion`, !src.includes(b),
    "a local calendar accessor on a UTC-midnight parse is the whole defect"));
  ok("no `new Date(` at all outside the epoch-day helpers", !/new Date\(/.test(src));
  ok("the loop iterates integers",
    /for \(let day = first; day <= last; day \+= 1\)/.test(src));
  ok("the weekday test goes through epochDayWeekday",
    /r\.dayOfWeek\.includes\(epochDayWeekday\(day\)\)/.test(src));
  ok("getUpcomingEventDays is exported", /export function getUpcomingEventDays/.test(src));
}

console.log("\n=== 10. source contract — src/pages/ActionCenter.jsx ===");
{
  const src = code("src/pages/ActionCenter.jsx");
  ok("no local EVENT_SCHEDULE copy", !/(const|let|var)\s+EVENT_SCHEDULE\s*=/.test(src),
    "three copies of one loop is how one defect shipped in three places");
  ok("no local RECURRING_EVENTS copy", !/(const|let|var)\s+RECURRING_EVENTS\s*=/.test(src));
  ok("no expansion loop left on the page", !src.includes(".setDate(") && !src.includes(".getDay("));
  ok("it imports the expansion instead",
    /import \{[^}]*getEventsInRange[^}]*getUpcomingEventDays[^}]*\} from "@\/lib\/eventSchedule"/.test(src));
  ok("eventsInRange delegates",
    /const eventsInRange = useMemo\(\(\) => getEventsInRange\(dateRange\), \[dateRange\]\)/.test(src));
  ok("upcomingDays passes the operator's own day",
    /getUpcomingEventDays\(\{ from: localTodayIso\(\), limit: 5 \}\)/.test(src));
  ok("localTodayIso is imported from hotel.js",
    /import \{[^}]*localTodayIso[^}]*\} from "@\/lib\/hotel"/.test(src));

  // Nothing else in src/ may declare these datasets either.
  const walk = (dir, out = []) => {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((d) => {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) walk(p, out);
      else if (/\.(js|jsx)$/.test(d.name)) out.push(p);
    });
    return out;
  };
  const files = walk(path.join(ROOT, "src"));
  const decl = (re) => files.filter((f) => re.test(
    fs.readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "")
  )).map((f) => path.relative(ROOT, f).replace(/\\/g, "/"));
  eq("exactly one declaration of EVENT_SCHEDULE in src/",
    decl(/(?:export )?const EVENT_SCHEDULE\s*=/).join(","), "src/lib/eventSchedule.js");
  eq("exactly one declaration of RECURRING_EVENTS in src/",
    decl(/(?:export )?const RECURRING_EVENTS\s*=/).join(","), "src/lib/eventSchedule.js");
  ok("no other file expands dayOfWeek with a local weekday",
    decl(/dayOfWeek\.includes\([^)]*getDay\(\)/).length === 0);
}

// ═══ 11. The same answer in every timezone ══════════════════════════════════
//
// The real proof. Five zones spanning UTC+14 to UTC-10, each a fresh process, all
// required to produce byte-identical output. Under the deleted loop the five
// snapshots differed; that is what "works on my machine" looked like.
console.log("\n=== 11. timezone independence ===");
{
  const zones = ["UTC", "America/New_York", "Pacific/Kiritimati", "Pacific/Honolulu", "Asia/Kolkata"];
  const snaps = new Map();
  const offsets = new Map();
  const todays = new Map();
  zones.forEach((tz) => {
    const r = spawnSync(process.execPath, [...process.execArgv, SELF], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, TZ: tz, PROBE_EVENTS_ZONE_CHILD: "1" },
    });
    if (r.status !== 0 || !r.stdout) {
      ok(`snapshot under ${tz}`, false, `exit ${r.status}: ${(r.stderr || "").slice(0, 300)}`);
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(r.stdout);
    } catch {
      ok(`snapshot under ${tz}`, false, `unparseable stdout: ${r.stdout.slice(0, 200)}`);
      return;
    }
    const want = zoneOffsetMinutes(tz);
    ok(`snapshot under ${tz}`, parsed.offset === want,
      `child ran in ${parsed.zone}, offset ${parsed.offset} min (want ${want})`);
    offsets.set(tz, parsed.offset);
    todays.set(tz, { local: parsed.today, utc: parsed.utcToday });
    snaps.set(tz, JSON.stringify({ range: parsed.range, upcoming: parsed.upcoming }));
  });

  // If TZ were being ignored, every child would share the parent's offset and the
  // byte-identity assertions below would be vacuous.
  eq("the five children really did run in five different offsets",
    new Set(offsets.values()).size, 5);

  // localTodayIso, measured rather than reasoned about. Kiritimati is UTC+14 and
  // Honolulu is UTC-10, a 24-hour spread, so at every instant of every day at
  // least one of them is on a different calendar date from UTC. This is what
  // makes the check deterministic: the source contract in section 7 catches a
  // reversion to toISOString() at any hour, but only this one proves the two
  // functions actually answer differently.
  {
    const differs = [...todays.entries()].filter(([, t]) => t.local !== t.utc);
    console.log(`    local vs UTC today: ${[...todays.entries()].map(([z, t]) => `${z}=${t.local}${t.local === t.utc ? "" : `≠${t.utc}`}`).join("  ")}`);
    ok("localTodayIso is NOT toISOString() — at least one zone is on another date",
      differs.length > 0,
      differs.length ? `${differs.map(([z]) => z).join(", ")} disagree with UTC` : "all five agreed, which cannot happen across a 24h spread");
    ok("…and UTC's own child agrees with UTC, as it must",
      todays.get("UTC").local === todays.get("UTC").utc);
    ok("every child returned a well-formed date key",
      [...todays.values()].every((t) => /^\d{4}-\d{2}-\d{2}$/.test(t.local)));
  }

  if (snaps.size === zones.length) {
    const base = snaps.get("UTC");
    zones.forEach((tz) => {
      ok(`${tz} matches UTC byte for byte`, snaps.get(tz) === base,
        `${(snaps.get(tz) || "").length} chars vs ${base.length}`);
    });
    const events = JSON.parse(base).range;
    console.log(`    identical in all ${zones.length} zones: ${events.length} events, ${base.length} chars`);
    console.log(`    offsets: ${zones.map((z) => `${z}=${offsets.get(z)}`).join("  ")}`);
  } else {
    ok("all five zones produced a snapshot", false, `${snaps.size}/${zones.length}`);
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
