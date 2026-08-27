import {
  toCents, fromCents, fromRate, add, subtract, multiply, divide, divideRate,
  sumCents
} from '@/lib/decimal';
import { commissionFor, grossRevenueForPeriod, grossUpFromNetCents } from '@/lib/hotel';
import { getTaxConfig, TAX_SOURCES } from '@/lib/taxConfig';
import { getEffectiveTaxRates, getTaxSettings } from '@/lib/taxSettings';
import { getCcFeeRate, getCcFeeOnRefunds } from '@/lib/commissionRates';
import { CARD_METHODS, refundTotal, refundTotalFromTotals } from '@/lib/paymentNorm';
import { filterCommittedPay } from '@/lib/payrollCalc';
// One shared deduction vocabulary, imported by this service and by
// src/components/dashboard/MoneyKept.jsx, so the two cannot disagree about which
// expense rows have a derived twin. See the note in that module.
import { expenseBucket, chooseActualOrEstimate, DERIVED_COST_BUCKETS } from '@/lib/expenseCategories';

function inRange(dateStr, from, to) {
  if (!dateStr) return false;
  const d = String(dateStr).slice(0, 10);
  // Empty/falsy bound = unbounded on that side. See src/lib/hotel.js inRange:
  // `d <= ''` rejects every real date, so an open upper bound must be skipped.
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}

function sum(rows, key) {
  return fromCents(sumCents((rows || []).map(r => r[key])));
}

// Classify booking source into tax bucket
function classifySource(r) {
  const text = `${r.source || ""} ${r.code || ""}`.toUpperCase();
  if (/EXPEDIA.*HOTEL COLLECT|EHC/.test(text)) return "EXPEDIA_HC";
  if (/BOOKING\.?COM.*HOTEL COLLECT|BHC/.test(text)) return "BOOKING_HC";
  if (/WALK|WIN/.test(text)) return "WALK_IN";
  if (/PROPERTY BOOKING|PRP|RR WEBSITE|WEB|RED ROOF APP|APP|CONTACT CENTER|CRS/.test(text)) return "PROPERTY_BOOKING";
  return "OTHER_OTA";
}

/**
 * Physical inventory for a set of occupancy rows, expressed in ROOM-CENTS
 * (rooms x 100) so it can be divided against the cent-scaled revenue and
 * rooms-sold totals without a second scaling step.
 *
 * WHY THE GROUPING EXISTS (2026-08-20)
 * ─────────────────────────────────────────────────────────────────────────────────
 * The fallback to "this property has N rooms" used to be applied ONCE PER ROW. A
 * property's inventory is a property of the DAY, not of the row, and this PMS
 * legitimately emits several occupancy rows for one (property, business_date) —
 * duplicate report sections are real data here, not corruption. So three rows for
 * one date, each with total_rooms missing or 0, bought three days of inventory:
 * capacity tripled, and occupancy and RevPAR — which divide BY capacity — were
 * reported at a third of their true value. The more complete the import, the worse
 * the understatement, and no single row looked wrong.
 *
 * Measured on the fixture in scripts/probe-decimal-integration.mjs: the live ledger
 * reported capacity 80 where the pre-aggregated daily cache reported 60, so the
 * Dashboard's two read paths disagreed about occupancy (18.33% vs 13.75%) and RevPAR
 * ($20.92 vs $15.69) for the same period.
 *
 * BEST OUTCOME NOTE: within a date the explicit total_rooms values are SUMMED, not
 * maxed. That is deliberate and it is the only choice that keeps the two read paths
 * equal: src/lib/dailyAggregates.js has already collapsed those rows into one
 * `occ_capacity_rooms` by summing, and a max cannot be recovered from a sum. The
 * fallback is what must not repeat, and it no longer does — it is used only when NO
 * row for that date carries an explicit inventory figure.
 *
 * @param {any[]} rows occupancy rows carrying `property_id`, `date`, `total_rooms`
 * @param {(pid: string) => number} roomsFor fallback inventory for a property
 * @returns {number} capacity in room-cents
 */
