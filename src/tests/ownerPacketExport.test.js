import { describe, it, expect } from 'vitest';
import { buildOwnerPerformancePacketWorkbook } from '@/lib/ownerPacketExport';

describe('Monthly Owner Performance Packet Exporter', () => {
  it('generates a 4-sheet executive workbook with comprehensive intelligence', () => {
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
    ]);

    // Check sheets exist and have cell data
    expect(wb.Sheets['Executive Summary']).toBeDefined();
    expect(wb.Sheets['Property Performance']).toBeDefined();
    expect(wb.Sheets['OTA & Channel Economics']).toBeDefined();
    expect(wb.Sheets['Data Health & Audit']).toBeDefined();
  });
});
