import { toCents, fromCents, sumCents } from '@/lib/decimal';

// ─── Daily batch chain checksum (4-way reconciliation) ─────────────────────
//
// NOT CRYPTOGRAPHIC, despite what three comments in this file claimed until
// 2026-08-24. This is multiply-by-31-and-add string folding — Java's
// String.hashCode — into a 32-bit int. It detects a figure that changed by
// accident, and nothing more. Anyone who can alter a number can recompute the
// chain, so it is not tamper evidence and must never be cited as such. The real
// HMAC-SHA256 audit chain lives in securityUtils.js and the base44 serverless
// audit functions; calling this one "cryptographic" made it look like a second
// copy of that guarantee, which is how a reviewer ends up trusting the wrong one.
//
// Two encoding defects fixed at the same time, both of which overstated it:
//
//   Math.abs(h) discarded the sign bit, so h and -h produced the SAME checksum.
//   That is collisions by construction — not merely improbable ones — in the
//   function whose only job is to notice that a number changed. Now `h >>> 0`,
//   which keeps all 32 bits.
//
//   padStart(16, '0') presented the result as a 16-hex-digit (64-bit) digest when
//   at most 8 of those digits can ever be non-zero. Now padded to 8, so the
//   printed width states the real strength instead of eight leading zeros of
//   borrowed credibility.
//
// Reachability, measured 2026-08-24: reconcileDailyFinancials below is imported
// only by src/lib/hotelKeyRegression.test.js. No page renders it.
function computeBatchChecksum(date, pmsTotalCents, gatewayNetCents, merchantNetCents, bankDepositCents, prevHash) {
  const payload = [date, pmsTotalCents, gatewayNetCents, merchantNetCents, bankDepositCents, prevHash || 'GENESIS'].join('|');
  let h = 0;
  for (let i = 0; i < payload.length; i++) {
    const ch = payload.charCodeAt(i);
    h = ((h << 5) - h + ch) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * reconcileDailyFinancials
 *
 * Performs a 4-way reconciliation between HotelKey PMS records, payment-gateway
 * authorizations, merchant batch settlements, and bank deposits. (This said
 * "3-way" and omitted the gateway leg until 2026-08-24, while the body already
 * computed gatewayAuthVariance and labelled itself 4-way — the parameter list and
 * the prose disagreed about how many sources were being checked.)
 *
 * Each day is compared across four sources:
 *   1. PMS — card_revenue, cash_revenue, direct_bill (recorded in the property management system)
 *   2. Gateway — token_authorized_amount less fee_deductions (from the card gateway)
 *   3. Merchant — settled_amount and fee_deductions (from the payment processor)
 *   4. Bank — deposit_amount (actual bank deposit)
 *
 * Reconciliation logic per day:
 *   - Merchant net settlement = settled_amount - fee_deductions
 *   - cardVariance = pmsCardRevenue - merchantNetSettlement
 *       (0 = MATCHED, >0 = SHORTAGE, <0 = EXCESS)
 *   - Expected deposit = merchantNet + cashRevenue
 *   - depositVariance = bankDeposit - expectedDeposit
 *
 * Period summary:
 *   - totalPmsRevenue = sum of bank deposits
 *   - totalMerchantSettled = sum of merchant net settlements
 *   - totalCashRevenue = sum of PMS cash revenue
 *   - netVariance = totalPmsRevenue - (totalMerchantSettled + totalCashRevenue)
 *   - reconciliationHealth: 'HEALTHY' when netVariance === 0, else 'VARIANCE_DETECTED'
 *
 * All math uses fixed-decimal integer arithmetic (cents) to avoid float errors.
 *
 * @param {Object} params
 * @param {Array<{date: string, card_revenue: number, cash_revenue: number, direct_bill?: number}>} [params.pmsRecords]
 * @param {Array<{date: string, token_authorized_amount: number, fee_deductions?: number}>} [params.gatewayAuths]
 * @param {Array<{date: string, settled_amount: number, fee_deductions?: number}>} [params.merchantBatches]
 * @param {Array<{date: string, deposit_amount: number}>} [params.bankDeposits]
 * @returns {{ periodSummary: Object, days: Array<Object>, auditChain: Array<Object>, auditRoot: string }}
 */
export function reconcileDailyFinancials({ pmsRecords = [], gatewayAuths = [], merchantBatches = [], bankDeposits = [] }) {
  const pmsByDate = new Map((pmsRecords || []).map(r => [r.date, r]));
  const gatewayByDate = new Map((gatewayAuths || []).map(g => [g.date, g]));
  const merchantByDate = new Map((merchantBatches || []).map(b => [b.date, b]));
  const depositByDate = new Map((bankDeposits || []).map(d => [d.date, d]));

  const allDates = new Set([
    ...pmsByDate.keys(),
    ...gatewayByDate.keys(),
    ...merchantByDate.keys(),
    ...depositByDate.keys(),
  ]);

  const sortedDates = [...allDates].sort();

  let totalPmsRevenue = 0;
  let totalMerchantSettled = 0;
  let totalCashRevenue = 0;
  let prevAuditHash = 'GENESIS';
  const auditChain = [];

  const days = sortedDates.map(date => {
    const pms = pmsByDate.get(date);
    const gateway = gatewayByDate.get(date);
    const merchant = merchantByDate.get(date);
    const deposit = depositByDate.get(date);

    const gatewayAuthAmount = gateway ? toCents(gateway.token_authorized_amount || 0) : 0;
    const gatewayFeeDeductions = gateway ? toCents(gateway.fee_deductions || 0) : 0;
    const gatewayNetCents = gatewayAuthAmount - gatewayFeeDeductions;

    const pmsCardRevenue = pms ? toCents(pms.card_revenue) : 0;
    const cashRevenue = pms ? toCents(pms.cash_revenue) : 0;
    const directBill = pms ? toCents(pms.direct_bill || 0) : 0;

    const settledAmount = merchant ? toCents(merchant.settled_amount) : 0;
    const feeDeductions = merchant ? toCents(merchant.fee_deductions || 0) : 0;
    const merchantNet = settledAmount - feeDeductions;

    const bankDeposit = deposit ? toCents(deposit.deposit_amount) : 0;

    // 4-Way Reconciliation Pipeline:
    // 1. PMS Gross  2. Gateway Auth  3. Merchant Settlement  4. Bank Deposit
    // Gateway authorization variance: gateway token auth vs PMS card revenue
    const gatewayAuthVarianceCents = gatewayNetCents - pmsCardRevenue;

    // Card variance: PMS card revenue vs merchant net settlement
    const cardVarianceCents = pmsCardRevenue - merchantNet;

    // Deposit variance: actual deposit vs expected (card net + cash)
    const expectedDepositCents = merchantNet + cashRevenue;
    const depositVarianceCents = bankDeposit - expectedDepositCents;

    const pmsTotalCents = pmsCardRevenue + cashRevenue + directBill;

    // Chain checksum for this daily batch. See computeBatchChecksum above: this
    // is accident detection, not tamper evidence.
    const auditBatchHash = computeBatchChecksum(date, pmsTotalCents, gatewayNetCents, merchantNet, bankDeposit, prevAuditHash);
    prevAuditHash = auditBatchHash;
    auditChain.push({ date, hash: auditBatchHash, gatewayVariance: gatewayAuthVarianceCents, gatewayStatus: gatewayAuthVarianceCents === 0 ? 'MATCHED' : (gatewayAuthVarianceCents > 0 ? 'GATEWAY_EXCESS' : 'GATEWAY_SHORTAGE') });

    // Daily status based on card variance
    let status;
    if (cardVarianceCents === 0) {
      status = 'MATCHED';
    } else if (cardVarianceCents > 0) {
      status = 'SHORTAGE';
    } else {
      status = 'EXCESS';
    }

    // If deposit exists and doesn't match expected, escalate status
    if (deposit && depositVarianceCents !== 0 && status === 'MATCHED') {
      status = 'DEPOSIT_VARIANCE';
    }

    totalPmsRevenue += bankDeposit;
    totalMerchantSettled += merchantNet;
    totalCashRevenue += cashRevenue;

    return {
      date,
      pmsTotal: fromCents(pmsTotalCents),
      pmsCard: fromCents(pmsCardRevenue),
      pmsCash: fromCents(cashRevenue),
      pmsCardRevenue: fromCents(pmsCardRevenue),
      cashRevenue: fromCents(cashRevenue),
      directBill: fromCents(directBill),
      gatewayAuth: fromCents(gatewayAuthAmount),
      gatewayNet: fromCents(gatewayNetCents),
      gatewayAuthVariance: fromCents(gatewayAuthVarianceCents),
      gatewayStatus: auditChain[auditChain.length - 1].gatewayStatus,
      merchantSettledNet: fromCents(merchantNet),
      merchantNetSettled: fromCents(merchantNet),
      feeDeductions: fromCents(feeDeductions),
      bankDeposited: fromCents(bankDeposit),
      bankDeposit: fromCents(bankDeposit),
      cardVariance: fromCents(cardVarianceCents),
      depositVariance: fromCents(depositVarianceCents),
      expectedDeposit: fromCents(expectedDepositCents),
      status,
      auditHash: auditBatchHash,
    };
  });

  const netVarianceCents = totalPmsRevenue - (totalMerchantSettled + totalCashRevenue);
  const reconciliationHealth = netVarianceCents === 0 ? 'HEALTHY' : 'VARIANCE_DETECTED';

  return {
    periodSummary: {
      totalPmsRevenue: fromCents(totalPmsRevenue),
      totalBankDeposited: fromCents(totalPmsRevenue),
      totalMerchantSettled: fromCents(totalMerchantSettled),
      totalCashRevenue: fromCents(totalCashRevenue),
      netVariance: fromCents(netVarianceCents),
      reconciliationHealth,
    },
    auditChain: auditChain,
    auditRoot: prevAuditHash,
    days,
  };
}


import { revenueReconciliation } from './RevenueReconciliation.js';

// Production analytics layers
import { summarize } from './transactionAnalytics.js';
import { revenueSplit, PERIODS, PERIOD_LABEL } from './statisticsAnalytics.js';

/**
 * Cross-check the revenue derivations for a period and return a traceable gross
 * revenue figure.
 *
 * FIXED 2026-08-19 — two defects, both of which produced a wrong number silently:
 *
 *   1. It passed the section name as lowercase `'revenue'`. Section matching was
 *      exact, the vendor export ships `'Revenue'`, so the filter matched NOTHING
 *      and the entire statistics leg evaluated to $0.00. Because the old
 *      reconciler AVERAGED the three paths, that zero did not raise an error — it
 *      dragged gross revenue down by roughly a third and returned it as fact
 *      ($677,285.61 against a true $1,020,598.17 on the Middleborough export).
 *      Now uses the STAT_SECTIONS constant via revenueSplit(), so a typo is a
 *      build-time reference error rather than a runtime $0. statisticsAnalytics
 *      also matches sections case-insensitively now, closing the same trap for
 *      any future caller.
 *
 *   2. It compared room revenue against total revenue. OccupancyDay.room_revenue
 *      excludes ancillary lines, so the ~$9,339.50 of pet fees, laundry and
 *      restaurant charges was reported as "drift" on every single run. Now the
 *      statistics ROOM subtotal is handed to the reconciler as the baseline for
 *      the occupancy leg, so each path is compared with something measuring the
 *      same quantity.
 *
 * Returns the full reconciliation alongside the figure: a caller that only gets a
 * number back cannot tell whether it came from the night-audit export or from a
 * fallback, and that provenance is the whole point of reconciling.
 *
 * @param {string} dateRange free-form label recorded with the result, e.g. "2026 YTD"
 * @param {Array<Object>} [transactionRows]
 * @param {Array<Object>} [statisticsRows]
 * @param {Array<Object>} [occupancyRows]
 * @param {{statisticsPeriod?: string}} [options] which statistics column to read
 * @returns {Promise<number>} gross revenue (also see .reconciliation on the result of
 *          reconcileRevenuePaths if you need provenance)
 */
export async function enforceFinancialInvariant(dateRange, transactionRows = [], statisticsRows = [], occupancyRows = [], options = {}) {
  return (await reconcileRevenuePaths(dateRange, transactionRows, statisticsRows, occupancyRows, options)).grossRevenue;
}

/**
 * The same cross-check, but returning provenance as well as the figure.
 *
 * @param {string} dateRange free-form label recorded with the result
 * @param {Array<Object>} [transactionRows]
 * @param {Array<Object>} [statisticsRows]
 * @param {Array<Object>} [occupancyRows]
 * @param {{statisticsPeriod?: string}} [options]
 * @returns {Promise<{grossRevenue: number, reconciliation: Object}>}
 */
export async function reconcileRevenuePaths(dateRange, transactionRows = [], statisticsRows = [], occupancyRows = [], { statisticsPeriod = 'ytd' } = {}) {
  const transactionRevenue = summarize(transactionRows).revenue;

  // ── Which statistics window is being compared, and why it is a parameter ────
  //
  // FIXED 2026-08-20. This read `revenueSplit(statisticsRows, 'ytd')` — a literal
  // — while the transaction and occupancy legs measure whatever ROWS the caller
  // handed in. The two legs are scoped by different mechanisms: a statistics
  // snapshot carries no date column at all (one business date, five period
  // columns), so its window is chosen by which COLUMN you read, whereas the other
  // two legs are already filtered by the caller. Reconciling a March transaction
  // ledger against the year-to-date column compares two different quantities and
  // reports the difference as "drift" — the exact failure mode the two fixes
  // above removed, arriving by a third route.
  //
  // This module cannot detect the mismatch on its own: nothing in the snapshot
  // says what window the caller's rows cover. So the window is now an explicit
  // parameter, it is recorded in the returned reconciliation, and an unrecognised
  // value throws instead of quietly falling back to year-to-date. A silent
  // fallback here is what turned a typo into a $343,312.56 error once already.
  const validPeriods = PERIODS.map(([key]) => key);
  if (!validPeriods.includes(statisticsPeriod)) {
    throw new Error(
      `[FinancialReconciliation] Unknown statisticsPeriod "${statisticsPeriod}". ` +
      `Expected one of: ${validPeriods.join(', ')}. The statistics leg is scoped by ` +
      `which period column is read, so an unrecognised value cannot be guessed.`
    );
  }

  // The Revenue section split into its room and ancillary halves. `total` is
  // comparable to the transaction ledger; `room` is comparable to OccupancyDay.
  const split = revenueSplit(statisticsRows, statisticsPeriod);

  // A statistics leg of exactly 0 from an EMPTY input is "not available", not
  // "zero revenue" — pass null so the reconciler excludes it instead of treating
  // it as a real figure that disagrees with everything else.
  const hasStatistics = Array.isArray(statisticsRows) && statisticsRows.length > 0;
  const statisticsRevenue = hasStatistics ? split.total : null;
  const statisticsRoomRevenue = hasStatistics ? split.room : null;

  const occupancyRevenue = Array.isArray(occupancyRows) && occupancyRows.length > 0
    ? fromCents(sumCents(occupancyRows.map((r) => r.room_revenue)))
    : null;

  const reconciliation = revenueReconciliation.reconcile(
    statisticsRevenue,
    transactionRevenue,
    occupancyRevenue,
    dateRange,
    { statisticsRoomRevenue },
  );

  if (reconciliation.drift_detected) {
    console.warn(`[FinancialReconciliation] Revenue drift detected: ${reconciliation.drift_details}`);
  }

  return {
    grossRevenue: reconciliation.authoritative_revenue,
    // The statistics window is recorded alongside the result because it is not
    // recoverable from the figure: two runs over the same snapshot can differ
    // solely by which period column was read, and a reader comparing them needs
    // to see that rather than infer drift.
    reconciliation: { ...reconciliation, statistics_period: statisticsPeriod, statistics_period_label: PERIOD_LABEL[statisticsPeriod] || statisticsPeriod },
  };
}