function capacityCents(rows, roomsFor) {
  /** @type {Map<string, { pid: string, explicit: number }>} */
  const byDay = new Map();
  (rows || []).forEach((r) => {
    const pid = r.property_id || '_default';
    const key = `${pid}|${String(r.date).slice(0, 10)}`;
    const rowRooms = Number(r.total_rooms) || 0;
    const cur = byDay.get(key);
    if (cur) cur.explicit += rowRooms > 0 ? rowRooms : 0;
    else byDay.set(key, { pid, explicit: rowRooms > 0 ? rowRooms : 0 });
  });

  let total = 0;
  byDay.forEach((day) => {
    const rooms = day.explicit > 0 ? day.explicit : roomsFor(day.pid);
    total += (Number(rooms) || 0) * 100;
  });
  return total;
}

export class CalculationService {
  static calculateOccupancyMetrics(occRows = [], propertyRoomCounts = {}) {
    const revenue = sumCents(occRows.map(r => r.room_revenue));
    const roomsSold = sumCents(occRows.map(r => r.rooms_sold));

    const capacity = capacityCents(occRows, (pid) => propertyRoomCounts?.[pid] ?? 100);

    const occupancy = capacity ? divideRate(roomsSold, capacity) : 0;
    const adr = roomsSold ? divide(revenue, roomsSold) : 0;
    const revpar = capacity ? divide(revenue, capacity) : 0;

    return {
      revenue: fromCents(revenue),
      roomsSold: fromCents(roomsSold),
      capacity: fromCents(capacity),
      occupancy: fromRate(occupancy),
      adr: fromCents(adr),
      revpar: fromCents(revpar),
    };
  }

  static calculatePerPropertyStats(occRows = [], properties = []) {
    const byProp = new Map();
    occRows.forEach((r) => {
      const pid = r.property_id || '_default';
      if (!byProp.has(pid)) byProp.set(pid, []);
      byProp.get(pid).push(r);
    });

    const results = [];
    byProp.forEach((rows, pid) => {
      const prop = properties.find((p) => p.id === pid);
      const fallbackRooms = prop?.rooms || 100;
      const revenue = sumCents(rows.map(r => r.room_revenue));
      const roomsSold = sumCents(rows.map(r => r.rooms_sold));
      // Same per-DAY inventory rule as calculateOccupancyMetrics — see capacityCents
      // above. This function had an identical copy of the per-row fallback, so the
      // per-property table on the portfolio view under-reported occupancy for exactly
      // the same reason, while the portfolio total came from the other copy.
      const capacity = capacityCents(rows, () => fallbackRooms);
      results.push({
        property_id: pid,
        property_name: prop?.name || rows[0]?.property_name || 'Unknown',
        revenue: fromCents(revenue),
        roomsSold: fromCents(roomsSold),
        occupancy: capacity ? fromRate(divideRate(roomsSold, capacity)) : 0,
        adr: roomsSold ? fromCents(divide(revenue, roomsSold)) : 0,
        revpar: capacity ? fromCents(divide(revenue, capacity)) : 0,
        // Distinct business dates, not row count. Same root cause as the capacity
        // bug above: this PMS emits several rows per date, so `rows.length` reported
        // more days than the period contains — sitting in the same table as the
        // occupancy figure it was inflating the denominator of.
        days: new Set(rows.map((r) => String(r.date).slice(0, 10))).size,
        rooms: fallbackRooms,
      });
    });
    return results.sort((a, b) => b.revenue - a.revenue);
  }

