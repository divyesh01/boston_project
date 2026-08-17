import React, { useMemo, useState } from "react";
import {
  ResponsiveContainer, PieChart, Pie, Cell, Tooltip, Legend,
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  AreaChart, Area, Line,
} from "recharts";
import { X, Wallet } from "lucide-react";
import Card from "@/components/ui-exec/Card";
import { usePaymentData } from "@/lib/useHotelData";
import { useGlobalFilters } from "@/lib/useGlobalFilters";
import { money, money2, pct, sum, inRange, C, CHART_COLORS, commissionFor } from "@/lib/hotel";
import { getCcFeeRate, getCcFeeOnRefunds } from "@/lib/commissionRates";
import { getTaxConfig } from "@/lib/taxConfig";
import { getEffectiveTaxRates, getTaxSettings } from "@/lib/taxSettings";
import { expenseLabel, STANDARD_CATEGORY_KEYS } from "@/lib/expenseCategories";
import { buildTaxObject } from "@/lib/taxLiability";
import { CARD_METHODS, refundOf } from "@/lib/paymentNorm";
import { filterCommittedPay } from "@/lib/payrollCalc";
import { useSettingsVersion } from "@/hooks/useSettingsVersion";

const tip = { background: "#0A1628", border: "1px solid #ffffff14", borderRadius: 12, color: "#e2e8f0" };
const axis = { fill: "#64748b", fontSize: 10 };


const TREND_MODES = [
  ["day", "Day"],
  ["week", "Week"],
  ["month", "Month"],
  ["year", "Year"],
];

// Tax buckets for manual expense entries that feed the liability display
const TAX_EXPENSE_CATS = ["state_taxes", "city_taxes"];

// Bucket a booking source into its configured tax class.
function classifyTaxSource(r) {
  const text = `${r.source || ""} ${r.code || ""}`.toUpperCase();
  if (/EXPEDIA.*HOTEL COLLECT|EHC/.test(text)) return "EXPEDIA_HC";
  if (/BOOKING\.?COM.*HOTEL COLLECT|BHC/.test(text)) return "BOOKING_HC";
  if (/WALK|WIN/.test(text)) return "WALK_IN";
  if (/PROPERTY BOOKING|PRP|RR WEBSITE|WEB|RED ROOF APP|APP|CONTACT CENTER|CRS/.test(text)) return "PROPERTY_BOOKING";
  return "OTHER_OTA";
}

// Bucket a YYYY-MM-DD date into day / week (Monday start) / month / year key
function bucketKey(dateStr, mode) {
  if (mode === "day") return dateStr;
  if (mode === "month") return dateStr.slice(0, 7);
  if (mode === "year") return dateStr.slice(0, 4);
  const dt = new Date(`${dateStr}T00:00:00`);
  const monday = new Date(dt);
  monday.setDate(dt.getDate() - ((dt.getDay() + 6) % 7));
  return monday.toISOString().slice(0, 10);
}

function buildPropertyFilter(property) {
  const filter = {};
  if (property && property !== "all") {
    if (Array.isArray(property)) {
      if (property.length > 0) filter.property_id = { $in: property };
    } else {
      filter.property_id = property;
    }
  }
  return filter;
}

function propKey(property) {
  return Array.isArray(property) ? property.join(",") : property;
}

