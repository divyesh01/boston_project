import { money2, pct, sum, inRange, C, CHART_COLORS, grossRevenueForPeriod, rowAncillaryRevenueCents } from "@/lib/hotel";
import { fromCents, toCents } from "@/lib/decimal";
import { CalculationService } from "@/lib/calculationService";
import { expenseLabel, STANDARD_CATEGORY_KEYS, expenseBucket, DERIVED_COST_BUCKETS } from "@/lib/expenseCategories";
import { buildTaxObject } from "@/lib/taxLiability";
import { filterCommittedPay } from "@/lib/payrollCalc";

// Pure calculation/view-model layer for MoneyKept.jsx.
// React owns data loading, memoization, state, and rendering; this module owns the
// deterministic transformation from row snapshots into owner-facing figures.

function bucketKey(dateStr, mode) {
  if (mode === "day") return dateStr;
  if (mode === "month") return dateStr.slice(0, 7);
  if (mode === "year") return dateStr.slice(0, 4);
  const dt = new Date(`${dateStr}T00:00:00`);
  const monday = new Date(dt);
  monday.setDate(dt.getDate() - ((dt.getDay() + 6) % 7));
  const mm = String(monday.getMonth() + 1).padStart(2, "0");
  const dd = String(monday.getDate()).padStart(2, "0");
  return `${monday.getFullYear()}-${mm}-${dd}`;
}

export function projectRecurringExpenses({ expenses = [], from = "", to = "" }) {
    const RECUR_MONTHS = { monthly: 1, quarterly: 3, yearly: 12 };
    const addPeriod = (iso, freq) => {
      const [y, m, d] = iso.split("-").map(Number);
      if (freq === "weekly") return new Date(Date.UTC(y, m - 1, d + 7)).toISOString().slice(0, 10);
      const months = RECUR_MONTHS[freq];
      if (!months) return iso;
      const first = new Date(Date.UTC(y, m - 1 + months, 1));
      const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
      first.setUTCDate(Math.min(d, lastDay));
      return first.toISOString().slice(0, 10);
    };
    const seriesMap = new Map();
    const extras = [];
    expenses.forEach((e) => {
      const base = String(e.expense_date || "").slice(0, 10);
      const freq = e.frequency || "one_time";
      if (!base || e.recurring === false || freq === "one_time") return;
      const key = `${String(e.expense_name || "").trim().toLowerCase()}|${e.category || "other"}|${e.property_id || ""}`;
      const s = seriesMap.get(key) || { entries: [] };
      s.entries.push({ property_id:e.property_id, date: base, amount: Number(e.amount) || 0, freq, category: e.category || "other", name: e.expense_name || "Recurring Expense" });
      seriesMap.set(key, s);
    });
    seriesMap.forEach((s) => {
      if (!s.entries.length) return;
      const sorted = [...s.entries].sort((a, b) => a.date.localeCompare(b.date));
      const first = sorted[0];
      if (!RECUR_MONTHS[first.freq] && first.freq !== "weekly") return;
      const entered = new Set(s.entries.map((x) => x.date));

      const HORIZON_DAYS = 1825;
      const effectiveFrom = from || first.date;
      const floorDate = first.date < effectiveFrom ? effectiveFrom : first.date;
      let projEnd = to;
      if (effectiveFrom && to) {
        const horizonEnd = new Date(new Date(effectiveFrom + "T00:00:00").getTime() + HORIZON_DAYS * 86400000)
          .toISOString().slice(0, 10);
        if (!projEnd || projEnd > horizonEnd) projEnd = horizonEnd;
      }
      let date = floorDate;
      let guard = 0;
      while (date <= (projEnd || effectiveFrom) && guard++ < 2000) {
        if (date >= effectiveFrom && !entered.has(date)) {
          extras.push({ property_id:first.property_id, expense_name: first.name, vendor: "Recurring", category: first.category, expense_date: date, amount: first.amount });
        }
        date = addPeriod(date, first.freq);
      }
    });
    return extras;
}

