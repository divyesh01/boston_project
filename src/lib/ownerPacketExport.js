/**
 * Monthly Owner Performance Packet Generator
 *
 * Generates an executive-ready, multi-sheet workbook (.xlsx) synthesizing:
 * 1. Portfolio Executive Summary
 * 2. Property Performance & Variance Decomposition (Volume vs Rate Effect)
 * 3. Distribution & OTA Net Economics (Net Contribution & Direct Shift)
 * 4. Data Health, Completeness & Ledger Reconciliation ($0.00 Balance Proof)
 */

import * as XLSX from 'xlsx';
import { formatCents, toCents, formatNumber } from '@/lib/decimal';
import { decomposeRevenueVariance } from '@/lib/varianceDecomposition';
import { normalizeChannel, CHANNEL_GROUPS, calculateDirectShiftOpportunity } from '@/lib/channelDictionary';
import { reconcileFinancialTotals } from '@/lib/dataHealth';

const fmtMoney = (v) => formatCents(toCents(v), 2);
const fmtPct = (v) => `${(Number(v) || 0).toFixed(1)}%`;

/**
 * Builds a multi-sheet XLSX Workbook representing the complete Owner Packet.
 *
 * @param {Object} params
 * @param {string} params.dateRangeLabel Human-readable date range (e.g. "September 2026")
 * @param {Array<Object>} params.properties List of property records
 * @param {Object} params.kpis High-level portfolio KPIs
 * @param {Array<Object>} params.propertyStats Per-property performance statistics
 * @param {Array<Object>} [params.prevPropertyStats=[]] Prior period statistics for variance decomposition
 * @param {Array<Object>} [params.channelMetrics=[]] Channel performance metrics
 * @param {Object} [params.portfolioHealth={}] Data health & completeness summary
 * @param {Object} [params.reconciliation={}] Financial reconciliation details
 * @returns {XLSX.WorkBook}
 */
