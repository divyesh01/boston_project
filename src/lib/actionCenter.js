import { CalculationService } from '@/lib/calculationService';
import { getCcFeeRate, getCcFeeOnRefunds } from '@/lib/commissionRates';
import { getOccThreshold, money, money2, pct } from '@/lib/hotel';
import { CARD_METHODS, refundTotal } from '@/lib/paymentNorm';
import { sumCommittedPay } from '@/lib/payrollCalc';
import { toCents, fromCents, fromRate, sumCents, add, subtract, multiply, divideRate } from '@/lib/decimal';

function isoKey(d) {
  return String(d || '').slice(0, 10);
}

// COUNTS ONLY — rooms sold, down room-nights, physical inventory. Integers are
// exact in floating point, so these do not need scaling; routing them through
// cents would imply a precision they do not have.
function sum(rows, key) {
  return rows.reduce((a, r) => a + (Number(r[key]) || 0), 0);
}

// MONEY. Every dollar figure in this file is accumulated in integer cents and
// converted back once, because this module's output sits next to the Dashboard's
// MoneyKept for the same period and the two must agree to the cent.
//
// WHY THIS IS NOT COSMETIC (measured with node, 2026-08-20):
//   [10.1, 0.2]        float-summed = 10.299999999999999   via sumCents = 10.3
//   [1234.56, 0.07, 0.1, 0.2] = 1234.9299999999998         via sumCents = 1234.93
//   0.07 x 1000 rows   float-summed = 69.99999999999966    via sumCents = 70
// (Not every fixture drifts — [19.99, 0.01, 0.1, 0.2] left-folds to exactly 20.3.
// Which values drift depends on the running total, which is why the assertions in
// scripts/probe-decimal-integration.mjs first prove the fixture distinguishes the
// two routes before asserting the product takes the right one.)
//
// Over a month of transaction rows the residue is invisible on a rounded card
// and NOT invisible in a reconciliation: src/lib/calculationService.js already
// computes revenue, card fees and payroll in cents, so a float sum here made the
// Action Center and the Dashboard disagree about the same month by amounts that
// could not be traced to any row.
//
// BEST OUTCOME NOTE (2026-08-20): converting at the boundaries (cents inside,
// dollars on the way out) is better than switching this module's public shape to
// cents. Every consumer — src/pages/ActionCenter.jsx and the money()/money2()
// formatters — takes dollars, and changing that would be a rewrite of the page
// for no gain. The invariant that matters is that no dollar value is ever
// produced by adding two dollar values.
const sumMoney = (rows, key) => fromCents(sumCents((rows || []).map((r) => r[key])));

