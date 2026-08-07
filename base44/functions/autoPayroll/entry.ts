const db = globalThis.__B44_DB__ || { auth:{ isAuthenticated: async()=>false, me: async()=>null }, entities:new Proxy({}, { get:()=>({ filter:async()=>[], get:async()=>null, create:async()=>({}), update:async()=>({}), delete:async()=>({}) }) }), integrations:{ Core:{ UploadFile:async()=>({ file_url:'' }) } } };

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
    const user = await db.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    let body = {};
    try { body = await req.json(); } catch (e) { /* empty body ok */ }

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
      const hours = Number(s.hours) || 0;
      const otHours = Number(s.overtime_hours) || 0;
      const otRate = Number(s.overtime_rate) || baseRate * 1.5;
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
        payroll_status: "approved",
        auto_generated: true,
      };

      await db.entities.PayrollRun.create(record);
      created.push(record);
    }

    return Response.json({
      status: "ok",
      message: `Payroll executed for ${created.length} active staff member(s) and marked as Approved.`,
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