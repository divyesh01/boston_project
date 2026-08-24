import { createClientFromRequest } from 'npm:@base44/sdk@^0.8.41';
import { secrets } from 'base44:runtime';
import * as crypto from 'node:crypto';

// ─── Timecard reconciliation (parity with src/lib/timecardCalc.js) ───
// Base44 functions are isolated modules that cannot import the client-side
// `@/lib/timecardCalc.js`, so the reconciliation is inlined here. The logic
// mirrors the local fallback in src/api/base44Client.js (runLocalAutoPayroll)
// so production payroll (this cron) and the offline path compute identical
// hours/overtime from the same TimecardPunch rows.
//
// Policy: weekly overtime after 40h, unpaid 30-min break per shift over 6h
// (an explicit punch.break_minutes wins), overnight shifts span midnight, and
// punches missing in/out — or with a duration that is impossible — are flagged
// and NEVER paid.
const MIN_PER_HOUR = 60;
const MIN_PER_DAY = 24 * 60;
const WEEKLY_OT_HOURS = 40;
const OT_MULTIPLIER = 1.5;
const BREAK_MINUTES = 30;
const BREAK_AFTER_HOURS = 6;

// ─── Money (parity with src/lib/decimal.js and src/lib/timecardCalc.js) ───
// Same isolation reason as the reconciler above: no shared import is possible,
// so the three functions this file needs are inlined. They must stay
// byte-equivalent in behaviour to their client-side originals, because this
// function and runLocalAutoPayroll write to the same PayrollRun table.
//
// This block replaced raw floating-point dollar math (`baseRate * hours`,
// `otHours * otRate`, `Math.round(totalPay * 100) / 100`), which CLAUDE.md's
// BUSINESS mandate forbids outright and which disagreed with the offline path
// even though the header above claimed parity.
const toCents = (value: any) => Math.round((Number(value) || 0) * 100);
const fromCents = (cents: number) => cents / 100;

// Pay for an exact number of worked MINUTES. `rateCents * minutes` is an exact
// integer, so the single division is the only place precision is lost — see the
// long note on payCentsForMinutes in src/lib/timecardCalc.js and section 7 of
// scripts/probe-payroll-minute-rounding.mjs.
const payCentsForMinutes = (rateCents: number, minutes: number) =>
  Math.round((rateCents * minutes) / MIN_PER_HOUR);

// Returns a minute of a real day (0..1439) or null — never anything else. The
// AM/PM branch used to range-check neither field, so "11:99 PM" returned 1479
// and "25:00 AM" became 01:00 (25 % 12 = 1). See the same note in
// src/lib/timecardCalc.js and scripts/probe-timecard-shift-span.mjs.
function parseTime(value: any): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    const n = Math.round(value);
    return n >= 0 && n < MIN_PER_DAY ? n : null;
  }
  const s = String(value).trim();
  if (!s) return null;
  const iso = s.match(/^\d{4}-\d{2}-\d{2}[T ](.*)$/);
  const timePart = (iso ? iso[1] : s).trim();
  let m = timePart.match(/^(\d{1,2}):(\d{2})\s*([AaPp][Mm])$/);
  if (m) {
    const raw = Number(m[1]);
    if (raw < 0 || raw > 23) return null;
    const min = Number(m[2]);
    if (min < 0 || min > 59) return null;
    let h = raw % 12;
    if (/p/i.test(m[3])) h += 12;
    return h * MIN_PER_HOUR + min;
  }
  m = timePart.match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    const h = Number(m[1]);
    if (h < 0 || h > 23) return null;
    const min = Number(m[2]);
    if (min < 0 || min > 59) return null;
    return h * MIN_PER_HOUR + min;
  }
  m = timePart.match(/^(\d{1,2})$/);
  if (m) {
    const h = Number(m[1]);
    if (h < 0 || h > 23) return null;
    return h * MIN_PER_HOUR;
  }
  return null;
}

