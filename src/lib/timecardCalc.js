import { toCents, fromCents } from '@/lib/decimal';

/**
 * Timecard reconciliation engine.
 *
 * The rest of the payroll pipeline treats `Staff.hours` as a hand-typed
 * per-period constant. This module closes that gap: it pairs raw clock-in /
 * clock-out timestamps into shifts, handles overnight shifts, applies unpaid
 * meal-break policy, buckets hours into workweeks, and derives regular vs
 * overtime hours (1.5x after 40 hours/week).
 *
 * Design rules:
 *   * Pure functions over plain data — no Dexie, no React, fully testable.
 *   * Never guess a missing punch into real pay. A shift with a missing clock
 *     out is flagged for manager review and excluded from paid hours, so the
 *     engine cannot silently short-pay or over-pay someone.
 *   * Overtime is computed per workweek (a shift can straddle two weeks; the
 *     hour is attributed to the day it STARTS on).
*  * All money math goes through integer cents (see src/lib/decimal).
 *   * MINUTES ARE THE BASIS OF RECORD, hours are a derived reading. A punch
 *     pair is an integer number of minutes, so every total up to the pay
 *     computation stays an exact integer; `hours` is only ever
 *     `minutes / 60`, and it is never rounded before money is derived from it.
 *     Rounding hours to 2 decimals and multiplying the rate by THAT is how this
 *     module used to underpay 2,243 minutes at $15.00/h by 5 cents (it paid
 *     $560.70 instead of $560.75). See scripts/probe-payroll-minute-rounding.mjs.
 *
 *   * A DURATION IS A MEASUREMENT WHERE THE DATA ALLOWS ONE. Two times of day
 *     can only describe a span of 0..1439 minutes, so when a punch carries its
 *     own date the date is used: a 2026-03-07 09:00 -> 2026-03-09 10:00 pair is
 *     2,940 minutes, not 60. A span that is impossible (>= 24h, or negative) is
 *     flagged and paid nothing — see UNPAYABLE_FLAGS and
 *     scripts/probe-timecard-shift-span.mjs.
 *
 * Time format accepted by `parseTime`: "HH:MM" 24h, "H:MM AM/PM", "HH", or a
 * full datetime "YYYY-MM-DD[T ]<time>" whose time part it reads. It returns a
 * minute of a real day (0..1439) or null, never anything else. The date half of
 * a full datetime is read separately, by `normalisePunch`.
 */

const _MS_PER_MIN = 60 * 1000;
const MIN_PER_HOUR = 60;
const MIN_PER_DAY = 24 * 60;
const DEFAULT_WEEKLY_OT_HOURS = 40;
const DEFAULT_OT_MULTIPLIER = 1.5;
const DEFAULT_BREAK_MINUTES = 30;
const DEFAULT_BREAK_AFTER_HOURS = 6;

/**
 * Flags that describe a duration no pay can be derived from. A shift carrying
 * one is listed and flagged for review but contributes no minutes.
 */
const UNPAYABLE_FLAGS = ["shift_exceeds_24h", "negative_shift_duration"];

/**
 * Parse a clock time into minutes since local midnight.
 *
 * The return value is a minute of a real day — an integer in [0, 1439] — or
 * null. Every branch enforces that, because a caller cannot tell a bad minute
 * from a good one and `minutesBetween` will happily turn 1479 into a shift
 * longer than a day. The AM/PM branch used to validate neither field, so
 * "11:99 PM" returned 1479 and "25:00 AM" silently became 01:00; that is how a
 * 24.15-hour shift reached payroll and was paid $362.25 despite being flagged
 * impossible. See scripts/probe-timecard-shift-span.mjs.
 *
 * A full datetime is accepted and only its time part is read here. The DATE
 * part matters too — see `datePartOf` and `normalisePunch`.
 *
 * @param {string|number} value
 * @returns {number|null} minutes since midnight in [0, 1439], or null if
 *   unparseable or not a time that exists.
 */
