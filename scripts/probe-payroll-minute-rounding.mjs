// Probe: payroll derives money from a DISPLAY-ROUNDED hours figure, so paid
// cents are lost downward on every week whose minutes are not a clean quarter
// hour.
//
// Measured before the fix (node, this repo, 2026-08-24):
//
//   REG  min=2243  hoursExact=37.38333333333333  h2=37.38
//        1500 * 37.38   = 56070.00000000001 -> 56070  ($560.70)
//        1500 * 2243/60 = 56075             -> 56075  ($560.75)     delta 5c
//
//   OT   min=140   hoursExact=2.3333333333333335  h2=2.33
//        2250 * 2.33    = 5242.5            -> 5243   ($52.43)
//        2250 * 140/60  = 5250              -> 5250   ($52.50)      delta 7c
//
// Root cause, one sentence: `reconcileTimecards` accumulates FLOAT hours,
// rounds them to 2 decimal places because that is what a human reads, and then
// multiplies the cents rate by the ROUNDED value. The exact basis already
// exists one function earlier -- `applyBreaks` returns `paidMinutes`, an
// integer -- and was thrown away at the boundary.
//
// Three copies of the same defect, only two of them editable:
//
//   1. src/lib/timecardCalc.js:290-300           editable  (fixed here)
//   2. base44/functions/autoPayroll/entry.ts     editable  (fixed here; it
//      additionally did raw FLOAT dollar math, `baseRate * hours`, which
//      CLAUDE.md's BUSINESS mandate forbids outright)
//   3. src/api/base44Client.js:1457-1492         PROTECTED (runLocalAutoPayroll)
//
// Copy 3 is the one that pays real people. base44Client.js:2108 routes
// `autoPayroll` to `runLocalAutoPayroll` ABOVE the `!USE_LOCAL_AUTH` gate at
// :2115, so the local mirror is the live path in production too; the backend
// function is reachable only from the base44 cron trigger. PROTECTED_FILES.md
// forbids editing it and forbids wrapping or monkey-patching it.
//
// It can still be made correct WITHOUT being touched, because it recomputes pay
// from `w.hours` -- it discards the reconciler's own pay fields. Feed it an
// EXACT `hours` instead of a 2-dp one and its existing integer-cent arithmetic
// lands on the right cent. That is why section 4 pins `hours` to the exact
// quotient and section 6 replicates the protected consumer's two lines here:
// if anyone re-rounds `hours` for display reasons, section 4 fails and section 6
// says what it costs. The display sites that made re-rounding tempting are
// handled at the render boundary instead (section 11).
//
// Run: node --import ./scripts/_loader-boot.mjs scripts/probe-payroll-minute-rounding.mjs