export function buildOwnerPerformancePacketWorkbook({
  dateRangeLabel = 'Current Period',
  properties = [],
  kpis = {},
  propertyStats = [],
  prevPropertyStats = [],
  channelMetrics = [],
  portfolioHealth = {},
  reconciliation = {},
}) {
  const wb = XLSX.utils.book_new();

  // ─────────────────────────────────────────────────────────────────────────────
  // SHEET 1: EXECUTIVE SUMMARY
  // ─────────────────────────────────────────────────────────────────────────────
  const execSummaryRows = [
    ['PORTFOLIO OWNER PERFORMANCE PACKET', ''],
    ['Reporting Period:', dateRangeLabel],
    ['Generated Date:', new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })],
    ['Portfolio Properties:', properties.length],
    ['', ''],
    ['EXECUTIVE KEY PERFORMANCE INDICATORS', ''],
    ['Metric', 'Value', 'Notes / Context'],
    ['Total Room Revenue', fmtMoney(kpis.revenue || 0), 'Gross room revenue across all properties'],
    ['Rooms Sold', kpis.roomsSold || 0, 'Total room nights occupied'],
    ['Portfolio Occupancy', fmtPct((kpis.occupancy || 0) * 100), 'Weighted by available room capacity'],
    ['Average Daily Rate (ADR)', fmtMoney(kpis.adr || 0), 'Revenue per occupied room night'],
    ['Revenue Per Available Room (RevPAR)', fmtMoney(kpis.revpar || 0), 'Total room revenue / total capacity'],
    ['Total Net Kept Revenue', fmtMoney(kpis.netKept || (kpis.revenue || 0) - (kpis.commissionTotal || 0)), 'Net take-home after OTA commissions & fees'],
    ['OTA Commission Drag', fmtMoney(kpis.commissionTotal || 0), 'Total distribution commission deducted'],
    ['OTA Commission Ratio', fmtPct((kpis.commissionRate || 0) * 100), 'Commission as % of gross revenue'],
    ['Direct Booking Share', fmtPct((kpis.directShare || 0) * 100), 'Share of revenue from direct and brand web'],
  ];

  const wsExec = XLSX.utils.aoa_to_sheet(execSummaryRows);
  XLSX.utils.book_append_sheet(wb, wsExec, 'Executive Summary');

  // ─────────────────────────────────────────────────────────────────────────────
  // SHEET 2: PROPERTY PERFORMANCE & VARIANCE DECOMPOSITION
  // ─────────────────────────────────────────────────────────────────────────────
  const prevMap = new Map((prevPropertyStats || []).map((p) => [p.property_id, p]));

  const propertyHeader = [
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
  ];

  const propertyDataRows = propertyStats.map((curr) => {
    const prev = prevMap.get(curr.property_id) || {};
    const variance = decomposeRevenueVariance(
      {
        propertyId: curr.property_id,
        propertyName: curr.property_name,
        roomRevenue: curr.revenue,
        roomsSold: curr.rooms_sold,
        adr: curr.adr,
      },
      {
        propertyId: prev.property_id,
        propertyName: prev.property_name,
        roomRevenue: prev.revenue,
        roomsSold: prev.rooms_sold,
        adr: prev.adr,
      }
    );

    const primaryDriver = variance.drivers?.[0]?.label || 'Volume & Rate Stability';

    return [
      curr.property_id,
      curr.property_name || curr.property_id,
      curr.revenue || 0,
      curr.rooms_sold || 0,
      Number(((curr.occupancy || 0) * 100).toFixed(1)),
      Number((curr.adr || 0).toFixed(2)),
      Number((curr.revpar || 0).toFixed(2)),
      curr.statusLabel || (curr.occupancy >= 0.7 ? 'On Target' : 'Caution'),
      Number(variance.volumeEffect.toFixed(2)),
      Number(variance.rateEffect.toFixed(2)),
      Number(variance.totalVariance.toFixed(2)),
      primaryDriver,
    ];
  });

  const wsProperties = XLSX.utils.aoa_to_sheet([propertyHeader, ...propertyDataRows]);
  XLSX.utils.book_append_sheet(wb, wsProperties, 'Property Performance');

  // ─────────────────────────────────────────────────────────────────────────────
  // SHEET 3: DISTRIBUTION & OTA NET ECONOMICS
  // ─────────────────────────────────────────────────────────────────────────────
  const channelHeader = [
    'Channel / Source',
    'Normalized Name',
    'Channel Group',
    'Gross Revenue ($)',
    'Stays / Bookings',
    'Commission Drag ($)',
    'Payment Fees ($)',
    'Net Owner Contribution ($)',
    'Net Margin %',
    'Direct Shift Gain ($)',
  ];

  const enrichedMetrics = (channelMetrics || []).map((ch) => {
    const norm = normalizeChannel(ch.channel || ch.source);
    return { ...ch, isOta: norm.isOta, group: norm.group, canonicalName: norm.canonicalName };
  });

  const totalShift = calculateDirectShiftOpportunity(enrichedMetrics, 0.15);

  const channelDataRows = enrichedMetrics.map((ch) => {
    const isOta = ch.isOta;
    const directShiftGain = isOta ? Math.round((ch.commission || 0) * 0.15 * 100) / 100 : 0;

    const netContribution = ch.netContribution !== undefined
      ? ch.netContribution
      : (ch.gross || 0) - (ch.commission || 0) - (ch.paymentFee || 0);

    const marginPct = (ch.gross || 0) > 0 ? (netContribution / ch.gross) * 100 : 100;

    return [
      ch.channel || ch.source,
      ch.canonicalName,
      ch.group,
      Number((ch.gross || 0).toFixed(2)),
      ch.stays || 0,
      Number((ch.commission || 0).toFixed(2)),
      Number((ch.paymentFee || 0).toFixed(2)),
      Number(netContribution.toFixed(2)),
      Number(marginPct.toFixed(1)),
      directShiftGain,
    ];
  });

  const shiftSummaryRow = [
    'TOTAL DIRECT SHIFT OPPORTUNITY (15% Shift to Direct)',
    '',
    '',
    totalShift.otaGross,
    '',
    totalShift.otaCommission,
    '',
    '',
    '',
    totalShift.potentialSavings,
  ];

  const wsChannels = XLSX.utils.aoa_to_sheet([channelHeader, ...channelDataRows, ['', ''], shiftSummaryRow]);
  XLSX.utils.book_append_sheet(wb, wsChannels, 'OTA & Channel Economics');

  // ─────────────────────────────────────────────────────────────────────────────
  // SHEET 4: DATA HEALTH & FINANCIAL RECONCILIATION
  // ─────────────────────────────────────────────────────────────────────────────
  const healthProperties = portfolioHealth.properties || [];

  const healthHeader = [
    'Property ID',
    'Property Name',
    'Overall Health Score',
    'Status Tier',
    'Occupancy %',
    'Revenue Ledger %',
    'Source Mix %',
    'Payment Ledger %',
    'Missing Dates Count',
    'Latest Date Imported',
  ];

  const healthDataRows = healthProperties.map((p) => [
    p.propertyId,
    p.propertyName,
    p.overallScore,
    p.statusLabel || p.status,
    p.completeness?.occupancy ?? 100,
    p.completeness?.revenue ?? 100,
    p.completeness?.source ?? 100,
    p.completeness?.payment ?? 100,
    (p.missingDates?.occupancy?.length || 0) + (p.missingDates?.revenue?.length || 0),
    p.latestDates?.occupancy || 'N/A',
  ]);

  const reconRows = [
    ['', ''],
    ['FINANCIAL LEDGER RECONCILIATION AUDIT ($0.00 DIFFERENCE TARGET)', ''],
    ['Reported PMS Room Revenue:', reconciliation.reported || 0],
    ['Calculated Channel Ledger Revenue:', reconciliation.calculated || 0],
    ['Unreconciled Variance:', reconciliation.difference || 0],
    ['Reconciliation Balance Status:', reconciliation.isBalanced ? 'BALANCED ($0.00 Difference)' : 'DISCREPANCY DETECTED'],
  ];

  const wsHealth = XLSX.utils.aoa_to_sheet([healthHeader, ...healthDataRows, ...reconRows]);
  XLSX.utils.book_append_sheet(wb, wsHealth, 'Data Health & Audit');

  return wb;
}

/**
 * Downloads the Monthly Owner Performance Packet as an .xlsx file.
 *
 * @param {Object} params Same parameters as buildOwnerPerformancePacketWorkbook
 * @param {string} [filename] Optional custom filename
 */
export function downloadOwnerPerformancePacket(params, filename) {
  const wb = buildOwnerPerformancePacketWorkbook(params);
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const defaultFilename = `Owner_Performance_Packet_${yyyy}_${mm}.xlsx`;
  XLSX.writeFile(wb, filename || defaultFilename);
}