  static calculateChannelMetrics(srcRows = []) {
    // Gross accumulates in integer CENTS and the commission is applied with
    // multiply() (2026-08-20). Both mattered: the previous float `cur.gross +=`
    // followed by a float `c.gross * info.rate` meant the commission for a channel
    // could land on either side of a half-cent depending on how many rows the
    // channel arrived in. That is how the live ledger and the pre-aggregated daily
    // cache — which collapses several rows per channel per day into one — came out
    // a cent apart on total deductions for the same period.
    // net_revenue is POST-commission NET (owner model, 2026-08-27). Accumulate it
    // as net in integer CENTS, then gross UP once per channel via the shared
    // grossUpFromNetCents helper — so the single division is rounded exactly once
    // per channel and every surface derives the identical gross/commission.
    const map = new Map();
    srcRows.forEach((r) => {
      const key = r.source || r.code || 'UNKNOWN';
      const cur = map.get(key) || { source: key, netCents: 0, stays: 0 };
      cur.netCents += toCents(r.net_revenue);
      cur.stays += Number(r.stays) || 0;
      map.set(key, cur);
    });

    return [...map.values()]
      .filter((c) => c.netCents > 0 || c.stays > 0)
      .map((c) => {
        const info = commissionFor(c.source);
        const { grossCents, commissionCents } = grossUpFromNetCents(c.netCents, info, c.stays);
        const gross = fromCents(grossCents);
        // grossCents is an internal accumulator and is deliberately NOT spread into
        // the result: a cents-scaled field sitting next to dollar fields is exactly
        // how a consumer ends up rendering a number 100x too large.
        return {
          source: c.source,
          stays: c.stays,
          ...info,
          gross,
          commission: fromCents(commissionCents),
          net: fromCents(c.netCents),
          margin: grossCents ? fromRate(divideRate(fromCents(c.netCents), gross)) : 0,
        };
      })
      .sort((a, b) => b.net - a.net);
  }

  static calculatePaymentMetrics(payRows = []) {
    const methodTotals = {};
    const allFields = [...CARD_METHODS, 'cash', 'check', 'direct_bill', 'corpay', 'wire_transfer', 'loyalty_certificate', 'loyalty_discount', 'vip_pass', 'other', 'closed_balance_folio'];

    allFields.forEach(key => { methodTotals[key] = sum(payRows, key); });

    // Both totals in cents: cardTotal is the basis for the processing-fee deduction
    // and netPaymentCollected is reconciled against the transaction ledger, so
    // neither may carry a residue.
    const cardTotal = fromCents(sumCents(CARD_METHODS.map((k) => methodTotals[k])));
    const cashTotal = methodTotals.cash || 0;
    const totalCollected = sum(payRows, 'total');
    const refunds = refundTotalFromTotals(methodTotals);
    const netPaymentCollected = fromCents(subtract(totalCollected, refunds));

    return { methodTotals, cardTotal, cashTotal, totalCollected, refunds, netPaymentCollected };
  }

