import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React, { useMemo, useState } from "react";
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell, } from "recharts";
import { BedDouble, DollarSign, Gauge, TrendingUp, Users2, Wallet, Info, Download } from "lucide-react";
import Card from "@/components/ui-exec/Card";
import KpiCard from "@/components/ui-exec/KpiCard";
import { useGlobalFilters } from "@/lib/useGlobalFilters";
import { useHotelMetrics, useMetricDates } from "@/lib/useHotelData";
import { money, money2, num, C, CHART_COLORS, downloadCsv, downloadExcel } from "@/lib/hotel";
import { snapshotDates, snapshotFor, headline, headlineTrends, composition, quality, indexSnapshot, metricValue, firstValue, PERIODS, PERIOD_LABEL, HEADLINE, } from "@/lib/statisticsAnalytics";
import MetricExplorer from "@/components/statistics/MetricExplorer";
const tip = { background: "#0A1628", border: "1px solid #ffffff14", borderRadius: 12, color: "#e2e8f0" };
const axis = { fill: "#64748b", fontSize: 10 };
const ICONS = {
    occupancy: Gauge, adr: DollarSign, revpar: TrendingUp,
    sold: BedDouble, revenue: Wallet, guests: Users2,
};
const ACCENTS = {
    occupancy: C.cyan, adr: C.purple, revpar: C.green,
    sold: C.amber, revenue: C.purple, guests: C.cyan,
};
function formatByUnit(value, unit) {
    if (value === null || value === undefined)
        return "—";
    if (unit === "currency")
        return money2(value);
    if (unit === "percentage")
        return `${Number(value).toFixed(1)}%`;
    return num(value);
}
// "A, B and C" — and past four names, a count, because the banner this feeds is
// one line and a PMS with real history loaded would list a hundred metrics.
function listNames(names = []) {
    if (names.length === 0)
        return "";
    if (names.length === 1)
        return names[0];
    if (names.length > 4)
        return `${names.slice(0, 3).join(", ")} and ${names.length - 3} others`;
    return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
function Segmented({ value, onChange, options }) {
    return (_jsx("div", { className: "flex flex-wrap gap-1 rounded-lg bg-[#0A1628] p-1", children: options.map(([key, label, hint]) => (_jsx("button", { onClick: () => onChange(key), title: hint, className: `rounded-md px-2.5 py-1 text-xs transition-colors ${value === key ? "bg-[#6C63FF] text-white" : "text-slate-400 hover:text-slate-200"}`, children: label }, key))) }));
}
export default function Statistics() {
    const { dateRange, property } = useGlobalFilters();
    const [period, setPeriod] = useState("actual_today");
    const [trendKey, setTrendKey] = useState("occupancy");
    const { data: rows = [], isLoading } = useHotelMetrics(dateRange, property);
    const { data: allDates = [] } = useMetricDates(property);
    const dates = useMemo(() => snapshotDates(rows), [rows]);
    const [pickedDate, setPickedDate] = useState("");
    const snapshot = useMemo(() => snapshotFor(rows, pickedDate), [rows, pickedDate]);
    const cards = useMemo(() => headline(snapshot.rows, period), [snapshot.rows, period]);
    const index = useMemo(() => indexSnapshot(snapshot.rows), [snapshot.rows]);
    const trends = useMemo(() => headlineTrends(rows), [rows]);
    const revenueMix = useMemo(() => composition(snapshot.rows, "Revenue", period).slice(0, 10), [snapshot.rows, period]);
    const paymentMix = useMemo(() => composition(snapshot.rows, "Payments", period), [snapshot.rows, period]);
    const q = useMemo(() => quality(rows), [rows]);
    if (isLoading)
        return _jsx("p", { className: "text-slate-500", children: "Loading hotel statistics\u2026" });
    // Two different empty states. "Nothing imported ever" and "nothing in this date
    // range" need different fixes, and conflating them sends the operator to the
    // Import page to re-upload a file they already have.
    if (!rows.length) {
        const everImported = allDates.length > 0;
        return (_jsxs("div", { className: "space-y-6", children: [_jsxs("header", { children: [_jsx("p", { className: "text-[11px] uppercase tracking-[0.3em] text-[#00D4FF]", children: "Property Performance" }), _jsx("h1", { className: "mt-2 font-heading text-3xl font-semibold text-white", children: "Statistics" })] }), _jsx(Card, { title: everImported ? "No snapshot in this date range" : "No statistics imported yet", children: everImported ? (_jsxs("p", { className: "text-sm text-slate-400", children: ["This property has ", num(allDates.length), " snapshot", allDates.length === 1 ? "" : "s", ", the most recent dated ", allDates[0], ". Move the date range to cover it."] })) : (_jsx("p", { className: "text-sm text-slate-400", children: "Upload a \u201CHotel Statistics\u201D export from Import Reports. Each file is one day\u2019s snapshot covering occupancy, ADR, RevPAR, revenue, taxes, payments, guests and reservations." })) })] }));
    }
    const roomsAvailable = firstValue(index, ["Rooms Available To Sell"], period);
    const totalRooms = firstValue(index, ["Total Rooms"], "actual_today");
    const outOfOrder = metricValue(index, "Out Of Order", period);
    const arrivals = metricValue(index, "Arrivals", period);
    const departures = metricValue(index, "Departures", period);
    const walkIns = metricValue(index, "Walk Ins", period);
    const noShows = metricValue(index, "No Shows", period);
    return (_jsxs("div", { className: "space-y-6", children: [_jsxs("header", { className: "flex flex-wrap items-end justify-between gap-4", children: [_jsxs("div", { children: [_jsx("p", { className: "text-[11px] uppercase tracking-[0.3em] text-[#00D4FF]", children: "Property Performance" }), _jsx("h1", { className: "mt-2 font-heading text-3xl font-semibold text-white", children: "Statistics" }), _jsxs("p", { className: "mt-1 text-sm text-slate-400", children: ["Snapshot for ", snapshot.date || "—", " \u00B7 ", num(snapshot.rows.length), " metrics", dates.length > 1 ? ` · ${num(dates.length)} snapshots in range` : ""] })] }), _jsxs("div", { className: "flex flex-wrap items-center gap-2", children: [dates.length > 1 && (_jsx("select", { value: snapshot.date, onChange: (e) => setPickedDate(e.target.value), className: "h-9 rounded-lg border border-white/10 bg-[#0A1628] px-3 text-sm text-slate-200 outline-none focus:border-[#6C63FF]", children: [...dates].reverse().map((d) => (_jsx("option", { value: d, children: d }, d))) })), _jsx(Segmented, { value: period, onChange: setPeriod, options: PERIODS })] })] }), _jsxs("p", { className: "flex items-center gap-2 text-xs text-slate-500", children: [_jsx(Info, { className: "h-3.5 w-3.5 shrink-0" }), "Showing ", _jsx("span", { className: "text-slate-300", children: PERIOD_LABEL[period] }), period === "actual_today"
                        ? ` — activity on ${snapshot.date} alone.`
                        : period === "mtd"
                            ? ` — 1 ${new Date(`${snapshot.date}T00:00:00`).toLocaleString("en-US", { month: "long" })} through ${snapshot.date}.`
                            : ` — 1 January through ${snapshot.date}.`] }), _jsx("div", { className: "grid gap-4 sm:grid-cols-2 lg:grid-cols-3", children: cards.map((m) => (_jsx(KpiCard, { label: m.label, value: formatByUnit(m.value, m.unit), accent: ACCENTS[m.key], icon: ICONS[m.key], sub: m.change
                        ? `${m.change.pct >= 0 ? "+" : "−"}${Math.abs(m.change.pct).toFixed(1)}% vs last year`
                        : m.hint }, m.key))) }), q.priorYearMetrics.length === 0 ? (_jsx("p", { className: "rounded-xl border border-[#FFB547]/20 bg-[#FFB547]/5 px-4 py-2.5 text-xs text-[#FFB547]", children: "Last-year columns are all zero in this export, so no year-over-year comparison is shown. That is missing history in the PMS, not a year with no business." })) : (_jsxs("p", { className: "rounded-xl border border-[#FFB547]/20 bg-[#FFB547]/5 px-4 py-2.5 text-xs text-[#FFB547]", children: ["Last-year figures are only loaded for ", listNames(q.priorYearMetrics), ". Every other metric reads zero for last year, so year-over-year is shown on those ", q.priorYearMetrics.length, " and left off elsewhere \u2014 that is missing history in the PMS, not a year with no business."] })), _jsxs("div", { className: "grid gap-4 lg:grid-cols-2", children: [_jsxs(Card, { title: "Rooms tonight", subtitle: "How the 100-room inventory resolved", children: [_jsx("div", { className: "grid grid-cols-2 gap-4 sm:grid-cols-4", children: [
                                    ["Total rooms", totalRooms, "count"],
                                    ["Available to sell", roomsAvailable, "count"],
                                    ["Out of order", outOfOrder, "count"],
                                    ["Sold", metricValue(index, "Room Sold", period), "count"],
                                ].map(([label, value, unit]) => (_jsxs("div", { children: [_jsx("p", { className: "text-[11px] uppercase tracking-[0.14em] text-slate-500", children: label }), _jsx("p", { className: "mt-1 font-heading text-2xl font-semibold tabular-nums text-white", children: formatByUnit(value, unit) })] }, label))) }), _jsx("div", { className: "mt-5 grid grid-cols-2 gap-4 sm:grid-cols-4", children: [
                                    ["Arrivals", arrivals],
                                    ["Departures", departures],
                                    ["Walk-ins", walkIns],
                                    ["No-shows", noShows],
                                ].map(([label, value]) => (_jsxs("div", { children: [_jsx("p", { className: "text-[11px] uppercase tracking-[0.14em] text-slate-500", children: label }), _jsx("p", { className: "mt-1 text-lg font-medium tabular-nums text-slate-200", children: formatByUnit(value, "count") })] }, label))) })] }), _jsx(Card, { title: "Where the money came from", subtitle: `Settlements by method · ${PERIOD_LABEL[period]}`, children: paymentMix.length === 0 ? (_jsx("p", { className: "text-sm text-slate-500", children: "No settlements recorded for this window." })) : (_jsx("div", { className: "h-64", children: _jsx(ResponsiveContainer, { width: "100%", height: "100%", children: _jsxs(BarChart, { data: paymentMix, layout: "vertical", margin: { left: 34, right: 12 }, children: [_jsx(CartesianGrid, { stroke: "#ffffff0a", horizontal: false }), _jsx(XAxis, { type: "number", tick: axis, stroke: "#ffffff10", tickFormatter: (v) => money(v) }), _jsx(YAxis, { type: "category", dataKey: "name", tick: axis, stroke: "#ffffff10", width: 96 }), _jsx(Tooltip, { contentStyle: tip, formatter: (v) => money2(v), cursor: { fill: "#ffffff06" } }), _jsx(Bar, { dataKey: "value", radius: [0, 4, 4, 0], children: paymentMix.map((e, i) => (_jsx(Cell, { fill: e.value < 0 ? C.coral : CHART_COLORS[i % CHART_COLORS.length] }, e.name))) })] }) }) })) })] }), _jsx(Card, { title: "Revenue lines", subtitle: `Non-zero revenue codes · ${PERIOD_LABEL[period]} · ${num(revenueMix.length)} of the section shown`, children: revenueMix.length === 0 ? (_jsx("p", { className: "text-sm text-slate-500", children: "No revenue posted in this window." })) : (_jsx("div", { className: "space-y-2.5", children: revenueMix.map((r, i) => {
                        const top = Math.abs(revenueMix[0].value) || 1;
                        return (_jsxs("div", { className: "flex items-center gap-3", children: [_jsx("span", { className: "w-44 shrink-0 truncate text-xs text-slate-400", title: r.name, children: r.name }), _jsx("span", { className: "h-2 flex-1 overflow-hidden rounded-full bg-white/5", children: _jsx("span", { className: "block h-full rounded-full transition-all duration-500", style: {
                                            width: `${Math.max(2, (Math.abs(r.value) / top) * 100)}%`,
                                            background: CHART_COLORS[i % CHART_COLORS.length],
                                        } }) }), _jsx("span", { className: "w-24 shrink-0 text-right text-sm tabular-nums text-slate-200", children: money2(r.value) })] }, r.name));
                    }) })) }), _jsx(Card, { title: "Across snapshots", subtitle: "Built from the Today column only \u2014 MTD and YTD figures from consecutive days overlap", right: dates.length > 1 ? (_jsx(Segmented, { value: trendKey, onChange: setTrendKey, options: HEADLINE.map((m) => [m.key, m.label]) })) : null, children: dates.length < 2 ? (_jsxs("p", { className: "text-sm text-slate-400", children: ["One snapshot in this range (", snapshot.date, "). Import a statistics export for another day, or widen the date range, and the trend appears here."] })) : (_jsx("div", { className: "h-72", children: _jsx(ResponsiveContainer, { width: "100%", height: "100%", children: _jsxs(AreaChart, { data: trends[trendKey] || [], margin: { left: -12, right: 8, top: 8 }, children: [_jsx("defs", { children: _jsxs("linearGradient", { id: "stat-trend", x1: "0", y1: "0", x2: "0", y2: "1", children: [_jsx("stop", { offset: "0%", stopColor: C.cyan, stopOpacity: 0.45 }), _jsx("stop", { offset: "100%", stopColor: C.cyan, stopOpacity: 0 })] }) }), _jsx(CartesianGrid, { stroke: "#ffffff0a", vertical: false }), _jsx(XAxis, { dataKey: "date", tick: axis, stroke: "#ffffff10" }), _jsx(YAxis, { tick: axis, stroke: "#ffffff10" }), _jsx(Tooltip, { contentStyle: tip, formatter: (v) => formatByUnit(v, HEADLINE.find((m) => m.key === trendKey)?.unit) }), _jsx(Area, { type: "monotone", dataKey: "value", name: HEADLINE.find((m) => m.key === trendKey)?.label || "Value", stroke: C.cyan, strokeWidth: 2, fill: "url(#stat-trend)" })] }) }) })) }), _jsx(MetricExplorer, { rows: snapshot.rows }), _jsxs(Card, { title: "About this data", subtitle: "What was imported and how much of it the app recognised", right: _jsxs("div", { className: "flex gap-2", children: [_jsxs("button", { onClick: () => downloadCsv(snapshot.rows.map((r) => ({
                                business_date: r.business_date,
                                section: r.section,
                                metric: r.metric_name,
                                category: r.metric_category,
                                period: r.period,
                                value: r.value,
                                unit: r.unit,
                                original: r.original_value,
                            })), `statistics-${snapshot.date || "snapshot"}.csv`), className: "flex items-center gap-2 rounded-lg bg-[#6C63FF]/20 px-3 py-1.5 text-xs font-medium text-[#6C63FF] transition-colors hover:bg-[#6C63FF]/35", children: [_jsx(Download, { className: "h-3.5 w-3.5" }), " Export CSV"] }), _jsxs("button", { onClick: () => downloadExcel(snapshot.rows.map((r) => ({
                                business_date: r.business_date,
                                section: r.section,
                                metric: r.metric_name,
                                category: r.metric_category,
                                period: r.period,
                                value: r.value,
                                unit: r.unit,
                                original: r.original_value,
                            })), `statistics-${snapshot.date || "snapshot"}.xlsx`), className: "flex items-center gap-2 rounded-lg bg-[#107C41]/20 px-3 py-1.5 text-xs font-medium text-[#107C41] transition-colors hover:bg-[#107C41]/35", children: [_jsx(Download, { className: "h-3.5 w-3.5" }), " Export Excel"] })] }), children: [_jsx("dl", { className: "grid gap-4 sm:grid-cols-2 lg:grid-cols-4", children: [
                            ["Snapshots in range", num(q.snapshots)],
                            ["Metrics stored", num(q.metrics)],
                            ["Unrecognised metrics", q.unknownCount ? num(q.unknownCount) : "none"],
                            ["Date range", q.firstDate === q.lastDate ? q.firstDate : `${q.firstDate} → ${q.lastDate}`],
                        ].map(([label, value]) => (_jsxs("div", { children: [_jsx("dt", { className: "text-[11px] uppercase tracking-[0.14em] text-slate-500", children: label }), _jsx("dd", { className: "mt-1 text-sm text-slate-200", children: value })] }, label))) }), q.unknownNames.length > 0 && (_jsxs("p", { className: "mt-4 text-xs text-slate-400", children: ["Imported but not categorised, and shown as-is in the table above:", " ", _jsx("span", { className: "text-[#FFB547]", children: q.unknownNames.join(", ") })] })), q.inferredDates.length > 0 && (_jsxs("p", { className: "mt-3 text-xs text-[#FFB547]", children: ["Hotel Statistics exports carry no date column, so the date on", " ", q.inferredDates.length === 1 ? "this snapshot was" : "these snapshots were", " inferred at import:", " ", q.inferredDates.join(", "), ". Correct it on the Import page if it is wrong."] }))] })] }));
}
