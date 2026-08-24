// Probe: the timecard reconciler cannot measure a shift longer than a day, and
// the flag it raises when it notices one does not stop the shift being paid.
//
// Measured against the shipped code (node, this repo, 2026-08-24):
//
//   A. parseTime's AM/PM branch validates NEITHER field, unlike its two
//      siblings:
//        parseTime("11:99 PM") = 1479   <- 1439 is the last minute of a day
//        parseTime("25:00 AM") =   60   <- 25 % 12 = 1, silently 01:00
//        parseTime("99:99 PM") =  999   <- silently 16:39
//        parseTime("23:60")    = null   <- the 24h branch DOES check
//        parseTime(3000)       = 3000   <- the numeric branch checks nothing
//
//   B. so a punch pair CAN produce a duration >= 24h, the flag fires, and the
//      shift is paid anyway:
//        "12:00 AM" -> "11:99 PM"  =>  flags ["shift_exceeds_24h"],
//                                     paid_minutes 1449, total_pay $362.25
//      `reconcileTimecards` only skips shifts with a MISSING punch. The flag is
//      decorative — which contradicts timecardCalc.js's own comment ("flag it
//      rather than pay an impossible duration") and diverges from
//      base44/functions/autoPayroll/entry.ts, which `continue`s on it.
//
//   C. and a shift that really does exceed 24h is not flagged at all, because
//      the information needed to see it is parsed and then thrown away.
//      parseTime accepts a full datetime and keeps only the time of day:
//        clock_in "2026-03-07 09:00", clock_out "2026-03-09 10:00"
//          2940 real minutes  ->  paid_minutes 60, no flag, $15.00
//      A 49-hour span silently books as one hour. Reversed dates are worse:
//        clock_in "2026-03-07 22:00", clock_out "2026-03-06 06:00"
//          a negative span     ->  paid_minutes 450, no flag
//
// Root cause, one sentence: the duration of a shift is computed from two
// times-of-day by `minutesBetween`, which can only ever return 0..1439, so
// "longer than a day" is not representable — and the two guards that exist
// around that limit (the range checks in parseTime, the >= 24h flag) are each
// applied in only some of the places they are needed.
//
// The fix repairs the earliest broken boundary in each case: parseTime refuses
// a value that is not a minute of a real day, normalisePunch uses the punch
// DATES when the input carries them instead of discarding them, and
// reconcileTimecards refuses to pay a shift it has flagged as impossible.
//
// Why the flagged shift must not be paid rather than paid at some clamped
// duration: the module's stated rule is "never guess a missing punch into real
// pay" (timecardCalc.js:14-16). Nothing in the data says whether "2026-03-09"
// was a real 49-hour span or a mistyped date, so any paid number would be a
// guess. Not paying is recoverable — the import path turns every flag into a
// high-severity AnomalyAlert (section 12), so a human sees it and fixes the row.
//
// The protected file inherits all of this for free: src/api/base44Client.js
// imports `reconcileTimecards` from this module (line 4) and calls it inside
// runLocalAutoPayroll, which is the live production payroll path. See section 11.
//
// Run: node --import ./scripts/_loader-boot.mjs scripts/probe-timecard-shift-span.mjs

import fs from "node:fs";
import path from "node:path";
import {
  parseTime,
  minutesBetween,
  normalisePunch,
  shiftDurationMinutes,
  applyBreaks,
  reconcileTimecards,
} from "@/lib/timecardCalc";

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

