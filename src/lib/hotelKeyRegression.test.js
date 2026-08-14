import { describe, it, expect } from 'vitest';
import { reconcileDailyFinancials } from './financialReconciliation';
import { calculateDynamicRateRecommendation } from './yieldOptimizer';
import { evaluateClerkShiftRisk } from './fraudScoringEngine';

describe('HotelKey PMS Financial Reconciliation & Math Regression Suite', () => {
  describe('3-Way Revenue Reconciliation Matrix', () => {
    const pmsData = [
      { date: '2026-07-01', card_revenue: 4250.00, cash_revenue: 350.00, direct_bill: 400.00 },
      { date: '2026-07-02', card_revenue: 3890.50, cash_revenue: 210.00, direct_bill: 0.00 },
      { date: '2026-07-03', card_revenue: 5120.00, cash_revenue: 480.00, direct_bill: 250.00 },
    ];

    const merchantBatches = [
      { date: '2026-07-01', settled_amount: 4335.00, fee_deductions: 85.00 },
      { date: '2026-07-02', settled_amount: 3968.31, fee_deductions: 77.81 },
      { date: '2026-07-03', settled_amount: 5222.40, fee_deductions: 102.40 },
    ];

    const bankDeposits = [
      { date: '2026-07-01', deposit_amount: 4600.00 },
      { date: '2026-07-02', deposit_amount: 4100.50 },
      { date: '2026-07-03', deposit_amount: 5600.00 },
    ];

    const result = reconcileDailyFinancials({
      pmsRecords: pmsData,
      merchantBatches,
      bankDeposits,
    });

    it('matches exact card revenue against net merchant settlement', () => {
      expect(result.periodSummary.totalPmsRevenue).toBe(14300.50);
      expect(result.periodSummary.totalMerchantSettled).toBe(13260.50);
      expect(result.periodSummary.totalCashRevenue).toBe(1040.00);
      expect(result.periodSummary.netVariance).toBe(0);
      expect(result.periodSummary.reconciliationHealth).toBe('HEALTHY');
    });

    it('validates daily status indicators', () => {
      expect(result.days).toHaveLength(3);
      expect(result.days[0].status).toBe('MATCHED');
      expect(result.days[1].status).toBe('MATCHED');
      expect(result.days[2].status).toBe('MATCHED');
    });

    it('calculates zero card variance for all matched days', () => {
      expect(result.days[0].cardVariance).toBe(0);
      expect(result.days[1].cardVariance).toBe(0);
      expect(result.days[2].cardVariance).toBe(0);
    });

    it('calculates zero deposit variance for all matched days', () => {
      expect(result.days[0].depositVariance).toBe(0);
      expect(result.days[1].depositVariance).toBe(0);
      expect(result.days[2].depositVariance).toBe(0);
    });

    it('correctly computes merchant net settlement per day', () => {
      expect(result.days[0].merchantNetSettled).toBe(4250.00);
      expect(result.days[1].merchantNetSettled).toBe(3890.50);
      expect(result.days[2].merchantNetSettled).toBe(5120.00);
    });

    it('detects cash shortage variances accurately', () => {
      const shortBatch = [{ date: '2026-07-01', settled_amount: 4100.00, fee_deductions: 0 }];
      const varianceResult = reconcileDailyFinancials({
        pmsRecords: pmsData.slice(0, 1),
        merchantBatches: shortBatch,
        bankDeposits: [],
      });
      expect(varianceResult.days[0].status).toBe('SHORTAGE');
      expect(varianceResult.days[0].cardVariance).toBe(150.00);
      expect(varianceResult.periodSummary.reconciliationHealth).toBe('VARIANCE_DETECTED');
    });

    it('detects cash excess when merchant settles more than PMS recorded', () => {
      const excessBatch = [{ date: '2026-07-01', settled_amount: 4400.00, fee_deductions: 0 }];
      const excessResult = reconcileDailyFinancials({
        pmsRecords: pmsData.slice(0, 1),
        merchantBatches: excessBatch,
        bankDeposits: [],
      });
      expect(excessResult.days[0].status).toBe('EXCESS');
      expect(excessResult.days[0].cardVariance).toBe(-150.00);
    });

    it('handles empty inputs gracefully', () => {
      const empty = reconcileDailyFinancials({ pmsRecords: [], merchantBatches: [], bankDeposits: [] });
      expect(empty.days).toHaveLength(0);
      expect(empty.periodSummary.totalPmsRevenue).toBe(0);
      expect(empty.periodSummary.totalMerchantSettled).toBe(0);
      expect(empty.periodSummary.netVariance).toBe(0);
      expect(empty.periodSummary.reconciliationHealth).toBe('HEALTHY');
    });

    it('uses fixed-decimal arithmetic (no floating-point drift)', () => {
      // Classic float trap: 0.1 + 0.2 = 0.30000000000000004 in IEEE-754.
      // Our fixed-decimal engine must produce exact 0.30.
      const driftTest = reconcileDailyFinancials({
        pmsRecords: [{ date: '2026-07-01', card_revenue: 0.10, cash_revenue: 0.20, direct_bill: 0 }],
        merchantBatches: [{ date: '2026-07-01', settled_amount: 0.10, fee_deductions: 0 }],
        bankDeposits: [{ date: '2026-07-01', deposit_amount: 0.30 }],
      });
      expect(driftTest.days[0].cardVariance).toBe(0);
      expect(driftTest.days[0].depositVariance).toBe(0);
      expect(driftTest.periodSummary.netVariance).toBe(0);
    });
  });

  describe('Dynamic Pricing Math & Floor/Ceiling Boundaries', () => {
    it('applies capacity surge multiplier when occupancy exceeds 90%', () => {
      const quote = calculateDynamicRateRecommendation({
        currentBaseRate: 100,
        currentOccupancy: 95,
        historicalAvgOccupancy: 70,
        daysToArrival: 1,
      });
      expect(quote.recommendedRate).toBeGreaterThanOrEqual(125);
      expect(quote.recommendedRate).toBeLessThanOrEqual(135);
      expect(quote.confidence).toBe(0.92);
    });

    it('enforces safety rate ceilings and floors', () => {
      const extremeHigh = calculateDynamicRateRecommendation({
        currentBaseRate: 200,
        currentOccupancy: 98,
        historicalAvgOccupancy: 50,
        daysToArrival: 0,
      });
      expect(extremeHigh.recommendedRate).toBeLessThanOrEqual(270);

      const extremeLow = calculateDynamicRateRecommendation({
        currentBaseRate: 100,
        currentOccupancy: 20,
        historicalAvgOccupancy: 80,
        daysToArrival: 1,
      });
      expect(extremeLow.recommendedRate).toBeGreaterThanOrEqual(85);
    });

    it('handles zero or negative base rate inputs defensively', () => {
      const invalid = calculateDynamicRateRecommendation({ currentBaseRate: 0, currentOccupancy: 50, historicalAvgOccupancy: 70, daysToArrival: 1 });
      expect(invalid.recommendedRate).toBe(0);
      expect(invalid.confidence).toBe(0);
    });

    it('applies moderate demand uplift within safety bounds', () => {
      const quote = calculateDynamicRateRecommendation({
        currentBaseRate: 150,
        currentOccupancy: 75,
        historicalAvgOccupancy: 65,
        daysToArrival: 5,
      });
      expect(quote.confidence).toBe(0.78);
      expect(quote.delta).toBeGreaterThan(0);
      expect(quote.delta).toBeLessThan(150);
    });
  });

  describe('Statistical Z-Score & Outlier Scoring', () => {
    const historicalCohort = [
      { cash_adjustments: 5, rate_override_count: 1 },
      { cash_adjustments: 10, rate_override_count: 0 },
      { cash_adjustments: 0, rate_override_count: 2 },
      { cash_adjustments: 8, rate_override_count: 1 },
      { cash_adjustments: 4, rate_override_count: 1 },
    ];

    it('flags extreme cash adjustments as CRITICAL severity', () => {
      const highRiskShift = {
        clerk_name: 'Test Clerk',
        shift_date: '2026-07-04',
        cash_adjustments: 150.00,
        rate_override_count: 8,
        shift_timestamp: '2026-07-04T03:00:00.000Z',
      };
      const evaluation = evaluateClerkShiftRisk(highRiskShift, historicalCohort);
      expect(evaluation.riskScore).toBeGreaterThanOrEqual(70);
      expect(evaluation.severity).toBe('CRITICAL');
      expect(evaluation.requiresManagerReview).toBe(true);
      expect(evaluation.flags.length).toBeGreaterThanOrEqual(2);
    });

    it('clears normal peer-level shift transactions', () => {
      const normalShift = {
        clerk_name: 'Regular Clerk',
        shift_date: '2026-07-04',
        cash_adjustments: 5.00,
        rate_override_count: 1,
        shift_timestamp: '2026-07-04T14:00:00.000Z',
      };
      const evaluation = evaluateClerkShiftRisk(normalShift, historicalCohort);
      expect(evaluation.riskScore).toBeLessThan(40);
      expect(evaluation.severity).toBe('LOW');
      expect(evaluation.requiresManagerReview).toBe(false);
    });
  });
});
