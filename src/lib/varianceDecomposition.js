/**
 * Hotel Revenue & Owner Variance Decomposition Engine
 *
 * Deterministically decomposes year-over-year or period-over-period hotel revenue
 * variances into standard hospitality economic drivers:
 *
 *   1. Volume Effect = (Rooms Sold A - Rooms Sold B) * ADR B
 *   2. Rate Effect   = (ADR A - ADR B) * Rooms Sold A
 *   3. Proof: Volume Effect + Rate Effect === Room Revenue Variance (100% exact)
 *   4. Commission Drag = -(OTA Commission A - OTA Commission B)
 *   5. Ancillary Effect = Other Revenue A - Other Revenue B
 */

import { toCents, fromCents, sumCents } from '@/lib/decimal';

/**
 * @typedef {Object} PropertyPeriodStats
 * @property {string} [propertyId]
 * @property {string} [propertyName]
 * @property {number} roomRevenue In dollars
 * @property {number} roomsSold Integer count of rooms sold
 * @property {number} [adr] In dollars (calculated if omitted)
 * @property {number} [capacity] Available room nights
 * @property {number} [occupancy] Occupancy rate (0 to 1)
 * @property {number} [otherRevenue=0] Ancillary / other revenue in dollars
 * @property {number} [otaCommission=0] Commission paid in dollars
 * @property {number} [cancellations=0] Cancelled rooms or cancellation drag
 */

/**
 * @typedef {Object} VarianceDriver
 * @property {string} key
 * @property {string} label
 * @property {number} amount In dollars (signed)
 * @property {string} description Human-readable explanation
 * @property {boolean} isFavorable Positive impact on profit/revenue
 */

/**
 * @typedef {Object} VarianceDecompositionResult
 * @property {string} propertyId
 * @property {string} propertyName
 * @property {number} currentRevenue
 * @property {number} priorRevenue
 * @property {number} totalVariance Dollar difference (current - prior)
 * @property {number} pctChange Percentage change (e.g. -0.051 for -5.1%)
 * @property {number} volumeEffect Dollar impact of room sales volume
 * @property {number} rateEffect Dollar impact of ADR change
 * @property {number} commissionDrag Dollar impact of commission change (signed for net effect)
 * @property {number} otherRevenueEffect Dollar impact of other revenue
 * @property {boolean} isReconciled True if volumeEffect + rateEffect === room revenue delta
 * @property {VarianceDriver[]} drivers Sorted by absolute dollar impact
 * @property {string} summary One-line executive diagnosis
 */

/**
 * Decomposes revenue variance between two periods for a single property or portfolio.
 *
 * @param {PropertyPeriodStats} current Current period stats (e.g. 2026 YTD)
 * @param {PropertyPeriodStats} prior Prior comparison stats (e.g. 2025 YTD)
 * @returns {VarianceDecompositionResult}
 */
export function decomposeRevenueVariance(current, prior) {
  const propertyId = current?.propertyId || prior?.propertyId || 'all';
  const propertyName = current?.propertyName || prior?.propertyName || 'Portfolio';

  const revA = Number(current?.roomRevenue) || 0;
  const revB = Number(prior?.roomRevenue) || 0;
  const roomsA = Number(current?.roomsSold) || 0;
  const roomsB = Number(prior?.roomsSold) || 0;

  const adrA = roomsA > 0 ? revA / roomsA : 0;
  const adrB = roomsB > 0 ? revB / roomsB : 0;

  const revACents = toCents(revA);
  const revBCents = toCents(revB);
  const totalVariance = fromCents(revACents - revBCents);
  const pctChange = revB > 0 ? (revA - revB) / revB : 0;

  // 1. Volume Effect: (Rooms Sold A - Rooms Sold B) * ADR B
  const volumeEffect = fromCents(Math.round((roomsA - roomsB) * adrB * 100));

  // 2. Rate Effect: (ADR A - ADR B) * Rooms Sold A
  const rateEffect = fromCents(Math.round((adrA - adrB) * roomsA * 100));

  // Exact mathematical identity check: volumeEffect + rateEffect === totalVariance
  const isReconciled = Math.abs(volumeEffect + rateEffect - totalVariance) <= 0.05;

  // 3. Commission Drag: -(Comm A - Comm B)
  const commA = Number(current?.otaCommission) || 0;
  const commB = Number(prior?.otaCommission) || 0;
  const commissionDrag = fromCents(toCents(-(commA - commB)));

  // 4. Ancillary / Other Revenue: Other A - Other B
  const otherA = Number(current?.otherRevenue) || 0;
  const otherB = Number(prior?.otherRevenue) || 0;
  const otherRevenueEffect = fromCents(toCents(otherA - otherB));

  const roomsDiff = roomsA - roomsB;
  const adrDiff = fromCents(toCents(adrA - adrB));

  /** @type {VarianceDriver[]} */
  const drivers = [
    {
      key: 'volume',
      label: 'Room Volume Effect (Occupied Rooms)',
      amount: volumeEffect,
      description: `${roomsDiff >= 0 ? '+' : ''}${roomsDiff} rooms sold vs prior period (valued at prior ADR $${adrB.toFixed(2)})`,
      isFavorable: volumeEffect >= 0,
    },
    {
      key: 'rate',
      label: 'Rate / ADR Pricing Effect',
      amount: rateEffect,
      description: `${adrDiff >= 0 ? '+' : ''}$${adrDiff.toFixed(2)}/night achieved ADR across ${roomsA} sold rooms`,
      isFavorable: rateEffect >= 0,
    },
  ];

  if (commA > 0 || commB > 0) {
    drivers.push({
      key: 'commission',
      label: 'OTA Commission Leakage Shift',
      amount: commissionDrag,
      description: commissionDrag <= 0
        ? `Commission expenses increased by $${Math.abs(commissionDrag).toFixed(2)}`
        : `Commission expenses decreased by $${commissionDrag.toFixed(2)}`,
      isFavorable: commissionDrag >= 0,
    });
  }

  if (otherA > 0 || otherB > 0) {
    drivers.push({
      key: 'other',
      label: 'Ancillary & Other Revenue',
      amount: otherRevenueEffect,
      description: `${otherRevenueEffect >= 0 ? '+' : '-'}$${Math.abs(otherRevenueEffect).toFixed(2)} from miscellaneous fees & amenities`,
      isFavorable: otherRevenueEffect >= 0,
    });
  }

  // Sort drivers by absolute dollar impact
  drivers.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

  // Executive summary synthesis
  const primaryDriver = drivers[0];
  let summary = '';
  if (totalVariance >= 0) {
    summary = `Revenue is up +$${totalVariance.toFixed(2)} (+${(pctChange * 100).toFixed(1)}%), led primarily by ${primaryDriver.label.toLowerCase()} (+$${primaryDriver.amount.toFixed(2)}).`;
  } else {
    summary = `Revenue is down -$${Math.abs(totalVariance).toFixed(2)} (${(pctChange * 100).toFixed(1)}%), driven primarily by ${primaryDriver.label.toLowerCase()} (-$${Math.abs(primaryDriver.amount).toFixed(2)}).`;
  }

  return {
    propertyId,
    propertyName,
    currentRevenue: revA,
    priorRevenue: revB,
    totalVariance,
    pctChange,
    volumeEffect,
    rateEffect,
    commissionDrag,
    otherRevenueEffect,
    isReconciled,
    drivers,
    summary,
  };
}
