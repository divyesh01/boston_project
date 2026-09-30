import { describe, it, expect } from 'vitest';
import {
  findMissingDates,
  evaluatePropertyDataHealth,
  evaluatePortfolioDataHealth,
  reconcileFinancialTotals,
} from '@/lib/dataHealth';
import {
  createHotelDataAdapter,
  HotelKeyCsvAdapter,
  GoogleDriveAdapter,
  HotelKeyDatastreamAdapter,
} from '@/lib/hotelDataAdapter';

describe('Data Health & Completeness Engine', () => {
  it('detects missing calendar dates accurately', () => {
    // 5-day range: 2026-09-01 to 2026-09-05. Days 02 and 04 are missing.
    const existingDates = ['2026-09-01', '2026-09-03', '2026-09-05'];
    const missing = findMissingDates(existingDates, '2026-09-01', '2026-09-05');

    expect(missing).toEqual(['2026-09-02', '2026-09-04']);
  });

  it('evaluates property data health and assigns appropriate status tiers', () => {
    // 3-day range: 2026-09-01 to 2026-09-03
    const dateRange = { from: '2026-09-01', to: '2026-09-03' };

    // Property with complete data
    const completeHealth = evaluatePropertyDataHealth({
      propertyId: 'BOS',
      propertyName: 'Boston',
      occRows: [{ date: '2026-09-01' }, { date: '2026-09-02' }, { date: '2026-09-03' }],
      srcRows: [{ date: '2026-09-01' }, { date: '2026-09-02' }, { date: '2026-09-03' }],
      grossRows: [{ date: '2026-09-01' }, { date: '2026-09-02' }, { date: '2026-09-03' }],
      payRows: [{ date: '2026-09-01' }, { date: '2026-09-02' }, { date: '2026-09-03' }],
      dateRange,
    });

    expect(completeHealth.overallScore).toBe(100);
    expect(completeHealth.status).toBe('healthy');
    expect(completeHealth.statusLabel).toBe('All Reports Current');

    // Property with missing source days
    const partialHealth = evaluatePropertyDataHealth({
      propertyId: 'HART',
      propertyName: 'Hartford',
      occRows: [{ date: '2026-09-01' }, { date: '2026-09-02' }, { date: '2026-09-03' }],
      srcRows: [{ date: '2026-09-01' }], // Missing 2 days of source
      grossRows: [{ date: '2026-09-01' }, { date: '2026-09-02' }, { date: '2026-09-03' }],
      payRows: [{ date: '2026-09-01' }, { date: '2026-09-02' }, { date: '2026-09-03' }],
      dateRange,
    });

    expect(partialHealth.overallScore).toBeLessThan(100);
    expect(partialHealth.missingDates.source).toEqual(['2026-09-02', '2026-09-03']);
    expect(partialHealth.status).toBe('warning');
  });

  it('reconciles reported vs calculated revenue with cent-exact balance check', () => {
    const balanced = reconcileFinancialTotals(124813.91, 124813.91);
    expect(balanced.isBalanced).toBe(true);
    expect(balanced.difference).toBe(0);
    expect(balanced.status).toBe('reconciled');

    const discrepancy = reconcileFinancialTotals(124813.91, 124800.00);
    expect(discrepancy.isBalanced).toBe(false);
    expect(discrepancy.difference).toBe(13.91);
    expect(discrepancy.status).toBe('discrepancy');

    // R01: A 1-cent real discrepancy must fail exact reconciliation
    const oneCentDiscrepancy = reconcileFinancialTotals(100.00, 100.01);
    expect(oneCentDiscrepancy.isBalanced).toBe(false);
    expect(oneCentDiscrepancy.difference).toBe(0.01);
    expect(oneCentDiscrepancy.status).toBe('discrepancy');

    // R01: Empty/zero ledgers without explicit data must NEVER produce verified success
    const emptyResult = reconcileFinancialTotals(0, 0);
    expect(emptyResult.isBalanced).toBe(false);
    expect(emptyResult.status).toBe('no_data');
    expect(emptyResult.difference).toBe(0);

    // R01: Missing channel ledger must be marked incomplete, not verified
    const missingChannel = reconcileFinancialTotals(500.00, 0, {
      hasData: true,
      reportedCount: 5,
      calculatedCount: 0,
      channelLedgerPresent: false,
    });
    expect(missingChannel.isBalanced).toBe(false);
    expect(missingChannel.status).toBe('incomplete');

    // R01: Failed ledger fetch must return failed status
    const failedResult = reconcileFinancialTotals(0, 0, { isFailed: true });
    expect(failedResult.isBalanced).toBe(false);
    expect(failedResult.status).toBe('failed');

    // R01: Payment settlement mismatch is explicitly tracked
    const paymentMismatch = reconcileFinancialTotals(1000.00, 1000.00, {
      paymentsTotal: 950.00,
      hasData: true,
    });
    expect(paymentMismatch.isBalanced).toBe(true);
    expect(paymentMismatch.status).toBe('reconciled');
    expect(paymentMismatch.paymentsMatch).toBe(false);
    expect(paymentMismatch.paymentsStatus).toBe('variance');
    expect(paymentMismatch.paymentsDifference).toBe(50.00);
  });

  it('correctly evaluates empty property data and empty portfolio without defaulting to 100', () => {
    const emptyPropHealth = evaluatePropertyDataHealth({
      propertyId: 'EMPTY',
      propertyName: 'Empty Property',
      occRows: [],
      srcRows: [],
      grossRows: [],
      payRows: [],
      dateRange: { from: '', to: '' },
    });

    expect(emptyPropHealth.overallScore).toBe(0);
    expect(emptyPropHealth.status).toBe('critical');
    expect(emptyPropHealth.statusLabel).toBe('No Data Ingested');

    const emptyPortfolioHealth = evaluatePortfolioDataHealth([], {});
    expect(emptyPortfolioHealth.portfolioScore).toBe(0);
    expect(emptyPortfolioHealth.properties).toHaveLength(0);
  });
});


describe('Universal Hotel Data Adapter Interface', () => {
  it('creates appropriate adapter types via factory', () => {
    const csvAdapter = createHotelDataAdapter('csv');
    expect(csvAdapter).toBeInstanceOf(HotelKeyCsvAdapter);
    expect(csvAdapter.sourceType).toBe('csv');

    const driveAdapter = createHotelDataAdapter('google_drive');
    expect(driveAdapter).toBeInstanceOf(GoogleDriveAdapter);
    expect(driveAdapter.sourceType).toBe('google_drive');

    const streamAdapter = createHotelDataAdapter('hk_datastream');
    expect(streamAdapter).toBeInstanceOf(HotelKeyDatastreamAdapter);
    expect(streamAdapter.sourceType).toBe('hk_datastream');
  });

  it('detects report types from header signatures', () => {
    const adapter = new HotelKeyCsvAdapter();

    const occResult = adapter.detectReportType(['Date', 'Total Rooms', 'Rooms Sold', 'Comp Rooms']);
    expect(occResult.reportType).toBe('occupancy');

    const revResult = adapter.detectReportType(['Date', 'Room Rent', 'Food', 'Misc Charge']);
    expect(revResult.reportType).toBe('revenue');

    const srcResult = adapter.detectReportType(['Date', 'Source', 'Net Revenue', 'Stays']);
    expect(srcResult.reportType).toBe('source');

    const payResult = adapter.detectReportType(['Date', 'Cash', 'Visa', 'Master', 'Check']);
    expect(payResult.reportType).toBe('payment');
  });
});
