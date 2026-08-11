import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import React, { useMemo, useState } from "react";
import { Users, AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, Info } from "lucide-react";
import Card from "@/components/ui-exec/Card";
import KpiCard from "@/components/ui-exec/KpiCard";
import { useClerkRecords } from "@/lib/useHotelData";
import { money2, num, C } from "@/lib/hotel";
import { useGlobalFilters } from "@/lib/useGlobalFilters";
export default function Employees() {
    const { dateRange, property, properties, employee } = useGlobalFilters();
    const { data: records = [], isLoading } = useClerkRecords(dateRange, property);
    const [selected, setSelected] = useState(null);
    // Clerk records imported from ClerkShift.csv come in three record types:
    //  - "payment": payment method totals (CASH, CHECK, AMEX...), NOT clerks
    //  - "clerk_payment": per-clerk payment activity with clerk_name + amount
    //  - "drop": cash drops with clerk_name + shift_date + amount
    // We only surface clerk_payment and drop records; payment methods are
    // shown on the Payments page instead.
    const clerkRecords = useMemo(() => {
        let r = records.filter((x) => x.record_type === "clerk_payment");
        if (employee !== "all")
            r = r.filter((x) => x.clerk_name === employee);
        return r;
    }, [records, employee]);
    const drops = useMemo(() => {
        let r = records.filter((x) => x.record_type === "drop");
        if (employee !== "all")
            r = r.filter((x) => x.clerk_name === employee);
        return r;
    }, [records, employee]);
    const stats = useMemo(() => {
        if (!clerkRecords.length && !drops.length)
            return [];
        const map = new Map();
        const ensure = (k) => {
            if (!map.has(k))
                map.set(k, {
                    clerk: k,
                    totalAdjusted: 0,
                    positiveSum: 0,
                    negativeSum: 0,
                    txnCount: 0,
                    records: [],
                    dropCount: 0,
                    cashDropped: 0,
                });
            return map.get(k);
        };
        clerkRecords.forEach((r) => {
            const k = r.clerk_name || "Unknown";
            const s = ensure(k);
            const adj = Number(r.amount) || 0;
            s.totalAdjusted += adj;
            if (adj > 0)
                s.positiveSum += adj;
            else if (adj < 0)
                s.negativeSum += adj;
            s.txnCount += 1;
            s.records.push(r);
        });
        drops.forEach((d) => {
            const k = d.clerk_name || "Unknown";
            const s = ensure(k);
            s.dropCount += 1;
            s.cashDropped += Number(d.amount) || 0;
        });
        return [...map.values()].map((s) => {
            let status = "balanced";
            if (s.dropCount > 0) {
                const dropVariance = s.cashDropped - s.totalAdjusted;
                if (Math.abs(dropVariance) > 1)
                    status = dropVariance > 0 ? "over" : "short";
                else
                    status = "balanced";
            }
            else {
                if (s.totalAdjusted > 0)
                    status = "over";
                else if (s.totalAdjusted < 0)
                    status = "short";
            }
            return {
                ...s,
                avgPerRecord: s.txnCount ? Math.abs(s.totalAdjusted) / s.txnCount : 0,
                status,
            };
        }).sort((a, b) => b.txnCount - a.txnCount);
    }, [clerkRecords, drops]);
    const totalAdjusted = stats.reduce((a, s) => a + s.totalAdjusted, 0);
    const totalTxns = stats.reduce((a, s) => a + s.txnCount, 0);
    const totalDrops = stats.reduce((a, s) => a + s.dropCount, 0);
    const propName = property === "all" ? "All Properties" : (properties.find((p) => p.id === property)?.name || "Property");
    const periodLabel = `${dateRange.from || "—"} → ${dateRange.to || "—"}`;
    if (isLoading)
        return _jsx("p", { className: "text-slate-500", children: "Loading clerk data\u2026" });
    return (_jsxs("div", { className: "space-y-6", children: [_jsxs("header", { children: [_jsx("p", { className: "text-[11px] uppercase tracking-[0.3em] text-[#00D4FF]", children: "Module 6" }), _jsx("h1", { className: "mt-2 font-heading text-3xl font-semibold text-white", children: "Clerk Audit" }), _jsxs("p", { className: "mt-1 text-sm text-slate-400", children: [propName, " \u00B7 ", periodLabel, " \u00B7 ", totalTxns, " records \u00B7 ", stats.length, " clerks"] })] }), stats.length === 0 ? (_jsxs(Card, { title: "No clerk data available", children: [_jsxs("p", { className: "text-sm text-slate-400", children: ["No clerk shift records are available for ", _jsx("span", { className: "text-slate-200", children: propName }), " during", " ", _jsx("span", { className: "text-slate-200", children: periodLabel }), "."] }), _jsxs("p", { className: "mt-2 text-sm text-slate-500", children: ["Import a ", _jsx("span", { className: "text-slate-300", children: "Clerk Shift & Cash Audit" }), " report to see clerk performance, cash handling, and audit flags."] })] })) : (_jsxs(_Fragment, { children: [_jsxs("div", { className: "flex items-start gap-3 rounded-xl border border-[#FFB547]/20 bg-[#FFB547]/[0.06] p-4", children: [_jsx(Info, { className: "mt-0.5 h-5 w-5 shrink-0 text-[#FFB547]" }), _jsxs("div", { children: [_jsx("p", { className: "text-sm text-slate-200", children: "Clerk Audit Data Quality Notice" }), _jsxs("p", { className: "mt-1 text-xs text-slate-400", children: [stats.length, " clerks detected from ", totalTxns, " payment records imported from ClerkShift.csv. Clerk performance is derived from the per-clerk payment activity and cash deposit records in the report. Net amounts shown represent the difference between positive and negative payment activity per clerk."] })] })] }), _jsxs("div", { className: "grid gap-4 sm:grid-cols-2 xl:grid-cols-4", children: [_jsx(KpiCard, { label: "Clerks Detected", value: num(stats.length), sub: "from payment records", accent: C.purple, icon: Users }), _jsx(KpiCard, { label: "Total Records", value: num(totalTxns), sub: "payment entries", accent: C.cyan }), _jsx(KpiCard, { label: "Net Payments", value: money2(totalAdjusted), sub: totalAdjusted >= 0 ? "Net positive" : "Net negative", accent: totalAdjusted >= 0 ? C.green : C.coral }), _jsx(KpiCard, { label: "Cash Drops", value: num(totalDrops), sub: totalDrops ? "deposit records" : "no drop data", accent: C.amber })] }), _jsx(Card, { title: "Clerk Performance", subtitle: "Click a row to see adjustment details", children: _jsx("div", { className: "overflow-x-auto", children: _jsxs("table", { className: "w-full text-sm", children: [_jsx("thead", { children: _jsxs("tr", { className: "text-left text-[11px] uppercase tracking-widest text-slate-500", children: [_jsx("th", { className: "pb-3 pr-4", children: "Clerk" }), _jsx("th", { className: "pb-3 pr-4 text-right", children: "Records" }), _jsx("th", { className: "pb-3 pr-4 text-right", children: "Positive Adj." }), _jsx("th", { className: "pb-3 pr-4 text-right", children: "Negative Adj." }), _jsx("th", { className: "pb-3 pr-4 text-right", children: "Net Adjusted" }), totalDrops > 0 && _jsx("th", { className: "pb-3 pr-4 text-right", children: "Cash Dropped" }), _jsx("th", { className: "pb-3 text-right", children: "Audit Status" })] }) }), _jsx("tbody", { children: stats.map((s) => (_jsxs(React.Fragment, { children: [_jsxs("tr", { onClick: () => setSelected(selected === s.clerk ? null : s.clerk), className: "cursor-pointer border-t border-white/5 transition-colors hover:bg-white/[0.03]", children: [_jsx("td", { className: "py-2.5 pr-4", children: _jsxs("span", { className: "flex items-center gap-2 text-slate-200", children: [selected === s.clerk ? _jsx(ChevronUp, { className: "h-3.5 w-3.5 text-slate-500" }) : _jsx(ChevronDown, { className: "h-3.5 w-3.5 text-slate-500" }), s.clerk] }) }), _jsx("td", { className: "py-2.5 pr-4 text-right tabular-nums text-slate-400", children: num(s.txnCount) }), _jsx("td", { className: "py-2.5 pr-4 text-right tabular-nums text-[#00E096]", children: money2(s.positiveSum) }), _jsx("td", { className: "py-2.5 pr-4 text-right tabular-nums text-[#FF6B6B]", children: money2(s.negativeSum) }), _jsxs("td", { className: "py-2.5 pr-4 text-right tabular-nums text-white", children: [s.totalAdjusted >= 0 ? "+" : "", money2(s.totalAdjusted)] }), totalDrops > 0 && (_jsx("td", { className: "py-2.5 pr-4 text-right tabular-nums text-slate-300", children: money2(s.cashDropped) })), _jsx("td", { className: "py-2.5 text-right", children: s.status === "over" ? (_jsxs("span", { className: "flex items-center justify-end gap-1 text-xs text-[#FFB547]", children: [_jsx(AlertTriangle, { className: "h-3.5 w-3.5" }), " Over"] })) : s.status === "short" ? (_jsxs("span", { className: "flex items-center justify-end gap-1 text-xs text-[#FF6B6B]", children: [_jsx(AlertTriangle, { className: "h-3.5 w-3.5" }), " Short"] })) : (_jsxs("span", { className: "flex items-center justify-end gap-1 text-xs text-[#00E096]", children: [_jsx(CheckCircle2, { className: "h-3.5 w-3.5" }), " Balanced"] })) })] }), selected === s.clerk && (_jsx("tr", { className: "border-t border-white/5", children: _jsxs("td", { colSpan: totalDrops > 0 ? 7 : 6, className: "bg-[#0A1628]/40 px-8 py-4", children: [_jsxs("p", { className: "mb-3 text-[11px] uppercase tracking-widest text-slate-500", children: ["Payment details \u2014 ", s.clerk, " \u00B7 ", s.records.length, " records"] }), _jsx("div", { className: "max-h-60 overflow-auto", children: _jsxs("table", { className: "w-full text-xs", children: [_jsx("thead", { children: _jsxs("tr", { className: "text-left text-slate-500", children: [_jsx("th", { className: "pb-2 pr-4", children: "Payment Type" }), _jsx("th", { className: "pb-2 pr-4 text-right", children: "Amount" }), _jsx("th", { className: "pb-2 text-right", children: "Txns" })] }) }), _jsx("tbody", { children: s.records.slice(0, 100).map((r) => (_jsxs("tr", { className: "border-t border-white/5", children: [_jsx("td", { className: "py-1.5 pr-4 text-slate-300", children: r.payment_type || "—" }), _jsx("td", { className: "py-1.5 pr-4 text-right tabular-nums text-slate-300", children: money2(r.amount) }), _jsx("td", { className: "py-1.5 text-right tabular-nums text-slate-500", children: r.transaction_count || "—" })] }, r.id))) })] }) })] }) }))] }, s.clerk))) })] }) }) })] }))] }));
}