  static calculateTaxLiability(srcRows = [], grossRows = [], propertyId = null, dateRange = { from: '', to: '' }) {
    const taxConfig = getTaxConfig();
    if (!taxConfig.taxEnabled || getTaxSettings().length === 0) {
      // Every key the enabled path returns, so a caller reading `.estimated` or
      // `.imported` gets 0 rather than undefined — which would become NaN the
      // moment it reached toCents() and poison the whole deduction total.
      return { state: 0, city: 0, other: 0, total: 0, imported: 0, estimated: 0 };
    }

    // Per-date bases in integer CENTS. Grouping is by date already; the residue came
    // from accumulating dollars within a date, which changed which side of a
    // half-cent the rate product landed on once several source rows for one date
    // were collapsed by the daily-aggregate cache.
    const taxBase = new Map();
    srcRows.forEach((r) => {
      const src = TAX_SOURCES.find((s) => s.key === classifySource(r));
      // Also respect per-source taxExempt from commission rate settings
      const info = commissionFor(r.source || r.code);
      if (!src || !src.taxable || info.taxExempt) return;
      const d = String(r.date).slice(0, 10);
      // net_revenue is POST-commission NET; the taxable base is the grossed-up
      // booking value (gross up the tax base too — owner directive 2026-08-27).
      const { grossCents } = grossUpFromNetCents(toCents(r.net_revenue), info, r.stays);
      taxBase.set(d, (taxBase.get(d) || 0) + grossCents);
    });

    const taxImp = new Map();
    grossRows.forEach((r) => {
      const d = String(r.date).slice(0, 10);
      const cur = taxImp.get(d) || { state: 0, city: 0, other: 0 };
      cur.state += toCents(r.state_tax);
      cur.city += toCents(r.city_tax);
      cur.other += toCents(r.other_tax);
      taxImp.set(d, cur);
    });

    let stateCents = 0, cityCents = 0, otherCents = 0;
    // Imported and estimated tax are accumulated APART because they are different
    // kinds of money and only one of them is a cost to the owner.
    //
    // Imported tax sits on the PMS gross-charge ledger: it was collected from the
    // guest and is remitted onward, passing through the business without ever
    // being the owner's to keep. Estimated tax is what the owner will owe out of
    // pocket on revenue the PMS did not tax.
    //
    // WHY THIS SPLIT EXISTS (2026-08-20): the only caller, calculateMoneyKept,
    // deducted `total` — imported and estimated together — so every dollar of
    // guest-collected tax was charged against the owner's "money kept". The
    // dashboard widget has always deducted the estimated portion only and treated
    // the imported portion as pass-through. `total` is unchanged for anyone
    // reporting total LIABILITY, which is a real and different question.
    let importedCents = 0, estimatedCents = 0;
    const dates = new Set([...taxBase.keys(), ...taxImp.keys()]);
    dates.forEach(d => {
      if (!inRange(d, dateRange.from, dateRange.to)) return;
      const imp = taxImp.get(d);
      // Threshold is now a whole cent rather than 0.004 dollars, because the values
      // being tested are cents. Same intent: "was any tax actually imported".
      const hasImported = imp && (imp.state + imp.city + imp.other) > 0;
      if (hasImported) {
        stateCents += imp.state;
        cityCents += imp.city;
        otherCents += imp.other;
        importedCents += imp.state + imp.city + imp.other;
      } else {
        const base = fromCents(taxBase.get(d) || 0);
        const r = getEffectiveTaxRates(propertyId, d);
        const s = multiply(base, r.state);
        const c = multiply(base, r.city);
        const o = multiply(base, r.other);
        stateCents += s;
        cityCents += c;
        otherCents += o;
        estimatedCents += s + c + o;
      }
    });

    return {
      state: fromCents(stateCents),
      city: fromCents(cityCents),
      other: fromCents(otherCents),
      total: fromCents(stateCents + cityCents + otherCents),
      // Guest-collected, remitted onward: a liability, never an owner cost.
      imported: fromCents(importedCents),
      // Owed by the owner on revenue the PMS did not tax: a real cost.
      estimated: fromCents(estimatedCents),
    };
  }

