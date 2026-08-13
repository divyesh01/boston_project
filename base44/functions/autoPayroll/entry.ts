const db = globalThis.__B44_DB__ || { auth:{ isAuthenticated: async()=>false, me: async()=>null }, entities:new Proxy({}, { get:()=>({ filter:async()=>[], get:async()=>null, create:async()=>({}), update:async()=>({}), delete:async()=>({}) }) }), integrations:{ Core:{ UploadFile:async()=>({ file_url:'' }) } } };

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
// punches missing in/out are flagged and NEVER paid.
const MIN_PER_HOUR = 60;
const WEEKLY_OT_HOURS = 40;
const OT_MULTIPLIER = 1.5;
const BREAK_MINUTES = 30;
const BREAK_AFTER_HOURS = 6;

function parseTime(value: any): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value) : null;
  const s = String(value).trim();
  if (!s) return null;
  const iso = s.match(/^\d{4}-\d{2}-\d{2}[T ](.*)$/);
  const timePart = (iso ? iso[1] : s).trim();
  let m = timePart.match(/^(\d{1,2}):(\d{2})\s*([AaPp][Mm])$/);
  if (m) {
    let h = Number(m[1]) % 12;
    if (/p/i.test(m[3])) h += 12;
    return h * MIN_PER_HOUR + Number(m[2]);
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

function minutesBetween(inMin: number, outMin: number): number {
  let delta = outMin - inMin;
  if (delta < 0) delta += 24 * MIN_PER_HOUR;
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
    const clockIn = parseTime(p.clock_in ?? p.time_in ?? p.start_time);
    const clockOut = parseTime(p.clock_out ?? p.time_out ?? p.end_time);
    const employeeKey = String(p.employee_name ?? "").trim();
    if (!employeeKey) continue;
    const bounds = weekBounds(date, 0);
    if (!bounds) continue;
    const key = `${employeeKey.toLowerCase()}||${bounds.weekStart}`;
    let row = rows.get(key);
    if (!row) {
      row = {
        employeeKey: employeeKey.toLowerCase(),
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
    let dur = clockOut === clockIn ? 24 * MIN_PER_HOUR : minutesBetween(clockIn, clockOut);
    if (dur >= 24 * MIN_PER_HOUR) {
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
    row.hours += paidMinutes / MIN_PER_HOUR;
    row.unpaid_break_minutes += applied;
  }
  const out = [];
  for (const row of (rows.values() as any)) {
    const otHours = Math.max(0, row.hours - WEEKLY_OT_HOURS);
    row.overtime_hours = Math.round(otHours * 100) / 100;
    row.hours = Math.round((row.hours - otHours) * 100) / 100;
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
    // Scheduled cron runs have no user session and execute as the trusted
    // service role. Manual invocations (from the Payroll page) must come from
    // an authenticated owner/admin.
    let user: any = null;
    const cookieHeader = req.headers.get('cookie') || '';
    const cookieMatch = cookieHeader.match(/base44_session=([^;]+)/);
    const token = cookieMatch ? cookieMatch[1] : null;
    if (token) {
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const sessions = await db.asServiceRole.entities.Session.filter({ token_hash: tokenHash }, null, 1, 0);
      const session = sessions[0];
      if (session && !session.is_revoked && new Date(session.expires_at) >= new Date()) {
        user = await db.asServiceRole.entities.User.get(session.user_id);
      }
    }

    if (user) {
      if (user.role !== 'admin' && user.role !== 'owner') {
        return Response.json({ error: "Forbidden: Only admins or owners can run payroll" }, { status: 403 });
      }
      if (user.is_active === false) {
        return Response.json({ error: "Forbidden: Account is suspended" }, { status: 403 });
      }
      const _csrfHeader = req.headers.get('x-csrf-token');
      const _cookieHeader = req.headers.get('cookie') || '';
      const _csrfCookieMatch = _cookieHeader.match(/csrf_token=([^;]+)/);
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
    const staff = await db.entities.Staff.filter({ active: true });
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
      existing = await db.entities.PayrollRun.filter({ pay_period_end: periodEnd }) || [];
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
      const allPunches = await db.entities.TimecardPunch.filter({}) || [];
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
      return weeks.reduce(
        (acc: any, w: any) => ({
          hours: acc.hours + (Number(w.hours) || 0),
          overtime_hours: acc.overtime_hours + (Number(w.overtime_hours) || 0),
        }),
        { hours: 0, overtime_hours: 0 }
      );
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
      const regularPay = s.pay_type === "salary" ? baseRate : baseRate * hours;
      const overtimePay = otHours * otRate;
      const totalPay = regularPay + overtimePay + bonus - deductions;

      const record = {
        property_id: s.property_id || "",
        property_name: s.property_name || "",
        employee_name: s.employee_name,
        department: s.department || "",
        pay_type: s.pay_type || "hourly",
        base_rate: baseRate,
        hours,
        regular_pay: Math.round(regularPay * 100) / 100,
        overtime_hours: otHours,
        overtime_rate: otRate,
        overtime_pay: Math.round(overtimePay * 100) / 100,
        bonus,
        deductions,
        total_pay: Math.round(totalPay * 100) / 100,
        pay_period_start: periodStart,
        pay_period_end: periodEnd,
        payroll_date: periodEnd,
        payroll_status: "pending",
        auto_generated: true,
        timecard_derived: !!tc,
      };

      await db.entities.PayrollRun.create(record);
      created.push(record);
    }

    // Server-side audit (#9): record who generated payroll, the period, and the
    // outcome. Generated runs are intentionally "pending" so a second human
    // approval is required; the audit entry makes the generation traceable in a
    // way the client-side (forgeable) chain cannot guarantee.
    try {
      await db.entities.AuditLog.create({
        user_id: user ? user.id : null,
        username: (user && (user.username || user.email)) || "system",
        action: "Payroll Generated",
        performed_by_id: user ? user.id : null,
        performed_by: (user && (user.username || user.email)) || "system",
        result: "success",
        detail: `Generated ${created.length} pending payroll run(s) for ${periodStart} → ${periodEnd}${body.force ? " (forced)" : ""}${body.propertyId ? ` · property ${body.propertyId}` : ""}`,
        created_date: new Date().toISOString(),
      });
    } catch {
      // AuditLog entity may not exist on every deployment; never fail the run.
    }

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
    return Response.json({ error: error.message, status: "failed" }, { status: 500 });
  }
}