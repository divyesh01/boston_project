/**
 * Data Health, Reconciliation & Missing Report Detection Engine
 *
 * Verifies completeness, continuity, and mathematical balance across HotelKey reports
 * for multi-property portfolios (up to 25+ hotels).
 */

import { toCents, fromCents } from '@/lib/decimal';

export const REPORT_TYPES = {
  OCCUPANCY: 'occupancy',
  REVENUE: 'revenue',
  SOURCE: 'source',
  PAYMENT: 'payment',
  AUDIT: 'final_audit',
};

/**
 * Checks a date sequence for missing days.
 *
 * @param {string[]} dates Array of YYYY-MM-DD date strings
 * @param {string} from YYYY-MM-DD start date
 * @param {string} to YYYY-MM-DD end date
 * @returns {string[]} Array of missing YYYY-MM-DD dates
 */
export function findMissingDates(dates = [], from = '', to = '') {
  if (!from || !to) return [];
  const existingSet = new Set(dates.map((d) => String(d).slice(0, 10)));
  const missing = [];

  const start = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
    return [];
  }

  const cur = new Date(start);
  while (cur <= end) {
    const yyyy = cur.getFullYear();
    const mm = String(cur.getMonth() + 1).padStart(2, '0');
    const dd = String(cur.getDate()).padStart(2, '0');
    const dateStr = `${yyyy}-${mm}-${dd}`;

    if (!existingSet.has(dateStr)) {
      missing.push(dateStr);
    }
    cur.setDate(cur.getDate() + 1);
  }

  return missing;
}

/**
 * Assesses data health and report completeness for a property.
 *
 * @param {Object} params
 * @param {string} params.propertyId
 * @param {string} params.propertyName
 * @param {Array<{ date: string }>} [params.occRows=[]]
 * @param {Array<{ date: string }>} [params.srcRows=[]]
 * @param {Array<{ date: string }>} [params.grossRows=[]]
 * @param {Array<{ date: string }>} [params.payRows=[]]
 * @param {Array<Object>} [params.uploadedReports=[]]
 * @param {{ from: string, to: string }} params.dateRange
 * @returns {Object} PropertyDataHealth
 */
export function evaluatePropertyDataHealth({
  propertyId,
  propertyName,
  occRows = [],
  srcRows = [],
  grossRows = [],
  payRows = [],
  uploadedReports = [],
  dateRange = { from: '', to: '' },
}) {
  const { from, to } = dateRange;

  const occDates = [...new Set(occRows.map((r) => String(r.date).slice(0, 10)))];
  const srcDates = [...new Set(srcRows.map((r) => String(r.date).slice(0, 10)))];
  const grossDates = [...new Set(grossRows.map((r) => String(r.date).slice(0, 10)))];
  const payDates = [...new Set(payRows.map((r) => String(r.date).slice(0, 10)))];

  const missingOcc = findMissingDates(occDates, from, to);
  const missingSrc = findMissingDates(srcDates, from, to);
  const missingGross = findMissingDates(grossDates, from, to);
  const missingPay = findMissingDates(payDates, from, to);

  const hasAnyData = occRows.length > 0 || srcRows.length > 0 || grossRows.length > 0 || payRows.length > 0;

  if (!hasAnyData) {
    return {
      propertyId,
      propertyName,
      overallScore: 0,
      completeness: { occupancy: 0, source: 0, revenue: 0, payment: 0 },
      missingDates: { occupancy: [], source: [], revenue: [], payment: [] },
      status: 'critical',
      badgeColor: '#FF6B6B',
      statusLabel: 'No Data Ingested',
      uploadedReportsCount: uploadedReports.length,
      provenanceHashes: [],
    };
  }

  const totalPossibleDays = from && to
    ? Math.max(1, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86400000) + 1)
    : Math.max(1, occDates.length, srcDates.length, grossDates.length, payDates.length);

  const completeness = {
    occupancy: Math.round(((totalPossibleDays - missingOcc.length) / totalPossibleDays) * 100),
    source: Math.round(((totalPossibleDays - missingSrc.length) / totalPossibleDays) * 100),
    revenue: Math.round(((totalPossibleDays - missingGross.length) / totalPossibleDays) * 100),
    payment: Math.round(((totalPossibleDays - missingPay.length) / totalPossibleDays) * 100),
  };

  const overallScore = Math.round(
    (completeness.occupancy + completeness.source + completeness.revenue + completeness.payment) / 4
  );

  let status = 'healthy';
  let badgeColor = '#00E096';
  let statusLabel = 'All Reports Current';

  if (overallScore < 70 || missingOcc.length > 5 || missingGross.length > 5) {
    status = 'critical';
    badgeColor = '#FF6B6B';
    statusLabel = 'Missing Critical Data';
  } else if (overallScore < 95 || missingOcc.length > 0 || missingSrc.length > 0) {
    status = 'warning';
    badgeColor = '#FFB547';
    statusLabel = 'Partial Gaps Detected';
  }

  // Find latest imported dates
  const latestOcc = occDates.sort().pop() || null;
  const latestGross = grossDates.sort().pop() || null;
  const latestSrc = srcDates.sort().pop() || null;

  return {
    propertyId,
    propertyName: propertyName || propertyId,
    overallScore,
    status,
    badgeColor,
    statusLabel,
    totalPossibleDays,
    completeness,
    missingDates: {
      occupancy: missingOcc,
      source: missingSrc,
      revenue: missingGross,
      payment: missingPay,
    },
    latestDates: {
      occupancy: latestOcc,
      revenue: latestGross,
      source: latestSrc,
    },
    uploadedCount: uploadedReports.length,
  };
}