export function buildMoneyKeptBaseData({
  occRows = [],
  srcRows = [],
  grossRows = [],
  payRecords = [],
  expenses = [],
  payroll = [],
  from = "",
  to = "",
  aggPayRows = null,
  aggExpenses = null,
  recurringExtras = [],
}) {
    const payRows = (aggPayRows && aggPayRows.length) ? aggPayRows : payRecords.filter((r) => inRange(r.date, from, to));
    const expInPeriod = (aggExpenses && aggExpenses.length) ? aggExpenses : expenses.filter((e) => inRange(e.expense_date, from, to));
    // Only approved/paid runs reduce cash. Drafts are proposals, and counting
    // them here made money kept drop the moment a run was keyed in.
    const payInPeriod = filterCommittedPay(payroll).filter((p) =>
      inRange(p.pay_period_start, from, to)
    );
    const grossInPeriod = (grossRows || []).filter((r) => inRange(r.date, from, to));

    // Gross is the TOTAL the hotel collected, not room revenue alone. This used
    // to read `sum(occRows, "room_revenue")`, which silently excluded $9,339.50
    // of ancillary income (pet fees, laundry, restaurant, property damage, early
    // check-in, misc, AR adjustments) — money the owner kept, measured against a
    // base that pretended it did not exist, so the keep rate and every deduction
    // percentage below were computed against the wrong denominator.
    //
    // `grossRevenueForPeriod` reports which ledger it used. When the Gross
    // Revenue Report has no rows for the period it falls back to the occupancy
    // room ledger — the exact previous behaviour — and says so via `.basis` so
    // the UI can label a room-only figure honestly instead of overstating it.
    const grossBasis = grossRevenueForPeriod({ grossRows: grossInPeriod, occRows });
    const gross = grossBasis.dollars;

    // ── Imported PMS tax lines per day (state / city / other) ──
    const taxImp = new Map();
    grossInPeriod.forEach((r) => {
      const d = String(r.date).slice(0, 10);
      const cur = taxImp.get(d) || { state: 0, city: 0, other: 0, present:false };
      cur.present ||= r.tax_fields_present === true || (r.tax_fields_present !== false && ["state_tax","city_tax","other_tax"].some(key=>r[key] != null));
      cur.state += Number(r.state_tax) || 0;
      cur.city += Number(r.city_tax) || 0;
      cur.other += Number(r.other_tax) || 0;
      taxImp.set(d, cur);
    });

    // ── Day-level ledger ──
    const dayMap = new Map();
    const bump = (date, key, v) => {
      if (!date) return;
      const cur = dayMap.get(date) || { date, gross: 0, commission: 0, ccFee: 0, refundFee: 0, refunds: 0 };
      cur[key] += v;
      dayMap.set(date, cur);
    };
    // The day ledger must sum to the SAME figure as the headline gross:
    // `sumDay("gross")` is the denominator that allocates lump expenses and
    // payroll across days, so a day series summing to room revenue while the
    // headline reads total revenue would mis-allocate every lump deduction.
    // Room from the occupancy leg, ancillary from the charge ledger — the same
    // two halves grossRevenueForPeriod adds up.
    if (occRows.length) occRows.forEach((r) => bump(String(r.date).slice(0, 10), "gross", Number(r.room_revenue) || 0));
    else grossInPeriod.forEach(r=>bump(String(r.date).slice(0,10),"gross",Number(r.room_rent)||0));
    grossInPeriod.forEach((r) => bump(String(r.date).slice(0, 10), "gross", fromCents(rowAncillaryRevenueCents(r))));
    const channels = CalculationService.calculateChannelMetrics(srcRows);
    channels.forEach(c=>c.dailyCommission.forEach(d=>bump(d.date,"commission",fromCents(d.cents))));
    const cardFees = CalculationService.calculateCardFees(payRows);
    cardFees.daily.forEach(r=>bump(r.date,"ccFee",fromCents(r.feeCents)));
    const refundSummary = CalculationService.calculateRefunds(payRows);
    refundSummary.daily.forEach(r=>{bump(r.date,"refunds",fromCents(r.refundsCents));bump(r.date,"refundFee",fromCents(r.feeCents));});

    const dayTotals = [...dayMap.values()].sort((a,b)=>a.date.localeCompare(b.date)).map(day=>{
      const source=srcRows.filter(r=>String(r.date).slice(0,10)===day.date);
      const grossDay=grossInPeriod.filter(r=>String(r.date).slice(0,10)===day.date);
      const occDay=occRows.filter(r=>String(r.date).slice(0,10)===day.date);
      const tax=CalculationService.calculateTaxLiability(source,grossDay,null,{from:day.date,to:day.date},occDay);
      const imported=CalculationService.calculateTaxLiability([],grossDay,null,{from:day.date,to:day.date});
      return {...day,state:tax.state,city:tax.city,other:tax.other,passTax:tax.imported,deductTax:tax.estimated,impState:imported.state,impCity:imported.city,impOther:imported.other,taxBase:source.reduce((n,r)=>n+(Number(r.net_revenue)||0),0)||occDay.reduce((n,r)=>n+(Number(r.room_revenue)||0),0)};
    });

    const expRecord = (e) => ({
      name: e.expense_name || "Expense",
      detail: `${e.vendor || "—"} · ${e.category} · ${String(e.expense_date || "").slice(0, 10)}`,
      amount: Number(e.amount) || 0,
    });
    const otaFromSources = srcRows.length > 0;

    // ACTUAL-BEATS-ESTIMATE.
    //
    // Three costs can arrive by two different routes: OTA commission, card
    // processing fees and taxes are each *derived* from imported data at
    // configured rates, and can *also* be entered by the owner as a real expense
    // row (the invoice / merchant statement / tax payment). Deducting both
    // charges the owner twice for one cost.
    //
    // The rule below is applied identically to all three: if actual expense rows
    // exist in the period, they are the deduction and the estimate is discarded;
    // otherwise the estimate stands in. The label says which one is in force so
    // the number stays traceable to its source.
    //
    // Previously `ota_commission` was re-bucketed to "other" when SourceDay rows
    // existed, which moved it off the OTA line but left it in the total, and
    // `credit_card_fees` fell through to its own bucket and was pushed by the
    // generic category loop alongside the derived fee. Both double-counted.
    //
    // `expenseBucket` is the shared implementation (src/lib/expenseCategories.js);
    // it is behaviour-identical to the local `bucketOf` this replaced, plus it
    // trims and lower-cases the key so a category that escaped slugifyCategory
    // buckets the same way a well-formed one does.
    const expGroups = {};
    expInPeriod.forEach((e) => {
      const b = expenseBucket(e.category);
      (expGroups[b] = expGroups[b] || []).push(e);
    });
    const expRows = (b) => (expGroups[b] || []);
    const expAmt = (b) => expRows(b).reduce((a, e) => a + (Number(e.amount) || 0), 0);

    // Add recurring expenses (memoized above)
    recurringExtras.forEach((e) => {
      const b = expenseBucket(e.category);
      (expGroups[b] = expGroups[b] || []).push(e);
    });

    // Manual tax expense entries (real business tax outflows).
    // These read the "taxes" bucket that `expenseBucket` actually writes — the
    // previous code asked for `expRows("tax")` (singular), a bucket nothing ever
    // creates, so every manually entered state/city/other tax expense silently
    // evaluated to 0 and was dropped from both the deduction total and the
    // liability panel.
    const manualState = expRows("taxes").filter((e) => e.category === "state_taxes");
    const manualCity = expRows("taxes").filter((e) => e.category === "city_taxes");
    const manualStateAmt = manualState.reduce((a, e) => a + (Number(e.amount) || 0), 0);
    const manualCityAmt = manualCity.reduce((a, e) => a + (Number(e.amount) || 0), 0);
    const manualOtherTax = expRows("taxes").filter((e) => e.category === "taxes");
    const manualOtherTaxAmt = manualOtherTax.reduce((a, e) => a + (Number(e.amount) || 0), 0);
    const manualTaxAmt = manualStateAmt + manualCityAmt + manualOtherTaxAmt;

    // ── OTA commissions from imported SourceDay data ──
    const otaRecords = channels.filter(c=>c.gross>0 || c.commission>0).map(c=>({name:c.source,detail:`Gross ${money2(c.gross)} @ ${pct(c.rate,1)} commission`,amount:c.commission}));


    const ccRecords = cardFees.daily.map(r=>({name:r.date,detail:`Card volume ${money2(fromCents(r.cardTotalCents))} @ ${pct(r.rate,2)}`,amount:fromCents(r.feeCents)})).filter(r=>r.amount!==0);

    const refundRecords = dayTotals.filter((d) => d.refunds !== 0).map((d) => ({
      name: d.date,
      detail: "Closed balance folio + loyalty discount",
      amount: d.refunds,
    }));

    // Total refunded amount across the period — excluded from the keep-rate
    // denominator because money returned to the guest was never truly "kept".
    const refundsTotal = refundRecords.reduce((a, x) => a + x.amount, 0);

    const refundFeeRecords = dayTotals.filter((d) => d.refundFee !== 0).map((d) => ({
      name: d.date,
      detail: `Refund ${money2(d.refunds)} ? configured property refund fee`,
      amount: d.refundFee,
    }));

    // ── Deduction items ──
    const items = [];
    const pushItem = (key, label, amount, records, rate) => {
      if (Math.abs(amount) > 0.004) items.push({ key, label, amount: Math.round(amount * 100) / 100, records: records || [], rate: Number.isFinite(rate) ? rate : undefined });
    };

    // OTA commission — actual invoices beat the rate-card estimate.
    //
    // The branch decision comes from the shared `chooseActualOrEstimate`
    // (src/lib/expenseCategories.js) so this widget and
    // calculationService.js#calculateMoneyKept cannot disagree about which side
    // wins. It decides in integer cents, which is the same threshold the old
    // `> 0.004` dollar comparison expressed; the amounts pushed below stay in the
    // dollars this component displays.
    // Select actual versus estimated deductions inside each property, then sum.
    const costLedgers = [occRows, srcRows, grossInPeriod, payRows, [...expInPeriod, ...recurringExtras]];
    const ids = [...new Set(costLedgers.flat().map(r=>String(r.property_id ?? '')))];
    const costs = ids.map(id=>{
      const [occ,source,gross,pay,exp] = costLedgers.map(rows=>rows.filter(r=>String(r.property_id ?? '')===id));
      const value = CalculationService.calculateMoneyKept(occ,source,gross,pay,exp,[],{from,to},id || null);
      return {id,exp,source,gross,value};
    });
    const labelBasis = key => new Set(costs.map(c=>c.value.basis[key])).size===1 ? costs[0]?.value.basis[key] : 'mixed actual/estimated';
    const costTotal = key => fromCents(costs.reduce((n,c)=>n+toCents(c.value[key]),0));
    const recordsFor = (bucket,key,basisKey) => costs.flatMap(c=>c.value.basis[basisKey]==='actual'
      ? c.exp.filter(e=>expenseBucket(e.category)===bucket).map(expRecord)
      : [{name:c.id || 'Property',detail:'Estimated at configured property rates',amount:c.value[key]}]);
    pushItem('ota', 'OTA Commissions ('+labelBasis('ota')+')', costTotal('otaCommissions'), recordsFor('ota','otaCommissions','ota'));
    pushItem('cc', 'Credit Card Processing Fees ('+labelBasis('cc')+')', costTotal('ccFees'), recordsFor('credit_card_fees','ccFees','cc'));
    pushItem('refund_fee', 'CC Fee on Refunds', costTotal('refundFees'), costs.map(c=>({name:c.id || 'Property',detail:'Configured property refund fee',amount:c.value.refundFees})));
    const estimatedTaxFromRates = costTotal('estimatedTaxes');
    const taxIsActual = labelBasis('tax') === 'actual';
    const effectiveTaxRate = undefined;
    pushItem('taxes','Business Taxes ('+labelBasis('tax')+')',costTotal('estimatedTaxes'),recordsFor('taxes','estimatedTaxes','tax'));
    const liability = {state:0,city:0,other:0};
    for (const c of costs) {
      const imported = CalculationService.calculateTaxLiability([],c.gross,c.id || null,{from,to});
      const full = CalculationService.calculateTaxLiability(c.source,c.gross,c.id || null,{from,to},occRows.filter(r=>String(r.property_id ?? '')===c.id));
      for (const [key,category] of [['state','state_taxes'],['city','city_taxes'],['other','taxes']]) {
        const amount = c.value.basis.tax==='actual' ? imported[key] + c.exp.filter(e=>e.category===category).reduce((n,e)=>n+Number(e.amount || 0),0) : full[key];
        liability[key] = fromCents(toCents(liability[key])+toCents(amount));
      }
    }

    pushItem("payroll", "Payroll", sum(payInPeriod, "total_pay") + expAmt("payroll"), [
      ...payInPeriod.map((p) => ({
        name: p.employee_name || "Payroll",
        detail: `${String(p.pay_period_start || "").slice(0, 10)} → ${String(p.pay_period_end || "").slice(0, 10)}`,
        amount: Number(p.total_pay) || 0,
      })),
      ...expRows("payroll").map(expRecord),
    ].filter((x) => x.amount > 0));

    // Buckets already emitted above with their own actual-vs-estimate handling.
    // `credit_card_fees` MUST be among them: it is a standard category, so without
    // it the generic loop below would push the merchant statement a second time on
    // top of the line already emitted above. The set is DERIVED_COST_BUCKETS in
    // src/lib/expenseCategories.js, shared with calculationService.js.
    const customKeys = Object.keys(expGroups)
      .filter((b) => !DERIVED_COST_BUCKETS.includes(b) && !STANDARD_CATEGORY_KEYS.includes(b))
      .sort((a, b) => expAmt(b) - expAmt(a));
    [...STANDARD_CATEGORY_KEYS.filter((k) => expGroups[k] && !DERIVED_COST_BUCKETS.includes(k) && k !== "other"), ...customKeys].forEach((b) => {
      pushItem(b, expenseLabel(b), expAmt(b), expRows(b).map(expRecord));
    });
    pushItem("other", "Other Expenses", expAmt("other"), expRows("other").map(expRecord));
    pushItem("refunds", "Refunds", refundRecords.reduce((a, x) => a + x.amount, 0), refundRecords);

    // INTEGER CENTS on the headline figure (CLAUDE.md §4). `pushItem` already
    // snaps each amount to 2dp, but summing a dozen of them with `+` and then
    // subtracting from gross accumulates ~1e-10 of binary residue — invisible
    // after formatting, which is exactly why it survived. Summing cents and
    // subtracting once is exact, so `kept` no longer depends on how many
    // deduction categories the period happens to have.
    const totalDeductionsCents = items.reduce((a, i) => a + toCents(i.amount), 0);
    const totalDeductions = fromCents(totalDeductionsCents);
    const kept = fromCents(toCents(gross) - totalDeductionsCents);

    // ── Tax liability (state / city / other shown separately) ──
    //
    // A day contributes on exactly one branch: imported PMS tax (passTax > 0) or
    // tax estimated from configured rates (deductTax > 0). Liability is the
    // imported pass-through the owner has collected and owes, plus whichever of
    // {actual payments, rate estimate} is in force for the days with no imported
    // line. Adding the manual amounts on top of the estimate — as this did
    // before — counted the same liability twice.
    const impDays = dayTotals.filter((d) => d.passTax > 0.004);
    const estDays = dayTotals.filter((d) => d.deductTax > 0.004);
    const sumOn = (rows, k) => rows.reduce((a, d) => a + d[k], 0);
    const liabState = liability.state;
    const liabCity = liability.city;
    const liabOther = liability.other;
    const passThrough = sumOn(impDays, "passTax");

    const dayImpImported = (d) => {
      const imp = taxImp.get(d.date);
      return imp?.present === true;
    };

    const taxRecords = {};
    for (const [label,key,category] of [['State Tax','state','state_taxes'],['City/Local Tax','city','city_taxes'],['Other Taxes','other','taxes']]) {
      taxRecords[label] = costs.flatMap(c=>{
        const records = [];
        const dates = [...new Set([...c.source,...c.gross,...occRows.filter(r=>String(r.property_id ?? '')===c.id)].map(r=>String(r.date).slice(0,10)))];
        for (const date of dates) {
          const gross = c.gross.filter(r=>String(r.date).slice(0,10)===date);
          const source = c.value.basis.tax==='actual' ? [] : c.source.filter(r=>String(r.date).slice(0,10)===date);
          const occupancy = c.value.basis.tax==='actual' ? [] : occRows.filter(r=>String(r.property_id ?? '')===c.id && String(r.date).slice(0,10)===date);
          const value = CalculationService.calculateTaxLiability(source,gross,c.id || null,{from:date,to:date},occupancy);
          if (value[key]) records.push({name:date,detail:c.id+' ? imported/estimated tax liability',amount:value[key]});
        }
        if(c.value.basis.tax==='actual') records.push(...c.exp.filter(e=>e.category===category).map(expRecord));
        return records;
      });
    }

    // Tax object consumed by the UI: per-jurisdiction liability amounts, the
    // matching line-item records, the imported pass-through, and the estimated
    // tax + combined effective rate used for the "estimated" explanatory note.
    const tax = buildTaxObject({
      liabState,
      liabCity,
      liabOther,
      taxRecords,
      passThrough,
      taxIsActual,
      estimatedTaxFromRates,
      effectiveTaxRate,
    });

    return {
      gross,
      grossBasis,
      items,
      totalDeductions,
      kept,
      from,
      to,
      tax,
      refundsTotal,
      passThrough,
      taxRecords,
      liabState,
      liabCity,
      liabOther,
      dayTotals,
    };
    // `expenses` is listed because line 146 reads it directly on the fallback path
    // (no aggregate cache). It was previously omitted and the memo still refreshed,
    // but only by accident: `recurringExtras` depends on `expenses` and returns a
    // fresh array identity, so it was standing in as a proxy dependency. That is a
    // load-bearing coincidence — anyone memoizing recurringExtras harder would have
    // frozen the owner's headline number at whatever the first render computed.
}

