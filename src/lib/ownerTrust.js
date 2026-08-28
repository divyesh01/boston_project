import { filterCommittedPay } from './payrollCalc.js';
import { expenseBucket, DERIVED_COST_BUCKETS } from './expenseCategories.js';

// Date-only report keys are calendar days. UTC arithmetic avoids DST changing
// their distance; the caller supplies today's LOCAL calendar date.
function dayNumber(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) return null;
  return ms / 86400000;
}

export function reportFreshness(latestDate, today) {
  if (!latestDate) return { state: 'empty', ageDays: null };
  const latest = dayNumber(latestDate);
  const current = dayNumber(today);
  if (latest === null || current === null) return { state: 'invalid', ageDays: null };
  const ageDays = current - latest;
  return { state: ageDays < 0 ? 'future' : ageDays === 0 ? 'current' : ageDays === 1 ? 'recent' : 'stale', ageDays };
}

export function costCoverage(expenses, payroll, dateRange) {
  const from = dayNumber(dateRange?.from);
  const to = dayNumber(dateRange?.to);
  if (from === null || to === null || from > to) return { state: 'unknown', missing: [] };
  const inPeriod = (date) => {
    const day = dayNumber(String(date || '').slice(0, 10));
    return day !== null && day >= from && day <= to;
  };
  const missing = [];
  const expenseBuckets = expenses.filter((e) => inPeriod(e.expense_date)).map((e) => expenseBucket(e.category));
  if (!expenseBuckets.some((bucket) => !DERIVED_COST_BUCKETS.includes(bucket))) missing.push('operating expenses');
  if (!expenseBuckets.includes('payroll') && !filterCommittedPay(payroll).some((p) => inPeriod(p.pay_period_start))) missing.push('payroll (approved/paid runs or payroll expenses)');
  // A single record (even a valid zero-cost entry) cannot prove all bills were entered.
  return { state: missing.length ? 'incomplete' : 'unverified', missing };
}

export function forecastRevenueCents(forecast, days) {
  if (!Number.isInteger(days) || days < 1 || forecast.length < days) return null;
  return forecast.slice(0, days).reduce((sum, day) => sum + day.projectedRevenueCents, 0);
}