/**
 * Assesses data health across a portfolio of properties.
 *
 * @param {Array<{ id: string, name: string }>} properties
 * @param {Object} dataByProperty Map of propertyId -> { occRows, srcRows, grossRows, payRows, uploadedReports }
 * @param {{ from: string, to: string }} dateRange
 * @returns {{
 *   portfolioScore: number,
 *   healthyCount: number,
 *   warningCount: number,
 *   criticalCount: number,
 *   properties: Array<Object>
 * }}
 */
export function evaluatePortfolioDataHealth(properties = [], dataByProperty = {}, dateRange = { from: '', to: '' }) {
  const propertyHealths = properties.map((prop) => {
    const propData = dataByProperty[prop.id] || {};
    return evaluatePropertyDataHealth({
      propertyId: prop.id,
      propertyName: prop.name,
      occRows: propData.occRows || [],
      srcRows: propData.srcRows || [],
      grossRows: propData.grossRows || [],
      payRows: propData.payRows || [],
      uploadedReports: propData.uploadedReports || [],
      dateRange,
    });
  });

  const healthyCount = propertyHealths.filter((p) => p.status === 'healthy').length;
  const warningCount = propertyHealths.filter((p) => p.status === 'warning').length;
  const criticalCount = propertyHealths.filter((p) => p.status === 'critical').length;

  const totalScore = propertyHealths.reduce((acc, p) => acc + p.overallScore, 0);
  const portfolioScore = propertyHealths.length > 0 ? Math.round(totalScore / propertyHealths.length) : 0;

  return {
    portfolioScore,
    healthyCount,
    warningCount,
    criticalCount,
    properties: propertyHealths,
  };
}

/**
 * Reconciles reported HotelKey Revenue Summary with calculated ledger totals.
 *
 * @param {number} reportedGross Total from PMS Revenue Summary / Final Audit
 * @param {number} calculatedGross Total calculated from raw rows
 * @returns {{
 *   reported: number,
 *   calculated: number,
 *   difference: number,
 *   isBalanced: boolean,
 *   status: 'reconciled' | 'discrepancy'
 * }}
 */
export function reconcileFinancialTotals(reportedGross = 0, calculatedGross = 0) {
  const diffCents = Math.abs(toCents(reportedGross) - toCents(calculatedGross));
  const isBalanced = diffCents === 0;

  return {
    reported: fromCents(toCents(reportedGross)),
    calculated: fromCents(toCents(calculatedGross)),
    difference: fromCents(diffCents),
    isBalanced,
    status: isBalanced ? 'reconciled' : 'discrepancy',
  };
}