export function buildMoneyKeptPresentation(baseData, trendMode = "week") {
    const { gross, grossBasis, items, totalDeductions, kept, from: baseFrom, to: baseTo, tax, refundsTotal, passThrough, dayTotals } = baseData;
    
    // ── Trend: allocate lump expenses/payroll across days by revenue share ──
    const sumDay = (k) => sum(dayTotals, k);
    const lumpTotal = totalDeductions - (sumDay("commission") + sumDay("ccFee") + sumDay("refundFee") + sumDay("deductTax") + sumDay("refunds"));
    const grossTotal = sumDay("gross");
    const daily = dayTotals.map((d) => {
      const share = grossTotal > 0 ? (d.gross / grossTotal) * lumpTotal : 0;
      return {
        ...d,
        kept: d.gross - d.commission - d.ccFee - d.refundFee - d.deductTax - d.refunds - share,
      };
    });

    const trendMap = new Map();
    daily.forEach((d) => {
      const k = bucketKey(d.date, trendMode);
      const cur = trendMap.get(k) || { label: k, gross: 0, kept: 0 };
      cur.gross += d.gross;
      cur.kept += d.kept;
      trendMap.set(k, cur);
    });
    const trendData = [...trendMap.values()]
      .filter((t) => t.gross > 0 || t.kept !== 0)
      .map((t) => ({ ...t, gross: Math.round(t.gross * 100) / 100, kept: Math.round(t.kept * 100) / 100 }))
      .sort((a, b) => a.label.localeCompare(b.label));

    // One colour per deduction, shared by the pie slice AND the dot in the list
    // on the left, so the two panels always read as the same thing. (They used
    // to be coloured independently — the list from CHART_COLORS by row index,
    // the pie from a mix of fixed hues and a separate index — so a purple dot
    // in the list could sit next to an orange slice for the same deduction.)
    const FIXED_COLORS = { taxes: "#8b5cf6", credit_card_fees: "#f59e0b", cc: "#f59e0b", ota: "#ef4444" };
    const PRIORITY_KEYS = ["taxes", "cc", "credit_card_fees", "ota"];
    const colorByKey = new Map();
    let paletteAt = 0;
    items.forEach((i) => {
      colorByKey.set(i.key, FIXED_COLORS[i.key] || CHART_COLORS[paletteAt++ % CHART_COLORS.length]);
    });

    // Pie slices follow the natural revenue narrative, clockwise from the top:
    // Business Taxes → Credit Card Processing Fees → OTA Commissions →
    // any remaining deductions → Estimated Money Kept (the bottom line, last).
    const pieDeduction = (key, label) => {
      const amt = items.find((i) => i.key === key)?.amount;
      return amt && amt > 0.004
        ? { name: label, value: Math.round(amt * 100) / 100, color: colorByKey.get(key) }
        : null;
    };
    const orderedPie = [
      pieDeduction("taxes", "Business Taxes"),
      pieDeduction("credit_card_fees", "Credit Card Processing Fees") ||
        pieDeduction("cc", "Credit Card Processing Fees"),
      pieDeduction("ota", "OTA Commissions"),
    ].filter(Boolean);

    const otherPie = items
      .filter((i) => !PRIORITY_KEYS.includes(i.key) && i.amount > 0.004)
      .map((i) => ({ name: i.label, value: Math.round(i.amount * 100) / 100, color: colorByKey.get(i.key) }));

    // The pie answers "where did every gross dollar go?", so its slices must
    // total gross: all deductions plus whatever is kept. If deductions exceed
    // gross there is no positive wedge left to draw, and the remaining slices
    // would silently rebase to 100% OF DEDUCTIONS while still looking like a
    // share of gross. That case is flagged so the chart can say so out loud
    // instead of quietly reporting different percentages than the list.
    const keptSlice = Math.round(kept * 100) / 100;
    const pieData = [
      ...orderedPie,
      ...otherPie,
      ...(keptSlice > 0 ? [{ name: "Estimated Money Kept", value: keptSlice, color: C.green }] : []),
    ];
    const pieIsGrossShare = keptSlice > 0;

    const barData = [
      { name: grossBasis?.basis === "room" ? "Room Revenue" : "Total Revenue", value: Math.round(gross * 100) / 100, color: C.purple },
      { name: "Estimated Money Kept", value: Math.max(0, Math.round(kept * 100) / 100), color: C.green },
    ];

    return {
      gross, grossBasis, items, totalDeductions, kept, pieData, barData, trendData, from: baseFrom, to: baseTo,
      refundsTotal, passThrough, tax, colorByKey, pieIsGrossShare
    };
}
