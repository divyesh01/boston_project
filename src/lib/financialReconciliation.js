import { toCents, fromCents, sumCents } from '@/lib/decimal';

/**
 * reconcileDailyFinancials
 *
 * Performs a 3-way reconciliation between HotelKey PMS records, merchant
 * batch settlements, and bank deposits.
 *
 * Each day is compared across three sources:
 *   1. PMS — card_revenue, cash_revenue, direct_bill (recorded in the property management system)
 *   2. Merchant — settled_amount and fee_deductions (from the payment processor)
 *   3. Bank — deposit_amount (actual bank deposit)
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
 * @param {Array<{date: string, card_revenue: number, cash_revenue: number, direct_bill?: number}>} params.pmsRecords
 * @param {Array<{date: string, settled_amount: number, fee_deductions?: number}>} params.merchantBatches
 * @param {Array<{date: string, deposit_amount: number}>} params.bankDeposits
 * @returns {{ periodSummary: Object, days: Array<Object> }}
 */
export function reconcileDailyFinancials({ pmsRecords = [], merchantBatches = [], bankDeposits = [] }) {
  const pmsByDate = new Map((pmsRecords || []).map(r => [r.date, r]));
  const merchantByDate = new Map((merchantBatches || []).map(b => [b.date, b]));
  const depositByDate = new Map((bankDeposits || []).map(d => [d.date, d]));

  const allDates = new Set([
    ...pmsByDate.keys(),
    ...merchantByDate.keys(),
    ...depositByDate.keys(),
  ]);

  const sortedDates = [...allDates].sort();

  let totalPmsRevenue = 0;
  let totalMerchantSettled = 0;
  let totalCashRevenue = 0;

  const days = sortedDates.map(date => {
    const pms = pmsByDate.get(date);
    const merchant = merchantByDate.get(date);
    const deposit = depositByDate.get(date);

    const pmsCardRevenue = pms ? toCents(pms.card_revenue) : 0;
    const cashRevenue = pms ? toCents(pms.cash_revenue) : 0;
    const directBill = pms ? toCents(pms.direct_bill || 0) : 0;

    const settledAmount = merchant ? toCents(merchant.settled_amount) : 0;
    const feeDeductions = merchant ? toCents(merchant.fee_deductions || 0) : 0;
    const merchantNet = settledAmount - feeDeductions;

    const bankDeposit = deposit ? toCents(deposit.deposit_amount) : 0;

    // Card variance: PMS card revenue vs merchant net settlement
    const cardVarianceCents = pmsCardRevenue - merchantNet;

    // Deposit variance: actual deposit vs expected (card net + cash)
    const expectedDepositCents = merchantNet + cashRevenue;
    const depositVarianceCents = bankDeposit - expectedDepositCents;

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
      pmsCardRevenue: fromCents(pmsCardRevenue),
      cashRevenue: fromCents(cashRevenue),
      directBill: fromCents(directBill),
      merchantNetSettled: fromCents(merchantNet),
      feeDeductions: fromCents(feeDeductions),
      bankDeposit: fromCents(bankDeposit),
      cardVariance: fromCents(cardVarianceCents),
      depositVariance: fromCents(depositVarianceCents),
      expectedDeposit: fromCents(expectedDepositCents),
      status,
    };
  });

  const netVarianceCents = totalPmsRevenue - (totalMerchantSettled + totalCashRevenue);
  const reconciliationHealth = netVarianceCents === 0 ? 'HEALTHY' : 'VARIANCE_DETECTED';

  return {
    periodSummary: {
      totalPmsRevenue: fromCents(totalPmsRevenue),
      totalMerchantSettled: fromCents(totalMerchantSettled),
      totalCashRevenue: fromCents(totalCashRevenue),
      netVariance: fromCents(netVarianceCents),
      reconciliationHealth,
    },
    days,
  };
}