  static calculateMoneyKept(occRows = [], srcRows = [], grossRows = [], payRows = [], expenses = [], payroll = [], dateRange = { from: '', to: '' }, propertyId = null) {
    // Gross comes from the SAME helper the dashboard widget uses, not from a
    // second local rule.
    //
    // WHY THIS CHANGED (2026-08-20): this line was `sumCents(occRows.map(r =>
    // r.room_revenue))` — room revenue only — while the widget that renders this
    // number, src/components/dashboard/MoneyKept.jsx:165, calls
    // grossRevenueForPeriod({ grossRows, occRows }) and therefore ADDS ancillary
    // charges (misc, food, bar, laundry, phone, …) whenever the gross-charge
    // ledger covers the period. Two routes to the single headline dollar figure
    // this widget exists to report. Worse, calculateMoneyKept already RECEIVES
    // grossRows — it just ignored them for gross and used them only for tax — so
    // it deducted taxes and expenses that ancillary revenue helped pay for while
    // refusing to count that revenue. That understates what the owner kept.
    //
    // BEST OUTCOME NOTE: routing both callers through one exported helper is the
    // better logic because divergence becomes impossible rather than merely
    // unlikely — there is no second rule left to drift. The helper also reports
    // WHICH ledger it used, so `grossBasis` is returned below and the UI can say
    // "Room Revenue" or "Total Revenue" instead of quietly swapping one for the
    // other. Row filtering stays the caller's job here, matching how occRows,
    // srcRows and payRows are already handled by every caller of this method.
    const grossBasis = grossRevenueForPeriod({ grossRows, occRows });
    const grossCents = grossBasis.cents;

    const ccFee = getCcFeeRate();
    const ccFeeRefunds = getCcFeeOnRefunds();

    const otaCommissionsCents = sumCents(this.calculateChannelMetrics(srcRows).map(c => c.commission));

    // Card volume is the sum of the CARD_METHODS columns — NOT
    // `total - cash - check`.
    //
    // WHY THIS CHANGED (2026-08-20): `total - cash - check` charged a credit-card
    // processing fee on every non-cash, non-check tender, which includes
    // direct_bill, corpay, wire_transfer, loyalty_certificate, loyalty_discount,
    // vip_pass, other and closed_balance_folio. None of those touch a card
    // processor. The effect was to overstate a deduction, which understates the
    // owner's "money kept" — the single number this whole widget exists to report.
    //
    // Evidence that this line was the outlier rather than the spec: the live
    // dashboard widget src/components/dashboard/MoneyKept.jsx:187 sums CARD_METHODS,
    // src/lib/actionCenter.js sums CARD_METHODS, and scripts/verify-money-kept.mjs
    // already asserted that CARD_METHODS deliberately excludes cash, check,
    // direct_bill and wire_transfer. Three sources agreed; this one did not.
    //
    // BEST OUTCOME NOTE: deriving the volume from the named card columns is the
    // better logic because it fails SAFE. A new tender column added to the schema
    // is not silently treated as a card (and charged a fee) — it is simply not a
    // card until someone adds it to CARD_METHODS, which is a one-line, reviewable
    // decision rather than an invisible consequence of a subtraction.
    const cardTotalCents = sumCents((payRows || []).flatMap(r => CARD_METHODS.map(k => r[k])));
    const ccFeesCents = multiply(fromCents(cardTotalCents), ccFee);

    const refundsDollars = refundTotal(payRows);
    const refundsCents = toCents(refundsDollars);
    let refundFeesCents = 0;
    if (ccFeeRefunds) refundFeesCents = multiply(refundsDollars, ccFee);

    const expInPeriod = expenses.filter(e => inRange(e.expense_date, dateRange.from, dateRange.to));
    // Approved/paid only (COMMITTED_PAYROLL_STATUSES in src/lib/payrollCalc.js) —
    // a draft run must not reduce the owner's "money kept".
    const payInPeriod = filterCommittedPay(payroll).filter(p => inRange(p.pay_period_start, dateRange.from, dateRange.to));

    // ── ACTUAL BEATS ESTIMATE ─────────────────────────────────────────────────
    //
    // WHY THIS CHANGED (2026-08-20). Three of the deductions below are DERIVED
    // from imported data at configured rates — OTA commission from the rate card,
    // card fees from card volume, taxes from the tax settings — and the owner can
    // ALSO enter each one as a real Expense row: the Expedia invoice, the merchant
    // statement, the tax payment. This method previously deducted the estimate and
    // then swept the owner's actual row into `operatingExpenses` as well, because
    // its only exclusion was the literal category 'payroll'. One cost, deducted
    // twice, understating the single number this method exists to report.
    //
    // The rule and the bucket vocabulary now come from
    // src/lib/expenseCategories.js, which src/components/dashboard/MoneyKept.jsx
    // also imports. That widget has applied this rule for some time and documents
    // three earlier double-counting bugs of its own; this method never received
    // it. As with the card-volume basis fixed earlier the same day, the other
    // implementations agreed and this one did not — MoneyKept.jsx:407-425 and
    // actionCenter.js:139-148 both do actual-beats-estimate.
    //
    // BEST OUTCOME NOTE: the rule lives in the shared module rather than being
    // copied a third time here, so the two surfaces cannot drift apart without
    // deleting an import. Each leg also reports WHICH basis is in force, so a UI
    // can label the line "(actual)" or "(estimated)" instead of silently swapping
    // one quantity for the other — the same contract `grossBasis` above provides.
    const bucketedCents = new Map();
    expInPeriod.forEach(e => {
      const b = expenseBucket(e.category);
      bucketedCents.set(b, (bucketedCents.get(b) || 0) + toCents(e.amount));
    });
    const actualCentsFor = (bucket) => bucketedCents.get(bucket) || 0;

    const otaLeg = chooseActualOrEstimate({
      actualCents: actualCentsFor('ota'),
      estimateCents: otaCommissionsCents,
      // With no SourceDay rows there is no rate card to estimate from, and a $0
      // "estimated" line would claim a measurement nobody made.
      estimateApplies: srcRows.length > 0,
    });

    const ccLeg = chooseActualOrEstimate({
      actualCents: actualCentsFor('credit_card_fees'),
      estimateCents: ccFeesCents,
    });
    // The derived refund fee rides with the ESTIMATE. A real merchant statement
    // already contains what the processor charged on refunds, so adding the
    // derived figure on top of it bills the owner twice for the same fee.
    const refundFeesAppliedCents = ccLeg.basis === 'actual' ? 0 : refundFeesCents;

    const taxLiability = this.calculateTaxLiability(srcRows, grossRows, propertyId, dateRange);
    // Only the ESTIMATED portion is an owner cost. The imported portion was
    // collected from the guest and is remitted onward — reported below as
    // passThroughTaxes so it stays visible instead of disappearing.
    const passThroughTaxesCents = toCents(taxLiability.imported);
    const taxLeg = chooseActualOrEstimate({
      actualCents: actualCentsFor('taxes'),
      estimateCents: toCents(taxLiability.estimated),
    });

    // Payroll-category expense rows belong on the payroll line beside the
    // committed runs. Excluding them from operating expenses was correct — they
    // would double-count a run — but nothing added them back, so a contract
    // cleaner filed under 'payroll' was silently dropped from every total.
    // MoneyKept.jsx:443 and actionCenter.js:145 both add them.
    const totalPayrollCents = sumCents(payInPeriod.map(p => p.total_pay)) + actualCentsFor('payroll');

    // Everything with no derived twin, which is every remaining bucket.
    const operatingExpensesCents = [...bucketedCents.entries()]
      .filter(([bucket]) => !DERIVED_COST_BUCKETS.includes(bucket))
      .reduce((acc, [, cents]) => acc + cents, 0);

    const otaCommissionsAppliedCents = otaLeg.cents;
    const ccFeesAppliedCents = ccLeg.cents;
    const estimatedTaxesCents = taxLeg.cents;

    const totalDeductionsCents = otaCommissionsAppliedCents + ccFeesAppliedCents + refundFeesAppliedCents + refundsCents + totalPayrollCents + operatingExpensesCents + estimatedTaxesCents;
    const keptCents = grossCents - totalDeductionsCents;

    // The rate is "kept out of what was keepable", so the denominator is revenue
    // less the money that was never the hotel's to keep. It has to be guarded on
    // its own: `gross > 0` did not stop a full-refund or all-tax period from
    // dividing by zero and reporting Infinity as a percentage.
    //
    // Imported tax needs no subtraction here: it is not inside grossCents at all.
    // GROSS_ANCILLARY_COMPONENTS in hotel.js lists the revenue columns, and the
    // state/city/other tax columns are not among them.
    const keepableBaseCents = grossCents - refundsCents - estimatedTaxesCents;

    return {
      gross: fromCents(grossCents),
      // Provenance for the figure above: "total" when the gross-charge ledger
      // covered the period, "room" when it did not. Returned rather than hidden
      // so a caller cannot present the two as the same quantity.
      grossBasis,
      otaCommissions: fromCents(otaCommissionsAppliedCents),
      ccFees: fromCents(ccFeesAppliedCents),
      refundFees: fromCents(refundFeesAppliedCents),
      refunds: fromCents(refundsCents),
      totalPayroll: fromCents(totalPayrollCents),
      operatingExpenses: fromCents(operatingExpensesCents),
      estimatedTaxes: fromCents(estimatedTaxesCents),
      // Guest-collected tax, remitted onward. Deliberately NOT part of
      // totalDeductions; reported so a caller can show the liability without
      // charging it to the owner.
      passThroughTaxes: fromCents(passThroughTaxesCents),
      // Which basis each contested leg is on, so a line can be labelled honestly.
      // "imported" on the tax leg means the estimate was zero because the PMS
      // already taxed the revenue — pass-through, not an absence of tax.
      basis: {
        ota: otaLeg.basis,
        cc: ccLeg.basis,
        tax: taxLeg.basis === 'estimated' && taxLeg.cents === 0 && passThroughTaxesCents > 0
          ? 'imported'
          : taxLeg.basis,
      },
      totalDeductions: fromCents(totalDeductionsCents),
      kept: fromCents(keptCents),
      keepRate: keepableBaseCents > 0 ? keptCents / keepableBaseCents : 0,
    };
  }

