import { describe, it, expect } from 'vitest';
import { decomposeRevenueVariance } from '@/lib/varianceDecomposition';

describe('Hotel Revenue Variance Decomposition Engine', () => {
  it('mathematically reconciles Volume Effect + Rate Effect === Total Variance', () => {
    // Prior Year: 1,000 rooms @ $100 ADR = $100,000
    // Current Year: 900 rooms @ $90 ADR = $81,000
    const prior = {
      propertyId: 'HART',
      propertyName: 'Hartford',
      roomsSold: 1000,
      roomRevenue: 100000,
      otherRevenue: 5000,
      otaCommission: 15000,
    };

    const current = {
      propertyId: 'HART',
      propertyName: 'Hartford',
      roomsSold: 900,
      roomRevenue: 81000,
      otherRevenue: 6200,
      otaCommission: 18600,
    };

    const result = decomposeRevenueVariance(current, prior);

    // Total Variance: $81,000 - $100,000 = -$19,000
    expect(result.totalVariance).toBe(-19000);
    expect(result.pctChange).toBeCloseTo(-0.19, 2);

    // Volume Effect: (900 - 1000) * $100 = -$10,000
    expect(result.volumeEffect).toBe(-10000);

    // Rate Effect: ($90 - $100) * 900 = -$9,000
    expect(result.rateEffect).toBe(-9000);

    // Exact Mathematical Proof: Volume (-$10,000) + Rate (-$9,000) === -$19,000
    expect(result.volumeEffect + result.rateEffect).toBe(result.totalVariance);
    expect(result.isReconciled).toBe(true);

    // Commission Drag: -(18,600 - 15,000) = -$3,600
    expect(result.commissionDrag).toBe(-3600);

    // Other Revenue: $6,200 - $5,000 = +$1,200
    expect(result.otherRevenueEffect).toBe(1200);

    // Check drivers ordering: Volume ($10k) > Rate ($9k) > Commission ($3.6k) > Other ($1.2k)
    expect(result.drivers[0].key).toBe('volume');
    expect(result.drivers[1].key).toBe('rate');
    expect(result.drivers[2].key).toBe('commission');
    expect(result.drivers[3].key).toBe('other');
  });

  it('handles positive growth variance with Rate-led expansion', () => {
    const prior = {
      propertyId: 'BOS',
      propertyName: 'Boston',
      roomsSold: 1000,
      roomRevenue: 100000, // ADR $100
    };

    const current = {
      propertyId: 'BOS',
      propertyName: 'Boston',
      roomsSold: 1050,
      roomRevenue: 126000, // ADR $120
    };

    const result = decomposeRevenueVariance(current, prior);

    // Total Variance: $126,000 - $100,000 = +$26,000
    expect(result.totalVariance).toBe(26000);

    // Volume Effect: (1050 - 1000) * $100 = +$5,000
    expect(result.volumeEffect).toBe(5000);

    // Rate Effect: ($120 - $100) * 1050 = +$21,000
    expect(result.rateEffect).toBe(21000);

    // Volume ($5k) + Rate ($21k) === Total ($26k)
    expect(result.volumeEffect + result.rateEffect).toBe(result.totalVariance);
    expect(result.isReconciled).toBe(true);

    // Primary driver should be Rate Effect ($21,000)
    expect(result.drivers[0].key).toBe('rate');
    expect(result.summary).toContain('led primarily by rate / adr pricing effect');
  });
});
