import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { buildOwnerPerformancePacketWorkbook } from '@/lib/ownerPacketExport';
import { CalculationService } from '@/lib/calculationService';

describe('Monthly Owner Performance Packet Exporter', () => {
  it('generates a 4-sheet executive workbook with comprehensive intelligence and verified cell values', () => {
    const properties = [
      { id: 'BOS', name: 'Boston Inn' },
      { id: 'HART', name: 'Hartford Hotel' },
    ];

    const kpis = {
      revenue: 125000,
      roomsSold: 950,
      occupancy: 0.76,
      adr: 131.58,
      revpar: 100.0,
      netKept: 110000,
      commissionTotal: 15000,
      commissionRate: 0.12,
      directShare: 0.42,
    };

    const propertyStats = [
      {
        property_id: 'BOS',
        property_name: 'Boston Inn',
        revenue: 75000,
        rooms_sold: 500,
        total_rooms: 600,
        occupancy: 0.833,
        adr: 150,
        revpar: 125,
      },
      {
        property_id: 'HART',
        property_name: 'Hartford Hotel',
        revenue: 50000,
        rooms_sold: 450,
        total_rooms: 650,
        occupancy: 0.692,
        adr: 111.11,
        revpar: 76.92,
      },
    ];

    const prevPropertyStats = [
      {
        property_id: 'BOS',
        property_name: 'Boston Inn',
        revenue: 70000,
        rooms_sold: 480,
        total_rooms: 600,
        occupancy: 0.8,
        adr: 145.83,
        revpar: 116.67,
      },
      {
        property_id: 'HART',
        property_name: 'Hartford Hotel',
        revenue: 55000,
        rooms_sold: 500,
        total_rooms: 650,
        occupancy: 0.769,
        adr: 110,
        revpar: 84.62,
      },
    ];

    const channelMetrics = [
      {
        channel: 'EXPEDIA',
        gross: 45000,
        stays: 300,
        commission: 6750,
        paymentFee: 1350,
        netContribution: 36900,
      },
      {
        channel: 'BRAND WEB',
        gross: 30000,
        stays: 200,
        commission: 0,
        paymentFee: 900,
        netContribution: 29100,
      },
    ];

    const portfolioHealth = {
      portfolioScore: 98,
      healthyCount: 2,
      warningCount: 0,
      criticalCount: 0,
      properties: [
        {
          propertyId: 'BOS',
          propertyName: 'Boston Inn',
          overallScore: 100,
          statusLabel: 'All Reports Current',
          completeness: { occupancy: 100, revenue: 100, source: 100, payment: 100 },
          missingDates: { occupancy: [], revenue: [] },
          latestDates: { occupancy: '2026-09-28' },
        },
        {
          propertyId: 'HART',
          propertyName: 'Hartford Hotel',
          overallScore: 96,
          statusLabel: 'All Reports Current',
          completeness: { occupancy: 100, revenue: 95, source: 95, payment: 95 },
          missingDates: { occupancy: [], revenue: ['2026-09-02'] },
          latestDates: { occupancy: '2026-09-28' },
        },
      ],
    };

    const reconciliation = {
      reported: 125000,
      calculated: 125000,
      difference: 0,
      isBalanced: true,
    };

    const wb = buildOwnerPerformancePacketWorkbook({
      dateRangeLabel: 'September 2026',
      properties,
      kpis,
      propertyStats,
      prevPropertyStats,
      channelMetrics,
      portfolioHealth,
      reconciliation,
    });

    expect(wb).toBeDefined();
    expect(wb.SheetNames).toEqual([
      'Executive Summary',
      'Property Performance',
      'OTA & Channel Economics',
      'Data Health & Audit',
      'Data Provenance',
    ]);

    // 1. Verify Sheet 1: Executive Summary
    const ws1 = wb.Sheets['Executive Summary'];
    expect(ws1).toBeDefined();
    const rows1 = XLSX.utils.sheet_to_json(ws1, { header: 1 });
    expect(rows1[0][0]).toBe('PORTFOLIO OWNER PERFORMANCE PACKET');
    expect(rows1[1][1]).toBe('September 2026');
    expect(rows1[7][0]).toBe('Total Room Revenue');
    expect(rows1[7][1]).toBe('$125,000.00');
    expect(rows1[8][0]).toBe('Rooms Sold');
    expect(rows1[8][1]).toBe(950);
    expect(rows1[9][0]).toBe('Portfolio Occupancy');
    expect(rows1[9][1]).toBe('76.0%');
    expect(rows1[13][0]).toBe('OTA Commission Drag');
    expect(rows1[13][1]).toBe('$15,000.00');
    expect(rows1[14][0]).toBe('OTA Commission Ratio');
    expect(rows1[14][1]).toBe('12.0%');
    expect(rows1[15][0]).toBe('Direct Booking Share');
    expect(rows1[15][1]).toBe('42.0%');

    // 2. Verify Sheet 2: Property Performance
    const ws2 = wb.Sheets['Property Performance'];
    expect(ws2).toBeDefined();
    const rows2 = XLSX.utils.sheet_to_json(ws2, { header: 1 });
    expect(rows2[0]).toEqual([
      'Property ID',
      'Property Name',
      'Revenue',
      'Rooms Sold',
      'Occupancy %',
      'ADR',
      'RevPAR',
      'Status Alert',
      'Volume Effect ($)',
      'Rate Effect ($)',
      'Net Period Variance ($)',
      'Primary Variance Driver',
    ]);
    const bosRow = rows2[1];
    expect(bosRow[0]).toBe('BOS');
    expect(bosRow[1]).toBe('Boston Inn');
    expect(bosRow[2]).toBe(75000);
    expect(bosRow[3]).toBe(500); // Rooms sold must be non-zero
    expect(bosRow[4]).toBe(83.3);
    expect(bosRow[5]).toBe(150);
    // Volume effect and Rate effect must sum to variance
    const volumeEffect = bosRow[8];
    const rateEffect = bosRow[9];
    const totalVariance = bosRow[10];
    expect(Math.round((volumeEffect + rateEffect) * 100) / 100).toBe(totalVariance);
    expect(totalVariance).toBe(5000); // 75000 - 70000

    // 3. Verify Sheet 3: OTA & Channel Economics
    const ws3 = wb.Sheets['OTA & Channel Economics'];
    expect(ws3).toBeDefined();
    const rows3 = XLSX.utils.sheet_to_json(ws3, { header: 1 });
    expect(rows3[0][0]).toBe('Channel / Source');
    expect(rows3[0][1]).toBe('Normalized Name');
    expect(rows3[0][2]).toBe('Channel Group');

    const expediaRow = rows3[1];
    expect(expediaRow[0]).toBe('EXPEDIA');
    expect(expediaRow[1]).toBe('Expedia');
    expect(expediaRow[2]).toBe('OTA');
    expect(expediaRow[3]).toBe(45000);
    expect(expediaRow[5]).toBe(6750); // Commission
    expect(expediaRow[7]).toBe(36900); // Net contribution
    expect(expediaRow[9]).toBe(1012.5); // Direct shift gain (15% of 6750)

    // 4. Verify Sheet 4: Data Health & Audit
    const ws4 = wb.Sheets['Data Health & Audit'];
    expect(ws4).toBeDefined();
    const rows4 = XLSX.utils.sheet_to_json(ws4, { header: 1 });
    expect(rows4[0][0]).toBe('Property ID');
    expect(rows4[1][0]).toBe('BOS');
    expect(rows4[1][2]).toBe(100); // Overall score
    expect(rows4[2][0]).toBe('HART');
    expect(rows4[2][2]).toBe(96);

    // Reconciliation block at bottom
    const reconStatusRow = rows4.find((r) => r[0] === 'Reconciliation Balance Status:');
    expect(reconStatusRow).toBeDefined();
    expect(reconStatusRow[1]).toBe('BALANCED ($0.00 Difference)');

    // 5. Verify Sheet 5: Data Provenance & Audit Controls
    const ws5 = wb.Sheets['Data Provenance'];
    expect(ws5).toBeDefined();
    const rows5 = XLSX.utils.sheet_to_json(ws5, { header: 1 });
    expect(rows5[0][0]).toBe('PORTFOLIO DATA PROVENANCE & AUDIT CONTROLS');
    expect(rows5[1][0]).toBe('Packet Schema Version:');
    expect(rows5[1][1]).toBe('owner-packet-v2.1');
    expect(rows5[6][0]).toBe('Total Portfolio Room Revenue:');
    expect(rows5[6][1]).toBe('$125,000.00');
    expect(rows5[9][0]).toBe('Reconciliation Status:');
    expect(rows5[9][1]).toBe('BALANCED ($0.00 Difference)');
    expect(rows5[11][0]).toBe('Data Health Gate Status:');
    expect(rows5[11][1]).toBe('READY / AUDITED');
  });

  it('correctly integrates with CalculationService.calculatePerPropertyStats output (camelCase roomsSold)', () => {
    const properties = [{ id: 'BOS', name: 'Boston Inn', rooms: 100 }];
    const occRows = [
      { property_id: 'BOS', property_name: 'Boston Inn', date: '2026-09-01', room_revenue: 12000, rooms_sold: 80 },
      { property_id: 'BOS', property_name: 'Boston Inn', date: '2026-09-02', room_revenue: 15000, rooms_sold: 90 },
    ];
    const prevOccRows = [
      { property_id: 'BOS', property_name: 'Boston Inn', date: '2026-08-01', room_revenue: 10000, rooms_sold: 70 },
      { property_id: 'BOS', property_name: 'Boston Inn', date: '2026-08-02', room_revenue: 11000, rooms_sold: 75 },
    ];

    const currentStats = CalculationService.calculatePerPropertyStats(occRows, properties);
    const prevStats = CalculationService.calculatePerPropertyStats(prevOccRows, properties);

    // Verify CalculationService returns both camelCase and snake_case
    expect(currentStats[0].roomsSold).toBe(170);
    expect(currentStats[0].rooms_sold).toBe(170);
    expect(currentStats[0].revenue).toBe(27000);
    expect(currentStats[0].roomRevenue).toBe(27000);

    const wb = buildOwnerPerformancePacketWorkbook({
      dateRangeLabel: 'Sep 1-2, 2026',
      properties,
      kpis: {
        revenue: 27000,
        roomsSold: 170,
        occupancy: 0.85,
        adr: 158.82,
        revpar: 135.0,
        netKept: 24000,
        commissionTotal: 3000,
        commissionRate: 0.111,
        directShare: 0.5,
      },
      propertyStats: currentStats,
      prevPropertyStats: prevStats,
      channelMetrics: [
        { channel: 'EXPEDIA COLLECT', gross: 13500, stays: 85, commission: 2025, paymentFee: 405 },
        { channel: 'BRAND WEB', gross: 13500, stays: 85, commission: 0, paymentFee: 405 },
      ],
      portfolioHealth: {
        portfolioScore: 100,
        healthyCount: 1,
        warningCount: 0,
        criticalCount: 0,
        properties: [{
          propertyId: 'BOS',
          propertyName: 'Boston Inn',
          overallScore: 100,
          statusLabel: 'All Reports Current',
          completeness: { occupancy: 100, revenue: 100, source: 100, payment: 100 },
        }],
      },
      reconciliation: {
        reported: 27000,
        calculated: 27000,
        difference: 0,
        isBalanced: true,
      },
    });

    const ws2 = wb.Sheets['Property Performance'];
    const rows2 = XLSX.utils.sheet_to_json(ws2, { header: 1 });
    const bosRow = rows2[1];

    expect(bosRow[0]).toBe('BOS');
    expect(bosRow[1]).toBe('Boston Inn');
    expect(bosRow[2]).toBe(27000);
    expect(bosRow[3]).toBe(170); // Must be 170 rooms sold, NOT 0!
    expect(bosRow[5]).toBe(158.82); // ADR
    expect(bosRow[10]).toBe(6000); // 27000 - 21000 total variance

    // Verify binary workbook export (valid ZIP/XLSX structure)
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    expect(buf).toBeDefined();
    expect(buf.length).toBeGreaterThan(1000);
    // Standard ZIP/XLSX magic number: 0x50, 0x4B, 0x03, 0x04 ("PK\x03\x04")
    expect(buf[0]).toBe(0x50);
    expect(buf[1]).toBe(0x4B);
    expect(buf[2]).toBe(0x03);
    expect(buf[3]).toBe(0x04);
  });
});