// The date a punch value states for itself, or "" if it is a bare time of day.
// parseTime reads the time half; a shift longer than a day is only visible in
// the other half.
function datePartOf(value: any): string {
  if (typeof value !== "string") return "";
  const m = value.trim().match(/^(\d{4}-\d{2}-\d{2})[T ]/);
  return m ? m[1] : "";
}

// A day as a count of days, for subtracting one date from another. Built with
// Date.UTC and never converted back: the difference of two UTC midnights is
// exact and immune to DST, while `new Date("2026-03-07")` reports the previous
// day through the local getters in any zone behind UTC.
function dayIndex(day: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ""));
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(ms) ? Math.round(ms / 86400000) : null;
}

function minutesBetween(inMin: number, outMin: number): number {
  let delta = outMin - inMin;
  if (delta < 0) delta += MIN_PER_DAY;
  return delta;
}

function weekBounds(day: string, weekStart = 0): { weekStart: string; weekEnd: string } | null {
  const parts = String(day || "").split("-").map((n) => Number(n));
  const [y, m, d] = parts;
  if (!y || !m || !d) return null;
  const dt = new Date(y, m - 1, d);
  const dow = dt.getDay();
  const offset = (dow - weekStart + 7) % 7;
  const start = new Date(y, m - 1, d - offset);
  const end = new Date(y, m - 1, d - offset + 6);
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    weekStart: `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`,
    weekEnd: `${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(end.getDate())}`,
  };
}