import fs from "node:fs";
import path from "node:path";
import { reconcileTimecards, weeksToPayrollRuns, payCentsForMinutes, applyBreaks, normalisePunch } from "@/lib/timecardCalc";
import { toCents } from "@/lib/decimal";

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
// comment that QUOTES the defective line in order to explain it. Both files
// asserted below document what they replaced, so this is load-bearing.
const codeOnly = (text) =>
  text
    .split(/\r?\n/)
    .filter((line) => {
      const t = line.trim();
      return t && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*") && !t.startsWith("{/*");
    })
    .join("\n");

const round2 = (n) => Math.round(n * 100) / 100;

// Round-half-up of (rateCents * minutes / 60) computed in exact integer
// arithmetic. This is the reference every cent figure below is judged against,
// so no assertion is measuring float against float.
const refCents = (rateCents, minutes) => {
  const p = BigInt(rateCents) * BigInt(minutes);
  return Number((2n * p + 60n) / 120n);
};

// "07:00" + n minutes, as a clock string, so a fixture can name a duration
// instead of a wall time and stay readable.
const clock = (minsSinceMidnight) => {
  const h = Math.floor(minsSinceMidnight / 60);
  const m = minsSinceMidnight % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
};
const shift = (date, durationMinutes, startMin = 7 * 60) => ({
  employee_name: "Ada",
  shift_date: date,
  clock_in: clock(startMin),
  clock_out: clock(startMin + durationMinutes),
});

console.log("=".repeat(74));
console.log("probe-payroll-minute-rounding — tracker #53 (audit item V3)");
console.log("=".repeat(74));

// ---------------------------------------------------------------------------
console.log("\n[1] Reproduction A: 2,243 paid minutes at $15.00/h must pay $560.75");

// Sun 2026-03-01 .. Sat 2026-03-07. Five shifts, 448+449+449+448+449 = 2243 min.
// deductBreaks:false keeps the fixture's arithmetic visible — the break policy
// is exercised on its own in section 8.
const WEEK_A = [
  shift("2026-03-01", 448),
  shift("2026-03-02", 449),
  shift("2026-03-03", 449),
  shift("2026-03-04", 448),
  shift("2026-03-05", 449),
];
const OPTS_A = { deductBreaks: false, rates: { Ada: { base_rate: 15 } } };
const weeksA = reconcileTimecards(WEEK_A, OPTS_A);

check("one (employee, week) row", () => weeksA.length === 1, `got ${weeksA.length}`);

const A = weeksA[0] || {};
console.log(`     regular_minutes=${A.regular_minutes} hours=${A.hours} regular_pay=${A.regular_pay}`);

check(
  "the exact paid minutes survived reconciliation (2,243)",
  () => A.regular_minutes === 2243,
  `got ${A.regular_minutes}`
);
check(
  "regular_pay is $560.75, not the $560.70 a 2-dp hours figure produces",
  () => toCents(A.regular_pay) === 56075,
  `got ${A.regular_pay} (${toCents(A.regular_pay)}c) — 56070c is the defect`
);
check(
  "no overtime below the 40h cap",
  () => A.overtime_minutes === 0 && toCents(A.overtime_pay) === 0
);
check(
  "total_pay is the exact sum of its parts",
  () => toCents(A.total_pay) === toCents(A.regular_pay) + toCents(A.overtime_pay)
);
check(
  "regular_pay equals the integer-arithmetic reference",
  () => toCents(A.regular_pay) === refCents(1500, 2243),
  `reference ${refCents(1500, 2243)}c`
);

// ---------------------------------------------------------------------------
console.log("\n[2] Reproduction B: the overtime split happens in MINUTES");

// Sun 2026-03-08 .. Sat 2026-03-14. 5 x 480 + 1 x 140 = 2540 min.
// Cap 40h = 2400 min, so 140 min of overtime at 1.5 x $15 = $22.50/h.
const WEEK_B = [
  shift("2026-03-08", 480),
  shift("2026-03-09", 480),
  shift("2026-03-10", 480),
  shift("2026-03-11", 480),
  shift("2026-03-12", 480),
  shift("2026-03-13", 140),
];
const B = reconcileTimecards(WEEK_B, { deductBreaks: false, rates: { Ada: { base_rate: 15 } } })[0] || {};
console.log(`     regular_minutes=${B.regular_minutes} overtime_minutes=${B.overtime_minutes} regular_pay=${B.regular_pay} overtime_pay=${B.overtime_pay}`);

check("regular minutes clamp at the cap (2,400)", () => B.regular_minutes === 2400, `got ${B.regular_minutes}`);
check("overtime minutes are the remainder (140)", () => B.overtime_minutes === 140, `got ${B.overtime_minutes}`);
check("regular_pay $600.00", () => toCents(B.regular_pay) === 60000, `got ${toCents(B.regular_pay)}c`);
check(
  "overtime_pay is $52.50, not the $52.43 a 2-dp hours figure produces",
  () => toCents(B.overtime_pay) === 5250,
  `got ${B.overtime_pay} (${toCents(B.overtime_pay)}c) — 5243c is the defect`
);
check("total_pay $652.50", () => toCents(B.total_pay) === 65250, `got ${toCents(B.total_pay)}c`);
check(
  "the default overtime rate is still 1.5x base",
  () => B.rate && toCents(B.rate.overtime_rate) === 2250,
  `got ${B.rate && B.rate.overtime_rate}`
);

// ---------------------------------------------------------------------------
console.log("\n[3] The minute basis is integral and complete");

for (const [label, row, total] of [["A", A, 2243], ["B", B, 2540]]) {
  check(
    `week ${label}: paid_minutes is the exact total (${total})`,
    () => row.paid_minutes === total,
    `got ${row.paid_minutes}`
  );
  check(
    `week ${label}: regular_minutes + overtime_minutes === paid_minutes`,
    () => row.regular_minutes + row.overtime_minutes === row.paid_minutes,
    `got ${row.regular_minutes} + ${row.overtime_minutes} vs ${row.paid_minutes}`
  );
  check(
    `week ${label}: all three minute fields are non-negative integers`,
    () =>
      [row.paid_minutes, row.regular_minutes, row.overtime_minutes].every(
        (v) => Number.isInteger(v) && v >= 0
      )
  );
}

// ---------------------------------------------------------------------------
console.log("\n[4] `hours` is the EXACT quotient of the minute basis");
console.log("     (load-bearing: the protected live consumer recomputes pay from it — section 6)");

check(
  "hours === regular_minutes / 60, to the last bit",
  () => A.hours === 2243 / 60,
  `got ${A.hours}, expected ${2243 / 60}`
);
check(
  "hours has NOT been re-rounded to 2 decimals",
  () => A.hours !== 37.38,
  "hours is 37.38 — a display rounding has been reintroduced upstream of the money"
);
check(
  "overtime_hours === overtime_minutes / 60",
  () => B.overtime_hours === 140 / 60,
  `got ${B.overtime_hours}, expected ${140 / 60}`
);
check(
  "a whole-hour week still reports a whole number (no 39.99999 artefacts)",
  () => B.hours === 40 && B.regular_minutes === 2400,
  `got ${B.hours}`
);

// ---------------------------------------------------------------------------
console.log("\n[5] WHY: the 2-dp figure cannot reproduce the cents");

const brokenRegular = Math.round(toCents(15) * round2(2243 / 60));
const brokenOt = Math.round(toCents(22.5) * round2(140 / 60));
console.log(`     Math.round(1500 * ${round2(2243 / 60)}) = ${brokenRegular}c   exact ${refCents(1500, 2243)}c`);
console.log(`     Math.round(2250 * ${round2(140 / 60)}) = ${brokenOt}c     exact ${refCents(2250, 140)}c`);

check(
  "the 2-dp regular figure underpays by exactly 5c (the reported defect)",
  () => refCents(1500, 2243) - brokenRegular === 5,
  `delta ${refCents(1500, 2243) - brokenRegular}`
);
check(
  "the 2-dp overtime figure underpays by exactly 7c",
  () => refCents(2250, 140) - brokenOt === 7,
  `delta ${refCents(2250, 140) - brokenOt}`
);
check(
  "and the shipped value is NOT the 2-dp one",
  () => toCents(A.regular_pay) !== brokenRegular && toCents(B.overtime_pay) !== brokenOt
);

// ---------------------------------------------------------------------------
console.log("\n[6] The PROTECTED live consumer now lands on the correct cent");
console.log("     replicating src/api/base44Client.js:1457-1492 verbatim — that file is NOT modified");

// Four identical weeks, which is what a monthly run reduces. runLocalAutoPayroll
// sums `w.hours` across the weeks and multiplies once, so a per-week rounding
// error compounds up to five times before the multiply.
const WEEK_STARTS = ["2026-03-01", "2026-03-08", "2026-03-15", "2026-03-22"];
const MONTH_PUNCHES = WEEK_STARTS.flatMap((s) => {
  const [y, m, d] = s.split("-").map(Number);
  const day = (n) => `${y}-${String(m).padStart(2, "0")}-${String(d + n).padStart(2, "0")}`;
  return [shift(day(0), 448), shift(day(1), 449), shift(day(2), 449), shift(day(3), 448), shift(day(4), 449)];
});
const month = reconcileTimecards(MONTH_PUNCHES, OPTS_A);

// The protected file's two lines, copied exactly:
//   hours: acc.hours + (Number(w.hours) || 0)
//   const regularPayCents = Math.round(baseRateCents * hours)
const mirrorHours = month.reduce((acc, w) => acc + (Number(w.hours) || 0), 0);
const mirrorCents = Math.round(toCents(15) * mirrorHours);

// The same reduction over the 2-dp values the reconciler used to emit.
const legacyHours = month.reduce((acc, w) => acc + round2(w.regular_minutes / 60), 0);
const legacyCents = Math.round(toCents(15) * legacyHours);

const exactMonthCents = refCents(1500, 4 * 2243);
console.log(`     4 weeks x 2243 min: mirror ${mirrorCents}c · legacy(2dp) ${legacyCents}c · exact ${exactMonthCents}c`);

check("the month reduced to 4 week rows", () => month.length === 4, `got ${month.length}`);
check(
  "the protected mirror's arithmetic now yields $2,243.00 exactly",
  () => mirrorCents === exactMonthCents,
  `got ${mirrorCents}c, expected ${exactMonthCents}c`
);
check(
  "with 2-dp hours the same arithmetic loses 20c over four weeks",
  () => exactMonthCents - legacyCents === 20,
  `delta ${exactMonthCents - legacyCents}c`
);
check(
  "summing the minute basis is exact integer addition",
  () => month.reduce((a, w) => a + w.regular_minutes, 0) === 4 * 2243
);

// ---------------------------------------------------------------------------
console.log("\n[7] payCentsForMinutes is exact and DETERMINISTIC where the float form is not");

const RATES = [1000, 1234, 1500, 1550, 1875, 2250, 3333, 7777, 12345];
let exactMismatch = 0;
let floatDivergences = 0;
let floatHalfCentOnly = true;
let floatWithinOneCent = true;

for (const rateCents of RATES) {
  for (let minutes = 0; minutes <= 2880; minutes++) {
    const ref = refCents(rateCents, minutes);
    if (payCentsForMinutes(rateCents, minutes) !== ref) exactMismatch++;

    const floatForm = Math.round(rateCents * (minutes / 60));
    if (floatForm !== ref) {
      floatDivergences++;
      if ((rateCents * minutes) % 60 !== 30) floatHalfCentOnly = false;
      if (Math.abs(floatForm - ref) !== 1) floatWithinOneCent = false;
    }
  }
}
console.log(`     swept ${RATES.length * 2881} (rate, minute) pairs · exact-form mismatches ${exactMismatch} · float-form divergences ${floatDivergences}`);

check(
  "payCentsForMinutes matches exact integer arithmetic on every swept pair",
  () => exactMismatch === 0,
  `${exactMismatch} mismatches`
);
check(
  "every float-form divergence is an exact half-cent case",
  () => floatHalfCentOnly,
  "a divergence was found where rateCents*minutes is NOT 30 mod 60 — the float form is worse than a half-cent tie-break"
);
check(
  "and no float-form divergence exceeds 1c",
  () => floatWithinOneCent
);
check(
  "the sweep found at least one float-form divergence (so the claim is measured, not vacuous)",
  () => floatDivergences > 0,
  `${floatDivergences} — with none, section 7 proves nothing`
);
check(
  "a zero-minute week pays zero, not NaN",
  () => payCentsForMinutes(1500, 0) === 0
);

// ---------------------------------------------------------------------------
console.log("\n[8] The existing contract is preserved (break policy, cap, flags)");

// 5 x 9h with the default 30-min unpaid break = 510 paid min/day = 2550/week.
const BREAKY = ["2026-03-01", "2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05"].map((d) => shift(d, 540, 8 * 60));
const C = reconcileTimecards(BREAKY, { rates: { Ada: { base_rate: 20 } } })[0] || {};
console.log(`     hours=${C.hours} overtime_hours=${C.overtime_hours} regular_pay=${C.regular_pay} overtime_pay=${C.overtime_pay} breaks=${C.unpaid_break_minutes}`);

check("the default unpaid break still deducts 30 min per long shift (150)", () => C.unpaid_break_minutes === 150, `got ${C.unpaid_break_minutes}`);
check("42.5h paid splits 40 + 2.5", () => C.hours === 40 && C.overtime_hours === 2.5, `got ${C.hours} + ${C.overtime_hours}`);
check("regular_pay $800.00 at $20/h", () => toCents(C.regular_pay) === 80000, `got ${toCents(C.regular_pay)}c`);
check("overtime_pay $75.00 at $30/h", () => toCents(C.overtime_pay) === 7500, `got ${toCents(C.overtime_pay)}c`);
check("the break flag is still raised", () => (C.flags || []).includes("unpaid_break_applied"));

// applyBreaks itself is untouched: the exact basis was always there.
check(
  "applyBreaks still reports paidMinutes as an integer (480 - 30)",
  () => applyBreaks(normalisePunch(shift("2026-03-01", 480, 8 * 60))).paidMinutes === 450
);
check(
  "a shift at exactly the break threshold keeps all 360 minutes",
  () => applyBreaks(normalisePunch(shift("2026-03-01", 360, 9 * 60))).paidMinutes === 360
);

// A missing clock-out is reviewed, never paid — and must not corrupt the basis.
const HALF = [shift("2026-03-01", 480), { employee_name: "Ada", shift_date: "2026-03-02", clock_in: "07:00" }];
const D = reconcileTimecards(HALF, { deductBreaks: false, rates: { Ada: { base_rate: 15 } } })[0] || {};
check(
  "an unpunched-out shift adds no minutes and is flagged",
  () => D.regular_minutes === 480 && (D.flags || []).includes("missing_clock_out"),
  `minutes ${D.regular_minutes}, flags ${JSON.stringify(D.flags)}`
);

// ---------------------------------------------------------------------------
console.log("\n[9] weeksToPayrollRuns persists exactly the fields it always did");

const EXPECTED_KEYS = [
  "employee_name", "department", "pay_type", "base_rate", "hours", "overtime_hours",
  "overtime_rate", "overtime_pay", "bonus", "deductions", "regular_pay", "total_pay",
  "pay_period_start", "pay_period_end", "payroll_status", "property_id", "property_name",
  "auto_generated", "timecard_derived", "flags", "employee_id", "created_date", "updated_date",
];
const runKeys = Object.keys(weeksToPayrollRuns([A], { status: "draft" })[0] || {});

check(
  "the persisted PayrollRun shape is unchanged (no minute fields leaked into a schema that cannot be tested here)",
  () => runKeys.length === EXPECTED_KEYS.length && EXPECTED_KEYS.every((k) => runKeys.includes(k)),
  `got ${runKeys.length} keys: ${runKeys.filter((k) => !EXPECTED_KEYS.includes(k)).join(", ") || "(none extra)"}`
);
check(
  "and it carries the exact pay figures, not recomputed ones",
  () => toCents(weeksToPayrollRuns([A])[0].regular_pay) === 56075
);

// ---------------------------------------------------------------------------
console.log("\n[10] base44/functions/autoPayroll/entry.ts pays in integer cents from minutes");

const entryRaw = src("base44/functions/autoPayroll/entry.ts");
const entry = codeOnly(entryRaw);

check("the backend function still exists", () => entry.length > 1000);
check(
  "it no longer multiplies dollars: `baseRate * hours` is gone",
  () => !/baseRate\s*\*\s*hours/.test(entry),
  "raw float dollar math — forbidden by CLAUDE.md BUSINESS"
);
check(
  "it no longer multiplies dollars: `otHours * otRate` is gone",
  () => !/otHours\s*\*\s*otRate/.test(entry)
);
check(
  "no Math.round(<dollars> * 100) / 100 remains on a pay field",
  () => !/Math\.round\((?:regularPay|overtimePay|totalPay)\s*\*\s*100\)\s*\/\s*100/.test(entry)
);
check(
  "it derives pay through payCentsForMinutes",
  () => /payCentsForMinutes\s*\(/.test(entry)
);
check(
  "its inline reconciler carries a minute basis",
  () => /regular_minutes/.test(entry) && /overtime_minutes/.test(entry)
);
check(
  "its inline reconciler no longer re-rounds hours before the money",
  () => !/row\.hours\s*=\s*Math\.round\(/.test(entry)
);
check(
  "it converts back to dollars once, through fromCents",
  () => /fromCents\s*\(/.test(entry)
);
check(
  "byEmployee sums the minute basis, not just hours",
  () => /regular_minutes:\s*acc\.regular_minutes/.test(entry)
);
check(
  "the AUDIT_CANONICAL_V1 audit write is untouched",
  // The marker is a COMMENT in all three copies of the canonical payload, so it
  // has to be sought in the raw source; codeOnly() would strip it and the
  // assertion would fail for the wrong reason. `monotonicIso` is real code.
  () => /AUDIT_CANONICAL_V1/.test(entryRaw) && /monotonicIso\s*\(/.test(entry)
);

// ---------------------------------------------------------------------------
console.log("\n[11] the two payroll-hours render sites format the exact value");

const expenses = codeOnly(src("src/pages/Expenses.jsx"));

check(
  "the delete-confirmation line no longer interpolates raw hours",
  () => !/\$\{p\?\.hours\s*\|\|\s*0\}h/.test(expenses),
  "an exact quotient would print as 37.38333333333333h"
);
check(
  "the payroll list row no longer interpolates raw hours",
  () => !/\{p\.hours\s*\|\|\s*0\}h/.test(expenses)
);
check(
  "both sites go through formatNumber",
  () => (expenses.match(/formatNumber\((?:p\?\.|p\.)hours/g) || []).length === 2,
  `found ${(expenses.match(/formatNumber\((?:p\?\.|p\.)hours/g) || []).length}`
);
check(
  "formatNumber is imported",
  () => /import\s*\{[^}]*formatNumber[^}]*\}\s*from\s*['"]@\/lib\/decimal['"]/.test(expenses)
);

// ---------------------------------------------------------------------------
// The protected file is READ, never written. This assertion is not vacuous: it
// fails if someone reintroduces float dollar math there, which is the only kind
// of regression this probe can police from outside an unmodifiable file.
console.log("\n[12] src/api/base44Client.js (PROTECTED — read only) still pays in cents");

const clientCode = codeOnly(src("src/api/base44Client.js"));
const mirror = (() => {
  const a = clientCode.indexOf("const created = [];");
  const b = clientCode.indexOf("return {", a);
  return a === -1 || b === -1 ? "" : clientCode.slice(a, b);
})();

check("the runLocalAutoPayroll record builder was located", () => mirror.length > 200);
check(
  "it computes regularPayCents through toCents/Math.round, not float dollars",
  () => /regularPayCents\s*=/.test(mirror) && /toCents\(/.test(mirror)
);
check(
  "it reads tc.hours — which is why section 4 must keep `hours` exact",
  () => /Number\(tc\.hours\)/.test(clientCode),
  "the coupling changed; sections 4 and 6 need re-deriving against the new consumer"
);

// ---------------------------------------------------------------------------
console.log(`\n${failures === 0 ? "PASSED" : "FAILED"}: ${passes} passed, ${failures} failed`);
if (failures > 0) {
  console.log("DEFECT PRESENT — payroll cents are being derived from a display-rounded hours figure.");
  process.exit(1);
}
console.log("Payroll money is derived from the exact integer minute basis.");
process.exit(0);
