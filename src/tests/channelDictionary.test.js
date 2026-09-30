import { describe, it, expect } from 'vitest';
import {
  normalizeChannel,
  calculateOtaDependence,
  calculateDirectShiftOpportunity,
  CHANNEL_GROUPS,
} from '@/lib/channelDictionary';
import { CalculationService } from '@/lib/calculationService';

describe('Owner Channel Dictionary & Normalization', () => {
  it('normalizes HotelKey Expedia variations correctly', () => {
    const r1 = normalizeChannel('EXPEDIA');
    expect(r1.normalizedName).toBe('Expedia');
    expect(r1.group).toBe(CHANNEL_GROUPS.OTA);
    expect(r1.isOta).toBe(true);
    expect(r1.isDirect).toBe(false);

    const r2 = normalizeChannel('EXPEDIA HOTEL COLLECT', 'EHC');
    expect(r2.normalizedName).toBe('Expedia');
    expect(r2.group).toBe(CHANNEL_GROUPS.OTA);

    const r3 = normalizeChannel('', 'EHC');
    expect(r3.normalizedName).toBe('Expedia');
  });

  it('normalizes Booking.com variations correctly', () => {
    const r1 = normalizeChannel('BOOKING.COM');
    expect(r1.normalizedName).toBe('Booking.com');
    expect(r1.group).toBe(CHANNEL_GROUPS.OTA);

    const r2 = normalizeChannel('BOOKING', 'BHC');
    expect(r2.normalizedName).toBe('Booking.com');
    expect(r2.isOta).toBe(true);
  });

  it('normalizes Direct channels (Website, Walk-In, Phone) correctly', () => {
    const web = normalizeChannel('RR WEBSITE', 'WEB');
    expect(web.normalizedName).toBe('Brand Website');
    expect(web.group).toBe(CHANNEL_GROUPS.DIRECT);
    expect(web.isDirect).toBe(true);
    expect(web.isOta).toBe(false);

    const walk = normalizeChannel('WALK-IN', 'WIN');
    expect(walk.normalizedName).toBe('Walk-In');
    expect(walk.group).toBe(CHANNEL_GROUPS.DIRECT);
    expect(walk.isDirect).toBe(true);

    const prop = normalizeChannel('PROPERTY BOOKING', 'PRP');
    expect(prop.normalizedName).toBe('Property Direct');
    expect(prop.group).toBe(CHANNEL_GROUPS.DIRECT);

    const redistay = normalizeChannel('REDISTAY', 'RRI');
    expect(redistay.normalizedName).toBe('Brand Website');
    expect(redistay.group).toBe(CHANNEL_GROUPS.DIRECT);

    const cro = normalizeChannel('CENTRAL RESERVATIONS', 'CRO');
    expect(cro.normalizedName).toBe('Property Direct');
    expect(cro.group).toBe(CHANNEL_GROUPS.DIRECT);

    const corp = normalizeChannel('DIRECT BILL', 'DB');
    expect(corp.normalizedName).toBe('Group & Corporate');
    expect(corp.group).toBe(CHANNEL_GROUPS.CORPORATE);

    const clp = normalizeChannel('CORPORATE LODGING', 'CLP');
    expect(clp.normalizedName).toBe('Group & Corporate');
    expect(clp.group).toBe(CHANNEL_GROUPS.CORPORATE);

    const bdc = normalizeChannel('BOOKING', 'BDC');
    expect(bdc.normalizedName).toBe('Booking.com');
    expect(bdc.group).toBe(CHANNEL_GROUPS.OTA);

    const epc = normalizeChannel('EXPEDIA PARTNER CENTRAL', 'EPC');
    expect(epc.normalizedName).toBe('Expedia');
    expect(epc.group).toBe(CHANNEL_GROUPS.OTA);
  });

  it('calculates OTA Dependence scores and thresholds accurately', () => {
    const low = calculateOtaDependence(2000, 10000); // 20%
    expect(low.level).toBe('Low');
    expect(low.percentage).toBe(20);

    const mod = calculateOtaDependence(3500, 10000); // 35%
    expect(mod.level).toBe('Moderate');

    const high = calculateOtaDependence(4800, 10000); // 48%
    expect(high.level).toBe('High');

    const veryHigh = calculateOtaDependence(6200, 10000); // 62%
    expect(veryHigh.level).toBe('Very High');
  });

  it('calculates Direct Shift Opportunity correctly', () => {
    const mockChannels = [
      { isOta: true, gross: 100000, commission: 15000, stays: 1000 },
      { isOta: true, gross: 50000, commission: 9000, stays: 500 },
      { isOta: false, gross: 120000, commission: 0, stays: 1200 },
    ];

    const result = calculateDirectShiftOpportunity(mockChannels, 0.10); // 10% shift
    // Total OTA commission: 15,000 + 9,000 = 24,000
    // 10% shift savings: 2,400
    expect(result.potentialSavings).toBe(2400);
    expect(result.roomsShifted).toBe(150); // 10% of 1500 OTA rooms
  });
});

describe('CalculationService Channel Net Contribution Contract', () => {
  it('reconciles bit-exact gross, commission, payment fee, and net contribution', () => {
    const mockRows = [
      { source: 'EXPEDIA', code: 'EHC', net_revenue: 1000, stays: 10, refunds: 50 },
      { source: 'WALK-IN', code: 'WIN', net_revenue: 1000, stays: 10, refunds: 0 },
    ];

    // CC fee rate 2.5% (0.025)
    const metrics = CalculationService.calculateChannelMetrics(mockRows, '*', {
      ccFeeRate: 0.025,
      applyPaymentFee: true,
    });

    expect(metrics).toHaveLength(2);

    const expedia = metrics.find((m) => m.source === 'EXPEDIA');
    expect(expedia).toBeDefined();
    expect(expedia.normalized).toBe('Expedia');
    expect(expedia.group).toBe(CHANNEL_GROUPS.OTA);
    expect(expedia.gross).toBe(1000);
    expect(expedia.commission).toBe(150); // 15% of 1000
    expect(expedia.paymentFee).toBe(25); // 2.5% of 1000
    expect(expedia.refunds).toBe(50);

    // Exact Owner Net Contribution: $1000 - $150 - $25 - $50 = $775
    expect(expedia.netContribution).toBe(775);
    expect(expedia.netPerRoom).toBe(77.5); // $775 / 10 stays

    // Backward compatibility contract: gross - commission === net
    expect(expedia.net).toBe(850); // $1000 - $150 = $850
    expect(expedia.gross - expedia.commission).toBe(expedia.net);

    const walkin = metrics.find((m) => m.source === 'WALK-IN');
    expect(walkin).toBeDefined();
    expect(walkin.normalized).toBe('Walk-In');
    expect(walkin.group).toBe(CHANNEL_GROUPS.DIRECT);
    expect(walkin.gross).toBe(1000);
    expect(walkin.commission).toBe(0);
    expect(walkin.net).toBe(1000);
  });
});