// MONEY × COUNT. decimal.js has multiply(money, rate) but no money-times-count:
// routing a room-night count through toRate() would divide it by RATE_SCALE and
// silently return a number 10,000x too small. Distinct from multiply() on
// purpose — the second argument here is a quantity of things, not a fraction.
//
// Rounds once, at the end, so a fractional count (which dirty imported rows can
// produce — `rooms_sold` is coerced with Number(), not parsed as an integer)
// still lands on a whole cent instead of a repeating binary fraction.
const moneyTimesCount = (dollars, count) => {
  const n = Number(count);
  if (!Number.isFinite(n)) return 0;
  return fromCents(Math.round(toCents(dollars) * n));
};


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
  eventsInRange = [],
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
  const otaGross = sumMoney(otaChannels, 'gross');
  const otaCommission = sumMoney(otaChannels, 'commission');
  const otaRate = otaGross > 0 ? otaCommission / otaGross : 0;

  const directGross = sumMoney(
    channelMetrics.filter((c) => (c.type || 'none') === 'none'),
    'gross',
  );
  const directRatio = revenue > 0 ? directGross / revenue : 0;

  // ── Payments / fees / refunds ──
  const payInPeriod = payRows.filter((r) => inPeriod(r.date));
  // Flattened to one cent sum rather than a nested float reduce: the inner
  // accumulator ran once per card method per row, so the residue compounded with
  // the row count.
  const cardVolume = fromCents(
    sumCents(payInPeriod.flatMap((r) => CARD_METHODS.map((k) => r[k]))),
  );
  const ccFee = getCcFeeRate();
  // multiply() is the same call src/lib/calculationService.js:208 makes for this
  // exact quantity. Computing it here with `cardVolume * ccFee` meant the
  // Dashboard and the Action Center could print two different card-fee figures
  // for one month, with no row to blame.
  const ccFees = fromCents(multiply(cardVolume, ccFee));
  const refunds = refundTotal(payInPeriod);
  const ccFeeOnRefunds = getCcFeeOnRefunds() ? fromCents(multiply(refunds, ccFee)) : 0;
  const refundRate = revenue > 0 ? refunds / revenue : 0;

  // ── Expenses / payroll ──
  const expInPeriod = expenses.filter((e) => inPeriod(e.expense_date));
  const payRunInPeriod = payroll.filter((p) => inPeriod(p.pay_period_start));

  // Actual drawings recorded by the owner as Expense rows. The dashboard's
  // MoneyKept uses an "actual beats-estimate" rule for OTA commission and card
  // fees: when the owner entered the real invoice/merchant statement, that
  // number is the deduction and the rate-card estimate is discarded. Mirroring
  // it here stops the Action Center from charging the same cost twice.
  const amountOf = (rows) => sumMoney(rows, 'amount');
  const otaActual = amountOf(expInPeriod.filter((e) => e.category === 'ota_commission'));
  const ccActual = amountOf(expInPeriod.filter((e) => e.category === 'credit_card_fees'));

  // Approved/paid only — mirrors MoneyKept so the two never disagree about the
  // same month. A draft run is not yet committed money.
  const payrollTotal = fromCents(add(
    sumCommittedPay(payRunInPeriod),
    amountOf(expInPeriod.filter((e) => e.category === 'payroll')),
  ));

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
  const oosLoss = moneyTimesCount(adr || 0, downNights);

  // ── Period-over-period deltas ──
  // These two are RATIOS, and deliberately stay float division: pct() quantises
  // to at most 2 decimal places before anything is displayed or compared, so a
  // sub-basis-point residue cannot reach the screen or change a threshold test.
  // Only accumulations and money-times-rate products are converted — a ratio that
  // is immediately rounded is not where cent drift comes from.
  const revDeltaPct = prevStats && prevStats.revenue > 0
    ? (revenue - prevStats.revenue) / prevStats.revenue
    : null;
  const occDropPoints = prevStats ? occupancy - prevStats.occupancy : null;
  // Money, so it is differenced in cents: this value is printed as a dollar
  // figure in the red "revenue is down" card AND used as that card's impact
  // score, which orders the top-3 list.
  const revenueLostVsPrev = prevStats
    ? Math.max(0, fromCents(subtract(prevStats.revenue, revenue)))
    : 0;
  // ── Weekend rate opportunity ──
  const weekendRows = occRows.filter((r) => {
    const d = new Date(`${isoKey(r.date)}T00:00:00`);
    return d.getDay() === 0 || d.getDay() === 6;
  });
  const weekendRevenue = sumMoney(weekendRows, 'room_revenue');
  const weekendRoomsSold = sum(weekendRows, 'rooms_sold');
  const weekendAdr = weekendRoomsSold > 0 ? weekendRevenue / weekendRoomsSold : 0;
  const weekendCap = sum(weekendRows, 'total_rooms');
  const weekendOccupancy = weekendCap > 0 ? weekendRoomsSold / weekendCap : 0;
  const weekendGap = adr > 0 ? fromCents(subtract(adr, weekendAdr)) : 0;

  // ── Top expense anomaly ──
  const sortedExpenses = [...expInPeriod].sort((a, b) => (Number(b.amount) || 0) - (Number(a.amount) || 0));
  const topExpense = sortedExpenses[0];
  const secondExpense = sortedExpenses[1];
  const expCount = expInPeriod.length;
  // Compared in cents. A float 2.5x threshold can flip this card on and off for
  // two amounts that are equal to the cent, and the card accuses a specific vendor
  // row of being an anomaly — that decision must be reproducible.
  const topExpenseOutlier = topExpense && (
    expCount >= 3 && toCents(topExpense.amount) > multiply(secondExpense?.amount, 2.5)
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
    // (target − actual) occupancy points × capacity = the room-nights the shortfall
    // represents; × ADR = what they were worth; × 0.5 because only about half of a
    // theoretical gap is realistically recoverable inside the period. One rounding,
    // at the end, in moneyTimesCount.
    const gapRoomNights = capacity > 0 ? (occThreshold - occupancy) * capacity * 0.5 : 0;
    fix.push({
      tone: 'red',
      key: 'occ-target',
      title: `Occupancy ${pct(occupancy)} is below the ${pct(occThreshold)} target`,
      detail: `${roomsSold} rooms sold in the period. A same-day offer on weak nights could close the gap.`,
      impact: moneyTimesCount(adr || 0, gapRoomNights),
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
      impact: fromCents(toCents(payrollTotal) - multiply(revenue, 0.2)),
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
    // A whole-dollar rate suggestion — an owner cannot action "raise weekend rates
    // by $12.37". Routed through multiply() anyway so the pre-rounding value is
    // cent-exact and the $5 floor is applied to a number, not to float noise.
    const suggestedLift = Math.max(5, Math.round(fromCents(multiply(weekendAdr, 0.08))));
    opportunity.push({
      tone: 'green',
      key: 'weekend-rate',
      title: `Weekend rooms sell well but price below weekdays`,
      detail: `Weekend occupancy is ${pct(weekendOccupancy)} with ADR ${money2(weekendAdr)} — ${money2(weekendGap)} below the period average. A ${money(suggestedLift)} lift on weekend rates could add ~${money(moneyTimesCount(suggestedLift, weekendRoomsSold))} this period.`,
      impact: moneyTimesCount(suggestedLift, weekendRoomsSold),
      to: '/rooms',
      metrics: [
        ['Weekend occupancy', pct(weekendOccupancy)],
        ['Weekend ADR', money2(weekendAdr)],
        ['Period ADR', money2(adr)],
      ],
    });
  }

  if (otaRate > 0.12 && directRatio < 0.4) {
    const shiftable = fromCents(multiply(otaGross, 0.2));
    const saving = fromCents(multiply(shiftable, otaRate));
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

  // 🟢 EVENT-BASED DEMAND INTELLIGENCE — pricing opportunities around local events
  if (eventsInRange && eventsInRange.length > 0) {
    const demandTierOrder = { 'Maximum': 4, 'Very High': 3, 'High': 2, 'Moderate to High': 1.5, 'Moderate': 1 };
    
    // Group events by date
    const eventsByDate = {};
    eventsInRange.forEach(e => {
      if (!eventsByDate[e.date]) eventsByDate[e.date] = [];
      eventsByDate[e.date].push(e);
    });

    // For each date with events, calculate peak demand
    Object.entries(eventsByDate).forEach(([date, dayEvents]) => {
      const maxDemand = dayEvents.reduce((max, e) => {
        const tier = demandTierOrder[e.demand] || 0;
        return tier > max ? tier : max;
      }, 0);
      const _maxDemandLabel = Object.keys(demandTierOrder).find(k => demandTierOrder[k] === maxDemand) || 'Moderate';
      const closestEvent = dayEvents.reduce((closest, e) => 
        (e.distance || 999) < (closest.distance || 999) ? e : closest
      );

      // Only surface actionable events within 35 miles
      if (closestEvent.distance <= 35 && maxDemand >= 2) {
        // All rows for the date, not the first one. This PMS legitimately emits
        // several occupancy rows per (property, business_date), so `occRows.find()`
        // described the whole day using one arbitrary slice of it: this card could
        // advise a rate lift "at 30% occupancy" on a date that was in fact 90% sold,
        // and then price the uplift against rooms that were already gone. Routed
        // through CalculationService rather than recomputed inline so the per-day
        // inventory rule (see capacityCents there) applies here too instead of being
        // copied a fourth time.
        const dayRows = occRows.filter(r => isoKey(r.date) === date);
        const dayStats = dayRows.length
          ? CalculationService.calculateOccupancyMetrics(dayRows, roomCounts)
          : null;
        const dayOccupancy = dayStats ? dayStats.occupancy : 0;
        const dayAdr = dayStats && dayStats.adr > 0 ? dayStats.adr : adr;
        const dayCapacity = dayStats && dayStats.capacity > 0
          ? dayStats.capacity
          : (roomCounts[Object.keys(roomCounts)[0]] || 100);
        const daySold = dayStats ? dayStats.roomsSold : 0;

        const suggestedLiftPct = maxDemand === 4 ? 0.35 : maxDemand === 3 ? 0.25 : maxDemand === 2 ? 0.15 : 0.10;
        const suggestedLift = Math.max(10, Math.round(fromCents(multiply(dayAdr || adr, suggestedLiftPct))));
        const roomsAvailable = Math.max(0, dayCapacity - daySold);
        const estimatedUplift = moneyTimesCount(suggestedLift, roomsAvailable);

        opportunity.push({
          tone: 'green',
          key: `event-demand-${date}`,
          title: `High-demand event: ${closestEvent.name} (${closestEvent.demand} demand)`,
          detail: `${closestEvent.name} at ${closestEvent.venue} (${closestEvent.distance} mi) — ${closestEvent.priceRange}. Current occupancy ${pct(dayOccupancy)} with ADR ${money2(dayAdr)}. Suggest ${money(suggestedLift)} rate lift on ${date} could capture ~${money(estimatedUplift)}.`,
          impact: estimatedUplift,
          to: '/rooms',
          metrics: [
            ['Event', closestEvent.name],
            ['Demand Tier', closestEvent.demand],
            ['Distance', `${closestEvent.distance} mi`],
            ['Current Occ', pct(dayOccupancy)],
            ['Suggested Lift', money(suggestedLift)],
            ['Est. Uplift', money(estimatedUplift)],
          ],
        });
      }
    });

    // Multi-day event clusters (surge periods)
    const sortedDates = Object.keys(eventsByDate).sort();
    let clusterStart = null;
    let clusterEvents = [];
    sortedDates.forEach((date, idx) => {
      const dayEvents = eventsByDate[date];
      const maxDemand = dayEvents.reduce((max, e) => Math.max(max, demandTierOrder[e.demand] || 0), 0);
      if (maxDemand >= 3) {
        if (!clusterStart) clusterStart = date;
        clusterEvents.push(...dayEvents);
      } else if (clusterStart) {
        // End of cluster
        if (idx > 0 && sortedDates[idx - 1] === sortedDates[sortedDates.length - 1]) {
          // Handle last date
        }
      }
    });

    // Check for 2+ consecutive high-demand days
    for (let i = 0; i < sortedDates.length - 1; i++) {
      const d1 = sortedDates[i];
      const d2 = sortedDates[i + 1];
      const day1Max = Math.max(...eventsByDate[d1].map(e => demandTierOrder[e.demand] || 0));
      const day2Max = Math.max(...eventsByDate[d2].map(e => demandTierOrder[e.demand] || 0));
      
      const date1Obj = new Date(d1).getTime();
      const date2Obj = new Date(d2).getTime();
      const diffDays = Math.round((date2Obj - date1Obj) / 86400000);
      
      if (diffDays === 1 && day1Max >= 2 && day2Max >= 2) {
        const eventNames = [...new Set([...eventsByDate[d1], ...eventsByDate[d2]].map(e => e.name))].slice(0, 3).join(', ');
        opportunity.push({
          tone: 'green',
          key: `event-cluster-${d1}-${d2}`,
          title: `Multi-day surge: ${eventNames}`,
          detail: `Back-to-back high-demand events on ${d1} & ${d2}. Implement 2-night minimum stay and dynamic pricing across both nights to maximize RevPAR.`,
          impact: 0, // Strategic, not directly calculable
          to: '/rooms',
          metrics: [
            ['Period', `${d1} → ${d2}`],
            ['Events', eventNames],
            ['Strategy', '2-night min + dynamic pricing'],
          ],
        });
      }
    }
  }

  // 🟢 KEEP GOING — what's working
  if (revDeltaPct !== null && revDeltaPct > 0) {
    keepDoing.push({
      tone: 'cyan',
      key: 'rev-up',
      title: `Revenue is ${pct(revDeltaPct)} above previous period`,
      detail: `${money(revenue)} vs ${money(prevStats.revenue)}. Whatever you changed, keep doing it.`,
      impact: fromCents(subtract(revenue, prevStats.revenue)),
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
  const ccEstimatedTotal = fromCents(add(ccFees, ccFeeOnRefunds));
  const otaResolved = otaActual > 0 ? otaActual : otaCommission;
  const ccResolved = ccActual > 0 ? ccActual : ccEstimatedTotal;

  // The headline number. Summed in cents and divided once, quantised to basis
  // points by divideRate — the same quantisation pct() applies for display, so the
  // printed percentage is exactly the value that was computed rather than a
  // rounded view of a slightly different one.
  //
  // BEST OUTCOME NOTE (2026-08-20): this mirrors how src/lib/calculationService.js
  // derives MoneyKept, which is the point. Both are shown to the owner for the same
  // period, often on the same screen, and before this change five dollar figures
  // were float-added here and cent-added there. Two "money kept" percentages that
  // differ by a hundredth of a point with no row to blame is worse than either
  // being slightly off, because it makes the owner distrust both pages.
  const deductionsTotal = fromCents(
    sumCents([otaResolved, ccResolved, refunds, payrollTotal, operatingExpenses]),
  );
  const keepRate = revenue > 0 ? 1 - fromRate(divideRate(deductionsTotal, revenue)) : 0;

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
      ccEstimated: ccEstimatedTotal,
      refunds,
      downNights,
      oosLoss,
      keepRate,
    },
    buckets: { fix, investigate, opportunity, keepDoing },
    top3,
    meta: {
      // Distinct business dates, not row count. Several occupancy rows per date are
      // normal here, so `occRows.length` reported a 31-day month as 60-odd days.
      periodDays: new Set(occRows.map((r) => isoKey(r.date))).size,
      comparedToPrev: !!prevStats,
      stats,
      prevStats,
    },
  };
}