function reconcileTimecards(punches: any[]): any[] {
  const rows = new Map<string, any>();
  for (const p of punches || []) {
    const date = String(p.date || p.shift_date || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const rawIn = p.clock_in ?? p.time_in ?? p.start_time;
    const rawOut = p.clock_out ?? p.time_out ?? p.end_time;
    const clockIn = parseTime(rawIn);
    const clockOut = parseTime(rawOut);
    const employeeKey = String(p.employee_name ?? "").trim();
    if (!employeeKey) continue;
    const bounds = weekBounds(date, 0);
    if (!bounds) continue;
    const key = `${employeeKey.toLowerCase()}||${bounds.weekStart}`;
    let row = rows.get(key);
    if (!row) {
      row = {
        employeeKey: employeeKey.toLowerCase(),
        paid_minutes: 0,
        regular_minutes: 0,
        overtime_minutes: 0,
        hours: 0,
        overtime_hours: 0,
        unpaid_break_minutes: 0,
        flags: new Set<string>(),
      };
      rows.set(key, row);
    }
    if (clockIn === null || clockOut === null) {
      row.flags.add(clockIn === null ? "missing_clock_in" : "missing_clock_out");
      continue;
    }
    // How long was the shift? When both punches state a date and those dates
    // differ, the span is a measurement: (days apart × 1440) + (out − in). Two
    // times of day can only describe 0..1439 minutes, so this is the only way a
    // shift longer than a day can be seen — a 2026-03-07 09:00 -> 2026-03-09
    // 10:00 pair (2,940 real minutes) used to read as 60 minutes with no flag.
    // Equal dates are treated as no information beyond the shift date, so an
    // overnight pair an exporter failed to advance still reads as 8 hours.
    // Parity with normalisePunch in src/lib/timecardCalc.js.
    let dur: number;
    const inIdx = dayIndex(datePartOf(rawIn) || date);
    const outIdx = dayIndex(datePartOf(rawOut));
    if (inIdx !== null && outIdx !== null && outIdx !== inIdx) {
      dur = (outIdx - inIdx) * MIN_PER_DAY + (clockOut - clockIn);
      if (dur < 0) {
        row.flags.add("negative_shift_duration");
        continue;
      }
    } else {
      dur = clockOut === clockIn ? MIN_PER_DAY : minutesBetween(clockIn, clockOut);
    }
    if (dur >= MIN_PER_DAY) {
      row.flags.add("shift_exceeds_24h");
      continue;
    }
    const explicitBreak = Number(p.break_minutes ?? NaN);
    const applied = Number.isFinite(explicitBreak)
      ? Math.max(0, explicitBreak)
      : dur > BREAK_AFTER_HOURS * MIN_PER_HOUR
        ? BREAK_MINUTES
        : 0;
    const paidMinutes = Math.max(0, dur - applied);
    if (applied > 0) row.flags.add("unpaid_break_applied");
    // Integer addition. Accumulating `paidMinutes / MIN_PER_HOUR` instead drifts,
    // and the drifted remainder is what used to be rounded to 2 decimals and
    // multiplied by the rate.
    row.paid_minutes += paidMinutes;
    row.unpaid_break_minutes += applied;
  }
  const out = [];
  for (const row of (rows.values() as any)) {
    const capMinutes = Math.max(0, Math.round(WEEKLY_OT_HOURS * MIN_PER_HOUR));
    row.overtime_minutes = Math.max(0, row.paid_minutes - capMinutes);
    row.regular_minutes = row.paid_minutes - row.overtime_minutes;
    // Exact quotients. Rounding these to 2 decimals underpaid 2,243 minutes at
    // $15.00/h by 5 cents ($560.70 instead of $560.75).
    row.hours = row.regular_minutes / MIN_PER_HOUR;
    row.overtime_hours = row.overtime_minutes / MIN_PER_HOUR;
    row.flags = [...row.flags];
    out.push(row);
  }
  return out;
}

// Automate Payroll — runs on the final calendar day of every month.
// The cron trigger fires daily on the 28th–31st (cron can't express "last day"),
// so this function dynamically computes the true final day of the current month
// (handling 28 / 29 / 30 / 31-day months) and only executes when it matches.
// Every active staff member gets an auto-generated PayrollRun with the default
// status "Approved". Runs are idempotent: a staff member is never processed twice
// for the same pay period.
//
// Optional body:
//   { force: true }          — run even if today is not the final day
//   { year, month }          — 0-based month to target (defaults to today)
//   { propertyId }           — optionally scope the run to a single property
export default async function runAutoPayroll(req) {
  try {
    const base44 = createClientFromRequest(req);

    let user: any = null;
    let isAuthorizedCron = false;

    // Gate 1: Automated Cron Execution
    const cronSecret = secrets.get('CRON_SECRET');
    const authHeader = req.headers.get('authorization');
    const cronKeyHeader = req.headers.get('x-cron-key');
    
    if (cronSecret && (authHeader === `Bearer ${cronSecret}` || cronKeyHeader === cronSecret)) {
      isAuthorizedCron = true;
    }

    // Gate 2: Manual UI Execution (if Cron fails)
    if (!isAuthorizedCron) {
      const cookieHeader = req.headers.get('cookie') || '';
      const cookieMatch = cookieHeader.match(/base44_session=([^;]+)/);
      const token = cookieMatch ? cookieMatch[1] : null;
      if (!token) return Response.json({ error: 'Unauthorized' }, { status: 401 });

      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const sessions = await base44.asServiceRole.entities.Session.filter({ token_hash: tokenHash }, null, 1, 0);
      const session = sessions[0];
      if (!session || session.is_revoked || new Date(session.expires_at) < new Date()) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
      }

      user = await base44.asServiceRole.entities.User.get(session.user_id);
      if (!user || !user.is_active || user.is_locked) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
      }

      if (user.role !== 'admin' && user.role !== 'owner') {
        return Response.json({ error: "Forbidden: Only admins or owners can run payroll" }, { status: 403 });
      }

      const _csrfHeader = req.headers.get('x-csrf-token');
      const _csrfCookieMatch = cookieHeader.match(/__Host-csrf_token=([^;]+)/);
      const _csrfCookie = _csrfCookieMatch ? _csrfCookieMatch[1] : null;
      if (!_csrfHeader || !_csrfCookie || _csrfHeader !== _csrfCookie) {
        return Response.json({ error: "Invalid CSRF token" }, { status: 403 });
      }
    }

    let body: any = {};
    try { 
      const raw = await req.json(); 
      if (raw && typeof raw === 'object') {
        body = {
          force: raw.force === true,
          year: typeof raw.year === 'number' ? raw.year : undefined,
          month: typeof raw.month === 'number' ? raw.month : undefined,
          propertyId: typeof raw.propertyId === 'string' ? raw.propertyId : undefined
        };
      }
    } catch (e) { /* empty body ok */ }

    const now = new Date();
    const year = Number.isInteger(body.year) ? body.year : now.getFullYear();
    const month = Number.isInteger(body.month) ? body.month : now.getMonth();

    // Final day of the target month — dynamic for 28/29/30/31-day months
    const lastDay = new Date(year, month + 1, 0).getDate();
    const isLastDayToday =
      now.getFullYear() === year && now.getMonth() === month && now.getDate() === lastDay;

    if (!body.force && !isLastDayToday) {
      return Response.json({
        status: "skipped",
        message: `Today (${now.toISOString().slice(0, 10)}) is not the final day of ${new Date(year, month, 1).toLocaleString("en-US", { month: "long", year: "numeric" })} (which is the ${lastDay}th). Payroll only auto-runs on the last calendar day.`,
        scheduledFor: `${year}-${String(month + 1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`,
      });
    }

    const pad = (n) => String(n).padStart(2, "0");
    const periodStart = `${year}-${pad(month + 1)}-01`;
    const periodEnd = `${year}-${pad(month + 1)}-${pad(lastDay)}`;

    // 1. Load all active staff
    const staff = await base44.asServiceRole.entities.Staff.filter({ active: true });
    if (!staff || staff.length === 0) {
      return Response.json({
        status: "ok",
        message: "No active staff found — nothing to process.",
        periodStart,
        periodEnd,
        runsCreated: 0,
        runsSkipped: 0,
      });
    }

    // 2. Load existing payroll runs for this pay period so we never run twice
    let existing = [];
    try {
      existing = await base44.asServiceRole.entities.PayrollRun.filter({ pay_period_end: periodEnd }) || [];
    } catch (err) {
      existing = [];
    }
    const paidKeys = new Set(
      existing.map((r) => `${r.property_id || "all"}::${String(r.employee_name || "").toLowerCase()}`)
    );

    // 2b. Reconcile clock-in/out punches for this period into per-employee
    // weekly hours. When punches cover the period for a person, the
    // reconciled hours/overtime win over the hand-typed Staff.hours; missing
    // punches are flagged and never paid. Falls back to Staff.hours when no
    // punch data exists for the period (parity with runLocalAutoPayroll).
    let timecardWeeks: any[] = [];
    try {
      // Base44's entity filter takes object equality predicates; range filters
      // aren't reliably supported, so load the punches and scope by period/
      // property in JS (punch volume is bounded — one row per shift).
      const allPunches = await base44.asServiceRole.entities.TimecardPunch.filter({}) || [];
      const punches = allPunches.filter(
        (p: any) =>
          (!body.propertyId || p.property_id === body.propertyId) &&
          String(p.shift_date || "").slice(0, 10) >= periodStart &&
          String(p.shift_date || "").slice(0, 10) <= periodEnd
      );
      if (punches.length) {
        const staffNames = new Set(staff.map((s: any) => String(s.employee_name).trim().toLowerCase()));
        timecardWeeks = reconcileTimecards(punches).filter((w) => staffNames.has(String(w.employeeKey || "").toLowerCase()));
      }
    } catch (err) {
      // TimecardPunch may not be deployed yet, or the filter isn't supported —
      // fall back to Staff.hours silently rather than failing the whole run.
      timecardWeeks = [];
    }
    const byEmployee = (low: string) => {
      const weeks = timecardWeeks.filter((w) => String(w.employeeKey || "").toLowerCase() === low);
      if (!weeks.length) return null;
      // Sum the MINUTES, then divide once. Summing the per-week `hours` quotients
      // instead would drift: five 8h shifts summed as hours came out as
      // 42.333333333333336, and the pay derived from that misses the cent.
      const summed = weeks.reduce(
        (acc: any, w: any) => ({
          regular_minutes: acc.regular_minutes + (Number(w.regular_minutes) || 0),
          overtime_minutes: acc.overtime_minutes + (Number(w.overtime_minutes) || 0),
        }),
        { regular_minutes: 0, overtime_minutes: 0 }
      );
      return {
        regular_minutes: summed.regular_minutes,
        overtime_minutes: summed.overtime_minutes,
        hours: summed.regular_minutes / MIN_PER_HOUR,
        overtime_hours: summed.overtime_minutes / MIN_PER_HOUR,
      };
    };

    // 3. Generate an approved payroll run per active staff member
    const created = [];
    const skipped = [];
    for (const s of staff) {
      const key = `${s.property_id || "r"}::${String(s.employee_name || "").toLowerCase()}`;
      if (paidKeys.has(key)) {
        skipped.push({ employee_name: s.employee_name, reason: "already processed for this period" });
        continue;
      }
      if (!s.employee_name || !(Number(s.base_rate) > 0)) {
        skipped.push({ employee_name: s.employee_name, reason: "missing pay configuration" });
        continue;
      }
      const baseRate = Number(s.base_rate) || 0;
      // Timecard-derived hours win when punches cover the period for this person;
      // otherwise fall back to the hand-typed Staff record.
      const tc = byEmployee(String(s.employee_name || "").toLowerCase());
      const hours = tc ? Number(tc.hours) || 0 : Number(s.hours) || 0;
      const otHours = tc ? Number(tc.overtime_hours) || 0 : Number(s.overtime_hours) || 0;
      const otRate = Number(s.overtime_rate) || baseRate * OT_MULTIPLIER;
      const bonus = Number(s.bonus) || 0;
      const deductions = Number(s.deductions) || 0;
      const baseRateCents = toCents(baseRate);
      const otRateCents = toCents(otRate);
      // Pay from the exact minute basis whenever punches cover the period. With no
      // punches the hand-typed Staff.hours IS the input of record, so it is
      // multiplied as given — a typed 37.38 pays $560.70 because 37.38 is what the
      // manager asserted, not a rounding of something more precise.
      const regularPayCents = s.pay_type === "salary"
        ? baseRateCents
        : tc
          ? payCentsForMinutes(baseRateCents, Number(tc.regular_minutes) || 0)
          : Math.round(baseRateCents * hours);
      const overtimePayCents = tc
        ? payCentsForMinutes(otRateCents, Number(tc.overtime_minutes) || 0)
        : Math.round(otRateCents * otHours);
      const totalPayCents = regularPayCents + overtimePayCents + toCents(bonus) - toCents(deductions);

      const record = {
        property_id: s.property_id || "",
        property_name: s.property_name || "",
        employee_name: s.employee_name,
        department: s.department || "",
        pay_type: s.pay_type || "hourly",
        base_rate: baseRate,
        hours,
        regular_pay: fromCents(regularPayCents),
        overtime_hours: otHours,
        overtime_rate: otRate,
        overtime_pay: fromCents(overtimePayCents),
        bonus,
        deductions,
        total_pay: fromCents(totalPayCents),
        pay_period_start: periodStart,
        pay_period_end: periodEnd,
        payroll_date: periodEnd,
        payroll_status: "pending",
        auto_generated: true,
        timecard_derived: !!tc,
      };

      await base44.asServiceRole.entities.PayrollRun.create(record);
      created.push(record);
    }

    // Server-side audit (#9): record who generated payroll, the period, and the
    // outcome. Generated runs are intentionally "pending" so a second human
    // approval is required; the audit entry makes the generation traceable in a
    // way the client-side (forgeable) chain cannot guarantee.
    await writeAudit(base44, {
      userId: user ? user.id : null,
      username: (user && (user.username || user.email)) || "system",
      action: "Payroll Generated",
      performedById: user ? user.id : null,
      performedBy: (user && (user.username || user.email)) || "system",
      propertyId: body.propertyId || null,
      detail: `Generated ${created.length} pending payroll run(s) for ${periodStart} → ${periodEnd}${body.force ? " (forced)" : ""}${body.propertyId ? ` · property ${body.propertyId}` : ""}`,
    });

    return Response.json({
      status: "ok",
      message: `Payroll executed for ${created.length} active staff member(s) and marked as Pending.`,
      periodStart,
      periodEnd,
      createdCount: created.length,
      skippedCount: skipped.length,
      created,
      skipped,
    });
  } catch (error) {
    console.error("AutoPayroll error:", error);
    return Response.json({ error: "Internal server error", status: "failed" }, { status: 500 });
  }
}

