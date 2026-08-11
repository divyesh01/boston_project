import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
import React, { useMemo } from "react";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";
import Card from "@/components/ui-exec/Card";
import KpiCard from "@/components/ui-exec/KpiCard";
import { AreaChart, Area, BarChart, Bar, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, } from "recharts";
import { useOccupancy } from "@/lib/useHotelData";
import { useGlobalFilters } from "@/lib/useGlobalFilters";
import { money, money2, num, pct, sum, inRange, C, occupancyStats } from "@/lib/hotel";
const METRICS = [
    { key: "total_revenue", label: "Total Revenue", fmt: money },
    { key: "room_revenue", label: "Room Revenue", fmt: money },
    { key: "rooms_sold", label: "Rooms Sold", fmt: num },
    { key: "adr", label: "ADR", fmt: money2 },
    { key: "revpar", label: "RevPAR", fmt: money2 },
    { key: "occupancy", label: "Occupancy", fmt: (v) => pct(v) },
];
export default function MtdGrowth() {
    const { dateRange, compareDateRange, compareOn, property, properties, period, months, compareMonths } = useGlobalFilters();
    const { data: occ = [] } = useOccupancy(dateRange, property, months);
    const { data: prevOcc = [] } = useOccupancy(compareOn ? compareDateRange : { from: "", to: "" }, property, compareOn ? compareMonths : [], compareOn);
    const curRows = useMemo(() => occ.filter((r) => inRange(r.date, dateRange.from, dateRange.to)), [occ, dateRange]);
    const prevRows = useMemo(() => prevOcc.filter((r) => inRange(r.date, compareDateRange.from, compareDateRange.to)), [prevOcc, compareDateRange]);
    // For incomplete month comparison, only compare equivalent elapsed days
    const curElapsed = useMemo(() => {
        if (!dateRange.from)
            return curRows;
        const from = new Date(dateRange.from);
        const to = new Date(dateRange.to);
        const elapsedDays = Math.round((to.getTime() - from.getTime()) / 86400000) + 1;
        return curRows;
    }, [curRows, dateRange]);
    const prevElapsed = useMemo(() => {
        if (!compareOn || !compareDateRange.from)
            return prevRows;
        // Match same number of days from previous period start
        const from = new Date(dateRange.from);
        const to = new Date(dateRange.to);
        const elapsedDays = Math.round((to.getTime() - from.getTime()) / 86400000) + 1;
        const prevFrom = new Date(compareDateRange.from);
        const prevToDate = new Date(prevFrom);
        prevToDate.setDate(prevFrom.getDate() + elapsedDays - 1);
        const prevToIso = prevToDate.toISOString().slice(0, 10);
        return prevRows.filter((r) => inRange(r.date, compareDateRange.from, prevToIso));
    }, [prevRows, compareOn, dateRange, compareDateRange]);
    // Shared engine: capacity is summed per property (portfolio-safe), and ADR /
    // RevPAR are properly weighted.
    //
    // Both were wrong here before. Capacity used
    // `properties.find(p => p.id === property)?.rooms || 100`, which returns
    // undefined -> 100 whenever `property` is "all" or an array. And ADR / RevPAR
    // were `sum(rows, key) / rows.length` — the unweighted mean of daily rates,
    // which is not ADR: a 10-room day at $200 and a 90-room day at $100 averaged
    // to $150 instead of the true $110.
    const calc = (rows, key) => {
        if (key === "occupancy" || key === "adr" || key === "revpar") {
            return occupancyStats(rows, properties)[key];
        }
        return sum(rows, key);
    };
    const comparisons = METRICS.map((m) => {
        const cur = calc(curElapsed, m.key);
        const prev = calc(prevElapsed, m.key);
        const diff = cur - prev;
        const pctCh = prev > 0 ? (diff / prev) * 100 : 0;
        return { ...m, cur, prev, diff, pctCh };
    });
    const chartData = useMemo(() => {
        const map = new Map();
        curElapsed.forEach((r) => {
            const d = String(r.date).slice(5);
            if (!map.has(d))
                map.set(d, { date: d, current: 0, previous: 0 });
            map.get(d).current += Number(r.total_revenue || 0);
        });
        prevElapsed.forEach((r) => {
            const d = String(r.date).slice(5);
            if (!map.has(d))
                map.set(d, { date: d, current: 0, previous: 0 });
            map.get(d).previous += Number(r.total_revenue || 0);
        });
        return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
    }, [curElapsed, prevElapsed]);
    const occChart = useMemo(() => {
        const map = new Map();
        curElapsed.forEach((r) => {
            const d = String(r.date).slice(5);
            if (!map.has(d))
                map.set(d, { date: d, current: 0, previous: 0 });
            map.get(d).current = (r.occupancy || 0) > 1 ? r.occupancy / 100 : (r.occupancy || 0);
        });
        prevElapsed.forEach((r) => {
            const d = String(r.date).slice(5);
            if (!map.has(d))
                map.set(d, { date: d, current: 0, previous: 0 });
            map.get(d).previous = (r.occupancy || 0) > 1 ? r.occupancy / 100 : (r.occupancy || 0);
        });
        return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
    }, [curElapsed, prevElapsed]);
    return (_jsxs("div", { className: "space-y-6", children: [_jsxs("header", { children: [_jsx("p", { className: "text-[11px] uppercase tracking-[0.3em] text-[#00D4FF]", children: "Period Analysis" }), _jsx("h1", { className: "mt-2 font-heading text-3xl font-semibold text-white", children: "MTD Growth" }), _jsxs("p", { className: "mt-1 text-sm text-slate-400", children: ["Current: ", dateRange.from || "—", " \u2192 ", dateRange.to || "—", " \u00B7 ", curElapsed.length, " days", compareOn && _jsxs(_Fragment, { children: [" \u00B7 vs Previous: ", compareDateRange.from || "—", " \u2192 ", compareDateRange.to || "—", " \u00B7 ", prevElapsed.length, " days"] })] })] }), _jsx("div", { className: "grid gap-4 sm:grid-cols-2 xl:grid-cols-3", children: comparisons.map((m) => {
                    const up = m.diff > 0;
                    const flat = m.diff === 0 || m.prev === 0;
                    const Icon = flat ? Minus : up ? TrendingUp : TrendingDown;
                    return (_jsx(KpiCard, { label: m.label, value: m.fmt(m.cur), sub: m.prev === 0
                            ? "Previous: N/A"
                            : `vs ${m.fmt(m.prev)} · ${up ? "+" : ""}${m.fmt(m.diff)} (${m.pctCh >= 0 ? "+" : ""}${m.pctCh.toFixed(1)}%)`, accent: flat ? C.amber : up ? C.green : C.coral, icon: Icon }, m.key));
                }) }), compareOn && (_jsxs("div", { className: "rounded-2xl border border-[#00D4FF]/20 bg-[#00D4FF]/[0.04] p-4", children: [_jsxs("p", { className: "text-xs uppercase tracking-widest text-[#00D4FF]", children: ["Comparison \u00B7 ", compareDateRange.from || "—", " \u2192 ", compareDateRange.to || "—", " (", prevElapsed.length, " elapsed days)"] }), _jsx("div", { className: "mt-3 overflow-x-auto", children: _jsxs("table", { className: "w-full text-sm", children: [_jsx("thead", { children: _jsxs("tr", { className: "border-b border-white/10 text-xs text-slate-500", children: [_jsx("th", { className: "py-2 text-left font-medium", children: "Metric" }), _jsx("th", { className: "py-2 text-right font-medium", children: "Current" }), _jsx("th", { className: "py-2 text-right font-medium", children: "Previous" }), _jsx("th", { className: "py-2 text-right font-medium", children: "Difference" }), _jsx("th", { className: "py-2 text-right font-medium", children: "% Change" }), _jsx("th", { className: "py-2 text-center font-medium", children: "Trend" })] }) }), _jsx("tbody", { children: comparisons.map((m) => {
                                        const up = m.diff > 0;
                                        const flat = m.diff === 0 || m.prev === 0;
                                        return (_jsxs("tr", { className: "border-b border-white/5", children: [_jsx("td", { className: "py-3 text-slate-300", children: m.label }), _jsx("td", { className: "py-3 text-right tabular-nums text-white", children: m.fmt(m.cur) }), _jsx("td", { className: "py-3 text-right tabular-nums text-slate-400", children: m.prev === 0 ? "N/A" : m.fmt(m.prev) }), _jsx("td", { className: `py-3 text-right tabular-nums ${flat ? "text-slate-500" : up ? "text-[#00E096]" : "text-[#FF6B6B]"}`, children: m.prev === 0 ? "N/A" : `${up ? "+" : ""}${m.fmt(m.diff)}` }), _jsx("td", { className: `py-3 text-right tabular-nums ${flat ? "text-slate-500" : up ? "text-[#00E096]" : "text-[#FF6B6B]"}`, children: m.prev === 0 ? "N/A" : `${m.pctCh >= 0 ? "+" : ""}${m.pctCh.toFixed(1)}%` }), _jsx("td", { className: "py-3 text-center", children: flat ? _jsx(Minus, { className: "mx-auto h-4 w-4 text-slate-500" }) : up ? _jsx(TrendingUp, { className: "mx-auto h-4 w-4 text-[#00E096]" }) : _jsx(TrendingDown, { className: "mx-auto h-4 w-4 text-[#FF6B6B]" }) })] }, m.key));
                                    }) })] }) })] })), _jsx(Card, { title: "Revenue Comparison", subtitle: "Current period vs previous period by day", children: _jsx("div", { className: "h-72", children: _jsx(ResponsiveContainer, { width: "100%", height: "100%", children: _jsxs(BarChart, { data: chartData, margin: { left: -12, right: 8, top: 8 }, children: [_jsx(CartesianGrid, { stroke: "#ffffff0a", vertical: false }), _jsx(XAxis, { dataKey: "date", tick: { fill: "#64748b", fontSize: 10 }, stroke: "#ffffff10" }), _jsx(YAxis, { tick: { fill: "#64748b", fontSize: 10 }, stroke: "#ffffff10", tickFormatter: (v) => `${v / 1000}k` }), _jsx(Tooltip, { contentStyle: { background: "#0A1628", border: "1px solid #ffffff14", borderRadius: 12, color: "#e2e8f0" }, formatter: (v) => money(v) }), _jsx(Bar, { dataKey: "current", name: "Current", fill: C.purple, radius: [4, 4, 0, 0] }), _jsx(Bar, { dataKey: "previous", name: "Previous", fill: C.cyan, radius: [4, 4, 0, 0] })] }) }) }) }), _jsx(Card, { title: "Occupancy Trend", subtitle: "Daily occupancy comparison", children: _jsx("div", { className: "h-64", children: _jsx(ResponsiveContainer, { width: "100%", height: "100%", children: _jsxs(AreaChart, { data: occChart, margin: { left: -12, right: 8, top: 8 }, children: [_jsx("defs", { children: _jsxs("linearGradient", { id: "curOcc", x1: "0", y1: "0", x2: "0", y2: "1", children: [_jsx("stop", { offset: "0%", stopColor: C.purple, stopOpacity: 0.6 }), _jsx("stop", { offset: "100%", stopColor: C.purple, stopOpacity: 0 })] }) }), _jsx(CartesianGrid, { stroke: "#ffffff0a", vertical: false }), _jsx(XAxis, { dataKey: "date", tick: { fill: "#64748b", fontSize: 10 }, stroke: "#ffffff10" }), _jsx(YAxis, { tick: { fill: "#64748b", fontSize: 10 }, stroke: "#ffffff10", tickFormatter: (v) => `${(v * 100).toFixed(0)}%` }), _jsx(Tooltip, { contentStyle: { background: "#0A1628", border: "1px solid #ffffff14", borderRadius: 12, color: "#e2e8f0" }, formatter: (v) => pct(v) }), _jsx(Area, { type: "monotone", dataKey: "current", name: "Current", stroke: C.purple, fill: "url(#curOcc)", strokeWidth: 2 }), _jsx(Line, { type: "monotone", dataKey: "previous", name: "Previous", stroke: C.cyan, strokeWidth: 2, dot: false })] }) }) }) })] }));
}