export function parseTime(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    const n = Math.round(value);
    return n >= 0 && n < MIN_PER_DAY ? n : null;
  }
  const s = String(value).trim();
  if (!s) return null;

  // Full datetime "2026-03-07 03:21 PM" — take the time portion (the time can
  // itself contain a space, e.g. "03:21 PM", so capture to end of string).
  const iso = s.match(/^\d{4}-\d{2}-\d{2}[T ](.*)$/);
  const timePart = (iso ? iso[1] : s).replace(/[Zz]$/, '').trim();

  // "HH:MM[:SS] AM/PM" or "H:MM[:SS] am"
  let m = timePart.match(/^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*([AaPp][Mm])$/);
  if (m) {
    // Range-check BEFORE the mod, or an impossible hour becomes a plausible
    // one: 25 % 12 is 1, so "25:00 AM" would read as 01:00 rather than being
    // refused. 13..23 with a meridiem is contradictory but resolves to exactly
    // one real time ("13:30 PM" -> 13:30), and exporters do emit it, so it is
    // accepted here as it always has been.
    const raw = Number(m[1]);
    if (raw < 0 || raw > 23) return null;
    const min = Number(m[2]);
    if (min < 0 || min > 59) return null;
    if (m[3] !== undefined) {
      const sec = Number(m[3]);
      if (sec < 0 || sec > 59) return null;
    }
    let h = raw % 12;
    if (/p/i.test(m[4])) h += 12;
    return h * MIN_PER_HOUR + min;
  }
  // "HH:MM[:SS]" 24h
  m = timePart.match(/^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/);
  if (m) {
    const h = Number(m[1]);
    if (h < 0 || h > 23) return null;
    const min = Number(m[2]);
    if (min < 0 || min > 59) return null;
    if (m[3] !== undefined) {
      const sec = Number(m[3]);
      if (sec < 0 || sec > 59) return null;
    }
    return h * MIN_PER_HOUR + min;
  }
  // Bare "HH" 24h
  m = timePart.match(/^(\d{1,2})$/);
  if (m) {
    const h = Number(m[1]);
    if (h < 0 || h > 23) return null;
    return h * MIN_PER_HOUR;
  }
  return null;
}

/**
 * Minutes between two times-of-day, handling an overnight crossing.
 * If `out < in`, the shift crossed midnight (+24h).
 *
 * This can only ever return 0..1439 (verified exhaustively over all 2,073,600
 * legal pairs), so a shift longer than a day is NOT representable here. When the
 * punches carry their own dates, `normalisePunch` measures the real span
 * instead; this function is the reading of last resort, for punches that are
 * bare times of day.
 */
export function minutesBetween(inMin, outMin) {
  let delta = outMin - inMin;
  if (delta < 0) delta += MIN_PER_DAY;
  return delta;
}

/**
 * The date a punch value states for itself, or "" if it is a bare time of day.
 * `parseTime` accepts "YYYY-MM-DD HH:MM" and reads only the time; this reads the
 * other half, so the two together describe an instant rather than a clock face.
 */
function datePartOf(value) {
  if (typeof value !== "string") return "";
  const m = value.trim().match(/^(\d{4}-\d{2}-\d{2})[T ]/);
  return m ? m[1] : "";
}

/**
 * A day (YYYY-MM-DD) as a count of days, for subtracting one date from another.
 *
 * Deliberately built with `Date.UTC` and never converted back: the difference of
 * two UTC midnights is exact and immune to DST, whereas `new Date("2026-03-07")`
 * is parsed as UTC and then reports the PREVIOUS day through the local getters
 * in any zone behind UTC. Only the difference is ever used, so no local calendar
 * date is derived from this.
 */
function dayIndex(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ""));
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(ms) ? Math.round(ms / 86400000) : null;
}

/**
 * True if the given day is within [periodStart, periodEnd] (both YYYY-MM-DD).
 */
export function inPeriod(day, periodStart, periodEnd) {
  if (!day) return false;
  if (periodStart && day < periodStart) return false;
  if (periodEnd && day > periodEnd) return false;
  return true;
}

/**
 * First day of the workweek containing `day` (YYYY-MM-DD). Weeks start on
 * `weekStart` (0=Sunday..6=Saturday, defaults to Sunday).
 * Returns { weekStart, weekEnd }.
 */
