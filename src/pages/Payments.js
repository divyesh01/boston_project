import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import React, { useMemo, useRef, useState } from "react";
import { CreditCard, DollarSign, Receipt, RefreshCw, AlertTriangle, Percent, Settings } from "lucide-react";
import Card from "@/components/ui-exec/Card";
import KpiCard from "@/components/ui-exec/KpiCard";
import UniversalChart from "@/components/charts/UniversalChart";
import ChartToolbar from "@/components/charts/ChartToolbar";
import TaxConfigModal from "@/components/TaxConfigModal";
import { usePaymentData, useOccupancy, useClerkRecords, useSources } from "@/lib/useHotelData";
import { usePullToRefresh } from "@/hooks/usePullToRefresh";
import { money, money2, sum, inRange, C } from "@/lib/hotel";
import { useGlobalFilters } from "@/lib/useGlobalFilters";
import { PAYMENT_METHOD_FIELDS, CARD_METHODS, refundTotalFromTotals } from "@/lib/paymentNorm";
import { getTaxConfig, calculateTax, formatTaxRate, TAX_SOURCES } from "@/lib/taxConfig";
export default function Payments() {
    const { dateRange, property, properties, paymentType, months } = useGlobalFilters();
    const { data: payRecords = [], isLoading, refetch } = usePaymentData(dateRange, property, months);
    const { data: occ = [] } = useOccupancy(dateRange, property, months);
    const { data: clerk = [] } = useClerkRecords(dateRange, property);
    const { data: sourceRows = [] } = useSources(dateRange, property, months);
    const chartRef = useRef(null);
    const { pullDist, refreshing } = usePullToRefresh(refetch);
    const payRows = useMemo(() => payRecords.filter((r) => inRange(r.date, dateRange.from, dateRange.to)), [payRecords, dateRange]);
    const occRows = useMemo(() => occ.filter((r) => inRange(r.date, dateRange.from, dateRange.to)), [occ, dateRange]);
    const srcRows = useMemo(() => sourceRows.filter((r) => inRange(r.date, dateRange.from, dateRange.to)), [sourceRows, dateRange]);
    // Aggregate payment methods from PaymentDay columns.
    //
    // `paymentType` narrows this to a single tender. It was destructured but never
    // used, so the dropdown appeared to work and changed nothing. PaymentDay
    // stores one column per method, so the filter is applied here at the
    // aggregation step rather than by dropping rows — a row can carry several
    // tenders at once.
    const activeMethods = useMemo(() => (paymentType && paymentType !== "all"
        ? PAYMENT_METHOD_FIELDS.filter(([key]) => key === paymentType)
        : PAYMENT_METHOD_FIELDS), [paymentType]);
    const methodFiltered = activeMethods.length !== PAYMENT_METHOD_FIELDS.length;
    const methodTotals = useMemo(() => {
        const out = {};
        activeMethods.forEach(([key]) => { out[key] = sum(payRows, key); });
        return out;
    }, [payRows, activeMethods]);
    const cardTotal = CARD_METHODS.reduce((a, k) => a + (methodTotals[k] || 0), 0);
    const cashTotal = methodTotals.cash || 0;
    // When one tender is selected, "collected" means that tender — otherwise the
    // stored row total, which is the authoritative sum across all methods.
    const totalCollected = methodFiltered
        ? activeMethods.reduce((a, [key]) => a + (methodTotals[key] || 0), 0)
        : sum(payRows, "total");
    const refunds = refundTotalFromTotals(methodTotals);
    const netPaymentCollected = totalCollected - refunds;
    const expectedRevenue = sum(occRows, "total_revenue");
    const variance = totalCollected - expectedRevenue;
    // Payment distribution data for chart — exclude zero values
    const paymentData = useMemo(() => {
        let data = activeMethods
            .map(([key, label]) => ({ name: label, value: Math.abs(methodTotals[key] || 0), key }))
            .filter((d) => d.value > 0)
            .sort((a, b) => b.value - a.value);
        return data;
    }, [methodTotals, activeMethods]);
    // Daily trend
    const dailyTrend = useMemo(() => {
        const cardKeys = methodFiltered
            ? CARD_METHODS.filter((k) => activeMethods.some(([key]) => key === k))
            : CARD_METHODS;
        const showCash = activeMethods.some(([key]) => key === "cash");
        return payRows
            .map((r) => ({
            date: String(r.date).slice(0, 10),
            total: methodFiltered
                ? activeMethods.reduce((a, [key]) => a + (Number(r[key]) || 0), 0)
                : Number(r.total) || 0,
            cash: showCash ? Number(r.cash) || 0 : 0,
            card: cardKeys.reduce((a, k) => a + (Number(r[k]) || 0), 0),
        }))
            .filter((r) => r.date)
            .sort((a, b) => a.date.localeCompare(b.date));
    }, [payRows, activeMethods, methodFiltered]);
    // Clerk drops (from ClerkShiftRecord, if any exist)
    const drops = useMemo(() => clerk.filter((x) => x.record_type === "drop"), [clerk]);
    // Clerk payment activity (real per-clerk records from ClerkShift.csv)
    const [expandedClerk, setExpandedClerk] = useState(null);
    const clerkAdjustments = useMemo(() => {
        const payments = clerk.filter((x) => x.record_type === "clerk_payment");
        const map = new Map();
        payments.forEach((r) => {
            const name = r.clerk_name || "Unknown";
            const cur = map.get(name) || { clerk: name, adjusted: 0, actual: 0, count: 0, records: [] };
            cur.adjusted += Number(r.amount) || 0;
            cur.actual += Number(r.amount) || 0;
            cur.count += 1;
            cur.records.push(r);
            map.set(name, cur);
        });
        return [...map.values()].sort((a, b) => b.adjusted - a.adjusted);
    }, [clerk]);
    const propName = property === "all" ? "All Properties" : (Array.isArray(property) ? `${property.length} Properties` : (properties.find((p) => p.id === property)?.name || "Property"));
    const periodLabel = `${dateRange.from || "—"} → ${dateRange.to || "—"}`;
    // Tax configuration
    const [taxModalOpen, setTaxModalOpen] = useState(false);
    const [taxConfig, setTaxConfig] = useState(getTaxConfig());
    // Classify booking-source rows (SourceDay) into the configured tax buckets.
    // Matching is based on the source/code text since the imported reports
    // carry channel names like "EXPEDIA HOTEL COLLECT", "WALK-IN", "PRP"...
    const classifySource = (r) => {
        const text = `${r.source || ""} ${r.code || ""}`.toUpperCase();
        if (/EXPEDIA.*HOTEL COLLECT|EHC/.test(text))
            return "EXPEDIA_HC";
        if (/BOOKING\.?COM.*HOTEL COLLECT|BHC/.test(text))
            return "BOOKING_HC";
        if (/WALK|WIN/.test(text))
            return "WALK_IN";
        if (/PROPERTY BOOKING|PRP|RR WEBSITE|WEB|RED ROOF APP|APP|CONTACT CENTER|CRS/.test(text))
            return "PROPERTY_BOOKING";
        return "OTHER_OTA";
    };
    const taxCalculations = useMemo(() => {
        const buckets = {};
        srcRows.forEach((r) => {
            const key = classifySource(r);
            buckets[key] = (buckets[key] || 0) + (Number(r.net_revenue) || 0);
        });
        return TAX_SOURCES.map((src) => {
            const rent = buckets[src.key] || 0;
            const tax = calculateTax(rent, src.key);
            return { ...src, rent, tax };
        });
    }, [srcRows, taxConfig]);
    const totalTaxCollected = taxCalculations.reduce((a, c) => a + c.tax, 0);
    if (isLoading)
        return _jsx("p", { className: "text-slate-500", children: "Loading payment data\u2026" });
    return (_jsxs("div", { className: "space-y-6", children: [(pullDist > 0 || refreshing) && (_jsx("div", { className: "flex items-center justify-center overflow-hidden", style: { height: Math.max(pullDist, refreshing ? 40 : 0) }, children: _jsx(RefreshCw, { className: `h-5 w-5 text-slate-400 ${refreshing ? "animate-spin" : ""}` }) })), _jsxs("header", { children: [_jsx("p", { className: "text-[11px] uppercase tracking-[0.3em] text-[#00D4FF]", children: "Module 7" }), _jsx("h1", { className: "mt-2 font-heading text-3xl font-semibold text-white", children: "Payment Methods" }), _jsxs("p", { className: "mt-1 text-sm text-slate-400", children: [propName, " \u00B7 ", periodLabel, " \u00B7 ", payRows.length, " days of data"] })] }), _jsxs(Card, { title: "Tax Management", subtitle: `Rate: ${formatTaxRate(taxConfig.taxRate)} · ${taxConfig.taxEnabled ? "Active" : "Disabled"}`, right: _jsxs("button", { onClick: () => setTaxModalOpen(true), className: "flex items-center gap-1.5 rounded-lg border border-white/10 bg-[#0A1628] px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-[#00D4FF]/30", children: [_jsx(Settings, { className: "h-3.5 w-3.5" }), " Configure Tax"] }), children: [_jsxs("div", { className: "grid gap-4 lg:grid-cols-3", children: [_jsxs("div", { className: "rounded-xl border border-white/5 bg-[#0A1628]/60 p-4", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx(Percent, { className: "h-4 w-4 text-[#00D4FF]" }), _jsx("p", { className: "text-[10px] uppercase tracking-widest text-slate-500", children: "Tax Rate" })] }), _jsx("p", { className: "mt-2 font-heading text-3xl font-semibold text-white", children: formatTaxRate(taxConfig.taxRate) }), _jsxs("div", { className: "mt-3 rounded-lg bg-[#040D1A] p-2.5", children: [_jsx("p", { className: "text-xs text-slate-500", children: "Formula" }), _jsxs("p", { className: "mt-0.5 font-mono text-xs text-[#00D4FF]", children: ["Tax = Room Rent \u00D7 ", formatTaxRate(taxConfig.taxRate)] })] }), _jsxs("div", { className: "mt-2 space-y-0.5 text-xs text-slate-500", children: [_jsxs("p", { children: ["$100 \u2192 $", (100 * taxConfig.taxRate).toFixed(2), " tax"] }), _jsxs("p", { children: ["$200 \u2192 $", (200 * taxConfig.taxRate).toFixed(2), " tax"] }), _jsxs("p", { children: ["$300 \u2192 $", (300 * taxConfig.taxRate).toFixed(2), " tax"] })] })] }), _jsxs("div", { className: "rounded-xl border border-white/5 bg-[#0A1628]/60 p-4 lg:col-span-2", children: [_jsx("p", { className: "text-[10px] uppercase tracking-widest text-slate-500", children: "Tax Breakdown by Booking Source" }), _jsx("div", { className: "mt-3 overflow-x-auto", children: _jsxs("table", { className: "w-full text-sm", children: [_jsx("thead", { children: _jsxs("tr", { className: "text-left text-[11px] uppercase tracking-widest text-slate-500", children: [_jsx("th", { className: "pb-2 pr-4", children: "Booking Source" }), _jsx("th", { className: "pb-2 pr-4 text-right", children: "Room Rent" }), _jsx("th", { className: "pb-2 pr-4 text-right", children: "Tax Rate" }), _jsx("th", { className: "pb-2 pr-4 text-right", children: "Tax Amount" }), _jsx("th", { className: "pb-2 text-center", children: "Status" })] }) }), _jsx("tbody", { children: taxCalculations.map((c) => (_jsxs("tr", { className: "border-t border-white/5", children: [_jsx("td", { className: "py-2.5 pr-4 text-slate-200", children: c.label }), _jsx("td", { className: "py-2.5 pr-4 text-right tabular-nums text-slate-300", children: money2(c.rent) }), _jsx("td", { className: "py-2.5 pr-4 text-right tabular-nums text-slate-400", children: c.taxable ? formatTaxRate(taxConfig.taxRate) : "—" }), _jsx("td", { className: "py-2.5 pr-4 text-right tabular-nums text-[#00D4FF]", children: money2(c.tax) }), _jsx("td", { className: "py-2.5 text-center", children: c.taxable ? (_jsx("span", { className: "rounded-full bg-[#00E096]/10 px-2 py-0.5 text-[10px] text-[#00E096]", children: "Taxable" })) : (_jsx("span", { className: "rounded-full bg-slate-700/30 px-2 py-0.5 text-[10px] text-slate-400", children: "Exempt" })) })] }, c.key))) }), _jsx("tfoot", { children: _jsxs("tr", { className: "border-t-2 border-white/10 bg-[#040D1A]/80", children: [_jsx("td", { className: "py-3 pr-4 font-semibold text-white", children: "TOTAL" }), _jsx("td", { className: "py-3 pr-4 text-right tabular-nums text-slate-300", children: money2(taxCalculations.reduce((a, c) => a + c.rent, 0)) }), _jsx("td", { className: "py-3 pr-4 text-right text-slate-500", children: "\u2014" }), _jsx("td", { className: "py-3 pr-4 text-right font-heading text-lg font-semibold text-[#00D4FF]", children: money2(totalTaxCollected) }), _jsx("td", { className: "py-3 text-center text-xs text-slate-500", children: taxConfig.taxEnabled ? "Active" : "Off" })] }) })] }) })] })] }), _jsx(TaxConfigModal, { open: taxModalOpen, onClose: () => { setTaxModalOpen(false); setTaxConfig(getTaxConfig()); } })] }), payRows.length === 0 ? (_jsxs(Card, { title: "No payment data available", children: [_jsxs("p", { className: "text-sm text-slate-400", children: ["No payment data is available for ", _jsx("span", { className: "text-slate-200", children: propName }), " during", " ", _jsx("span", { className: "text-slate-200", children: periodLabel }), "."] }), _jsxs("p", { className: "mt-2 text-sm text-slate-500", children: ["Import a ", _jsx("span", { className: "text-slate-300", children: "Payments Summary" }), " report to see payment method breakdowns, reconciliation, and daily trends."] })] })) : (_jsxs(_Fragment, { children: [_jsxs("div", { className: "grid gap-4 sm:grid-cols-2 xl:grid-cols-5", children: [_jsx(KpiCard, { label: "Total Collected", value: money(totalCollected), sub: `${payRows.length} days`, accent: C.purple, icon: DollarSign }), _jsx(KpiCard, { label: "Net Payment", value: money(netPaymentCollected), sub: `After ${money(refunds)} refunds`, accent: C.green, icon: DollarSign }), _jsx(KpiCard, { label: "Cash", value: money(cashTotal), sub: `${totalCollected ? ((cashTotal / totalCollected) * 100).toFixed(1) : 0}% of total`, accent: C.amber, icon: DollarSign }), _jsx(KpiCard, { label: "Card", value: money(cardTotal), sub: `${totalCollected ? ((cardTotal / totalCollected) * 100).toFixed(1) : 0}% of total`, accent: C.cyan, icon: CreditCard }), _jsx(KpiCard, { label: "Variance", value: money2(variance), sub: `Expected ${money2(expectedRevenue)}`, accent: Math.abs(variance) < 1 ? C.green : C.coral, icon: Receipt })] }), _jsx(Card, { title: "Payment Method Distribution", subtitle: `${propName} · ${periodLabel}`, right: _jsx(ChartToolbar, { targetRef: chartRef, title: "Payment Method Distribution", dateRange: periodLabel }), children: _jsx("div", { ref: chartRef, children: _jsx(UniversalChart, { data: paymentData, type: "donut" }) }) }), _jsx(Card, { title: "Payment Method Breakdown", subtitle: "Gross amounts by method with percentage of total", children: _jsx("div", { className: "overflow-x-auto", children: _jsxs("table", { className: "w-full text-sm", children: [_jsx("thead", { children: _jsxs("tr", { className: "text-left text-[11px] uppercase tracking-widest text-slate-500", children: [_jsx("th", { className: "pb-3 pr-4", children: "Payment Method" }), _jsx("th", { className: "pb-3 pr-4 text-right", children: "Total Amount" }), _jsx("th", { className: "pb-3 pr-4 text-right", children: "% of Total" }), _jsx("th", { className: "pb-3 text-right", children: "Category" })] }) }), _jsx("tbody", { children: paymentData.map((p) => {
                                            const pctOfTotal = totalCollected ? (p.value / totalCollected) * 100 : 0;
                                            const category = p.key === "cash" ? "Cash" : CARD_METHODS.includes(p.key) ? "Card" : p.key === "check" ? "Check" : "Other";
                                            return (_jsxs("tr", { className: "border-t border-white/5 transition-colors hover:bg-white/[0.03]", children: [_jsx("td", { className: "py-2.5 pr-4 text-slate-200", children: p.name }), _jsx("td", { className: "py-2.5 pr-4 text-right tabular-nums text-white", children: money(p.value) }), _jsxs("td", { className: "py-2.5 pr-4 text-right tabular-nums text-slate-400", children: [pctOfTotal.toFixed(1), "%"] }), _jsx("td", { className: "py-2.5 text-right text-xs text-slate-500", children: category })] }, p.key));
                                        }) }), _jsx("tfoot", { children: _jsxs("tr", { className: "border-t-2 border-white/10 bg-[#0A1628]/80", children: [_jsx("td", { className: "py-3 pr-4 font-semibold text-white", children: "TOTAL" }), _jsx("td", { className: "py-3 pr-4 text-right font-heading text-lg font-semibold text-[#00D4FF]", children: money(totalCollected) }), _jsx("td", { className: "py-3 pr-4 text-right tabular-nums text-slate-400", children: "100.0%" }), _jsxs("td", { className: "py-3 text-right text-xs text-slate-500", children: [paymentData.length, " methods"] })] }) })] }) }) }), _jsx(Card, { title: "Payment Reconciliation", subtitle: "Expected revenue vs recorded payments by day", children: _jsxs("div", { className: "space-y-4", children: [_jsxs("div", { className: "grid gap-3 sm:grid-cols-3", children: [_jsxs("div", { className: "rounded-xl bg-[#0A1628]/60 p-4", children: [_jsx("p", { className: "text-[10px] uppercase tracking-widest text-slate-500", children: "Expected Revenue" }), _jsx("p", { className: "mt-1 text-xl font-semibold text-white", children: money(expectedRevenue) }), _jsx("p", { className: "text-xs text-slate-500", children: "From occupancy reports" })] }), _jsxs("div", { className: "rounded-xl bg-[#0A1628]/60 p-4", children: [_jsx("p", { className: "text-[10px] uppercase tracking-widest text-slate-500", children: "Recorded Payments" }), _jsx("p", { className: "mt-1 text-xl font-semibold text-white", children: money(totalCollected) }), _jsx("p", { className: "text-xs text-slate-500", children: "From payment summary" })] }), _jsxs("div", { className: "rounded-xl bg-[#0A1628]/60 p-4", children: [_jsx("p", { className: "text-[10px] uppercase tracking-widest text-slate-500", children: "Variance" }), _jsxs("p", { className: "mt-1 text-xl font-semibold", style: { color: Math.abs(variance) < 1 ? C.green : C.coral }, children: [variance >= 0 ? "+" : "", money2(variance)] }), _jsx("p", { className: "text-xs text-slate-500", children: Math.abs(variance) < 1 ? "Balanced" : variance > 0 ? "Over-collected" : "Under-collected" })] })] }), methodFiltered ? (_jsxs("div", { className: "flex items-start gap-3 rounded-xl border border-[#00D4FF]/20 bg-[#00D4FF]/[0.06] p-4", children: [_jsx(AlertTriangle, { className: "mt-0.5 h-5 w-5 shrink-0 text-[#00D4FF]" }), _jsxs("div", { children: [_jsx("p", { className: "text-sm text-slate-200", children: "Showing one payment method only." }), _jsx("p", { className: "mt-1 text-xs text-slate-400", children: "Variance compares a single tender against the full room revenue for the period, so a large gap is expected here and does not indicate a problem. Set the payment method filter back to All to reconcile collections against revenue." })] })] })) : Math.abs(variance) > 100 && (_jsxs("div", { className: "flex items-start gap-3 rounded-xl border border-[#FFB547]/20 bg-[#FFB547]/[0.06] p-4", children: [_jsx(AlertTriangle, { className: "mt-0.5 h-5 w-5 shrink-0 text-[#FFB547]" }), _jsxs("div", { children: [_jsxs("p", { className: "text-sm text-slate-200", children: ["Payment variance of ", money2(Math.abs(variance)), " detected."] }), _jsx("p", { className: "mt-1 text-xs text-slate-400", children: "Possible causes: refunds not captured in daily total, advance deposits, adjustments, or missing payment records for some days. Review the daily trend below and compare with occupancy revenue to identify the discrepancy source." })] })] }))] }) }), dailyTrend.length > 0 && (_jsx(Card, { title: "Daily Payment Trend", subtitle: `${dailyTrend.length} days · Total, Cash, and Card`, children: _jsx("div", { className: "max-h-96 overflow-auto", children: _jsxs("table", { className: "w-full text-sm", children: [_jsx("thead", { className: "sticky top-0 bg-[#0F1F35] text-left text-[11px] uppercase tracking-widest text-slate-500", children: _jsxs("tr", { children: [_jsx("th", { className: "py-2 pr-4", children: "Date" }), _jsx("th", { className: "py-2 pr-4 text-right", children: "Total" }), _jsx("th", { className: "py-2 pr-4 text-right", children: "Cash" }), _jsx("th", { className: "py-2 pr-4 text-right", children: "Card" }), _jsx("th", { className: "py-2 text-right", children: "% Cash" })] }) }), _jsx("tbody", { children: dailyTrend.map((d) => (_jsxs("tr", { className: "border-t border-white/5", children: [_jsx("td", { className: "py-2 pr-4 text-slate-300", children: d.date }), _jsx("td", { className: "py-2 pr-4 text-right tabular-nums text-white", children: money(d.total) }), _jsx("td", { className: "py-2 pr-4 text-right tabular-nums text-slate-400", children: money2(d.cash) }), _jsx("td", { className: "py-2 pr-4 text-right tabular-nums text-slate-400", children: money2(d.card) }), _jsxs("td", { className: "py-2 text-right tabular-nums text-slate-500", children: [d.total ? ((d.cash / d.total) * 100).toFixed(0) : 0, "%"] })] }, d.date))) })] }) }) })), clerkAdjustments.length > 0 && (_jsx(Card, { title: "Payment Audit", subtitle: "Click a clerk to expand individual payment records", children: _jsx("div", { className: "space-y-2", children: clerkAdjustments.map((c) => (_jsxs("div", { children: [_jsxs("button", { onClick: () => setExpandedClerk(expandedClerk === c.clerk ? null : c.clerk), className: "flex w-full items-center justify-between rounded-xl border border-white/5 bg-[#0A1628]/60 px-4 py-3 transition-colors hover:border-white/10", children: [_jsxs("div", { className: "text-left", children: [_jsx("p", { className: "text-sm text-white", children: c.clerk }), _jsxs("p", { className: "text-xs text-slate-500", children: [c.count, " payment", c.count === 1 ? "" : "s"] })] }), _jsx("div", { className: "text-right", children: _jsx("p", { className: "font-heading text-base tabular-nums text-[#00D4FF]", children: money(c.adjusted) }) })] }), expandedClerk === c.clerk && (_jsxs("div", { className: "mt-1 space-y-1 rounded-xl border border-white/5 bg-[#040D1A] p-3", children: [c.records.slice(0, 50).map((r, i) => (_jsxs("div", { className: "flex items-center justify-between py-1.5 text-xs", children: [_jsx("span", { className: "text-slate-400", children: r.payment_type || "—" }), _jsx("span", { className: "tabular-nums text-slate-300", children: money2(Number(r.amount) || 0) })] }, i))), _jsxs("div", { className: "mt-2 flex items-center justify-between border-t border-white/5 pt-2", children: [_jsx("span", { className: "text-xs font-medium text-slate-300", children: "Total" }), _jsx("span", { className: "font-heading text-sm tabular-nums text-[#00D4FF]", children: money(c.adjusted) })] })] }))] }, c.clerk))) }) })), drops.length > 0 && (_jsx(Card, { title: "Cash Drop Records", subtitle: `${drops.length} deposit drop records`, children: _jsx("div", { className: "max-h-80 overflow-auto", children: _jsxs("table", { className: "w-full text-sm", children: [_jsx("thead", { className: "sticky top-0 bg-[#0F1F35] text-left text-[11px] uppercase tracking-widest text-slate-500", children: _jsxs("tr", { children: [_jsx("th", { className: "py-2 pr-4", children: "Date" }), _jsx("th", { className: "py-2 pr-4", children: "Clerk" }), _jsx("th", { className: "py-2 text-right", children: "Amount" })] }) }), _jsx("tbody", { children: drops.map((d, i) => (_jsxs("tr", { className: "border-t border-white/5", children: [_jsx("td", { className: "py-2 pr-4 text-slate-300", children: String(d.shift_date || "").slice(0, 10) || "—" }), _jsx("td", { className: "py-2 pr-4 text-slate-400", children: d.clerk_name || "—" }), _jsx("td", { className: "py-2 text-right tabular-nums text-[#00D4FF]", children: money2(d.amount) })] }, i))) })] }) }) }))] }))] }));
}
