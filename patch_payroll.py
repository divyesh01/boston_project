import re

with open('src/api/base44Client.js', 'r', encoding='utf-8') as f:
    code = f.read()

# Replace runLocalAutoPayroll function body
match = re.search(r'(async function runLocalAutoPayroll\(params = \{\}\) \{)(.*?\n\s*\n\s*return \{\n\s*data: \{\n\s*status: "ok",\n\s*message:.*?\}\n\})', code, re.DOTALL)
if not match:
    print("Could not find runLocalAutoPayroll")
    exit(1)

new_func = """async function runLocalAutoPayroll(params = {}) {
  const { periodStart, periodEnd, year, month, lastDay } = getPayrollPeriod(params.monthOffset);
  const now = new Date();
  const isLastDayToday = now.getDate() === lastDay && now.getMonth() === month && now.getFullYear() === year;

  if (!params.force && !isLastDayToday) {
    return {
      data: {
        status: "skipped",
        message: `Today (${now.toISOString().slice(0, 10)}) is not the final day of ${new Date(year, month, 1).toLocaleString("en-US", { month: "long", year: "numeric" })} (which is the ${lastDay}th). Payroll only auto-runs on the last calendar day.`,
        scheduledFor: periodEnd,
      },
    };
  }

  const staff = await localDb.Staff.filter((s) => s.active !== false).toArray();
  if (staff.length === 0) {
    return { data: { status: "ok", message: "No active staff found — nothing to process.", periodStart, periodEnd, createdCount: 0, skippedCount: 0 } };
  }

  const existing = await localDb.PayrollRun.filter((r) => r.pay_period_end === periodEnd).toArray();
  const paidKeys = new Set(existing.map((r) => `${r.property_id || "all"}::${String(r.employee_name || "").toLowerCase()}`));

  let timecardWeeks = [];
  try {
    const allPunches = await localDb.TimecardPunch.toArray() || [];
    const punches = allPunches.filter(
      (p) =>
        (!params.propertyId || p.property_id === params.propertyId) &&
        String(p.shift_date || "").slice(0, 10) >= periodStart &&
        String(p.shift_date || "").slice(0, 10) <= periodEnd
    );
    if (punches.length) {
      const staffNames = new Set(staff.map((s) => String(s.employee_name).trim().toLowerCase()));
      timecardWeeks = reconcileTimecards(punches).filter((w) => staffNames.has(String(w.employeeKey || "").toLowerCase()));
    }
  } catch (err) {
    timecardWeeks = [];
  }

  const byEmployee = (low) => {
    const weeks = timecardWeeks.filter((w) => String(w.employeeKey || "").toLowerCase() === low);
    if (!weeks.length) return null;
    return weeks.reduce(
      (acc, w) => ({
        hours: acc.hours + (Number(w.hours) || 0),
        overtime_hours: acc.overtime_hours + (Number(w.overtime_hours) || 0),
      }),
      { hours: 0, overtime_hours: 0 }
    );
  };

  const created = [];
  const skipped = [];
  for (const s of staff) {
    const key = `${s.property_id || "all"}::${String(s.employee_name || "").toLowerCase()}`;
    if (paidKeys.has(key)) {
      skipped.push({ employee_name: s.employee_name, reason: "already processed for this period" });
      continue;
    }
    if (!s.employee_name || !(Number(s.base_rate) > 0)) {
      skipped.push({ employee_name: s.employee_name, reason: "missing pay configuration" });
      continue;
    }
    
    const baseRate = Number(s.base_rate) || 0;
    const tc = byEmployee(String(s.employee_name || "").toLowerCase());
    const hours = tc ? Number(tc.hours) || 0 : Number(s.hours) || 0;
    const otHours = tc ? Number(tc.overtime_hours) || 0 : Number(s.overtime_hours) || 0;
    const otRate = Number(s.overtime_rate) || baseRate * 1.5;
    const bonus = Number(s.bonus) || 0;
    const deductions = Number(s.deductions) || 0;
    
    const baseRateCents = toCents(baseRate);
    const regularPayCents = s.pay_type === "salary" ? baseRateCents : Math.round(baseRateCents * hours);
    const overtimePayCents = Math.round(toCents(otRate) * otHours);
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
      payroll_status: "approved",
      auto_generated: true,
      timecard_derived: !!tc,
    };
    await localDb.PayrollRun.add({ ...record, created_date: now.toISOString(), updated_date: now.toISOString() });
    created.push(record);
  }

  return {
    data: {
      status: "ok",
      message: `Payroll executed for ${created.length} active staff member(s) and marked as Approved.`,
      periodStart,
      periodEnd,
      createdCount: created.length,
      skippedCount: skipped.length,
    }
  }"""

code = code.replace(match.group(0), new_func)
with open('src/api/base44Client.js', 'w', encoding='utf-8') as f:
    f.write(code)

print("success")