export function weekBounds(day, weekStart = 0) {
  const [y, m, d] = String(day || "").split("-").map((n) => Number(n));
  if (!y || !m || !d) return null;
  const dt = new Date(y, m - 1, d);
  const dow = dt.getDay();
  const offset = (dow - weekStart + 7) % 7;
  const start = new Date(y, m - 1, d - offset);
  const end = new Date(y, m - 1, d - offset + 6);
  const pad = (n) => String(n).padStart(2, "0");
  return {
    weekStart: `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`,
    weekEnd: `${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(end.getDate())}`,
  };
}

/**
 * Normalise a raw punch row into { employeeKey, employeeName, department,
 * date, clockIn, clockOut, durationMinutes, flags }.
 *
 * `clockIn`/`clockOut` are minutes since midnight. A missing clock-out leaves
 * clockOut null; the shift is flagged (never silently paid).
 *
 * `durationMinutes` is the shift's real span when both punches state a date and
 * those dates differ, and null otherwise — see the comment on the calculation.
 * It can exceed a day, and it can be negative; either is flagged and unpayable.
 *
 * @param {any} [p]  a raw punch row (any shape; only the known fields are read).
 *   Recognised: p.date or p.shift_date (YYYY-MM-DD the shift started),
 *   p.clock_in / p.time_in / p.start_time, p.clock_out / p.time_out /
 *   p.end_time, p.employee_name, p.employee_id, p.department.
 * @returns {Object|null} normalised shift or null if no usable time at all
 */
export function normalisePunch(p = /** @type {Object} */ ({})) {
  const date = String(p.date || p.shift_date || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { date: "", clockIn: null, clockOut: null, employeeKey: keyOf(p), employeeName: nameOf(p), department: p.department || "", flags: ["missing_date"] };
  }
  const rawIn = p.clock_in ?? p.time_in ?? p.start_time;
  const rawOut = p.clock_out ?? p.time_out ?? p.end_time;
  const clockIn = parseTime(rawIn);
  const clockOut = parseTime(rawOut);
  const flags = [];
  if (clockIn === null) flags.push("missing_clock_in");
  if (clockOut === null) flags.push("missing_clock_out");

  // How long was the shift? Two different questions, depending on what the data
  // actually says.
  //
  // If the punches carry their own dates, the span is a measurement:
  // (days apart × 1440) + (out − in). This is the only way a shift longer than a
  // day can be seen at all — `minutesBetween` tops out at 1439, so a 2026-03-07
  // 09:00 -> 2026-03-09 10:00 pair (2,940 real minutes) used to read as 60
  // minutes with no flag, because the dates were matched by parseTime's regex
  // and then thrown away.
  //
  // The clock-in's date may come from `shift_date`, which is documented as the
  // day the shift STARTS on. The clock-out's must be explicit in the value: if
  // only a time of day is given, which day it belongs to is unknown, and
  // guessing it is what this block exists to stop.
  //
  // Two dates that are EQUAL are treated as no information beyond `shift_date`,
  // so 22:00 -> 06:00 both stamped 2026-03-07 still reads as an 8-hour overnight
  // rather than a contradiction. An exporter that fails to advance the date is
  // common; the alternative reading (an out before the in) is incoherent, and
  // refusing to pay a legitimate overnight shift is a worse failure than the one
  // being fixed. Dates that DIFFER are believed — including when they run
  // backwards, which is a contradiction no reading can repair.
  let durationMinutes = null;
  if (clockIn !== null && clockOut !== null) {
    const inIdx = dayIndex(datePartOf(rawIn) || date);
    const outIdx = dayIndex(datePartOf(rawOut));
    if (inIdx !== null && outIdx !== null && outIdx !== inIdx) {
      durationMinutes = (outIdx - inIdx) * MIN_PER_DAY + (clockOut - clockIn);
    }

    if (durationMinutes === null) {
      // Bare times of day. A same-time pair can only be a 24h double-day or a
      // keying error; either way it needs review rather than pay.
      const dur = clockOut === clockIn ? MIN_PER_DAY : minutesBetween(clockIn, clockOut);
      if (dur >= MIN_PER_DAY) flags.push("shift_exceeds_24h");
    } else if (durationMinutes < 0) {
      flags.push("negative_shift_duration");
    } else if (durationMinutes >= MIN_PER_DAY) {
      flags.push("shift_exceeds_24h");
    }
  }

  return {
    date,
    clockIn,
    clockOut,
    durationMinutes,
    employeeKey: keyOf(p),
    employeeName: nameOf(p),
    department: p.department || "",
    employeeId: p.employee_id || p.employeeId || "",
    flags,
  };
}