// Drops comment lines so an anti-regression search cannot be satisfied by a
// comment that QUOTES the defective line in order to explain it. Every file
// asserted below documents what it replaced, so this is load-bearing.
const codeOnly = (text) =>
  text
    .split(/\r?\n/)
    .filter((line) => {
      const t = line.trim();
      return t && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*") && !t.startsWith("{/*");
    })
    .join("\n");

const MIN_OF_DAY_MAX = 24 * 60 - 1; // 1439

// One reconciled week for a single employee, so a fixture can be read as
// "these punches produced this much pay".
const week = (punches, baseRate = 15) => {
  const rows = reconcileTimecards(punches, { rates: { Ada: { base_rate: baseRate } } });
  return rows[0] || null;
};
const punch = (clockIn, clockOut, date = "2026-03-02") => ({
  employee_name: "Ada",
  shift_date: date,
  clock_in: clockIn,
  clock_out: clockOut,
});

console.log("=".repeat(74));
console.log("probe-timecard-shift-span — tracker #54 (audit item V2)");
console.log("=".repeat(74));

// ---------------------------------------------------------------------------
console.log("\n--- 1. parseTime's contract: a minute of a real day, or null ---");
//
// The docstring says "minutes since local midnight". That is 0..1439. Any other
// return value is a lie its callers cannot detect, and `minutesBetween` turns
// one into an impossible duration.

{
  let worst = -1;
  let worstInput = "";
  let checked = 0;
  const offenders = [];
  for (let h = 0; h <= 99; h++) {
    for (let m = 0; m <= 99; m++) {
      const hh = String(h).padStart(2, "0");
      const mm = String(m).padStart(2, "0");
      for (const suffix of ["", " AM", " PM", "AM", "pm"]) {
        const input = `${hh}:${mm}${suffix}`;
        const got = parseTime(input);
        checked++;
        if (got === null) continue;
        if (got > worst) {
          worst = got;
          worstInput = input;
        }
        if ((got < 0 || got > MIN_OF_DAY_MAX) && offenders.length < 6) offenders.push(`${input}=${got}`);
      }
    }
  }
  check(
    `no HH:MM[ AM|PM] string parses outside 0..1439 (${checked} inputs swept)`,
    () => worst <= MIN_OF_DAY_MAX,
    `max ${worst} via "${worstInput}"; offenders: ${offenders.join(", ")}`
  );
}

check("the 24-hour branch already rejects a bad minute", () => parseTime("23:60") === null);
check("the 24-hour branch already rejects a bad hour", () => parseTime("24:00") === null);
check(
  "the AM/PM branch rejects a bad minute too",
  () => parseTime("11:99 PM") === null,
  `got ${parseTime("11:99 PM")} — 1479 is 24h39m, a time that does not exist`
);
check(
  "the AM/PM branch rejects an impossible hour instead of taking it mod 12",
  () => parseTime("25:00 AM") === null,
  `got ${parseTime("25:00 AM")} — 25 % 12 = 1, so 25:00 silently became 01:00`
);
check("\"99:99 PM\" is refused", () => parseTime("99:99 PM") === null, `got ${parseTime("99:99 PM")}`);

// ---------------------------------------------------------------------------
console.log("\n--- 2. numeric punches are minutes of a day as well ---");
//
// The numeric branch is not reachable from today's only writer (the CSV
// importer stringifies every time field), but parseTime is exported and its
// signature accepts a number, so the contract has to hold there too.

check("a numeric minute-of-day still parses", () => parseTime(480) === 480);
check("minute 0 parses (falsy, so a `||` guard would drop it)", () => parseTime(0) === 0);
check("the last minute of the day parses", () => parseTime(1439) === 1439);
check("a number past the end of the day is refused", () => parseTime(3000) === null, `got ${parseTime(3000)}`);
check("a negative number is refused", () => parseTime(-60) === null, `got ${parseTime(-60)}`);
check("1e9 is refused", () => parseTime(1e9) === null, `got ${parseTime(1e9)}`);
check("NaN and Infinity are refused", () => parseTime(NaN) === null && parseTime(Infinity) === null);

// ---------------------------------------------------------------------------
console.log("\n--- 3. every form that worked before still works ---");
//
// Anti-regression. Two of these ("13:30 PM", "00:30 AM") are sloppy exporter
// output that resolves to exactly one sensible time; tightening the range check
// must not start refusing them.

const stillWorks = [
  ["08:00", 480],
  ["23:30", 1410],
  ["8:00 AM", 480],
  ["8:00 PM", 1200],
  ["12:00 PM", 720],
  ["12:00 AM", 0],
  ["03:21 PM", 921],
  ["2026-03-07 03:21 PM", 921],
  ["2026-03-07T03:21 PM", 921],
  ["13:30 PM", 810],
  ["00:30 AM", 30],
  ["9", 540],
];
for (const [input, expected] of stillWorks) {
  check(`parseTime("${input}") === ${expected}`, () => parseTime(input) === expected, `got ${parseTime(input)}`);
}
check("unparseable input is still null", () => parseTime("not-a-time") === null && parseTime("") === null && parseTime(null) === null);

// ---------------------------------------------------------------------------
console.log("\n--- 4. why the >=24h flag was unreachable from legal punches ---");
//
// Exhaustive over every legal pair. This is what makes section 1 load-bearing:
// with parseTime honest, a >= 24h duration can only come from the deliberate
// same-time synthesis or from real punch DATES (section 6) — never from an
// accident of arithmetic.

{
  let maxDur = -1;
  for (let a = 0; a <= MIN_OF_DAY_MAX; a++) {
    for (let b = 0; b <= MIN_OF_DAY_MAX; b++) {
      const d = minutesBetween(a, b);
      if (d > maxDur) maxDur = d;
    }
  }
  check(
    "minutesBetween over all 2,073,600 legal pairs never reaches 1440",
    () => maxDur === MIN_OF_DAY_MAX,
    `max ${maxDur}`
  );
}
check("an overnight pair still measures the short way round", () => minutesBetween(1320, 360) === 480);

// ---------------------------------------------------------------------------
console.log("\n--- 5. the shift_exceeds_24h flag has to stop the pay ---");
//
// The flag existed and was ignored: `reconcileTimecards` skipped only shifts
// with a missing punch. entry.ts's copy `continue`d on the flag, so the cron
// and the UI button paid different amounts from identical rows.

{
  const same = punch("08:00", "08:00");
  const n = normalisePunch(same);
  check("a same-time punch is still flagged", () => n.flags.includes("shift_exceeds_24h"), n.flags.join(","));
  const w = week([same]);
  check("a same-time punch pays nothing", () => w.paid_minutes === 0 && w.total_pay === 0, `paid_minutes ${w?.paid_minutes}, pay ${w?.total_pay}`);
  check("and it stays visible for review", () => w.shifts.length === 1 && w.flags.includes("shift_exceeds_24h"));
}

{
  // The reachable escape from section 1, kept as an assertion in its own right:
  // even if some future parse widening lets an out-of-range value through, the
  // reconciler must not pay it.
  const forged = {
    employee_name: "Ada",
    shift_date: "2026-03-02",
    clockIn: 0,
    clockOut: 1479,
    flags: ["shift_exceeds_24h"],
  };
  check(
    "applyBreaks on a >24h shift is not what pays it — the reconciler's skip is",
    () => applyBreaks(forged).paidMinutes === 1449,
    `got ${applyBreaks(forged).paidMinutes}`
  );
  const w = week([punch("12:00 AM", "11:99 PM")]);
  check(
    "the 1479-minute escape now pays 0 (it paid $362.25 for 24.15h)",
    () => w.paid_minutes === 0 && w.total_pay === 0,
    `paid_minutes ${w?.paid_minutes}, pay ${w?.total_pay}, flags ${JSON.stringify(w?.flags)}`
  );
  check(
    "and it is reported as a missing punch, because 11:99 PM is not a time",
    () => w.flags.includes("missing_clock_out"),
    JSON.stringify(w?.flags)
  );
}

// ---------------------------------------------------------------------------
console.log("\n--- 6. a real multi-day span is measured, not silently shrunk ---");
//
// parseTime already accepts "YYYY-MM-DD HH:MM" and already extracts the time
// from it. The date was matched by the same regex and then dropped, so the one
// input that CAN express a shift longer than a day was reduced to a time of day.

{
  const p = { employee_name: "Ada", shift_date: "2026-03-07", clock_in: "2026-03-07 09:00", clock_out: "2026-03-09 10:00" };
  const n = normalisePunch(p);
  check(
    "a 49-hour span is measured as 2940 minutes, not 60",
    () => shiftDurationMinutes(n) === 2940,
    `got ${shiftDurationMinutes(n)}`
  );
  check("it is flagged", () => n.flags.includes("shift_exceeds_24h"), n.flags.join(",") || "no flags");
  const w = week([p]);
  check("and it pays nothing (it used to pay 1h)", () => w.paid_minutes === 0 && w.total_pay === 0, `paid_minutes ${w?.paid_minutes}, pay ${w?.total_pay}`);
}

{
  // Exactly 24h to the minute: the boundary, and the same verdict.
  const p = { employee_name: "Ada", shift_date: "2026-03-07", clock_in: "2026-03-07 09:00", clock_out: "2026-03-08 09:00" };
  const n = normalisePunch(p);
  check("a span of exactly 1440 minutes is flagged", () => shiftDurationMinutes(n) === 1440 && n.flags.includes("shift_exceeds_24h"), `${shiftDurationMinutes(n)} min, ${n.flags.join(",")}`);
  check("one minute under the boundary is NOT flagged", () => {
    const ok = normalisePunch({ employee_name: "Ada", shift_date: "2026-03-07", clock_in: "2026-03-07 09:00", clock_out: "2026-03-08 08:59" });
    return shiftDurationMinutes(ok) === 1439 && !ok.flags.includes("shift_exceeds_24h");
  });
}

// ---------------------------------------------------------------------------
console.log("\n--- 7. the dated forms that are legitimate are unchanged ---");
//
// This is the assertion that keeps section 6 from being a regression: the
// overnight shift is the common case in a hotel and it must still pay the same
// as it did when the reconciler was guessing the span.

{
  const dated = { employee_name: "Ada", shift_date: "2026-03-07", clock_in: "2026-03-07 22:00", clock_out: "2026-03-08 06:00" };
  const undated = punch("22:00", "06:00", "2026-03-07");
  check("dated overnight 22:00 -> 06:00 is 480 minutes", () => shiftDurationMinutes(normalisePunch(dated)) === 480, `got ${shiftDurationMinutes(normalisePunch(dated))}`);
  check("undated overnight 22:00 -> 06:00 is 480 minutes too", () => shiftDurationMinutes(normalisePunch(undated)) === 480);
  check(
    "both pay identically (450 min after the unpaid break)",
    () => week([dated]).paid_minutes === 450 && week([undated]).paid_minutes === 450,
    `dated ${week([dated]).paid_minutes}, undated ${week([undated]).paid_minutes}`
  );
  check("neither is flagged as impossible", () => !normalisePunch(dated).flags.includes("shift_exceeds_24h") && !normalisePunch(undated).flags.includes("shift_exceeds_24h"));
}

{
  const sameDay = { employee_name: "Ada", shift_date: "2026-03-07", clock_in: "2026-03-07 09:00", clock_out: "2026-03-07 17:00" };
  check("a dated same-day pair is 480 minutes", () => shiftDurationMinutes(normalisePunch(sameDay)) === 480, `got ${shiftDurationMinutes(normalisePunch(sameDay))}`);
  const halfDated = { employee_name: "Ada", shift_date: "2026-03-07", clock_in: "09:00", clock_out: "2026-03-07 17:00" };
  check(
    "a pair where only the clock-out carries a date pairs it against shift_date",
    () => shiftDurationMinutes(normalisePunch(halfDated)) === 480,
    `got ${shiftDurationMinutes(normalisePunch(halfDated))}`
  );
  const halfDatedOvernight = { employee_name: "Ada", shift_date: "2026-03-07", clock_in: "22:00", clock_out: "2026-03-08 06:00" };
  check(
    "...including across midnight",
    () => shiftDurationMinutes(normalisePunch(halfDatedOvernight)) === 480,
    `got ${shiftDurationMinutes(normalisePunch(halfDatedOvernight))}`
  );
}

// ---------------------------------------------------------------------------
console.log("\n--- 8. a clock-out dated BEFORE the clock-in is refused ---");
//
// The old code read this as an overnight wrap and paid 450 minutes for it.

{
  const p = { employee_name: "Ada", shift_date: "2026-03-07", clock_in: "2026-03-07 22:00", clock_out: "2026-03-06 06:00" };
  const n = normalisePunch(p);
  check("it is flagged negative_shift_duration", () => n.flags.includes("negative_shift_duration"), n.flags.join(",") || "no flags");
  check("the duration is not reported as a positive number", () => shiftDurationMinutes(n) === 0, `got ${shiftDurationMinutes(n)}`);
  const w = week([p]);
  check("and it pays nothing (it used to pay 7.5h)", () => w.paid_minutes === 0 && w.total_pay === 0, `paid_minutes ${w?.paid_minutes}, pay ${w?.total_pay}`);
}

// ---------------------------------------------------------------------------
console.log("\n--- 9. a week mixes good and bad shifts without losing the good ones ---");
//
// The refusal has to be per shift. Dropping the whole employee-week because one
// row was mistyped would be a different way of getting the money wrong.

{
  const rows = reconcileTimecards(
    [
      punch("08:00", "16:00", "2026-03-02"), // 480 -> 450 paid
      punch("08:00", "16:00", "2026-03-03"), // 480 -> 450 paid
      { employee_name: "Ada", shift_date: "2026-03-04", clock_in: "2026-03-04 09:00", clock_out: "2026-03-06 09:00" }, // 48h, refused
      punch("08:00", "12:00", "2026-03-05"), // 240, under the break threshold
    ],
    { rates: { Ada: { base_rate: 15 } } }
  );
  const w = rows[0];
  check("the three good shifts still pay", () => w.paid_minutes === 450 + 450 + 240, `got ${w?.paid_minutes}`);
  check("the bad one is flagged on the week", () => w.flags.includes("shift_exceeds_24h"), JSON.stringify(w?.flags));
  check("all four shifts remain listed for review", () => w.shifts.length === 4, `got ${w?.shifts.length}`);
  check(
    "pay is exact for the surviving minutes",
    () => w.total_pay === Math.round(1500 * 1140 / 60) / 100,
    `got ${w?.total_pay}, expected ${Math.round(1500 * 1140 / 60) / 100}`
  );
}

// ---------------------------------------------------------------------------
console.log("\n--- 10. base44/functions/autoPayroll/entry.ts stays in parity ---");
//
// Static assertions because a Deno .ts module cannot be imported here, and
// because nothing else gates that file: eslint ignores **/*.ts and jsconfig's
// include never names one, so these lines are its only automated cover.
// (See the corrected note in eslint.config.js.)

const entry = codeOnly(src("base44/functions/autoPayroll/entry.ts"));
// parseTime only — so a range check that exists somewhere else in the file
// cannot satisfy an assertion about the parser.
const entryParse = entry.split("function datePartOf")[0];

check(
  "entry.ts range-checks the hour of its AM/PM branch",
  () => /raw\s*<\s*0\s*\|\|\s*raw\s*>\s*23/.test(entryParse),
  "an unchecked hour becomes a plausible one: 25 % 12 = 1"
);
check(
  "entry.ts range-checks the minute in BOTH string branches",
  () => (entryParse.match(/min\s*>\s*59/g) || []).length >= 2,
  `found ${(entryParse.match(/min\s*>\s*59/g) || []).length} minute checks, need 2`
);
check(
  "entry.ts bounds its numeric branch to a minute of a day",
  () => /n\s*>=\s*0\s*&&\s*n\s*<\s*MIN_PER_DAY/.test(entryParse),
  "Math.round(value) alone accepts 3000 and -60"
);
check(
  "entry.ts reads the date half of a punch value",
  () => /function datePartOf/.test(entry) && /function dayIndex/.test(entry)
);
check(
  "...and diffs the days in UTC, so DST cannot move a boundary",
  () => /Date\.UTC\(Number\(m\[1\]\)/.test(entry)
);
check(
  "entry.ts measures the span from the two day indices",
  () => /\(outIdx\s*-\s*inIdx\)\s*\*\s*MIN_PER_DAY\s*\+\s*\(clockOut\s*-\s*clockIn\)/.test(entry)
);
check(
  "entry.ts refuses to pay a >=24h shift",
  () => /shift_exceeds_24h"\);\s*continue;/.test(entry)
);
check(
  "entry.ts refuses to pay a backwards-dated shift",
  () => /negative_shift_duration"\);\s*continue;/.test(entry)
);
check(
  "entry.ts has not regained float dollar math",
  () => !/baseRate\s*\*\s*hours/.test(entry) && /payCentsForMinutes/.test(entry)
);

// ---------------------------------------------------------------------------
console.log("\n--- 11. the protected payroll path inherits the fix ---");
//
// src/api/base44Client.js is item 1 in PROTECTED_FILES.md and must not be
// edited. It does not need to be: it imports this module's reconciler, so
// runLocalAutoPayroll — the path Payroll.jsx actually calls — gets the corrected
// durations without a line changing. If that import is ever replaced by a local
// copy, these assertions fail and the fix has to be re-landed there.

const clientCode = src("src/api/base44Client.js");
check(
  "base44Client.js imports reconcileTimecards from @/lib/timecardCalc",
  () => /import\s*\{\s*reconcileTimecards\s*\}\s*from\s*['"]@\/lib\/timecardCalc['"]/.test(clientCode)
);
check(
  "runLocalAutoPayroll calls it rather than reimplementing it",
  () => /reconcileTimecards\(punches\)/.test(clientCode) && !/function\s+minutesBetween/.test(clientCode)
);
check(
  "base44Client.js is still listed as protected",
  () => /src\/api\/base44Client\.js/.test(src("PROTECTED_FILES.md"))
);

// ---------------------------------------------------------------------------
console.log("\n--- 12. every flag reaches a human ---");
//
// Not paying a shift is only safe because the operator is told. The import path
// turns each flag normalisePunch emits into a high-severity AnomalyAlert, so
// the new flag needs no UI work — but it does need that loop to stay generic.

const parsers = codeOnly(src("src/lib/reportParsers.js"));
check("the import path normalises every stored punch", () => /const\s+n\s*=\s*normalisePunch\(p\)/.test(parsers));
check("it raises an alert per flag rather than per known flag name", () => /for\s*\(const flag of n\.flags\)/.test(parsers));
check("the alert is high severity", () => /severity:\s*["']high["']/.test(parsers));
check(
  "and the CSV parser keeps time values verbatim, so a dated punch survives import",
  () => /clock_in:\s*inTime/.test(parsers) && /const inTime = String\(out\.clock_in \|\| ""\)\.trim\(\)/.test(parsers)
);

// ---------------------------------------------------------------------------
console.log("\n--- 13. tracker #53 does not regress ---");
//
// This file changes the same function that #53 fixed, so its invariant is
// re-asserted here: money comes from the integer minute basis and `hours` is an
// exact quotient, never a 2-dp display value.

{
  const rows = reconcileTimecards(
    [punch("07:00", "13:30", "2026-03-02"), punch("07:00", "14:23", "2026-03-03"), punch("07:00", "18:00", "2026-03-04")],
    { rates: { Ada: { base_rate: 15 } } }
  );
  const w = rows[0];
  check("paid_minutes is an integer", () => Number.isInteger(w.paid_minutes), `got ${w?.paid_minutes}`);
  check("hours is the exact quotient of the minutes", () => w.hours === w.regular_minutes / 60, `${w?.hours} vs ${w?.regular_minutes / 60}`);
  check(
    "pay equals round(rateCents * minutes / 60) to the cent",
    () => Math.round(w.regular_pay * 100) === Math.round(1500 * w.regular_minutes / 60),
    `${Math.round(w?.regular_pay * 100)} vs ${Math.round(1500 * w?.regular_minutes / 60)}`
  );
  const calc = codeOnly(src("src/lib/timecardCalc.js"));
  check("timecardCalc.js has not regained a 2-dp hours rounding", () => !/hours\s*=\s*Math\.round\([^)]*100\)/.test(calc) && !/round2\(/.test(calc));
}

// ---------------------------------------------------------------------------
console.log(`\n${failures === 0 ? "PASSED" : "FAILED"}: ${passes} passed, ${failures} failed`);
if (failures > 0) {
  console.log("DEFECT PRESENT — a shift longer than a day is either unmeasurable or paid despite being flagged.");
  process.exit(1);
}
console.log("Shift spans are measured from the punch dates, and an impossible shift is reviewed rather than paid.");
process.exit(0);