export default function MoneyKept({ occRows, srcRows, grossRows, dateRange, property, aggPayRows, aggExpenses, expenses = [], payroll = [] }) {
  const ccFee = getCcFeeRate();
  const ccFeeRefunds = getCcFeeOnRefunds();
  const settingsVersion = useSettingsVersion();
  const [active, setActive] = useState(null);
  const [trendMode, setTrendMode] = useState("week");

  const propFilter = useMemo(() => buildPropertyFilter(property), [property]);
  const propertyKey = useMemo(() => propKey(property), [property]);

  const { months } = useGlobalFilters();
  const { data: payRecords = [] } = usePaymentData(dateRange, property, months);

  const from = dateRange?.from || "";
  const to = dateRange?.to || "";

  // 1. Heavy computation: Recurring expense projection
  const recurringExtras = useMemo(() => {
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
      s.entries.push({ date: base, amount: Number(e.amount) || 0, freq, category: e.category || "other", name: e.expense_name || "Recurring Expense" });
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
          extras.push({ expense_name: first.name, vendor: "Recurring", category: first.category, expense_date: date, amount: first.amount });
        }
        date = addPeriod(date, first.freq);
      }
    });
    return extras;
  }, [expenses, from, to]);

  // 2. Base calculations: Deductions, taxes, actual expenses
  const baseData = useMemo(() => {
    const payRows = (aggPayRows && aggPayRows.length) ? aggPayRows : payRecords.filter((r) => inRange(r.date, from, to));
    const expInPeriod = (aggExpenses && aggExpenses.length) ? aggExpenses : expenses.filter((e) => inRange(e.expense_date, from, to));
    // Only approved/paid runs reduce cash. Drafts are proposals, and counting
    // them here made money kept drop the moment a run was keyed in.
    const payInPeriod = filterCommittedPay(payroll).filter((p) =>
      inRange(p.pay_period_start, from, to)
    );
    const grossInPeriod = (grossRows || []).filter((r) => inRange(r.date, from, to));

    const gross = sum(occRows, "room_revenue");

    // ── Imported PMS tax lines per day (state / city / other) ──
    const taxImp = new Map();
    grossInPeriod.forEach((r) => {
      const d = String(r.date).slice(0, 10);
      const cur = taxImp.get(d) || { state: 0, city: 0, other: 0 };
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
    occRows.forEach((r) => bump(String(r.date).slice(0, 10), "gross", Number(r.room_revenue) || 0));
    srcRows.forEach((r) => {
      const rev = Number(r.net_revenue) || 0;
      const stays = Number(r.stays) || 0;
      const info = commissionFor(r.source || r.code);
      let comm = 0;
      if (info.type === "percentage") comm = rev * info.rate;
      else if (info.type === "fixed") comm = info.rate * stays;
      else if (info.type === "actual") comm = info.rate;
      bump(String(r.date).slice(0, 10), "commission", comm);
    });
    payRows.forEach((r) => {
      const date = String(r.date).slice(0, 10);
      const card = CARD_METHODS.reduce((a, k) => a + (Number(r[k]) || 0), 0);
      bump(date, "ccFee", card * ccFee);
      const refund = Math.abs(refundOf(r));
      bump(date, "refunds", refund);
      if (ccFeeRefunds) bump(date, "refundFee", refund * ccFee);
    });

    // ── Tax estimate base: net revenue of taxable booking sources per day/property.
    // Only taxable sources (hotel-collect OTAs, walk-in, direct/property bookings) form
    // the base; imported PMS tax lines (below) always take precedence when present.
    const taxCfg = getTaxConfig();
    const taxableSources = new Set(taxCfg.sources.filter((s) => s.taxable).map((s) => s.key));
    const taxBaseByKey = new Map();
    const occGrossByKey = new Map();
    const hasSourceByKey = new Map();
    const dateBaseKeys = new Map();
    const keyDate = (k) => k.slice(0, 10);
    const pushDateKey = (k) => {
      const d = keyDate(k);
      const arr = dateBaseKeys.get(d) || [];
      arr.push(k);
      dateBaseKeys.set(d, arr);
    };
    srcRows.forEach((r) => {
      const d = String(r.date).slice(0, 10);
      const pid = r.property_id || "";
      const key = `${d}|${pid}`;
      hasSourceByKey.set(key, true);
      // A source is taxable only if BOTH conditions hold:
      // 1. Its tax-config bucket is marked taxable (classifyTaxSource → TAX_SOURCES)
      // 2. The per-source commission rate entry does NOT have taxExempt === true
      const srcInfo = commissionFor(r.source || r.code);
      if (taxableSources.has(classifyTaxSource(r)) && !srcInfo.taxExempt) {
        taxBaseByKey.set(key, (taxBaseByKey.get(key) || 0) + (Number(r.net_revenue) || 0));
      }
      pushDateKey(key);
    });
    occRows.forEach((r) => {
      const d = String(r.date).slice(0, 10);
      const pid = r.property_id || "";
      const key = `${d}|${pid}`;
      occGrossByKey.set(key, (occGrossByKey.get(key) || 0) + (Number(r.room_revenue) || 0));
      pushDateKey(key);
    });

    // Resolve taxes per day: imported (pass-through) or estimated from configured rates (deducted).
    // The per-property tax settings remain active even when the legacy global toggle is off.
    const taxEnabled = taxCfg.taxEnabled || getTaxSettings().length > 0;
    const ratesCache = new Map();
    const ratesFor = (pid, d) => {
      const k = `${pid}|${d}`;
      if (!ratesCache.has(k)) ratesCache.set(k, getEffectiveTaxRates(pid, d));
      return ratesCache.get(k);
    };

    const dayTotals = [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date)).map((d) => {
      const imp = taxImp.get(d.date);
      const hasImported = imp && (imp.state + imp.city + imp.other) > 0.004;
      let state = 0, city = 0, other = 0, passTax = 0, deductTax = 0, baseSum = 0;
      if (hasImported) {
        state = imp.state;
        city = imp.city;
        other = imp.other;
        passTax = state + city + other;
      } else if (taxEnabled) {
        const keys = dateBaseKeys.get(d.date) || [];
        const used = new Set();
        keys.forEach((key) => {
          if (used.has(key)) return;
          used.add(key);
          const pid = key.slice(d.date.length + 1);
          const r = ratesFor(pid, d.date);
          const hasSource = hasSourceByKey.has(key);
          const base = taxBaseByKey.has(key) ? taxBaseByKey.get(key) : hasSource ? 0 : (occGrossByKey.get(key) || 0);
          baseSum += base;
          state += base * r.state;
          city += base * r.city;
          other += base * r.other;
        });
        deductTax = state + city + other;
      }
      return { ...d, state, city, other, passTax, deductTax, taxBase: baseSum };
    });

    // ── Manual expenses & payroll ──
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
    const bucketOf = (cat) => {
      if (cat === "ota_commission") return "ota";
      if (cat === "payroll") return "payroll";
      if (TAX_EXPENSE_CATS.includes(cat)) return "taxes";
      return cat || "other";
    };
    const expGroups = {};
    expInPeriod.forEach((e) => {
      const b = bucketOf(e.category);
      (expGroups[b] = expGroups[b] || []).push(e);
    });
    const expRows = (b) => (expGroups[b] || []);
    const expAmt = (b) => expRows(b).reduce((a, e) => a + (Number(e.amount) || 0), 0);
    
    // Add recurring expenses (memoized above)
    recurringExtras.forEach((e) => {
      const b = bucketOf(e.category);
      (expGroups[b] = expGroups[b] || []).push(e);
    });

    // Manual tax expense entries (real business tax outflows).
    // These read the "taxes" bucket that `bucketOf` actually writes — the
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
    const srcMap = new Map();
    srcRows.forEach((r) => {
      const src = r.source || r.code || "UNKNOWN";
      const info = commissionFor(src);
      const rev = Number(r.net_revenue) || 0;
      const stays = Number(r.stays) || 0;
      let comm = 0;
      if (info.type === "percentage") comm = rev * info.rate;
      else if (info.type === "fixed") comm = info.rate * stays;
      else if (info.type === "actual") comm = info.rate;
      const cur = srcMap.get(src) || { name: src, gross: 0, stays: 0, comm: 0, rate: info.rate };
      cur.gross += rev;
      cur.stays += stays;
      cur.comm += comm;
      srcMap.set(src, cur);
    });
    const otaRecords = [...srcMap.values()]
      .filter((x) => x.gross > 0 || x.comm > 0)
      .map((x) => ({
        name: x.name,
        detail: `Gross ${money2(x.gross)} @ ${pct(x.rate, 1)} commission`,
        amount: x.comm,
      }));

    // ── CC fees & refunds per day ──
    const ccRecords = payRows
      .map((r) => {
        const date = String(r.date).slice(0, 10);
        const card = CARD_METHODS.reduce((a, k) => a + (Number(r[k]) || 0), 0);
        return { name: date, detail: `Card volume ${money2(card)} @ ${pct(ccFee, 2)}`, amount: card * ccFee };
      })
      .filter((x) => x.amount > 0);

    const refundRecords = dayTotals.filter((d) => d.refunds > 0).map((d) => ({
      name: d.date,
      detail: "Closed balance folio + loyalty discount",
      amount: d.refunds,
    }));

    // Total refunded amount across the period — excluded from the keep-rate
    // denominator because money returned to the guest was never truly "kept".
    const refundsTotal = refundRecords.reduce((a, x) => a + x.amount, 0);

    const refundFeeRecords = dayTotals.filter((d) => d.refundFee > 0).map((d) => ({
      name: d.date,
      detail: `Refund ${money2(d.refunds)} @ ${pct(ccFee, 2)} refund fee`,
      amount: d.refundFee,
    }));

    // ── Deduction items ──
    const items = [];
    const pushItem = (key, label, amount, records, rate) => {
      if (amount > 0.004) items.push({ key, label, amount: Math.round(amount * 100) / 100, records: records || [], rate: Number.isFinite(rate) ? rate : undefined });
    };

    // OTA commission — actual invoices beat the rate-card estimate.
    const otaActual = expAmt("ota");
    const otaEstimated = otaRecords.reduce((a, x) => a + x.amount, 0);
    if (otaActual > 0.004) {
      pushItem("ota", "OTA Commissions (actual)", otaActual, expRows("ota").map(expRecord));
    } else if (otaFromSources) {
      pushItem("ota", "OTA Commissions (estimated)", otaEstimated, otaRecords);
    }

    // Card processing fees — a real merchant statement beats the derived fee.
    const ccActual = expAmt("credit_card_fees");
    const ccTotal = ccRecords.reduce((a, x) => a + x.amount, 0);
    if (ccActual > 0.004) {
      pushItem("credit_card_fees", "Credit Card Processing Fees (actual)", ccActual, expRows("credit_card_fees").map(expRecord));
    } else {
      pushItem("cc", "Credit Card Processing Fees (estimated)", ccTotal, ccRecords);
      if (ccFeeRefunds) {
        pushItem("refund_fee", "CC Fee on Refunds", refundFeeRecords.reduce((a, x) => a + x.amount, 0), refundFeeRecords);
      }
    }

    // Taxes — imported PMS tax is guest-collected pass-through and is never a
    // cost to the owner. Of the remaining two, an actual tax payment beats the
    // estimate derived from configured rates.
    const estimatedTaxFromRates = dayTotals.reduce((a, d) => a + d.deductTax, 0);
    const estimatedTaxBase = dayTotals.reduce((a, d) => a + (d.taxBase || 0), 0);
    const taxIsActual = manualTaxAmt > 0.004;
    const taxTotal = taxIsActual ? manualTaxAmt : estimatedTaxFromRates;
    const effectiveTaxRate = !taxIsActual && estimatedTaxBase > 0 ? estimatedTaxFromRates / estimatedTaxBase : undefined;
    const estimatedTaxRecords = taxIsActual
      ? [...manualState, ...manualCity, ...manualOtherTax].map(expRecord)
      : dayTotals.filter((d) => d.deductTax > 0).map((d) => ({
          name: d.date,
          detail: "Estimated at configured tax rates",
          amount: d.deductTax,
        }));
    pushItem("taxes", taxIsActual ? "Business Taxes (actual)" : "Business Taxes (estimated)", taxTotal, estimatedTaxRecords, effectiveTaxRate);

    pushItem("payroll", "Payroll", sum(payInPeriod, "total_pay") + expAmt("payroll"), [
      ...payInPeriod.map((p) => ({
        name: p.employee_name || "Payroll",
        detail: `${String(p.pay_period_start || "").slice(0, 10)} → ${String(p.pay_period_end || "").slice(0, 10)}`,
        amount: Number(p.total_pay) || 0,
      })),
      ...expRows("payroll").map(expRecord),
    ].filter((x) => x.amount > 0));

    // Buckets already emitted above with their own actual-vs-estimate handling.
    // `credit_card_fees` MUST be here: it is a standard category, so without it
    // the generic loop below would push the merchant statement a second time on
    // top of the line already emitted above.
    const specialBuckets = new Set(["ota", "payroll", "taxes", "credit_card_fees"]);
    const customKeys = Object.keys(expGroups)
      .filter((b) => !specialBuckets.has(b) && !STANDARD_CATEGORY_KEYS.includes(b))
      .sort((a, b) => expAmt(b) - expAmt(a));
    [...STANDARD_CATEGORY_KEYS.filter((k) => expGroups[k] && !specialBuckets.has(k) && k !== "other"), ...customKeys].forEach((b) => {
      pushItem(b, expenseLabel(b), expAmt(b), expRows(b).map(expRecord));
    });
    pushItem("other", "Other Expenses", expAmt("other"), expRows("other").map(expRecord));
    pushItem("refunds", "Refunds", refundRecords.reduce((a, x) => a + x.amount, 0), refundRecords);

    const totalDeductions = items.reduce((a, i) => a + i.amount, 0);
    const kept = gross - totalDeductions;

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
    const liabState = sumOn(impDays, "state") + (taxIsActual ? manualStateAmt : sumOn(estDays, "state"));
    const liabCity = sumOn(impDays, "city") + (taxIsActual ? manualCityAmt : sumOn(estDays, "city"));
    const liabOther = sumOn(impDays, "other") + (taxIsActual ? manualOtherTaxAmt : sumOn(estDays, "other"));
    const passThrough = sumOn(impDays, "passTax");

    const dayImpImported = (d) => {
      const imp = taxImp.get(d.date);
      return !!(imp && (imp.state + imp.city + imp.other) > 0.004);
    };

    const taxRecords = {
      "State Tax": dayTotals.filter((d) => d.state > 0).map((d) => ({
        name: d.date,
        detail: dayImpImported(d) ? "Imported (PMS)" : "Estimated at configured rate",
        amount: d.state,
      })),
      "City/Local Tax": dayTotals.filter((d) => d.city > 0).map((d) => ({
        name: d.date,
        detail: dayImpImported(d) ? "Imported (PMS)" : "Estimated at configured rate",
        amount: d.city,
      })),
      "Other Taxes": dayTotals.filter((d) => d.other > 0).map((d) => ({
        name: d.date,
        detail: dayImpImported(d) ? "Imported (PMS)" : "Estimated at configured rate",
        amount: d.other,
      })),
    };

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
  }, [occRows, srcRows, grossRows, payRecords, payroll, from, to, property, ccFee, ccFeeRefunds, settingsVersion, aggPayRows, aggExpenses, recurringExtras]);

  // 3. Final data and charts: depends on baseData and trendMode
  const data = useMemo(() => {
    const { gross, items, totalDeductions, kept, from: baseFrom, to: baseTo, tax, refundsTotal, passThrough, dayTotals } = baseData;
    
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

    const pieData = items
      .map((i, idx) => ({ name: i.label, value: Math.max(0, Math.round(i.amount * 100) / 100), color: CHART_COLORS[idx % CHART_COLORS.length] }))
      .concat(kept > 0 ? [{ name: "Money Kept", value: Math.round(kept * 100) / 100, color: C.green }] : []);

    const barData = [
      { name: "Gross Revenue", value: Math.round(gross * 100) / 100, color: C.purple },
      { name: "Estimated Money Kept", value: Math.max(0, Math.round(kept * 100) / 100), color: C.green },
    ];

    return {
      gross, items, totalDeductions, kept, pieData, barData, trendData, from: baseFrom, to: baseTo,
      refundsTotal, passThrough, tax
    };
  }, [baseData, trendMode]);

  const { gross, items, totalDeductions, kept, pieData, barData, trendData, tax, refundsTotal, passThrough } = data;
  // Keep rate = money kept against the *net-revenue base*, not raw gross.
  // Refunds (returned to guest) and pass-through taxes (collected on behalf of
  // the government, never the owner's to keep) are removed from the denominator
  // so the percentage reflects true net-revenue efficiency rather than an
  // artificially inflated share of uncollected gross.
  const netRevenueBase = gross - refundsTotal - passThrough;
  const keepRate = netRevenueBase > 0 ? kept / netRevenueBase : (gross > 0 ? kept / gross : 0);
  const periodLabel = `${from || "—"} → ${to || "—"}`;
  const taxTotal = tax.state + tax.city + tax.other;

  const open = (label, rows) => setActive({ label, rows: rows || [] });

  const TaxRow = ({ label, amount, records, color }) => (
    <button
      onClick={() => open(label, records)}
      className="flex w-full items-center justify-between rounded-lg px-3 py-2 transition-colors hover:bg-white/[0.04]"
    >
      <span className="flex items-center gap-2 text-sm text-slate-300">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
        {label}
        {amount > 0 && <span className="text-[10px] text-slate-500">({pct(amount / (gross || 1))})</span>}
      </span>
      <span className="text-sm tabular-nums text-slate-200">{money(amount)}</span>
    </button>
  );

  return (
    <div className="space-y-6">
      {/* ── Main KPI hero ── */}
      <div className="relative overflow-hidden rounded-2xl border border-[#00E096]/20 bg-gradient-to-br from-[#00E096]/[0.10] via-[#0F1F35]/90 to-[#0F1F35]/90 p-6">
        <div className="absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-transparent via-[#00E096] to-transparent" />
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-[11px] uppercase tracking-[0.3em] text-[#00D4FF]">Money in My Pocket</p>
            <h2 className="mt-1 font-heading text-xl font-semibold text-white">Estimated Money Kept</h2>
            <p className="mt-1 text-xs text-slate-400">Net profit after commissions, card fees, expenses & refunds</p>
          </div>
          <Wallet className="h-6 w-6 text-[#00E096]" />
        </div>
        <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <div className="sm:col-span-2">
            <p className="text-[10px] uppercase tracking-widest text-slate-500" title="Estimated Money Kept = Gross Revenue - all commissions, fees, taxes, payroll, expenses and refunds">Estimated Money Kept</p>
            <p className={`mt-1 font-heading text-4xl font-semibold tabular-nums ${kept >= 0 ? "text-[#00E096]" : "text-[#FF6B6B]"}`}>
              {kept >= 0 ? "" : "-"}{money(Math.abs(kept))}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              {gross > 0 ? `${money(gross)} gross · keep rate ${pct(keepRate)}` : "No revenue in selected period"}
            </p>
            <p className="mt-0.5 text-[10px] text-slate-600">
              {netRevenueBase > 0 ? `rate measured on net base ${money(netRevenueBase)} = gross − refunds − pass-through tax` : ""}
            </p>
          </div>
          <div className="rounded-xl border border-white/5 bg-[#0A1628]/60 p-4">
            <p className="text-[10px] uppercase tracking-widest text-slate-500" title="Imported occupancy revenue">Gross Revenue</p>
            <p className="mt-1 font-heading text-2xl font-semibold tabular-nums text-white">{money(gross)}</p>
            <p className="mt-1 text-xs text-slate-500">Imported occupancy revenue</p>
          </div>
          <div className="rounded-xl border border-white/5 bg-[#0A1628]/60 p-4">
            <p className="text-[10px] uppercase tracking-widest text-slate-500" title="Sum of every deduction category shown below">Total Deductions</p>
            <p className="mt-1 font-heading text-2xl font-semibold tabular-nums text-[#FFB547]">-{money(totalDeductions)}</p>
            <p className="mt-1 text-xs text-slate-500">{gross > 0 ? `${pct(totalDeductions / gross)} of revenue` : "No deductions"} · {items.length} categories</p>
          </div>
        </div>
      </div>

      {/* ── Profit breakdown + pie ── */}
      <Card title="Profit Breakdown" subtitle={`Where every dollar goes · click any line to see the underlying transactions (${periodLabel})`}>
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="space-y-1">
            <button
              onClick={() => open("Gross Revenue", [{ name: "Gross Revenue", detail: "Imported occupancy reports", amount: gross }])}
              className="flex w-full items-center justify-between rounded-lg px-3 py-2 transition-colors hover:bg-white/[0.04]"
            >
              <span className="text-sm font-medium text-slate-200">Gross Revenue</span>
              <span className="font-heading text-sm tabular-nums text-white">
                {money(gross)}
                <span className="ml-1.5 text-xs text-slate-500">(100%)</span>
              </span>
            </button>

            {items.map((i, idx) => {
              const color = CHART_COLORS[idx % CHART_COLORS.length];
              return (
                <button
                  key={i.key}
                  onClick={() => open(i.label, i.records)}
                  title={"Click to see the underlying transactions"}
                  className="flex w-full items-center justify-between rounded-lg px-3 py-2 transition-colors hover:bg-white/[0.04]"
                >
                  <span className="flex items-center gap-2 text-sm text-slate-300">
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
                    {i.label}
                  </span>
                  <span className="text-sm tabular-nums text-slate-200">
                    -{money(i.amount)}
                    <span className="ml-1.5 text-xs text-slate-500">({i.rate !== undefined ? pct(i.rate, 2) : pct(i.amount / (gross || 1))})</span>
                  </span>
                </button>
              );
            })}

            {items.length === 0 && (
              <p className="px-3 py-6 text-center text-sm text-slate-500">
                No deductions recorded for the selected period. Enter expenses or payroll to see where money goes.
              </p>
            )}

            <div className="my-2 border-t border-dashed border-white/10" />
            <div className="flex w-full items-center justify-between rounded-lg bg-[#00E096]/[0.06] px-3 py-3">
              <span className="flex items-center gap-2 text-sm font-medium text-[#00E096]">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: C.green }} />
                Estimated Money Kept
              </span>
              <span className="font-heading text-base font-semibold tabular-nums text-[#00E096]">
                {kept >= 0 ? "" : "-"}{money(Math.abs(kept))}
                <span className="ml-1.5 text-xs font-normal text-slate-400">
                  {gross > 0 ? `(${pct(keepRate)})` : "(—)"}
                </span>
              </span>
            </div>
          </div>

          {/* Pie chart */}
          <div className="h-[340px] overflow-hidden">
            {pieData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={pieData}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    outerRadius={110}
                    innerRadius={55}
                    paddingAngle={2}
                    label={({ name, value, percent }) => {
                      const share = (percent || 0) * 100;
                      const t = name && name.length > 18 ? name.slice(0, 16) + "\u2026" : name;
                      if (share < 2) return "";
                      if (share < 5) return `${t} (${share.toFixed(1)}%)`;
                      return `${t} ${money(value)} (${share.toFixed(1)}%)`;
                    }}
                    labelLine={{ stroke: "#475569", strokeWidth: 1 }}
                  >
                    {pieData.map((entry, i) => (
                      <Cell key={i} fill={entry.color} stroke="#040D1A" strokeWidth={2} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={tip} formatter={(v, name) => [money(v), name]} />
                  <Legend wrapperStyle={{ fontSize: 11, color: "#94a3b8" }} />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <p className="py-16 text-center text-sm text-slate-500">No revenue data to visualize.</p>
            )}
          </div>
        </div>
      </Card>

      {/* ── Taxes Collected / Tax Liability ── */}
      <Card
        title="Taxes Collected / Tax Liability"
        subtitle={`State, city, and other taxes shown separately · click a line for daily records (${periodLabel})`}
      >
        {taxTotal > 0 ? (
          <div className="grid gap-6 lg:grid-cols-2">
            <div className="space-y-1">
              <TaxRow label="State Tax" amount={tax.state} color={CHART_COLORS[0]} records={tax.stateRecords} />
              <TaxRow label="City/Local Tax" amount={tax.city} color={CHART_COLORS[1]} records={tax.cityRecords} />
              <TaxRow label="Other Taxes" amount={tax.other} color={CHART_COLORS[2]} records={tax.otherRecords} />
              <div className="my-2 border-t border-dashed border-white/10" />
              <div className="flex w-full items-center justify-between rounded-lg bg-[#FFB547]/[0.06] px-3 py-3">
                <span className="flex items-center gap-2 text-sm font-medium text-[#FFB547]">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: C.amber }} />
                  Total Tax Liability
                </span>
                <span className="font-heading text-base font-semibold tabular-nums text-[#FFB547]">{money(taxTotal)}</span>
              </div>
              <p className="px-3 pt-2 text-xs text-slate-500">
                {tax.passThrough > 0.004 && (
                  <span className="block">Pass-through (imported from PMS): <span className="text-[#00E096]">{money(tax.passThrough)}</span> — collected from the guest, remitted to government, does not reduce money kept.</span>
                )}
                {tax.estimated > 0.004 && (
                  <span className="block">Estimated at configured rates{tax.effectiveRate > 0 ? ` — combined ${pct(tax.effectiveRate, 2)}` : ""}: <span className="text-[#FFB547]">{money(tax.estimated)}</span> — treated as a business cost since reports didn't include tax lines.</span>
                )}
              </p>
            </div>
          </div>
        ) : (
          <p className="py-6 text-center text-sm text-slate-500">
            No tax data for the selected period. Imported PMS state/city tax lines are shown here automatically; otherwise taxes are estimated from the per-property tax settings.
          </p>
        )}
      </Card>

      {/* ── Visual breakdown: bar + trend ── */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Gross Revenue vs Money Kept" subtitle="Every dollar of revenue vs what you keep after all deductions">
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={barData} layout="vertical" margin={{ left: 40, right: 16 }}>
                <CartesianGrid stroke="#ffffff0a" horizontal={false} />
                <XAxis type="number" tick={axis} tickFormatter={(v) => money(v)} stroke="#ffffff10" />
                <YAxis type="category" dataKey="name" tick={axis} width={150} stroke="#ffffff10" />
                <Tooltip contentStyle={tip} formatter={(v) => money(v)} />
                <Bar dataKey="value" radius={[0, 6, 6, 0]}>
                  {barData.map((b, i) => (
                    <Cell key={i} fill={b.color} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card
          title="Estimated Money Kept Trend"
          subtitle="Kept after deductions per day, week, month, or year"
          right={
            <div className="flex items-center gap-0.5 rounded-lg border border-white/10 bg-[#0A1628] p-0.5">
              {TREND_MODES.map(([mode, label]) => (
                <button
                  key={mode}
                  onClick={() => setTrendMode(mode)}
                  className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                    trendMode === mode ? "bg-[#6C63FF] text-white" : "text-slate-400 hover:text-slate-200"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          }
        >
          <div className="h-64">
            {trendData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={trendData} margin={{ left: -10, right: 8, top: 8 }}>
                  <defs>
                    <linearGradient id="keptGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={C.green} stopOpacity={0.35} />
                      <stop offset="100%" stopColor={C.green} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="#ffffff0a" vertical={false} />
                  <XAxis dataKey="label" tick={axis} stroke="#ffffff10" />
                  <YAxis tick={axis} stroke="#ffffff10" tickFormatter={(v) => `${Math.round(v / 1000)}k`} width={54} />
                  <Tooltip
                    contentStyle={tip}
                    formatter={(v, name) => [money(v), name === "gross" ? "Gross Revenue" : "Estimated Money Kept"]}
                  />
                  <Area type="monotone" dataKey="kept" stroke={C.green} strokeWidth={2} fill="url(#keptGrad)" />
                  <Line type="monotone" dataKey="gross" stroke={C.purple} strokeWidth={1.5} strokeDasharray="4 4" dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <p className="py-16 text-center text-sm text-slate-500">No trend data for the selected period.</p>
            )}
          </div>
        </Card>
      </div>

      {/* ── Drill-down modal ── */}
      {active && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onClick={() => setActive(null)}>
          <div
            className="w-full max-w-lg rounded-2xl border border-white/10 bg-[#151921] p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h3 className="font-heading text-lg font-semibold text-white">{active.label}</h3>
                <p className="text-xs text-slate-500">{active.rows.length} underlying records</p>
              </div>
              <button onClick={() => setActive(null)} className="text-slate-400 hover:text-white">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="max-h-80 space-y-1.5 overflow-auto pr-1">
              {active.rows.map((r, i) => (
                <div key={i} className="flex items-center justify-between rounded-lg border border-white/5 bg-[#0A1628]/60 px-3 py-2">
                  <div>
                    <p className="text-sm text-slate-200">{r.name}</p>
                    {r.detail && <p className="text-[11px] text-slate-500">{r.detail}</p>}
                  </div>
                  <span className="font-heading text-sm tabular-nums text-[#FFB547]">-{money(r.amount)}</span>
                </div>
              ))}
              {active.rows.length === 0 && <p className="py-6 text-center text-sm text-slate-500">No underlying transactions recorded.</p>}
            </div>
            <div className="mt-4 flex items-center justify-between border-t border-white/5 pt-3">
              <span className="text-sm text-slate-400">Total</span>
              <span className="font-heading text-lg tabular-nums text-[#FFB547]">
                -{money(active.rows.reduce((a, r) => a + (Number(r.amount) || 0), 0))}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}