  static calculateProfitMetrics(occRows, payRows, expenses, payroll, dateRange) {
    const grossRevenue = sum(occRows, 'room_revenue');
    const refundsAndAdjustments = refundTotal(payRows);
    const netRevenue = fromCents(subtract(grossRevenue, refundsAndAdjustments));

    const expensesInPeriod = expenses.filter(e => inRange(e.expense_date, dateRange.from, dateRange.to));
    // Approved/paid only, same rule as calculateMoneyKept above.
    const payrollInPeriod = filterCommittedPay(payroll).filter(p => inRange(p.pay_period_start, dateRange.from, dateRange.to));

    // Bucketed through the shared vocabulary so this method splits expenses the
    // same way calculateMoneyKept does. Note the deliberate difference in what it
    // does with the result: this method deducts NO derived estimates — no OTA
    // commission, no card fees, no tax — so an ota_commission or credit_card_fees
    // expense row here has no twin to duplicate and correctly belongs in operating
    // expenses. Only the payroll bucket is separated, and it is separated so it can
    // be ADDED to the payroll line, not so it can be discarded.
    const expenseBuckets = new Map();
    expensesInPeriod.forEach(e => {
      const b = expenseBucket(e.category);
      if (!expenseBuckets.has(b)) expenseBuckets.set(b, []);
      expenseBuckets.get(b).push(e);
    });

    // FIXED 2026-08-20: a payroll-category expense row — a contract cleaner, an
    // agency invoice — was excluded from operating expenses (right: it would
    // double-count a PayrollRun) and then added nowhere, so it fell out of
    // totalCosts entirely and operating profit was overstated by its full amount.
    // The exclusion was half a rule.
    const totalPayroll = fromCents(add(
      sum(payrollInPeriod, 'total_pay'),
      sum(expenseBuckets.get('payroll') || [], 'amount'),
    ));
    // Routed through this module's own sum() — which is fromCents(sumCents(...)) —
    // rather than an inline reduce. The inline version was not merely imprecise:
    // `a + (e.amount || 0)` never coerced, so an Expense whose `amount` arrived
    // from a CSV import as the STRING "1250.00" made the accumulator a string,
    // every later row concatenated onto it, and the final toCents() of
    // "012 50.0034.50" was not finite — which decimal.js maps to 0. Operating
    // expenses silently disappeared from operating profit, and the returned
    // `operatingExpenses` field was a string that rendered as a run of digits.
    const operatingExpenses = fromCents(sumCents(
      [...expenseBuckets.entries()]
        .filter(([bucket]) => bucket !== 'payroll')
        .flatMap(([, rows]) => rows.map(e => e.amount)),
    ));
    const totalCosts = fromCents(add(totalPayroll, operatingExpenses));

    const operatingProfit = fromCents(subtract(netRevenue, totalCosts));
    const profitMargin = netRevenue > 0 ? operatingProfit / netRevenue : 0;

    return { grossRevenue, netRevenue, totalPayroll, operatingExpenses, totalCosts, operatingProfit, profitMargin };
  }

