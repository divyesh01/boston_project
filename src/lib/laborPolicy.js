import { getEnterpriseConfig } from './enterpriseConfigEngine.js';
import { isBusinessDate } from './businessDate.js';
import { toCents, fromCents } from './decimal.js';

export function assessWage(entry, propertyId, businessDate) {
  const policy = getEnterpriseConfig(propertyId, businessDate).labor_policy;
  if (!policy) return { configured: false, issues: ['No reviewed labor policy applies to this business date.'] };
  const issues = [];
  if (entry.pay_type === 'hourly') {
    if (policy.minimum_wage != null && toCents(entry.base_rate) < toCents(policy.minimum_wage)) issues.push(`Hourly rate is below the configured minimum of $${policy.minimum_wage.toFixed(2)}.`);
    if (Number(entry.overtime_hours) > 0 && Number(entry.overtime_rate || Number(entry.base_rate) * 1.5) < Number(entry.base_rate) * (policy.overtime_multiplier ?? 1.5)) issues.push('Overtime rate is below the configured multiplier.');
  }
  return { configured: true, policy, issues };
}

// One employee identity across all service locations within the configured
// employer group. Allocate the excess once; daily OT is credited against weekly
// OT so the same hour is never counted twice. Does not infer joint employment.
export function allocateOvertime(shifts, policy) {
  const groups = new Map(), result = [];
  for (const shift of shifts) {
    if (!shift.employee_identity || !shift.employer_group || shift.property_id == null || shift.property_id === '' || !isBusinessDate(shift.date) || !Number.isFinite(Number(shift.hours)) || Number(shift.hours) < 0 || Number(shift.hours) > 24) throw new Error('Shifts need an employee identity, employer group, valid date and hours.');
    const d = new Date(`${shift.date}T12:00:00Z`);
    const start = policy.workweek_start ?? 0;
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() - start + 7) % 7));
    const key = JSON.stringify([shift.employer_group, shift.employee_identity, d.toISOString().slice(0, 10)]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(shift);
  }
  for (const rows of groups.values()) {
    let regularWeek = 0;
    const daily = new Map();
    for (const shift of [...rows].sort((a, b) => a.date.localeCompare(b.date))) {
      const units = Math.round(Number(shift.hours) * 10000), used = daily.get(shift.date) || 0;
      const dailyLimit = policy.daily_overtime_hours == null ? Infinity : policy.daily_overtime_hours * 10000;
      const dailyOt = Math.max(0, used + units - dailyLimit) - Math.max(0, used - dailyLimit);
      daily.set(shift.date, used + units);
      const weeklyLimit = policy.weekly_overtime_hours == null ? Infinity : policy.weekly_overtime_hours * 10000;
      const weeklyOt = Math.max(0, regularWeek + units - dailyOt - weeklyLimit);
      regularWeek += units - dailyOt - weeklyOt;
      const reportingHours = shift.reporting_pay_applies === true ? Math.max(0, (policy.reporting_pay_hours || 0) - Number(shift.hours)) : 0;
      result.push({ ...shift, regular_hours: (units - dailyOt - weeklyOt) / 10000, overtime_hours: (dailyOt + weeklyOt) / 10000, reporting_hours: reportingHours,
        sick_leave_accrued: Number(shift.hours) * (policy.sick_leave_hours_per_hour || 0) });
    }
  }
  return result;
}

export function buildServiceStatement({ employer, service, employee, lines, fica_rate = 0, workers_comp_rate = 0, approved = false }) {
  if (employer?.id == null || service?.id == null || String(employer.id) === String(service.id)) throw new Error('Select distinct employer and receiving properties.');
  if (employee?.id == null || !lines.length) throw new Error('Select a stable employee identity and source payroll lines.');
  for (const rate of [fica_rate, workers_comp_rate]) if (!Number.isFinite(rate) || rate < 0 || rate > 1) throw new Error('Invalid burden rate.');
  const seen = new Set();
  let wages = 0;
  const items = lines.map(line => {
    if (line.source_id == null || line.source_id === '' || seen.has(String(line.source_id)) || !isBusinessDate(line.date)) throw new Error('Every allocated line needs a unique payroll reference and business date.');
    seen.add(String(line.source_id));
    for (const key of ['hours', 'overtime_hours', 'rate', 'overtime_rate']) if (!Number.isFinite(Number(line[key])) || Number(line[key]) < 0) throw new Error('Invalid allocated hours or rate.');
    const amount = Math.round(toCents(line.rate) * Number(line.hours)) + Math.round(toCents(line.overtime_rate) * Number(line.overtime_hours));
    wages += amount;
    return { ...line, amount: fromCents(amount) };
  });
  const fica = Math.round(wages * fica_rate), comp = Math.round(wages * workers_comp_rate);
  return { employer_property_id: String(employer.id), service_property_id: String(service.id), employer_name: employer.name, service_name: service.name,
    employee_identity: String(employee.id), employee_name: employee.name, lines: items, wage_total: fromCents(wages), fica: fromCents(fica), workers_comp: fromCents(comp),
    total: fromCents(wages + fica + comp), fica_rate, workers_comp_rate, status: approved ? 'reviewed' : 'draft' };
}
