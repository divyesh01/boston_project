import { CalculationService } from '@/lib/calculationService';
import { getCcFeeRate, getCcFeeOnRefunds } from '@/lib/commissionRates';
import { getOccThreshold, money, money2, pct } from '@/lib/hotel';
import { CARD_METHODS, refundTotal } from '@/lib/paymentNorm';
import { sumCommittedPay } from '@/lib/payrollCalc';

function isoKey(d) {
  return String(d || '').slice(0, 10);
}

function sum(rows, key) {
  return rows.reduce((a, r) => a + (Number(r[key]) || 0), 0);
}

// Build the owner-action view-model. Pure function over the rows the page already
// fetches; keeps all thresholds local so the UI stays a thin renderer.
//
// `refundTotal` is the project-wide helper on purpose: refund fields are stored
// SIGNED, and taking |abs| per field before summing would inflate the total
// whenever a positive correction offsets a negative one. That trap is
// documented in paymentNorm.js and we defer to it here.
export function buildActionCenter({
  occRows = [], srcRows = [], payRows = [],
  expenses = [], payroll = [],
  roomCounts = {}, dateRange = { from: '', to: '' },
  prevOccRows = [],
}) {
  const from = dateRange.from || '';
  const to = dateRange.to || '';
  const inPeriod = (dateStr) => {
    const d = isoKey(dateStr);
    return !!d && d >= from && d <= to;
  };

  // ── Core stats (current + previous) ──
  const stats = CalculationService.calculateOccupancyMetrics(occRows, roomCounts);

  // Only trust the previous window for deltas when it actually covers most of the
  // current window. A delayed/partial import (e.g. last month only got half its rows
  // uploaded) would otherwise fabricate a scary "-40% revenue" from a comparison
  // that isn't apples-to-apples.
  const prevDays = prevOccRows.length;
  const curDays = occRows.length;
  const prevUsable = curDays > 0 && prevDays >= Math.max(1, Math.floor(curDays * 0.5));
  const prevStats = prevUsable
    ? CalculationService.calculateOccupancyMetrics(prevOccRows, roomCounts)
    : null;

  const occThreshold = getOccThreshold();
  const { revenue, roomsSold, occupancy, adr, capacity, revpar } = stats;

  // ── Channel / OTA analysis ──
  const channelMetrics = CalculationService.calculateChannelMetrics(srcRows);
  const otaChannels = channelMetrics.filter((c) => (c.type || 'none') !== 'none');
  const otaGross = sum(otaChannels, 'gross');
  const otaCommission = sum(otaChannels, 'commission');
  const otaRate = otaGross > 0 ? otaCommission / otaGross : 0;

  const directGross = channelMetrics
    .filter((c) => (c.type || 'none') === 'none')
    .reduce((a, c) => a + c.gross, 0);
  const directRatio = revenue > 0 ? directGross / revenue : 0;

  // ── Payments / fees / refunds ──
  const payInPeriod = payRows.filter((r) => inPeriod(r.date));
  const cardVolume = payInPeriod.reduce(
    (a, r) => a + CARD_METHODS.reduce((x, k) => x + (Number(r[k]) || 0), 0), 0
  );
  const ccFee = getCcFeeRate();
  const ccFees = cardVolume * ccFee;
  const refunds = refundTotal(payInPeriod);
  const ccFeeOnRefunds = getCcFeeOnRefunds() ? refunds * ccFee : 0;
  const refundRate = revenue > 0 ? refunds / revenue : 0;

  // ── Expenses / payroll ──
  const expInPeriod = expenses.filter((e) => inPeriod(e.expense_date));
  const payRunInPeriod = payroll.filter((p) => inPeriod(p.pay_period_start));

  // Actual drawings recorded by the owner as Expense rows. The dashboard's
  // MoneyKept uses an "actual beats-estimate" rule for OTA commission and card
  // fees: when the owner entered the real invoice/merchant statement, that
  // number is the deduction and the rate-card estimate is discarded. Mirroring
  // it here stops the Action Center from charging the same cost twice.
  const amountOf = (rows) => rows.reduce((a, e) => a + (Number(e.amount) || 0), 0);
  const otaActual = amountOf(expInPeriod.filter((e) => e.category === 'ota_commission'));
  const ccActual = amountOf(expInPeriod.filter((e) => e.category === 'credit_card_fees'));

  // Approved/paid only — mirrors MoneyKept so the two never disagree about the
  // same month. A draft run is not yet committed money.
  const payrollTotal = sumCommittedPay(payRunInPeriod) + amountOf(expInPeriod.filter((e) => e.category === 'payroll'));

  // Everything except the three handled-below-relevant buckets. Payroll is
  // summed with the PayrollRun records above; OTA commission and card fees are
  // handled by the actual-vs-estimate rule; so none of the three should ride
  // along inside operating expenses or they'd be deducted twice.
  const EXCLUDED_CATS = new Set(['ota_commission', 'credit_card_fees', 'payroll']);
  const operatingExpenses = amountOf(expInPeriod.filter((e) => !EXCLUDED_CATS.has(e.category)));
  const expenseTotal = amountOf(expInPeriod);
  const payrollRatio = revenue > 0 ? payrollTotal / revenue : 0;

  // ── Down rooms / OOS lost revenue ──
  const downNights = sum(occRows, 'down_rooms');
  const oosDays = occRows.filter((r) => Number(r.down_rooms) > 0).length;
  const oosLoss = downNights * (adr || 0);

  // ── Period-over-period deltas ──
  const revDeltaPct = prevStats && prevStats.revenue > 0
    ? (revenue - prevStats.revenue) / prevStats.revenue
    : null;
  const occDropPoints = prevStats ? occupancy - prevStats.occupancy : null;
  const revenueLostVsPrev = prevStats ? Math.max(0, prevStats.revenue - revenue) : 0;
  // ── Weekend rate opportunity ──
  const weekendRows = occRows.filter((r) => {
    const d = new Date(`${isoKey(r.date)}T00:00:00`);
    return d.getDay() === 0 || d.getDay() === 6;
  });
  const weekendRevenue = sum(weekendRows, 'room_revenue');
  const weekendRoomsSold = sum(weekendRows, 'rooms_sold');
  const weekendAdr = weekendRoomsSold > 0 ? weekendRevenue / weekendRoomsSold : 0;
  const weekendCap = sum(weekendRows, 'total_rooms');
  const weekendOccupancy = weekendCap > 0 ? weekendRoomsSold / weekendCap : 0;
  const weekendGap = adr > 0 ? adr - weekendAdr : 0;

  // ── Top expense anomaly ──
  const sortedExpenses = [...expInPeriod].sort((a, b) => (Number(b.amount) || 0) - (Number(a.amount) || 0));
  const topExpense = sortedExpenses[0];
  const secondExpense = sortedExpenses[1];
  const expCount = expInPeriod.length;
  const topExpenseOutlier = topExpense && (
    expCount >= 3 && Number(topExpense.amount) > 2.5 * (Number(secondExpense?.amount) || 0)
  );

  // ── Build buckets ──
  const fix = [];
  const investigate = [];
  const opportunity = [];
  const keepDoing = [];

  // 🔴 FIX — pain in the property, costs money today
  if (oosLoss > 0) {
    fix.push({
      tone: 'red',
      key: 'oos',
      title: 'Rooms out of service are costing you money',
      detail: `${downNights} down room-night${downNights === 1 ? '' : 's'} across ${oosDays} day${oosDays === 1 ? '' : 's'}. At period ADR that's an estimated ${money(oosLoss)} in lost booking revenue.`,
      impact: oosLoss,
      to: '/rooms',
    });
  }

  if (revDeltaPct !== null && revDeltaPct <= -0.05) {
    fix.push({
      tone: 'red',
      key: 'rev-drop',
      title: `Revenue is down ${pct(Math.abs(revDeltaPct))} vs previous period`,
      detail: `Revenue fell from ${money(prevStats.revenue)} to ${money(revenue)} — a loss of ${money(revenueLostVsPrev)} this period.`,
      impact: revenueLostVsPrev,
    });
  } else if (occDropPoints !== null && occDropPoints <= -0.05) {
    // Only used when total revenue did not already produce the signal above;
    // avoids firing two near-identical red cards for the same decline.
    fix.push({
      tone: 'red',
      key: 'occ-drop',
      title: `Occupancy dropped ${pct(Math.abs(occDropPoints))} vs previous period`,
      detail: `Occupancy went from ${pct(prevStats.occupancy)} to ${pct(occupancy)} — drags on both revenue and ADR.`,
      impact: revenueLostVsPrev,
    });
  }

  if (occupancy > 0 && occupancy < occThreshold) {
    fix.push({
      tone: 'red',
      key: 'occ-target',
      title: `Occupancy ${pct(occupancy)} is below the ${pct(occThreshold)} target`,
      detail: `${roomsSold} rooms sold in the period. A same-day offer on weak nights could close the gap.`,
      impact: capacity > 0 ? (occThreshold - occupancy) * capacity * (adr || 0) * 0.5 : 0,
    });
  }

  // 🟠 INVESTIGATE — money movement and costs that deserve a look
  if (otaRate > 0) {
    investigate.push({
      tone: 'amber',
      key: 'ota-leak',
      title: 'OTA commission is eating into rooms revenue',
      detail: `${otaChannels.length} OTA channel${otaChannels.length === 1 ? '' : 's'} produced ${money2(otaGross)} gross with ${money2(otaCommission)} commission — effective ${pct(otaRate, 1)}. Every point shifted to direct bookings stays in your pocket.`,
      impact: otaCommission,
      to: '/ota',
      metrics: [
        ['OTA gross', money2(otaGross)],
        ['Commission', money2(otaCommission)],
        ['Blend rate', pct(otaRate, 1)],
      ],
    });
  }

  if (ccFees > 0 && revenue > 0 && ccFees / revenue >= 0.015) {
    investigate.push({
      tone: 'amber',
      key: 'cc-fees',
      title: 'Card processing fees look high for current volume',
      detail: `Card fees are ${money2(ccFees)} on ${money2(cardVolume)} of card volume (${pct(ccFees / revenue, 2)} of revenue). Check the merchant rate and whether it's up for renegotiation.`,
      impact: ccFees,
      to: '/payments',
      metrics: [
        ['Card volume', money2(cardVolume)],
        ['Est. fees', money2(ccFees)],
        ['% of revenue', pct(ccFees / revenue, 2)],
      ],
    });
  }

  if (refunds > 0 && refundRate > 0.02) {
    investigate.push({
      tone: 'amber',
      key: 'refunds',
      title: `Refunds are ${pct(refundRate)} of revenue`,
      detail: `${money2(refunds)} in refunds this period. Confirm these all match real cancellations.`,
      impact: refunds,
      to: '/payments',
      metrics: [['Refunds', money2(refunds)], ['% of revenue', pct(refundRate)]],
    });
  }

  if (payrollRatio >= 0.2) {
    investigate.push({
      tone: 'amber',
      key: 'payroll',
      title: `Payroll is ${pct(payrollRatio)} of revenue`,
      detail: `${money2(payrollTotal)} in payroll against ${money2(revenue)} revenue — above the typical 20% guideline.`,
      impact: payrollTotal - revenue * 0.2,
      to: '/payroll',
      metrics: [['Payroll', money2(payrollTotal)], ['% of revenue', pct(payrollRatio, 1)]],
    });
  }

  if (topExpenseOutlier) {
    investigate.push({
      tone: 'amber',
      key: 'expense',
      title: `Largest expense: ${topExpense.expense_name || topExpense.category}`,
      detail: `${topExpense.vendor || '—'} · ${money2(topExpense.amount)} on ${isoKey(topExpense.expense_date)}, ${expCount > 2 ? `${expCount - 1} other expense${expCount > 3 ? 's' : ''} this period` : 'a large one-off'}. Verify it matches an invoice.`,
      impact: Number(topExpense.amount) || 0,
      to: '/expenses',
      metrics: [['Category', topExpense.category || '—'], ['Amount', money2(topExpense.amount)]],
    });
  }

  // 🟡 OPPORTUNITY — money you can still make
  if (weekendRoomsSold > 0 && weekendOccupancy >= 0.75 && weekendGap > 0) {
    const suggestedLift = Math.max(5, Math.round(weekendAdr * 0.08));
    opportunity.push({
      tone: 'green',
      key: 'weekend-rate',
      title: `Weekend rooms sell well but price below weekdays`,
      detail: `Weekend occupancy is ${pct(weekendOccupancy)} with ADR ${money2(weekendAdr)} — ${money2(weekendGap)} below the period average. A ${money(suggestedLift)} lift on weekend rates could add ~${money(weekendRoomsSold * suggestedLift)} this period.`,
      impact: weekendRoomsSold * suggestedLift,
      to: '/rooms',
      metrics: [
        ['Weekend occupancy', pct(weekendOccupancy)],
        ['Weekend ADR', money2(weekendAdr)],
        ['Period ADR', money2(adr)],
      ],
    });
  }

  if (otaRate > 0.12 && directRatio < 0.4) {
    const shiftable = otaGross * 0.2;
    const saving = shiftable * otaRate;
    opportunity.push({
      tone: 'green',
      key: 'ota-direct',
      title: 'Shift OTA volume to direct bookings',
      detail: `OTA pays an effective ${pct(otaRate, 1)} blend while direct costs you no commission. Moving 20% of OTA gross (${money2(shiftable)}) keeps ~${money2(saving)} out of commission.`,
      impact: saving,
      to: '/ota',
      metrics: [
        ['Direct share', pct(directRatio)],
        ['OTA blend', pct(otaRate, 1)],
        ['20% shift saves', money2(saving)],
      ],
    });
  }

  // 🟢 KEEP GOING — what's working
  if (revDeltaPct !== null && revDeltaPct > 0) {
    keepDoing.push({
      tone: 'cyan',
      key: 'rev-up',
      title: `Revenue is ${pct(revDeltaPct)} above previous period`,
      detail: `${money(revenue)} vs ${money(prevStats.revenue)}. Whatever you changed, keep doing it.`,
      impact: revenue - prevStats.revenue,
      metrics: [['Revenue', money2(revenue)], ['Previous', money2(prevStats.revenue)]],
    });
  }

  if (directRatio > 0.3) {
    keepDoing.push({
      tone: 'cyan',
      key: 'direct',
      title: `Direct bookings are ${pct(directRatio)} of revenue`,
      detail: 'Direct channels carry no commission — protect and grow this mix.',
      impact: directGross,
      metrics: [['Direct gross', money2(directGross)], ['Share', pct(directRatio)]],
    });
  }

  if (payrollRatio > 0 && payrollRatio <= 0.2) {
    keepDoing.push({
      tone: 'cyan',
      key: 'payroll-ok',
      title: `Payroll is a healthy ${pct(payrollRatio)} of revenue`,
      detail: `${money2(payrollTotal)} payroll on ${money2(revenue)} revenue — inside the typical 20% guideline.`,
      impact: payrollTotal,
      metrics: [['Payroll', money2(payrollTotal)], ['% of revenue', pct(payrollRatio)]],
    });
  }

  // ── Top 3 highest-value actions: only forward-looking stuff (fix + opportunity +
  // investigate). "Keep going" cards are informational, not actions.
  const top3 = [...fix, ...investigate, ...opportunity]
    .filter((a) => typeof a.impact === 'number' && a.impact > 0)
    .sort((a, b) => b.impact - a.impact)
    .slice(0, 3);

  // ── Resolve deductions for "money kept": actual invoices beat the estimate ──
  const otaResolved = otaActual > 0 ? otaActual : otaCommission;
  const ccResolved = ccActual > 0 ? ccActual : ccFees + ccFeeOnRefunds;

  return {
    premise: {
      revenue,
      occupancy,
      adr,
      revpar,
      roomsSold,
      capacity,
      payrollTotal,
      operatingExpenses,
      expenseTotal,
      otaCommission: otaResolved,
      ccFees: ccResolved,
      otaEstimated: otaCommission,
      ccEstimated: ccFees + ccFeeOnRefunds,
      refunds,
      downNights,
      oosLoss,
      keepRate: revenue > 0 ? 1 - (otaResolved + ccResolved + refunds + payrollTotal + operatingExpenses) / revenue : 0,
    },
    buckets: { fix, investigate, opportunity, keepDoing },
    top3,
    meta: {
      periodDays: occRows.length,
      comparedToPrev: !!prevStats,
      stats,
      prevStats,
    },
  };
}