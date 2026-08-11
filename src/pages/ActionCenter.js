import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React, { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ArrowRight, Wrench, AlertTriangle, TrendingUp, BadgeCheck, DollarSign, Percent, Gauge, Target, Sparkles, } from "lucide-react";
import Card from "@/components/ui-exec/Card";
import KpiCard from "@/components/ui-exec/KpiCard";
import { db } from "@/api/base44Client";
import { useOccupancy, useSources, usePaymentData } from "@/lib/useHotelData";
import { useGlobalFilters } from "@/lib/useGlobalFilters";
import { getOccThreshold, money, money2, pct } from "@/lib/hotel";
import { buildActionCenter } from "@/lib/actionCenter";
// Pick up productivity ticks describing each bucket's tone
const TONE = {
    red: { label: "Fix Today", color: "#FF6B6B", icon: Wrench, ring: "#FF6B6B", dot: "bg-[#FF6B6B]" },
    amber: { label: "Investigate", color: "#FFB547", icon: AlertTriangle, ring: "#FFB547", dot: "bg-[#FFB547]" },
    green: { label: "Opportunity", color: "#00E096", icon: TrendingUp, ring: "#00E096", dot: "bg-[#00E096]" },
    cyan: { label: "Keep Doing", color: "#00D4FF", icon: BadgeCheck, ring: "#00D4FF", dot: "bg-[#00D4FF]" },
};
const BUCKETS = [
    ["fix", "Fix Today", "Pain the property is feeling right now"],
    ["investigate", "Investigate", "Money movement that deserves a second look"],
    ["opportunity", "Opportunity", "Money you can still make"],
    ["keepDoing", "Keep Doing", "What's working — protect it"],
];
function buildPropertyFilter(property) {
    const filter = {};
    if (property && property !== "all") {
        if (Array.isArray(property)) {
            if (property.length > 0)
                filter.property_id = { $in: property };
        }
        else {
            filter.property_id = property;
        }
    }
    return filter;
}
function ActionCard({ action }) {
    const tone = TONE[action.tone] || TONE.amber;
    const Icon = tone.icon;
    return (_jsxs("div", { className: "group relative overflow-hidden rounded-2xl border border-white/5 bg-[#0F1F35]/80 p-4 transition-all duration-300 hover:border-white/15", children: [_jsx("div", { className: "absolute inset-x-0 top-0 h-[2px]", style: { background: `linear-gradient(90deg, transparent, ${tone.color}88, transparent)` } }), _jsxs("div", { className: "flex items-start gap-3", children: [_jsx("div", { className: "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl", style: { background: `${tone.color}1f`, color: tone.color }, children: _jsx(Icon, { className: "h-4.5 w-4.5" }) }), _jsxs("div", { className: "min-w-0 flex-1", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx("span", { className: "rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-widest", style: { background: `${tone.color}1a`, color: tone.color }, children: tone.label }), typeof action.impact === "number" && (_jsxs("span", { className: "text-[10px] text-slate-500", children: ["impact ~$", Math.round(action.impact).toLocaleString()] }))] }), _jsx("p", { className: "mt-1.5 font-heading text-sm font-semibold leading-snug text-white", children: action.title }), _jsx("p", { className: "mt-1 text-xs leading-relaxed text-slate-400", children: action.detail }), action.metrics && (_jsx("div", { className: "mt-3 grid grid-cols-3 gap-2", children: action.metrics.map(([label, value]) => (_jsxs("div", { className: "rounded-lg border border-white/5 bg-[#0A1628]/60 px-2 py-1.5", children: [_jsx("p", { className: "text-[9px] uppercase tracking-wider text-slate-500", children: label }), _jsx("p", { className: "mt-0.5 text-xs tabular-nums text-slate-200", children: value })] }, label))) })), action.to && (_jsxs(Link, { to: action.to, className: "mt-3 inline-flex items-center gap-1 text-xs font-medium text-[#6C63FF] transition-colors hover:text-[#9B8CFF]", children: ["View related report ", _jsx(ArrowRight, { className: "h-3 w-3" })] }))] })] })] }));
}
export default function ActionCenter() {
    const { dateRange, property, properties, months, channel } = useGlobalFilters();
    const { data: occ = [] } = useOccupancy(dateRange, property, months);
    const { data: sources = [] } = useSources(dateRange, property, months);
    const { data: payRows = [] } = usePaymentData(dateRange, property, months);
    const propertyKey = Array.isArray(property) ? property.join(",") : property;
    const propFilter = useMemo(() => buildPropertyFilter(property), [property]);
    const { data: expenses = [] } = useQuery({
        queryKey: ["expenses", propertyKey],
        queryFn: () => db.entities.Expense.filter(propFilter, "-expense_date", 100000),
    });
    const { data: payroll = [] } = useQuery({
        queryKey: ["payroll", propertyKey],
        queryFn: () => db.entities.PayrollRun.filter(propFilter, "-pay_period_start", 100000),
    });
    // Previous equal-length window for period-over-period deltas
    const prevRange = useMemo(() => {
        if (!dateRange.from || !dateRange.to)
            return { from: "", to: "" };
        const days = Math.round((new Date(dateRange.to).getTime() - new Date(dateRange.from).getTime()) / 86400000) + 1;
        const prevTo = new Date(new Date(dateRange.from).getTime() - 86400000);
        const prevFrom = new Date(prevTo.getTime() - (days - 1) * 86400000);
        return { from: prevFrom.toISOString().slice(0, 10), to: prevTo.toISOString().slice(0, 10) };
    }, [dateRange]);
    const prevEnabled = !!(prevRange.from && prevRange.to);
    const { data: prevOcc = [] } = useOccupancy(prevRange, property, [], prevEnabled);
    const roomCounts = useMemo(() => {
        if (property === "all" || Array.isArray(property)) {
            const map = {};
            properties.forEach((p) => { map[p.id] = p.rooms || 100; });
            return map;
        }
        return { [property]: properties.find((p) => p.id === property)?.rooms || 100 };
    }, [property, properties]);
    const model = useMemo(() => {
        const occRows = occ.filter((r) => {
            const d = String(r.date || "").slice(0, 10);
            return d >= (dateRange.from || "") && d <= (dateRange.to || "");
        });
        const srcRows = sources
            .filter((r) => {
            const d = String(r.date || "").slice(0, 10);
            return d >= (dateRange.from || "") && d <= (dateRange.to || "");
        })
            .filter((x) => channel === "all" || x.source === channel || x.code === channel);
        return buildActionCenter({
            occRows,
            srcRows,
            payRows,
            expenses,
            payroll,
            roomCounts,
            dateRange,
            prevOccRows: prevOcc,
        });
    }, [occ, sources, payRows, expenses, payroll, roomCounts, dateRange, prevOcc, channel]);
    const { premise, buckets, top3, meta } = model;
    const propName = property === "all"
        ? "All Properties"
        : Array.isArray(property)
            ? `${property.length} Properties`
            : (properties.find((p) => p.id === property)?.name || "Property");
    return (_jsxs("div", { className: "space-y-6", children: [_jsxs("header", { children: [_jsx("p", { className: "text-[11px] uppercase tracking-[0.3em] text-[#00D4FF]", children: "Owner Operating System" }), _jsx("h1", { className: "mt-2 font-heading text-3xl font-semibold text-white", children: "Owner Action Center" }), _jsxs("p", { className: "mt-1 text-sm text-slate-400", children: ["What happened \u00B7 why \u00B7 what's going wrong \u00B7 what to do next. ", propName, " \u00B7 ", dateRange.from || "—", " \u2192 ", dateRange.to || "—"] })] }), _jsx(Card, { title: "Where you stand", subtitle: "Computed from imported data for this period", children: _jsxs("div", { className: "grid gap-4 sm:grid-cols-2 xl:grid-cols-4", children: [_jsx(KpiCard, { label: "Revenue", value: money(premise.revenue), accent: "#6C63FF", icon: DollarSign, sub: `${meta.comparedToPrev ? 'vs ' + money(meta.prevStats?.revenue) : 'no previous window'}` }), _jsx(KpiCard, { label: "Occupancy", value: pct(premise.occupancy), accent: "#00D4FF", icon: Percent, sub: `target ${pct(getOccThreshold())}` }), _jsx(KpiCard, { label: "ADR", value: money2(premise.adr), accent: "#00E096", icon: Gauge, sub: `RevPAR ${money2(premise.revpar)}` }), _jsx(KpiCard, { label: "Est. money kept", value: money(premise.keepRate ? premise.revenue * premise.keepRate : 0), accent: "#FFB547", icon: Target, sub: "pre-tax \u00B7 after fees, payroll & expenses" })] }) }), _jsx(Card, { title: "Today's highest-value actions", subtitle: "Ranked by estimated dollar impact", right: _jsx(Sparkles, { className: "h-4 w-4 text-[#00D4FF]" }), children: _jsxs("div", { className: "grid gap-4 lg:grid-cols-3", children: [top3.map((a, i) => (_jsx(ActionCard, { action: a }, a.key || i))), top3.length === 0 && (_jsx("p", { className: "text-sm text-slate-500", children: "No actionable items yet \u2014 import more data, or everything is healthy." }))] }) }), BUCKETS.map(([key, label, desc]) => {
                const items = buckets[key] || [];
                return (_jsxs("div", { children: [_jsxs("div", { className: "mb-3 flex items-center gap-2", children: [_jsx("h3", { className: "font-heading text-base font-semibold text-white", children: label }), _jsx("span", { className: "rounded-full bg-white/5 px-2 py-0.5 text-[11px] text-slate-400", children: items.length }), _jsxs("span", { className: "hidden text-xs text-slate-500 sm:inline", children: ["\u00B7 ", desc] })] }), items.length ? (_jsx("div", { className: "grid gap-4 lg:grid-cols-2", children: items.map((a, i) => _jsx(ActionCard, { action: a }, a.key || i)) })) : (_jsx("p", { className: "rounded-xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-3 text-sm text-slate-500", children: "Nothing here \u2014 good." }))] }, key));
            }), _jsx("p", { className: "text-xs text-slate-600", children: "Estimates are computed locally from imported occupancy, source, payment, expense and payroll data \u2014 they are not financial advice and may not reflect every billing nuance." })] }));
}
