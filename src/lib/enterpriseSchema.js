import { isBusinessDate, validTimezone } from './businessDate.js';

export const ENTERPRISE_PROFILE_KEY = 'rri_enterprise_profile_v1';
export const ENTERPRISE_TEMPLATE_KEY = 'rri_enterprise_templates_v1';
export const ENTERPRISE_DEFAULT_KEY = 'rri_enterprise_defaults_v1';
export const PROMOTION_KEY = 'rri_promotion_scenario_v1';
export const SERVICE_STATEMENT_KEY = 'rri_service_statements_v1';
export const TAX_REMITTANCE_KEY = 'rri_tax_remittance_v1';
export const CLUSTERS = Object.freeze({
  EVENT_CORRIDOR: { label: 'Event corridor', high_revpar: 59.70, medium_revpar: 37.31, rate_floor: 69.99, rate_ceiling: 399.99 },
  HIGHWAY: { label: 'Highway', high_revpar: 58, medium_revpar: 36, rate_floor: 64.99, rate_ceiling: 199.99 },
  SUNBELT: { label: 'Sunbelt', high_revpar: 70, medium_revpar: 42, rate_floor: 74.99, rate_ceiling: 299.99 },
  EXTENDED: { label: 'Extended stay', high_revpar: 45, medium_revpar: 28, rate_floor: 49.99, rate_ceiling: 149.99 },
});
export const PMS_ADAPTERS = Object.freeze(['hotelkey', 'canonical_csv', 'synxis', 'opera', 'cloudbeds']);
const fail = message => { throw new Error(message); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function number(value, name, min = 0, max = 10000000) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(`Invalid ${name}.`);
}
export function validatePolicyPeriod(p) {
  if (!object(p)) fail('A policy period must be an object.');
  for (const key of ['effective_start', 'effective_end']) if (p[key] && !isBusinessDate(p[key])) fail(`Invalid ${key}.`);
  if (p.effective_start && p.effective_end && p.effective_start > p.effective_end) fail('Policy end precedes its start.');
  if (p.cluster && !Object.prototype.hasOwnProperty.call(CLUSTERS,p.cluster)) fail('Unknown demand cluster.');
  for (const key of ['capacity', 'cpor', 'margin_high', 'high_revpar', 'medium_revpar', 'rate_floor', 'rate_ceiling']) {
    if (p[key] != null) number(p[key], key);
  }
  if (p.capacity != null && (!Number.isInteger(p.capacity) || p.capacity < 1 || p.capacity > 100000)) fail('Capacity must be a positive room count.');
  if (p.high_revpar != null && p.medium_revpar != null && p.high_revpar < p.medium_revpar) fail('High RevPAR must be at least medium RevPAR.');
  if (p.rate_floor != null && p.rate_ceiling != null && p.rate_floor > p.rate_ceiling) fail('Rate floor exceeds the ceiling.');
  if (p.tax_jurisdictions != null) {
    if (!Array.isArray(p.tax_jurisdictions) || p.tax_jurisdictions.length > 30) fail('Invalid tax jurisdictions.');
    const ids = new Set();
    for (const j of p.tax_jurisdictions) {
      if (!object(j) || typeof j.id !== 'string' || !j.id || j.id.length > 100 || ids.has(j.id) || !['state', 'county', 'city', 'district', 'other'].includes(j.kind)) fail('Tax jurisdictions need unique IDs and a jurisdiction kind.');
      for (const key of ['label','source_url']) if (j[key] != null && (typeof j[key] !== 'string' || j[key].length > 1000)) fail(`Invalid tax ${key}.`);
      ids.add(j.id);
      if (!['percentage', 'flat_per_night'].includes(j.type)) fail('Invalid tax calculation type.');
      number(j.rate, 'tax rate', 0, j.type === 'percentage' ? 1 : 10000);
      if (j.exempt_after_nights != null && (!Number.isInteger(j.exempt_after_nights) || j.exempt_after_nights < 1)) fail('Invalid tax exemption duration.');
      if (!['hotel', 'marketplace'].includes(j.remitter || 'hotel')) fail('Invalid tax remitter.');
      if (j.reviewed !== true) fail('Review each tax jurisdiction before activating it.');
    }
  }
  if (p.labor_policy != null) {
    const l = p.labor_policy;
    if (!object(l)) fail('Invalid labor policy.');
    for (const key of ['minimum_wage', 'weekly_overtime_hours', 'daily_overtime_hours', 'reporting_pay_hours', 'sick_leave_hours_per_hour', 'overtime_multiplier']) {
      if (l[key] != null) number(l[key], key, 0, 1000);
    }
    if (l.workweek_start != null && (!Number.isInteger(l.workweek_start) || l.workweek_start < 0 || l.workweek_start > 6)) fail('Invalid workweek start.');
    if (l.overtime_multiplier != null && l.overtime_multiplier < 1) fail('Overtime multiplier must be at least one.');
    if (l.reviewed !== true || typeof l.source_url !== 'string' || !l.source_url || l.source_url.length > 1000) fail('Labor policies require a reviewed source.');
  }
  return p;
}
export function validatePeriods(periods) {
  if (!Array.isArray(periods) || periods.length > 100) fail('Invalid policy periods.');
  periods.forEach(validatePolicyPeriod);
  const windows = periods.filter(p => p.effective_start || p.effective_end);
  for (let i = 0; i < windows.length; i++) for (let k = i + 1; k < windows.length; k++) {
    if ((windows[i].effective_start || '') <= (windows[k].effective_end || '9999-12-31') && (windows[k].effective_start || '') <= (windows[i].effective_end || '9999-12-31')) fail('Policy periods overlap. Edit the existing period or close its date range first.');
  }
  if (periods.filter(p => !p.effective_start && !p.effective_end).length > 1) fail('Only one default policy period is allowed.');
  return periods;
}
export function validateEnterpriseProfile(value) {
  if (!object(value)) fail('Invalid property profile.');
  if (value.timezone && !validTimezone(value.timezone)) fail('Invalid property time zone.');
  if (value.current_business_date && !isBusinessDate(value.current_business_date)) fail('Invalid property business date.');
  if (value.night_audit_status && !['OPEN', 'RUNNING', 'CLOSED'].includes(value.night_audit_status)) fail('Invalid night audit status.');
  if (value.pms && !PMS_ADAPTERS.includes(value.pms)) fail('Unsupported PMS adapter.');
  for (const key of ['state', 'region', 'employer_of_record', 'employer_group_id']) if (value[key] != null && (typeof value[key] !== 'string' || value[key].length > 200)) fail(`Invalid ${key}.`);
  validatePeriods(value.periods || []);
  return value;
}
export function validateEnterpriseTemplates(value) {
  if (!object(value)) fail('Invalid templates.');
  for (const bucket of ['states', 'regions']) {
    if (value[bucket] != null && !object(value[bucket])) fail(`Invalid ${bucket} templates.`);
    if (Object.keys(value[bucket] || {}).length > 100) fail('Too many templates.');
    for (const periods of Object.values(value[bucket] || {})) validatePeriods(periods);
  }
  return value;
}