function keyOf(p) {
  // `||` (not `??`) so an empty-string employee_id falls through to the name:
  // imports seed employee_id as "" when the export lacks a number, and a blank
  // key must never collapse different employees into one payroll row.
  const id = String(p.employee_key ?? p.employeeKey ?? p.employee_id ?? p.employeeId ?? "").trim();
  return id || String(p.employee_name ?? "").trim();
}

function nameOf(p) {
  return String(p.employee_name ?? "").trim() || String(p.employee_id ?? "").trim();
}

/**
 * Round a shift's duration to a workable clock precision. Shifts are counted to
 * the minute; a 0-min shift is dropped unless it was flagged.
 *
 * `durationMinutes` is the measured span when `normalisePunch` could read one
 * from the punch dates, and is preferred over the time-of-day reading — which
 * cannot represent anything longer than a day. A negative span is a
 * contradiction in the data (it carries `negative_shift_duration` and
 * `reconcileTimecards` refuses to pay it); it is reported as 0 rather than as a
 * plausible positive number. Shifts built by hand, without the field, are
 * unaffected.
 */
export function shiftDurationMinutes(shift) {
  if (shift.clockIn === null || shift.clockOut === null) return 0;
  if (Number.isFinite(shift.durationMinutes)) return Math.max(0, shift.durationMinutes);
  return minutesBetween(shift.clockIn, shift.clockOut);
}

/**
 * Apply unpaid meal-break policy to a shift.
 *
 * Hospitality roles run long shifts; a break is normally unpaid. If the shift
 * has an explicit `break_minutes` field it wins; otherwise a default unpaid
 * break is deducted once a shift exceeds `breakAfterHours`.
 *
 * @returns {{ hours: number, paidMinutes: number, breakMinutes: number, flags: string[] }}
 */
export function applyBreaks(shift, options = {}) {
  const {
    breakMinutes = DEFAULT_BREAK_MINUTES,
    breakAfterHours = DEFAULT_BREAK_AFTER_HOURS,
    deductBreaks = true,
  } = options;

  const rawMinutes = shiftDurationMinutes(shift);
  const flags = [...(shift.flags || [])];

  if (!deductBreaks || rawMinutes === 0) {
    return { hours: rawMinutes / MIN_PER_HOUR, paidMinutes: rawMinutes, breakMinutes: 0, flags };
  }

  const explicitBreak = Number(shift.break_minutes ?? shift.breakMinutes ?? NaN);
  const applied = Number.isFinite(explicitBreak)
    ? Math.max(0, explicitBreak)
    : rawMinutes > breakAfterHours * MIN_PER_HOUR
      ? breakMinutes
      : 0;

  const paidMinutes = Math.max(0, rawMinutes - applied);
  if (applied > 0) flags.push("unpaid_break_applied");
  return { hours: paidMinutes / MIN_PER_HOUR, paidMinutes, breakMinutes: applied, flags };
}

/**
 * Pay, in integer cents, for an exact number of worked MINUTES.
 *
 * This is the only correct shape for hourly pay in this codebase, and the
 * ordering of the operations is the whole point:
 *
 *   payCentsForMinutes(1500, 2243)  ->  Math.round(1500 * 2243 / 60)  =  56075
 *   Math.round(1500 * (2243 / 60))                                    =  56075
 *   Math.round(1500 * 37.38)                                          =  56070   WRONG
 *
 * `rateCents * minutes` is an exact integer for every rate and shift length
 * this business can produce (a $10,000/h rate over a 24h shift is 1.4e9, far
 * inside 2^53), so the single division-and-round is the ONLY place precision is
 * lost, and it loses it deterministically. The middle form is correct to within
 * a cent but is not deterministic: when `rateCents * minutes` is exactly 30 mod
 * 60 the true value sits on a half cent, and one unit in the last place of
 * `minutes / 60` decides which way it goes. Measured over 25,929 (rate, minute)
 * pairs, that is the only case where the two disagree, and never by more than a
 * cent — see section 7 of scripts/probe-payroll-minute-rounding.mjs.
 *
 * @param {number} rateCents  hourly rate in integer cents (use toCents()).
 * @param {number} minutes    exact worked minutes (an integer).
 * @returns {number} pay in integer cents, rounded half up.
 */
