import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import OTAShiftSimulator, { calculateOtaShiftEconomics } from '@/components/dashboard/OTAShiftSimulator';

describe('OTA to Direct Shift Simulator Economics', () => {
  it('returns zero savings when shift percentage is 0%', () => {
    const res = calculateOtaShiftEconomics({
      grossOtaRevenue: 150000,
      shiftPct: 0,
      otaCommissionRate: 0.16,
      directCostRate: 0.035,
      periodDays: 214,
    });

    expect(res.shiftedRevenue).toBe(0);
    expect(res.commissionSaved).toBe(0);
    expect(res.directCost).toBe(0);
    expect(res.netSavings).toBe(0);
    expect(res.annualizedGain).toBe(0);
    expect(res.effectiveMarginGainPct).toBe(0);
  });

  it('accurately calculates economics for standard 15% shift', () => {
    const res = calculateOtaShiftEconomics({
      grossOtaRevenue: 100000,
      shiftPct: 15,
      otaCommissionRate: 0.16,
      directCostRate: 0.035,
      periodDays: 214,
    });

    // 15% of $100,000 = $15,000
    expect(res.shiftedRevenue).toBe(15000);
    // 16% commission saved on $15,000 = $2,400
    expect(res.commissionSaved).toBe(2400);
    // 3.5% direct cost on $15,000 = $525
    expect(res.directCost).toBe(525);
    // Net cash retained = $2,400 - $525 = $1,875
    expect(res.netSavings).toBe(1875);
    // Annualized gain = ($1,875 / 214) * 365 = $3,198.01 (cent-exact integer math)
    expect(res.annualizedGain).toBe(3198.01);
    // Effective margin gain % = (1,875 / 15,000) * 100 = 12.5%
    expect(res.effectiveMarginGainPct).toBe(12.5);
  });

  it('calculates full year 50% shift with custom rates', () => {
    const res = calculateOtaShiftEconomics({
      grossOtaRevenue: 200000,
      shiftPct: 50,
      otaCommissionRate: 0.18,
      directCostRate: 0.03,
      periodDays: 365,
    });

    // 50% of $200,000 = $100,000
    expect(res.shiftedRevenue).toBe(100000);
    // 18% of $100,000 = $18,000
    expect(res.commissionSaved).toBe(18000);
    // 3% of $100,000 = $3,000
    expect(res.directCost).toBe(3000);
    // Net cash retained = $15,000
    expect(res.netSavings).toBe(15000);
    // Over 365 days, annualized = $15,000
    expect(res.annualizedGain).toBe(15000);
    expect(res.effectiveMarginGainPct).toBe(15.0);
  });

  it('guarantees cent-exact integer math without floating point drift', () => {
    const res = calculateOtaShiftEconomics({
      grossOtaRevenue: 136988.58,
      shiftPct: 15,
      otaCommissionRate: 0.165,
      directCostRate: 0.032,
      periodDays: 180,
    });

    // Verify all returned dollar figures are exact two decimal numbers
    [res.shiftedRevenue, res.commissionSaved, res.directCost, res.netSavings, res.annualizedGain].forEach((val) => {
      const decimals = (val.toString().split('.')[1] || '').length;
      expect(decimals).toBeLessThanOrEqual(2);
    });

    // Assert net savings equals commissionSaved minus directCost (within 1 cent rounding)
    expect(Math.abs(res.netSavings - (res.commissionSaved - res.directCost))).toBeLessThanOrEqual(0.01);
  });

  it('handles edge cases gracefully', () => {
    // Zero revenue
    const zeroRes = calculateOtaShiftEconomics({ grossOtaRevenue: 0, shiftPct: 20 });
    expect(zeroRes.netSavings).toBe(0);
    expect(zeroRes.effectiveMarginGainPct).toBe(0);

    // Negative shift (clamped or zero ratio)
    const negRes = calculateOtaShiftEconomics({ grossOtaRevenue: 50000, shiftPct: -5 });
    expect(negRes.netSavings).toBe(0);

    // Period days = 0 (defaults to at least 1 day to avoid divide-by-zero)
    const divZeroRes = calculateOtaShiftEconomics({
      grossOtaRevenue: 10000,
      shiftPct: 10,
      periodDays: 0,
    });
    expect(Number.isFinite(divZeroRes.annualizedGain)).toBe(true);
  });

  it('renders Channel data unavailable and disables savings claim when grossOtaRevenue is missing or 0', () => {
    const { rerender } = render(<OTAShiftSimulator grossOtaRevenue={0} />);
    expect(screen.getByText("Channel data unavailable")).toBeInTheDocument();
    expect(screen.queryByText(/Projected 12-month EBITDA lift/i)).not.toBeInTheDocument();

    // Also when called with no props (should not fall back to $136,988.58)
    rerender(<OTAShiftSimulator />);
    expect(screen.getByText("Channel data unavailable")).toBeInTheDocument();
  });
});
