import React, { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ResponsiveContainer, PieChart, Pie, Cell, Tooltip, Legend,
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  AreaChart, Area, Line,
} from "recharts";
import { X, Wallet } from "lucide-react";
import Card from "@/components/ui-exec/Card";
import { db } from "@/api/base44Client";
import { money, money2, pct, sum, inRange, C, CHART_COLORS, commissionFor } from "@/lib/hotel";
import { getCcFeeRate, getCcFeeOnRefunds } from "@/lib/commissionRates";
import { TAX_SOURCES } from "@/lib/taxConfig";
import { getEffectiveTaxRates } from "@/lib/taxSettings";
import { expenseLabel, STANDARD_CATEGORY_KEYS } from "@/lib/expenseCategories";
import { CARD_METHODS } from "@/lib/paymentNorm";

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

function classifySource(r) {
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

export default function MoneyKept({ occRows, srcRows, grossRows, dateRange, property }) {
  const ccFee = getCcFeeRate();
  const ccFeeRefunds = getCcFeeOnRefunds();
  const [active, setActive] = useState(null);
  const [trendMode, setTrendMode] = useState("week");

  const propFilter = useMemo(() => buildPropertyFilter(property), [property]);
  const propertyKey = useMemo(() => propKey(property), [property]);

  // Shared query keys so any write to payments/expenses/payroll elsewhere auto-refreshes this section
  const { data: payRecords = [] } = useQuery({
    queryKey: ["payments", dateRange?.from, dateRange?.to, property, ""],
    queryFn: () => db.entities.PaymentDay.filter(propFilter, "date", 2000),
  });

  const { data: expenses = [] } = useQuery({
    queryKey: ["expenses", propertyKey],
    queryFn: () => db.entities.Expense.filter(propFilter, "-expense_date", 5000),
  });

  const { data: payroll = [] } = useQuery({
    queryKey: ["payroll", propertyKey],
    queryFn: () => db.entities.PayrollRun.filter(propFilter, "-pay_period_start", 5000),
  });

  const data = useMemo(() => {
    const from = dateRange?.from || "";
    const to = dateRange?.to || "";
    const payRows = payRecords.filter((r) => inRange(r.date, from, to));
    const expInPeriod = expenses.filter((e) => inRange(e.expense_date, from, to));
    const payInPeriod = payroll.filter((p) => inRange(p.pay_period_start, from, to));
    const grossInPeriod = (grossRows || []).filter((r) => inRange(r.date, from, to));

    const gross = sum(occRows, "total_revenue");

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

    // ── Taxable revenue base per day (from taxable booking sources) ──
    const taxBase = new Map();
    srcRows.forEach((r) => {
      const src = TAX_SOURCES.find((s) => s.key === classifySource(r));
      if (!src || !src.taxable) return;
      const d = String(r.date).slice(0, 10);
      taxBase.set(d, (taxBase.get(d) || 0) + (Number(r.net_revenue) || 0));
    });

    // ── Day-level ledger ──
    const dayMap = new Map();
    const bump = (date, key, v) => {
      if (!date) return;
      const cur = dayMap.get(date) || { date, gross: 0, commission: 0, ccFee: 0, refundFee: 0, refunds: 0 };
      cur[key] += v;
      dayMap.set(date, cur);
    };
    occRows.forEach((r) => bump(String(r.date).slice(0, 10), "gross", Number(r.total_revenue) || 0));
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
      const refund = Math.abs(Number(r.closed_balance_folio) || 0) + Math.abs(Number(r.loyalty_discount) || 0);
      bump(date, "refunds", refund);
      if (ccFeeRefunds) bump(date, "refundFee", refund * ccFee);
    });

    // Resolve taxes per day: imported (pass-through) or estimated from configured rates (deducted)
    const ratesCache = new Map();
    const ratesFor = (d) => {
      if (!ratesCache.has(d)) ratesCache.set(d, getEffectiveTaxRates(property, d));
      return ratesCache.get(d);
    };

    const dayTotals = [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date)).map((d) => {
      const imp = taxImp.get(d.date);
      const hasImported = imp && (imp.state + imp.city + imp.other) > 0.004;
      let state = 0, city = 0, other = 0, passTax = 0, deductTax = 0;
      if (hasImported) {
        state = imp.state;
        city = imp.city;
        other = imp.other;
        passTax = state + city + other;
      } else {
        const r = ratesFor(d.date);
        const base = taxBase.get(d.date) || d.gross;
        state = base * r.state;
        city = base * r.city;
        other = base * r.other;
        deductTax = state + city + other;
      }
      return { ...d, state, city, other, passTax, deductTax };
    });

    // ── Manual expenses & payroll ──
    const expRecord = (e) => ({
      name: e.expense_name || "Expense",
      detail: `${e.vendor || "—"} · ${e.category} · ${String(e.expense_date || "").slice(0, 10)}`,
      amount: Number(e.amount) || 0,
    });
    const otaFromSources = srcRows.length > 0;

    const bucketOf = (cat) => {
      if (cat === "ota_commission") return otaFromSources ? "other" : "ota";
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
    // ---- Recurring expenses: project scheduled occurrences into the selected period ----
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
    const recurringExtras = [];
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
      let date = first.date;
      let guard = 0;
      while (date <= to && guard++ < 600) {
        if (date >= from && !entered.has(date)) {
          recurringExtras.push({ expense_name: first.name, vendor: "Recurring", category: first.category, expense_date: date, amount: first.amount });
        }
        date = addPeriod(date, first.freq);
      }
    });
    recurringExtras.forEach((e) => {
      const b = bucketOf(e.category);
      (expGroups[b] = expGroups[b] || []).push(e);
    });

    // Manual tax expense entries (real business tax outflows)
    const manualState = expRows("tax").filter((e) => e.category === "state_taxes");
    const manualCity = expRows("tax").filter((e) => e.category === "city_taxes");
    const manualStateAmt = manualState.reduce((a, e) => a + (Number(e.amount) || 0), 0);
    const manualCityAmt = manualCity.reduce((a, e) => a + (Number(e.amount) || 0), 0);
    const manualOtherTax = expRows("tax").filter((e) => e.category === "taxes");
    const manualOtherTaxAmt = manualOtherTax.reduce((a, e) => a + (Number(e.amount) || 0), 0);

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

    const refundFeeRecords = dayTotals.filter((d) => d.refundFee > 0).map((d) => ({
      name: d.date,
      detail: `Refund ${money2(d.refunds)} @ ${pct(ccFee, 2)} refund fee`,
      amount: d.refundFee,
    }));

    // ── Deduction items ──
    const items = [];
    const pushItem = (key, label, amount, records) => {
      if (amount > 0.004) items.push({ key, label, amount: Math.round(amount * 100) / 100, records: records || [] });
    };

    if (otaFromSources) {
      pushItem("ota", "OTA Commissions", otaRecords.reduce((a, x) => a + x.amount, 0), otaRecords);
    } else {
      pushItem("ota", "OTA Commissions", expAmt("ota"), expRows("ota").map(expRecord));
    }
    const ccTotal = ccRecords.reduce((a, x) => a + x.amount, 0);
    pushItem("cc", "Credit Card Processing Fees", ccTotal, ccRecords);
    if (ccFeeRefunds) {
      pushItem("refund_fee", "CC Fee on Refunds", refundFeeRecords.reduce((a, x) => a + x.amount, 0), refundFeeRecords);
    }

    // Estimated (not imported) taxes reduce money kept; imported taxes are pass-through.
    const estimatedTaxTotal = dayTotals.reduce((a, d) => a + d.deductTax, 0) + manualStateAmt + manualCityAmt + manualOtherTaxAmt;
    const estimatedTaxRecords = [
      ...dayTotals.filter((d) => d.deductTax > 0).map((d) => ({
        name: d.date,
        detail: "Estimated at configured tax rates",
        amount: d.deductTax,
      })),
      ...[...manualState, ...manualCity, ...manualOtherTax].map(expRecord),
    ];
    pushItem("taxes", "Business Taxes (estimated)", estimatedTaxTotal, estimatedTaxRecords);

    pushItem("payroll", "Payroll", sum(payInPeriod, "total_pay") + expAmt("payroll"), [
      ...payInPeriod.map((p) => ({
        name: p.employee_name || "Payroll",
        detail: `${String(p.pay_period_start || "").slice(0, 10)} → ${String(p.pay_period_end || "").slice(0, 10)}`,
        amount: Number(p.total_pay) || 0,
      })),
      ...expRows("payroll").map(expRecord),
    ].filter((x) => x.amount > 0));

    const specialBuckets = new Set(["ota", "payroll", "taxes"]);
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
    const liabState = dayTotals.reduce((a, d) => a + d.state, 0) + manualStateAmt;
    const liabCity = dayTotals.reduce((a, d) => a + d.city, 0) + manualCityAmt;
    const liabOther = dayTotals.reduce((a, d) => a + d.other, 0);
    const passThrough = dayTotals.reduce((a, d) => a + d.passTax, 0);

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
      gross, items, totalDeductions, kept, pieData, barData, trendData, from, to,
      tax: {
        state: liabState, city: liabCity, other: liabOther,
        passThrough, estimated: estimatedTaxTotal,
        stateRecords: [...taxRecords["State Tax"], ...manualState.map(expRecord)],
        cityRecords: [...taxRecords["City/Local Tax"], ...manualCity.map(expRecord)],
        otherRecords: taxRecords["Other Taxes"],
      },
    };
  }, [occRows, srcRows, grossRows, payRecords, expenses, payroll, dateRange, property, ccFee, ccFeeRefunds, trendMode]);

  const { gross, items, totalDeductions, kept, pieData, barData, trendData, from, to, tax } = data;
  const keepRate = gross > 0 ? kept / gross : 0;
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
                    <span className="ml-1.5 text-xs text-slate-500">({pct(i.amount / (gross || 1))})</span>
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
                  {gross > 0 ? `(${pct(kept / gross)})` : "(—)"}
                </span>
              </span>
            </div>
          </div>

          {/* Pie chart */}
          <div className="h-[340px]">
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
                  <span className="block">Estimated at configured rates: <span className="text-[#FFB547]">{money(tax.estimated)}</span> — treated as a business cost since reports didn't include tax lines.</span>
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