export function payCentsForMinutes(rateCents, minutes) {
  return Math.round((rateCents * minutes) / MIN_PER_HOUR);
}

/**
 * Reconcile a set of shifts into per-employee, per-week totals.
 *
 * @param {Array<Object>} punches  raw punch rows (see normalisePunch)
 * @param {Object} [options]
 * @param {number} [options.weeklyOvertimeHours=40]
 * @param {number} [options.weekStart=0] 0=Sunday..6=Saturday
 * @param {boolean} [options.deductBreaks=true]
 * @param {number} [options.breakMinutes=30]
 * @param {number} [options.breakAfterHours=6]
 * @param {Object} [options.rates] employeeKey -> { base_rate, overtime_rate }
 *   Overtime defaults to 1.5x base.
 *
 * @returns {Array<Object>} one row per (employee, workweek):
 *   { employeeKey, employeeName, department, weekStart, weekEnd,
 *     shifts, flags, paid_minutes, regular_minutes, overtime_minutes,
 *     hours, overtime_hours, unpaid_break_minutes,
 *     regular_pay, overtime_pay, total_pay }
 *
 *   `paid_minutes` is the exact integer basis and equals
 *   `regular_minutes + overtime_minutes`. `hours` and `overtime_hours` are the
 *   unrounded quotients of the latter two — a reading for humans, and the value
 *   any consumer that only understands hours should multiply. Multiplying a
 *   rate by `paid_minutes` would pay overtime minutes at the base rate, which
 *   is why the split is exposed rather than left to the caller.
 *
 *   A shift with a missing punch, or with a duration that is impossible
 *   (UNPAYABLE_FLAGS), is listed in `shifts` and contributes its flags to the
 *   week, but contributes NO minutes. A week can therefore be flagged and still
 *   pay correctly for its sound shifts.
 */