export function validateRemittanceRecords(records) {
  if (!Array.isArray(records) || records.length > 500) throw new Error('Invalid remittance record list.');
  const seen = new Set();
  for (const r of records) {
    const key = JSON.stringify([r.date, r.reference]);
    if (!isBusinessDate(r.date) || !r.reference || typeof r.reference !== 'string' || r.reference.length > 500 || r.reviewed !== true || seen.has(key)) throw new Error('Remittance records need a unique date/reference and explicit review.');
    seen.add(key);
    for (const field of ['taxable_base', 'state', 'city', 'other']) if (typeof r[field] !== 'number' || !Number.isFinite(r[field]) || r[field] < 0 || r[field] > 10000000000) throw new Error('Invalid remittance amount.');
  }
  return records;
}

export function validateServiceStatements(records) {
  if (!Array.isArray(records) || records.length > 200) fail('Invalid service statements.');
  const ids = new Set();
  for (const row of records) {
    if (!object(row) || typeof row.id !== 'string' || !row.id || ids.has(row.id) || !row.employee_identity || !['draft','reviewed'].includes(row.status)) fail('Invalid statement identity or status.');
    ids.add(row.id);
    for (const key of ['employee_identity','employee_name','employer_property_id','service_property_id','employer_name','service_name']) if (typeof row[key] !== 'string' || !row[key] || row[key].length > 500) fail(`Invalid statement ${key}.`);
    if (!Array.isArray(row.lines) || !row.lines.length || row.lines.length > 100) fail('Invalid statement lines.');
    const sourceIds = new Set();
    for (const line of row.lines) {
      if (line.source_id == null || line.source_id === '' || sourceIds.has(String(line.source_id)) || !isBusinessDate(line.date)) fail('Invalid statement payroll reference.');
      sourceIds.add(String(line.source_id));
      for (const key of ['hours','overtime_hours','rate','overtime_rate','amount']) number(line[key],key);
      if (Math.round(line.amount*100) !== Math.round(Math.round(line.rate*100)*line.hours)+Math.round(Math.round(line.overtime_rate*100)*line.overtime_hours)) fail('Statement line amount does not reconcile.');
    }
    for (const key of ['wage_total','fica','workers_comp','total']) number(row[key],key,0,10000000000);
    for (const key of ['fica_rate','workers_comp_rate']) number(row[key],key,0,1);
    const cents = n => Math.round(n * 100);
    const wages = row.lines.reduce((n,l)=>n+Math.round(cents(l.rate)*l.hours)+Math.round(cents(l.overtime_rate)*l.overtime_hours),0);
    if (cents(row.wage_total) !== wages || cents(row.fica) !== Math.round(wages*row.fica_rate) || cents(row.workers_comp) !== Math.round(wages*row.workers_comp_rate) || cents(row.total) !== wages+cents(row.fica)+cents(row.workers_comp)) fail('Statement totals do not reconcile.');
  }
  return records;
}

