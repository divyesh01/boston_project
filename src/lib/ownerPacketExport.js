/**
 * Monthly Owner Performance Packet Generator
 *
 * Generates an executive-ready, multi-sheet workbook (.xlsx) synthesizing:
 * 1. Portfolio Executive Summary
 * 2. Property Performance & Variance Decomposition (Volume vs Rate Effect)
 * 3. Distribution & OTA Net Economics (Net Contribution & Direct Shift)
 * 4. Data Health, Completeness & Ledger Reconciliation ($0.00 Balance Proof)
 * 5. Data Provenance & Audit Controls
 */

import * as XLSX from 'xlsx';
import { formatCents, toCents, fromCents, formatNumber } from '@/lib/decimal';
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
    [(kpis.taxIncomplete || kpis.isPartial) ? 'Total Net Kept Revenue (Partial Estimate)' : 'Total Net Kept Revenue', kpis.netKept == null ? 'UNAVAILABLE' : fmtMoney(kpis.netKept), (kpis.taxIncomplete || kpis.isPartial) ? 'Partial estimate: tax calculations incomplete (missing rates or room nights)' : 'Net take-home after OTA commissions & fees'],
    ['OTA Commission Drag', fmtMoney(kpis.commissionTotal || 0), 'Total distribution commission deducted'],
    ['OTA Commission Ratio', fmtPct((kpis.commissionRate || 0) * 100), 'Commission as % of gross revenue'],
    ['Direct Booking Share', fmtPct((kpis.directShare || 0) * 100), 'Share of revenue from direct and brand web'],
  ];

  const wsExec = XLSX.utils.aoa_to_sheet(execSummaryRows);
  XLSX.utils.book_append_sheet(wb, wsExec, 'Executive Summary');

  // ─────────────────────────────────────────────────────────────────────────────
  // SHEET 2: PROPERTY PERFORMANCE & VARIANCE DECOMPOSITION
  // ─────────────────────────────────────────────────────────────────────────────
  const prevMap = new Map((prevPropertyStats || []).map((p) => [p.property_id || p.propertyId, p]));

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
    const propId = curr.property_id || curr.propertyId;
    const propName = curr.property_name || curr.propertyName || propId;
    const currRevenue = curr.revenue ?? curr.roomRevenue ?? 0;
    const currRoomsSold = curr.rooms_sold ?? curr.roomsSold ?? 0;
    const currAdr = curr.adr ?? (currRoomsSold > 0 ? currRevenue / currRoomsSold : 0);

    const prev = prevMap.get(propId) || {};
    const prevRevenue = prev.revenue ?? prev.roomRevenue ?? 0;
    const prevRoomsSold = prev.rooms_sold ?? prev.roomsSold ?? 0;
    const prevAdr = prev.adr ?? (prevRoomsSold > 0 ? prevRevenue / prevRoomsSold : 0);

    const variance = decomposeRevenueVariance(
      {
        propertyId: propId,
        propertyName: propName,
        roomRevenue: currRevenue,
        roomsSold: currRoomsSold,
        adr: currAdr,
      },
      {
        propertyId: prev.property_id || prev.propertyId || propId,
        propertyName: prev.property_name || prev.propertyName || propName,
        roomRevenue: prevRevenue,
        roomsSold: prevRoomsSold,
        adr: prevAdr,
      }
    );

    const primaryDriver = variance.drivers?.[0]?.label || 'Volume & Rate Stability';

    return [
      propId,
      propName,
      currRevenue,
      currRoomsSold,
      Number(((curr.occupancy || 0) * 100).toFixed(1)),
      fromCents(toCents(currAdr || 0)),
      fromCents(toCents(curr.revpar || 0)),
      curr.statusLabel || (curr.occupancy >= 0.7 ? 'On Target' : 'Caution'),
      fromCents(toCents(variance.volumeEffect)),
      fromCents(toCents(variance.rateEffect)),
      fromCents(toCents(variance.totalVariance)),
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
    return {
      ...ch,
      isOta: norm.isOta,
      group: norm.group,
      canonicalName: norm.canonicalName || norm.normalizedName || ch.normalized || 'Other',
    };
  });

  const totalShift = calculateDirectShiftOpportunity(enrichedMetrics, 0.15);

  const channelDataRows = enrichedMetrics.map((ch) => {
    const isOta = ch.isOta;
    const directShiftGain = isOta
      ? fromCents(Math.round(toCents(ch.commission || 0) * 0.15))
      : 0;

    const netContribution = ch.netContribution !== undefined
      ? ch.netContribution
      : (ch.gross || 0) - (ch.commission || 0) - (ch.paymentFee || 0);

    const marginPct = (ch.gross || 0) > 0 ? Number(((netContribution / ch.gross) * 100).toFixed(1)) : 100;

    return [
      ch.channel || ch.source,
      ch.canonicalName,
      ch.group,
      fromCents(toCents(ch.gross || 0)),
      ch.stays || 0,
      fromCents(toCents(ch.commission || 0)),
      fromCents(toCents(ch.paymentFee || 0)),
      fromCents(toCents(netContribution)),
      marginPct,
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
    p.overallScore ?? 0,
    p.statusLabel || p.status || 'Unknown',
    p.completeness?.occupancy ?? 0,
    p.completeness?.revenue ?? 0,
    p.completeness?.source ?? 0,
    p.completeness?.payment ?? 0,
    (p.missingDates?.occupancy?.length || 0) + (p.missingDates?.revenue?.length || 0),
    p.latestDates?.occupancy || 'N/A',
  ]);

  const hasHealthScore = portfolioHealth && portfolioHealth.portfolioScore !== undefined && portfolioHealth.portfolioScore !== null;
  const portfolioScoreNum = hasHealthScore ? Number(portfolioHealth.portfolioScore) : null;
  const healthScoreDisplay = portfolioScoreNum !== null ? `${portfolioScoreNum}/100` : 'UNKNOWN';

  const isReconciled = reconciliation && reconciliation.isBalanced === true;
  const hasNonZeroActivity = (kpis.revenue || 0) > 0 || (reconciliation.reported || 0) > 0;
  const isHealthy = hasHealthScore &&
    (portfolioHealth.criticalCount || 0) === 0 &&
    portfolioScoreNum >= 80 &&
    isReconciled &&
    hasNonZeroActivity;

  let sheet4ReconStatus = 'DISCREPANCY DETECTED';
  if (reconciliation.status === 'no_data' || (!hasNonZeroActivity && !isReconciled)) {
    sheet4ReconStatus = 'NO DATA (UNVERIFIED)';
  } else if (reconciliation.status === 'incomplete') {
    sheet4ReconStatus = 'INCOMPLETE LEDGER COVERAGE';
  } else if (reconciliation.status === 'failed') {
    sheet4ReconStatus = 'FAILED (LEDGER READ ERROR)';
  } else if (isReconciled) {
    sheet4ReconStatus = 'BALANCED ($0.00 Difference)';
  }

  const reconRows = [
    ['', ''],
    ['FINANCIAL LEDGER RECONCILIATION AUDIT ($0.00 DIFFERENCE TARGET)', ''],
    ['Reported PMS Room Revenue:', reconciliation.reported || 0],
    ['Calculated Channel Ledger Revenue:', reconciliation.calculated || 0],
    ['Settled Payment Ledger Total:', reconciliation.payments != null ? reconciliation.payments : 'N/A'],
    ['Unreconciled Variance:', reconciliation.difference || 0],
    ['Reconciliation Balance Status:', sheet4ReconStatus],
  ];

  const wsHealth = XLSX.utils.aoa_to_sheet([healthHeader, ...healthDataRows, ...reconRows]);
  XLSX.utils.book_append_sheet(wb, wsHealth, 'Data Health & Audit');

  // ─────────────────────────────────────────────────────────────────────────────
  // SHEET 5: DATA PROVENANCE & AUDIT CONTROLS
  // ─────────────────────────────────────────────────────────────────────────────
  const totalMissingDates = healthProperties.reduce(
    (acc, p) => acc + (p.missingDates?.occupancy?.length || 0) + (p.missingDates?.revenue?.length || 0),
    0
  );

  let gateStatus = 'INCOMPLETE / REQUIRES REVIEW';
  if (!hasHealthScore || portfolioScoreNum === 0 || !hasNonZeroActivity) {
    gateStatus = 'NO DATA / UNVERIFIED';
  } else if (isHealthy) {
    gateStatus = 'RECONCILED / OTHER CONTROLS UNVERIFIED';
  }

  let reconStatusLabel = 'DISCREPANCY DETECTED';
  if (reconciliation.status === 'no_data' || (!hasNonZeroActivity && !isReconciled)) {
    reconStatusLabel = 'NO DATA (UNVERIFIED)';
  } else if (reconciliation.status === 'incomplete') {
    reconStatusLabel = 'INCOMPLETE LEDGER COVERAGE';
  } else if (reconciliation.status === 'failed') {
    reconStatusLabel = 'FAILED TO RECONCILE';
  } else if (isReconciled) {
    reconStatusLabel = 'BALANCED ($0.00 Difference)';
  }

  let invariantCheck = 'Reconciliation Pending / Unverified';
  const isPartialNetKept = Boolean(kpis.taxIncomplete || kpis.isPartial);
  if (isReconciled && hasNonZeroActivity) {
    invariantCheck = isPartialNetKept
      ? 'Integer Cent Balance Verified; Business Taxes Incomplete (Partial Estimate)'
      : 'Integer Cent Balance Verified; Rate Card Controls Not Evaluated';
  } else if (reconciliation.difference > 0) {
    invariantCheck = `Reconciliation Variance Detected: ${fmtMoney(reconciliation.difference)} Drift`;
  } else if (reconciliation.status === 'incomplete') {
    invariantCheck = 'Reconciliation Incomplete: Channel Distribution Ledger Missing';
  } else if (!hasNonZeroActivity) {
    invariantCheck = 'Zero Ledger Activity Ingested: No Financial Assurance Claimed';
  }

  const hasRawHashes = Array.isArray(portfolioHealth.provenanceHashes) && portfolioHealth.provenanceHashes.length > 0;
  const hashInventory = hasRawHashes
    ? portfolioHealth.provenanceHashes.map((h) => `${h.file || h.id}: ${h.sha256}`).join('; ')
    : 'No raw-file SHA-256 signatures supplied in export scope';

  const provenanceRows = [
    ['PORTFOLIO DATA PROVENANCE & AUDIT CONTROLS', ''],
    ['Packet Schema Version:', 'owner-packet-v2.1'],
    ['Generated At (UTC):', new Date().toISOString()],
    ['Reporting Period:', dateRangeLabel],
    ['Properties Scoped:', properties.map((p) => p.name || p.id).join(', ')],
    ['Property Count:', properties.length],
    ['Total Portfolio Room Revenue:', fmtMoney(kpis.revenue || 0)],
    ['Total Net Kept Revenue:', kpis.netKept == null ? 'UNAVAILABLE' : isPartialNetKept ? `${fmtMoney(kpis.netKept)} (PARTIAL - TAX INCOMPLETE)` : fmtMoney(kpis.netKept)],
    ['Reconciliation Variance:', fmtMoney(reconciliation.difference || 0)],
    ['Reconciliation Status:', reconStatusLabel],
    ['Portfolio Health Score:', healthScoreDisplay],
    ['Data Health Gate Status:', gateStatus],
    ['Missing Date Gaps Across Portfolio:', totalMissingDates],
    ['Engine Identity:', 'Boston Project Owner Intelligence Core (DIVYESH-V3)'],
    ['Deterministic Invariant Check:', invariantCheck],
    ['Raw File SHA-256 Inventory (verification not performed):', hashInventory],
  ];

  const wsProvenance = XLSX.utils.aoa_to_sheet(provenanceRows);
  XLSX.utils.book_append_sheet(wb, wsProvenance, 'Data Provenance');

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
