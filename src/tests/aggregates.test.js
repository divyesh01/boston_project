import { describe, it, expect } from 'vitest';
import { buildSyntheticRows } from '../lib/dailyAggregates.js';

describe('Server-Authoritative Daily Financial Aggregates', () => {
  it('correctly maps server PropertyDaySummary rows into synthetic UI rows', () => {
    const serverSummaries = [
      {
        id: 'acc_123:HOTEL_A:2026-08-01',
        property_id: 'HOTEL_A',
        business_date: '2026-08-01',
        room_revenue_cents: 1200000, // $12,000.00
        ancillary_revenue_cents: 80000, // $800.00
        total_revenue_cents: 1280000, // $12,800.00
        rooms_sold: 80,
        available_rooms: 100,
        adr_cents: 15000, // $150.00
        occupancy_rate: 0.8,
        revpar_cents: 12000, // $120.00
        gross_ota_revenue_cents: 450000,
        direct_revenue_cents: 750000,
        ota_commission_cents: 67500,
        payment_total_cents: 1280000,
        channel_summary_json: JSON.stringify({
          'Booking.com': 250000,
          'Expedia': 200000,
          'Direct': 750000,
        }),
      },
      {
        id: 'acc_123:HOTEL_A:2026-08-02',
        property_id: 'HOTEL_A',
        business_date: '2026-08-02',
        room_revenue_cents: 1500000, // $15,000.00
        ancillary_revenue_cents: 100000, // $1,000.00
        total_revenue_cents: 1600000, // $16,000.00
        rooms_sold: 100,
        available_rooms: 100,
        adr_cents: 15000,
        occupancy_rate: 1.0,
        revpar_cents: 15000,
        gross_ota_revenue_cents: 600000,
        direct_revenue_cents: 900000,
        ota_commission_cents: 90000,
        payment_total_cents: 1600000,
        channel_summary_json: JSON.stringify({
          'Booking.com': 350000,
          'Expedia': 250000,
          'Direct': 900000,
        }),
      },
    ];

    const { occRows, srcRows, grossRows, payRows } = buildSyntheticRows(serverSummaries);

    // Verify Occupancy Rows
    expect(occRows).toHaveLength(2);
    expect(occRows[0].room_revenue).toBe(12000);
    expect(occRows[0].rooms_sold).toBe(80);
    expect(occRows[0].total_rooms).toBe(100);
    expect(occRows[0].occupancy).toBe(0.8);
    expect(occRows[0].adr).toBe(150);
    expect(occRows[0].revpar).toBe(120);

    expect(occRows[1].room_revenue).toBe(15000);
    expect(occRows[1].occupancy).toBe(1.0);

    // Verify Source / Channel Rows
    expect(srcRows.length).toBeGreaterThanOrEqual(6);
    const bookingRow = srcRows.find((r) => r.source === 'Booking.com' && r.date === '2026-08-01');
    expect(bookingRow).toBeDefined();
    expect(bookingRow?.net_revenue).toBe(2500);

    // Verify Gross Revenue Rows
    expect(grossRows).toHaveLength(2);
    expect(grossRows[0].room_rent).toBe(12000);
    expect(grossRows[0].misc_charge).toBe(800);

    // Verify Payment Rows
    expect(payRows).toHaveLength(2);
    expect(payRows[0].total).toBe(12800);
    expect(payRows[1].total).toBe(16000);
  });

  it('preserves the financial invariant: room_rent + misc = total in synthetic rows', () => {
    const summary = [
      {
        property_id: 'HOTEL_B',
        business_date: '2026-08-10',
        room_revenue_cents: 800000,
        ancillary_revenue_cents: 150000,
        total_revenue_cents: 950000,
        rooms_sold: 50,
        available_rooms: 80,
      },
    ];

    const { occRows, grossRows } = buildSyntheticRows(summary);
    expect(occRows[0].room_revenue).toBe(8000);
    expect(grossRows[0].room_rent).toBe(8000);
    expect(grossRows[0].misc_charge).toBe(1500);
    expect(grossRows[0].room_rent + grossRows[0].misc_charge).toBe(9500);
  });
});