  /**
   * Projected revenue and profit under a set of what-if assumptions.
   *
   * ⚠️ CURRENTLY UNUSED. Measured 2026-08-20: `calculateForecast` has no callers
   * anywhere in src/, scripts/ or src/tests/. It is the one place in this module
   * that still does plain floating-point arithmetic on dollar amounts, and it is
   * left that way deliberately rather than converted: every input is an ASSUMPTION
   * (a percentage nudge on a rate, an occupancy guess), so integer-cent exactness
   * would assert a precision the numbers do not have, and rewriting dead code is
   * how a "fix" ships untested.
   *
   * IF THIS IS EVER WIRED TO A SCREEN: quantise the outputs to cents before they
   * are displayed or stored — `fromCents(toCents(x))` on each returned figure — or
   * a projection will render as $12345.670000000001. Do not let a forecast figure
   * flow into a reconciled total; those must be built from integer cents end to
   * end (see BUSINESS.md).
   */
  static calculateForecast(historicalData, assumptions) {
    const { dailyRevenue, dailyOccupancy, dailyAdr } = historicalData;
    const { rateAdjust, occupancyAdjust, adrAdjust, availableRooms, otaCommission, expenseAdjust, horizonDays } = assumptions;

    const adjRate = 1 + (rateAdjust || 0) / 100;
    const adjOcc = Math.min(1, Math.max(0, dailyOccupancy + (occupancyAdjust || 0) / 100));
    const adjAdr = (dailyAdr || 50) * adjRate + (adrAdjust || 0);

    const projectedRoomsSold = Math.round(availableRooms * adjOcc * horizonDays);
    const projectedRevenue = projectedRoomsSold * adjAdr;
    const otaCommissionAmount = projectedRevenue * (otaCommission || 0) / 100;
    const baseExpenses = dailyRevenue * horizonDays * 0.65;
    const projectedExpenses = baseExpenses * (1 + (expenseAdjust || 0) / 100);
    const netProfit = projectedRevenue - projectedExpenses - otaCommissionAmount;
    const projectedRevpar = availableRooms > 0 ? projectedRevenue / (availableRooms * horizonDays) : 0;

    return {
      revenue: projectedRevenue,
      roomsSold: projectedRoomsSold,
      occupancy: adjOcc,
      adr: adjAdr,
      revpar: projectedRevpar,
      expenses: projectedExpenses,
      otaCommission: otaCommissionAmount,
      netProfit,
      margin: projectedRevenue > 0 ? netProfit / projectedRevenue : 0,
    };
  }

  static calculatePortfolioComparison(currentRows = [], previousRows = [], propertyRoomCounts = {}, _properties = []) {
    const current = this.calculateOccupancyMetrics(currentRows, propertyRoomCounts);
    const previous = this.calculateOccupancyMetrics(previousRows, propertyRoomCounts);

    return {
      // Money diffs in cents; roomsSold is a count and occupancy is a rate, both
      // already exact / immediately quantised for display.
      revenue: { current: current.revenue, previous: previous.revenue, diff: fromCents(subtract(current.revenue, previous.revenue)) },
      roomsSold: { current: current.roomsSold, previous: previous.roomsSold, diff: current.roomsSold - previous.roomsSold },
      occupancy: { current: current.occupancy, previous: previous.occupancy, diff: current.occupancy - previous.occupancy },
      adr: { current: current.adr, previous: previous.adr, diff: fromCents(subtract(current.adr, previous.adr)) },
      revpar: { current: current.revpar, previous: previous.revpar, diff: fromCents(subtract(current.revpar, previous.revpar)) },
    };
  }
}

export const calculationService = new CalculationService();
export default CalculationService;