export function reconcileTimecards(punches = [], options = {}) {
  const {
    weeklyOvertimeHours = DEFAULT_WEEKLY_OT_HOURS,
    weekStart = 0,
    deductBreaks = true,
    breakMinutes = DEFAULT_BREAK_MINUTES,
    breakAfterHours = DEFAULT_BREAK_AFTER_HOURS,
    rates = {},
  } = options;

  const rows = new Map();

  for (const p of punches) {
    const shift = normalisePunch(p);
    if (!shift) continue;

    const bounds = weekBounds(shift.date, weekStart);
    if (!bounds) {
      continue;
    }

    const key = `${shift.employeeKey}||${bounds.weekStart}`;
    let row = rows.get(key);
    if (!row) {
      row = {
        employeeKey: shift.employeeKey,
        employeeName: shift.employeeName,
        department: shift.department,
        weekStart: bounds.weekStart,
        weekEnd: bounds.weekEnd,
        shifts: [],
        flags: new Set(),
        paid_minutes: 0,
        regular_minutes: 0,
        overtime_minutes: 0,
        hours: 0,
        overtime_hours: 0,
        unpaid_break_minutes: 0,
      };
      rows.set(key, row);
    }

    if (shift.date) row.shifts.push(shift);
    for (const f of shift.flags || []) row.flags.add(f);

    // Only pay shifts with both punches. A missing punch is reviewed, not paid.
    if (shift.clockIn === null || shift.clockOut === null) continue;

    // Nor is a shift whose duration is impossible. `normalisePunch` flagged it,
    // and until now that flag was decorative here: a pair that measured 1,449
    // minutes was paid 24.15 hours ($362.25 at $15/h) with the flag attached.
    // The backend copy (base44/functions/autoPayroll/entry.ts) has always
    // skipped it, so the cron and the Payroll page paid different amounts for
    // identical rows. Nothing in the data says what the real span was, so any
    // paid number would be a guess — and this module's rule is to never guess a
    // punch into real pay. The shift stays in `shifts` and its flag stays on the
    // week, and the import path raises a high-severity AnomalyAlert per flag
    // (reportParsers.js), so a human is told rather than a wrong number booked.
    if (UNPAYABLE_FLAGS.some((f) => shift.flags.includes(f))) continue;

    const paid = applyBreaks(shift, { deductBreaks, breakMinutes, breakAfterHours });
    row.unpaid_break_minutes += paid.breakMinutes;
    // Integer addition, so a week's basis is exact no matter how many shifts it
    // holds. `paid.hours` is the same quantity divided by 60 and is deliberately
    // NOT accumulated: summing quotients drifts (five shifts of 480 min summed
    // as hours gave 42.333333333333336, whose overtime remainder came out as
    // 2.3333333333333357 rather than 2.3333333333333335).
    row.paid_minutes += paid.paidMinutes;
    for (const f of paid.flags) row.flags.add(f);
  }

  const out = [];
  for (const row of rows.values()) {
    // Regular vs overtime: minutes above the weekly cap are overtime, paid at
    // the OT multiplier. Split per week so a 50h week gets 40 regular + 10 OT
    // rather than paying everything as OT. The cap is converted to minutes so
    // the comparison and the remainder are both exact integers.
    const capMinutes = Math.max(0, Math.round(weeklyOvertimeHours * MIN_PER_HOUR));
    row.overtime_minutes = Math.max(0, row.paid_minutes - capMinutes);
    row.regular_minutes = row.paid_minutes - row.overtime_minutes;

    // Hours are the derived reading. Exact quotients, never rounded — money is
    // computed from the minutes below, and the one consumer that recomputes pay
    // from `hours` alone (runLocalAutoPayroll, a protected file) can only land
    // on the right cent if this value is exact. Render sites format it.
    row.hours = row.regular_minutes / MIN_PER_HOUR;
    row.overtime_hours = row.overtime_minutes / MIN_PER_HOUR;

    const r = rates[row.employeeKey] || {};
    const baseRate = Number(r.base_rate) || 0;
    const otRate = Number(r.overtime_rate) || baseRate * DEFAULT_OT_MULTIPLIER;

    row.regular_pay = fromCents(payCentsForMinutes(toCents(baseRate), row.regular_minutes));
    row.overtime_pay = fromCents(payCentsForMinutes(toCents(otRate), row.overtime_minutes));
    row.total_pay = fromCents(toCents(row.regular_pay) + toCents(row.overtime_pay));
    row.rate = { base_rate: baseRate, overtime_rate: otRate };
    row.flags = [...row.flags];
    out.push(row);
  }

  out.sort((a, b) => (a.employeeKey < b.employeeKey ? -1 : a.employeeKey > b.employeeKey ? 1 : 0) || (a.weekStart < b.weekStart ? -1 : 1));
  return out;
}

/**
 * Build PayrollRun-shaped records from reconciled weeks, ready for bulkCreate.
 * Mirrors buildPayrollRunRecord in payrollCalc.js so downstream consumers
 * (dashboard Money Kept, Action Center, Expenses) read identical shapes.
 *
 * @param {Array} weeks   output of reconcileTimecards
 * @param {Object} meta   { propertyId, propertyName, periodStart, periodEnd, status }
 * @returns {Array<Object>} rows with payroll_status committed (approved/paid)
 *   only when `status` is committed; drafts carry the status verbatim.
 */
export function weeksToPayrollRuns(weeks = [], meta = {}) {
  const now = new Date().toISOString();
  return weeks.map((w) => ({
    employee_name: w.employeeName,
    department: w.department || "",
    pay_type: "hourly",
    base_rate: w.rate?.base_rate || 0,
    hours: w.hours,
    overtime_hours: w.overtime_hours,
    overtime_rate: w.rate?.overtime_rate || 0,
    overtime_pay: w.overtime_pay,
    bonus: 0,
    deductions: 0,
    regular_pay: w.regular_pay,
    total_pay: w.total_pay,
    pay_period_start: w.weekStart,
    pay_period_end: w.weekEnd,
    payroll_status: meta.status || "draft",
    property_id: meta.propertyId || "",
    property_name: meta.propertyName || "",
    auto_generated: true,
    timecard_derived: true,
    flags: w.flags || [],
    employee_id: "",
    created_date: now,
    updated_date: now,
  }));
}