// ─── AuditLog chain writer ───
// This function is a WRITER on the tamper-evident AuditLog chain. The canonical
// payload below is the contract shared with base44/functions/audit_verify/
// entry.js; the base44 host permits no module sharing between functions, so it
// exists here as a copy. Any field added, removed, renamed or re-ordered MUST be
// mirrored in the verifier and every other writer, or the verifier will misflag
// every healthy row as tampered. scripts/probe-audit-chain.mjs asserts the
// AUDIT_CANONICAL_V1 markers and hashed fields agree across all copies.
async function writeAudit(base44: any, opts: any) {
  // An audit write must never break the operation it records — the payroll runs
  // (or the data wipe) have already been committed by the time we get here.
  try {
    // FAIL CLOSED, but by SKIPPING the row rather than writing an unsigned one.
    // audit_verify recomputes the expected hash for every stored row and reports
    // a hashless row as `tampered`, so emitting one here would make the entire
    // healthy trail read as forged — strictly worse than a missing row. An
    // unconfigured deployment is already loud: audit_verify returns
    // chain_secret_missing and no rows accumulate.
    const chainSecret = secrets.get('AUDIT_CHAIN_SECRET');
    if (!chainSecret) throw new Error('AUDIT_CHAIN_SECRET is not configured');

    const lastEntries = await base44.asServiceRole.entities.AuditLog.filter({}, '-created_date', 1, 0);
    const lastRow = (lastEntries && lastEntries[0]) || null;
    const previousHash = (lastRow && lastRow.hash) || '0'.repeat(64);
    const nowIso = monotonicIso(lastRow && lastRow.created_date);

    // `|| null` rather than a bare undefined: JSON.stringify DROPS undefined
    // keys, so an undefined here would hash a different shape than the verifier
    // rebuilds from a row the backend stored as null.
    // AUDIT_CANONICAL_V1 = user_id,action,performed_by_id,performed_by,property_id,result,detail,created_date,previous_hash
    const canonical = JSON.stringify({
      user_id: opts.userId || null,
      action: opts.action,
      performed_by_id: opts.performedById || null,
      performed_by: opts.performedBy,
      property_id: opts.propertyId || null,
      result: 'success',
      detail: opts.detail || '',
      created_date: nowIso,
      previous_hash: previousHash,
    });
    const hash = crypto.createHash('sha256').update(`${chainSecret}:${canonical}`).digest('hex');

    // Written but NOT signed: username. It is forensic context only, exactly as
    // in audit_log/entry.js — the signed field set must stay identical.
    await base44.asServiceRole.entities.AuditLog.create({
      user_id: opts.userId || null,
      username: opts.username,
      action: opts.action,
      performed_by_id: opts.performedById || null,
      performed_by: opts.performedBy,
      property_id: opts.propertyId || null,
      result: 'success',
      detail: opts.detail || '',
      created_date: nowIso,
      hash,
      previous_hash: previousHash,
    });
  } catch (err) {
    console.error('[autoPayroll] audit write failed:', err);
  }
}

// Strictly increasing, because the verifier orders the chain by created_date. A
// same-millisecond tie could be walked in the opposite order to the one the rows
// were linked in and reported as a chain break that never happened.
function monotonicIso(lastIso: any) {
  const now = Date.now();
  const last = lastIso ? Date.parse(lastIso) : NaN;
  return new Date(Number.isFinite(last) && last >= now ? last + 1 : now).toISOString();
}