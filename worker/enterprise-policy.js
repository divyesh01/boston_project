import { queryAll } from './db.js';
import { ENTERPRISE_PROFILE_KEY, ENTERPRISE_DEFAULT_KEY, ENTERPRISE_TEMPLATE_KEY } from '../src/lib/enterpriseSchema.js';
import { isBusinessDate } from '../src/lib/businessDate.js';

function effective(periods, date) {
  return (Array.isArray(periods) ? periods : []).filter(p => (!p.effective_start || date >= p.effective_start) && (!p.effective_end || date <= p.effective_end))
    .sort((a, b) => String(a.effective_start || '').localeCompare(String(b.effective_start || '')))
    .reduce((out, p) => ({ ...out, ...p }), {});
}
export async function assertConfiguredWage(env, accountId, row, entity) {
  if (!['Staff', 'PayrollRun'].includes(entity) || row.pay_type !== 'hourly') return;
  const rows = await queryAll(env, `SELECT setting_key, property_id, value_json FROM app_setting WHERE account_id = ? AND property_id IN ('*', ?) AND setting_key IN (?, ?, ?)`,
    [accountId, String(row.property_id), ENTERPRISE_PROFILE_KEY, ENTERPRISE_DEFAULT_KEY, ENTERPRISE_TEMPLATE_KEY]);
  const value = (key, propertyId) => { const record = rows.find(r => r.setting_key === key && r.property_id === propertyId); return record ? JSON.parse(record.value_json) : null; };
  const profile = value(ENTERPRISE_PROFILE_KEY, String(row.property_id)) || {};
  const templates = value(ENTERPRISE_TEMPLATE_KEY, '*') || {};
  const date = entity === 'Staff' ? profile.current_business_date || row.hire_date : row.pay_period_end || row.payroll_date;
  if (!isBusinessDate(date)) return;
  const policy = { ...effective(value(ENTERPRISE_DEFAULT_KEY, '*'), date), ...effective(templates.states?.[profile.state], date), ...effective(templates.regions?.[profile.region], date), ...effective(profile.periods, date) }.labor_policy;
  if (!policy || policy.reviewed !== true) return;
  if (!Number.isFinite(Number(row.base_rate)) || Number(row.base_rate) < (policy.minimum_wage ?? 0)) throw new Error('Hourly rate is below the reviewed property labor policy.');
  if (Number(row.overtime_hours) > 0 && Number(row.overtime_rate || Number(row.base_rate) * 1.5) < Number(row.base_rate) * (policy.overtime_multiplier ?? 1.5)) throw new Error('Overtime rate is below the reviewed property labor policy.');
}
