import { describe, expect, it } from 'vitest';
import { reportFreshness, costCoverage, forecastRevenueCents } from '@/lib/ownerTrust';

describe('report freshness uses calendar days, not elapsed hours', () => {
  it('reports a 26-day-old occupancy report', () => {
    expect(reportFreshness('2026-08-02', '2026-08-28')).toMatchObject({ state: 'stale', ageDays: 26 });
  });
  it.each([
    ['2026-08-28', '2026-08-28', 'current', 0],
    ['2026-08-27', '2026-08-28', 'recent', 1],
    ['2026-03-07', '2026-03-09', 'stale', 2],
    ['2024-02-28', '2024-03-01', 'stale', 2],
    ['2025-12-31', '2026-01-01', 'recent', 1],
    ['2026-08-29', '2026-08-28', 'future', -1],
  ])('%s through %s', (date, today, state, ageDays) => {
    expect(reportFreshness(date, today)).toMatchObject({ state, ageDays });
  });
  it.each(['oops', '2026-02-30', '2026-13-01'])('rejects invalid date %s', (date) => {
    expect(reportFreshness(date, '2026-08-28').state).toBe('invalid');
  });
  it('distinguishes no records from invalid data', () => {
    expect(reportFreshness('', '2026-08-28').state).toBe('empty');
  });
});

describe('cost coverage is evidence of records, not complete accounts', () => {
  const range = { from: '2026-08-01', to: '2026-08-31' };
  it('identifies both missing cost categories', () => {
    expect(costCoverage([], [], range)).toMatchObject({ missing: ['operating expenses', 'payroll (approved/paid runs or payroll expenses)'], state: 'incomplete' });
  });
  it('ignores costs outside the period and draft payroll', () => {
    expect(costCoverage([{ expense_date: '2026-07-31' }], [{ pay_period_start: '2026-08-01', payroll_status: 'draft' }], range).missing).toHaveLength(2);
  });
  it('does not claim completeness even when both have records (including zero-cost rows)', () => {
    expect(costCoverage([{ expense_date: '2026-08-01', amount: 0 }], [{ pay_period_start: '2026-08-01', payroll_status: 'approved', total_pay: 0 }], range)).toMatchObject({ missing: [], state: 'unverified' });
  });
  it('does not interpret an unset date range as missing costs', () => {
    expect(costCoverage([], [], { from: '', to: '' }).state).toBe('unknown');
  });
  it('counts payroll expenses as payroll, not operating expense evidence', () => {
    expect(costCoverage([{ expense_date: '2026-08-01', category: ' Payroll ' }], [], range).missing).toEqual(['operating expenses']);
    expect(costCoverage([
      { expense_date: '2026-08-01', category: 'payroll' },
      { expense_date: '2026-08-02', category: 'utilities' },
    ], [], range)).toMatchObject({ state: 'unverified', missing: [] });
  });
  it('does not mistake fee and tax entries for general operating expense coverage', () => {
    expect(costCoverage([{ expense_date: '2026-08-01', category: 'ota_commission' }], [], range).missing).toContain('operating expenses');
  });
});

describe('forecast horizon', () => {
  const days = Array.from({ length: 14 }, () => ({ projectedRevenueCents: 101 }));
  it('sums exact cents only for the requested available horizon', () => {
    expect(forecastRevenueCents(days, 7)).toBe(707);
    expect(forecastRevenueCents(days, 14)).toBe(1414);
    expect(forecastRevenueCents(days, 30)).toBeNull();
    expect(forecastRevenueCents(days, 90)).toBeNull();
  });
});
