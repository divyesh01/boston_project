import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React, { useMemo, useState } from "react";
import { DollarSign, Percent, Gauge, TrendingUp, TrendingDown, X, } from "lucide-react";
import KpiCard from "@/components/ui-exec/KpiCard";
import Card from "@/components/ui-exec/Card";
import { useOccupancy, useSources } from "@/lib/useHotelData";
import { useGlobalFilters, MONTHS_LONG } from "@/lib/useGlobalFilters";
import { Link } from "react-router-dom";
import { money, money2, pct, num, inRange, C, occupancyStats, commissionFor } from "@/lib/hotel";
import { getRevenueThresholds, getRevenueColor, getRevenueGroup, getRevenueGroupLabel } from "@/lib/revenueThresholds";
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export default function MonthlyCalendar() {
    const { dateRange, property, properties, month, year, months } = useGlobalFilters();
    const { data: occ = [] } = useOccupancy(dateRange, property, months);
    const { data: sources = [] } = useSources(dateRange, property, months);
    const [selectedDay, setSelectedDay] = useState(null);
    // Read the configured thresholds so the legend cannot drift from the colours.
    const revThresholds = getRevenueThresholds();
    const occRows = useMemo(() => occ.filter((r) => inRange(r.date, dateRange.from, dateRange.to)), [occ, dateRange]);
    const byDate = useMemo(() => {
        const map = new Map();
        occRows.forEach((r) => {
            const d = String(r.date).slice(0, 10);
            map.set(d, r);
        });
        return map;
    }, [occRows]);
    const srcByDate = useMemo(() => {
        const map = new Map();
        sources.forEach((r) => {
            const d = String(r.date).slice(0, 10);
            if (!map.has(d))
                map.set(d, []);
            map.get(d).push(r);
        });
        return map;
    }, [sources]);
    // Build calendar grid
    const calYear = year || new Date().getFullYear();
    const calMonth = month !== null ? month : new Date().getMonth();
    const firstDay = new Date(calYear, calMonth, 1);
    const lastDayNum = new Date(calYear, calMonth + 1, 0).getDate();
    const startDow = firstDay.getDay();
    const cells = [];
    for (let i = 0; i < startDow; i++)
        cells.push(null);
    for (let d = 1; d <= lastDayNum; d++) {
        const dateStr = `${calYear}-${String(calMonth + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        cells.push({ date: dateStr, day: d, data: byDate.get(dateStr) });
    }
    // KPIs describe exactly the days drawn in the grid.
    //
    // They used to be computed over the whole global `dateRange` while the grid
    // was built from `year`/`month`, so under a YTD, quarterly or custom range the
    // header and the grid below it described different spans — the header could
    // report eight months of revenue above a single month of squares.
    const gridRows = useMemo(() => {
        const monthPrefix = `${calYear}-${String(calMonth + 1).padStart(2, "0")}`;
        return occRows.filter((r) => String(r.date).slice(0, 7) === monthPrefix);
    }, [occRows, calYear, calMonth]);
    const kpis = useMemo(() => {
        const s = occupancyStats(gridRows, properties);
        return {
            revenue: s.revenue,
            occupancy: s.occupancy,
            adr: s.adr,
            revpar: s.revpar,
            highest: gridRows.length ? Math.max(...gridRows.map((r) => r.total_revenue || 0)) : 0,
            lowest: gridRows.length ? Math.min(...gridRows.map((r) => r.total_revenue || 0)) : 0,
            days: s.days,
        };
    }, [gridRows, properties]);
    const groups = useMemo(() => {
        const g = { high: [], medium: [], low: [], nodata: [] };
        cells.forEach((c) => {
            if (!c)
                return;
            if (!c.data) {
                g.nodata.push(c);
                return;
            }
            const group = getRevenueGroup(c.data.total_revenue || 0);
            g[group].push(c);
        });
        return g;
    }, [cells]);
    const groupStats = (groupCells) => {
        if (!groupCells.length)
            return { days: 0, revenue: 0, pct: 0, occupancy: 0, adr: 0, revpar: 0 };
        const rows = groupCells.map((c) => c.data).filter(Boolean);
        const s = occupancyStats(rows, properties);
        return {
            days: groupCells.length,
            revenue: s.revenue,
            pct: kpis.revenue > 0 ? s.revenue / kpis.revenue : 0,
            occupancy: s.occupancy,
            adr: s.adr,
            revpar: s.revpar,
        };
    };
    const selectedData = selectedDay ? byDate.get(selectedDay) : null;
    const selectedSources = selectedDay ? (srcByDate.get(selectedDay) || []) : [];
    const prevDayData = selectedDay ? byDate.get(new Date(new Date(selectedDay).getTime() - 86400000).toISOString().slice(0, 10)) : null;
    const channelRanking = useMemo(() => {
        if (!selectedSources.length)
            return [];
        const ranked = selectedSources
            .map((s) => {
            // Actually subtract commission — the panel is titled "Ranked by Net
            // Revenue" but used to set commission: 0 and net = gross, so an OTA
            // booking outranked a direct booking of the same value.
            const gross = s.net_revenue || 0;
            const info = commissionFor(s.source || s.code);
            let commission = 0;
            if (info.type === "percentage")
                commission = gross * info.rate;
            else if (info.type === "fixed")
                commission = info.rate * (s.stays || 0);
            else if (info.type === "actual")
                commission = info.rate;
            return {
                name: s.source || s.code || "Unknown",
                gross,
                commission,
                net: gross - commission,
                stays: s.stays || 0,
            };
        })
            .sort((a, b) => b.net - a.net);
        const total = ranked.reduce((a, r) => a + r.net, 0);
        return ranked.map((r, i) => ({ ...r, rank: i + 1, pct: total > 0 ? r.net / total : 0 }));
    }, [selectedSources]);
    return (_jsxs("div", { className: "space-y-6", children: [_jsxs("header", { children: [_jsx("p", { className: "text-[11px] uppercase tracking-[0.3em] text-[#00D4FF]", children: "Owner Intelligence" }), _jsx("h1", { className: "mt-2 font-heading text-3xl font-semibold text-white", children: "Monthly Calendar View" }), _jsxs("p", { className: "mt-1 text-sm text-slate-400", children: ["Visualize daily performance patterns, channel dominance, and yield rhythms for ", MONTHS_LONG[calMonth], " ", calYear, "."] })] }), _jsxs("div", { className: "grid gap-4 sm:grid-cols-2 xl:grid-cols-3", children: [_jsx(KpiCard, { label: "Total Monthly Revenue", value: money(kpis.revenue), sub: `${kpis.days} days with data`, accent: C.purple, icon: DollarSign }), _jsx(KpiCard, { label: "Average Occupancy", value: pct(kpis.occupancy), accent: C.cyan, icon: Percent }), _jsx(KpiCard, { label: "Average ADR", value: money2(kpis.adr), accent: C.amber, icon: Gauge }), _jsx(KpiCard, { label: "Average RevPAR", value: money2(kpis.revpar), accent: C.green, icon: Gauge }), _jsx(KpiCard, { label: "Highest Day", value: money(kpis.highest), sub: "Peak revenue day", accent: "#4ade80", icon: TrendingUp }), _jsx(KpiCard, { label: "Lowest Day", value: money(kpis.lowest), sub: "Minimum revenue day", accent: "#ff6b6b", icon: TrendingDown })] }), _jsx(Card, { title: `${MONTHS_LONG[calMonth]} ${calYear} Calendar`, subtitle: `Green ≥ ${money(revThresholds.highRevenueThreshold)} · Gray ${money(revThresholds.mediumRevenueThreshold)}–${money(revThresholds.highRevenueThreshold)} · Red < ${money(revThresholds.mediumRevenueThreshold)} (editable in Settings)`, children: _jsxs("div", { className: "grid grid-cols-7 gap-1.5 sm:gap-2", children: [DOW.map((d) => (_jsx("div", { className: "pb-2 text-center text-xs font-medium text-slate-500", children: d }, d))), cells.map((cell, i) => {
                            if (!cell)
                                return _jsx("div", { className: "min-h-[90px] sm:min-h-[120px]" }, i);
                            const revenue = cell.data?.total_revenue || 0;
                            const color = cell.data ? getRevenueColor(revenue) : "transparent";
                            const occPct = cell.data?.occupancy ? (cell.data.occupancy > 1 ? cell.data.occupancy : cell.data.occupancy * 100) : 0;
                            return (_jsxs("button", { onClick: () => setSelectedDay(cell.date), className: `min-h-[90px] rounded-lg border p-2 text-left transition-all sm:min-h-[120px] ${selectedDay === cell.date ? "border-[#00D4FF] ring-1 ring-[#00D4FF]" : "border-white/5"} ${!cell.data ? "bg-[#0A1628]/40" : ""}`, style: cell.data ? { backgroundColor: `${color}15`, borderLeft: `3px solid ${color}` } : {}, children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsx("span", { className: "text-xs font-semibold text-white", children: cell.day }), cell.data && _jsxs("span", { className: "text-[10px] text-slate-400", children: [occPct.toFixed(0), "%"] })] }), cell.data ? (_jsxs("div", { className: "mt-1 space-y-0.5 text-[10px] text-slate-300", children: [_jsx("div", { className: "font-heading font-semibold text-sm tabular-nums text-white", children: money(revenue) }), _jsxs("div", { children: ["ADR ", money2(cell.data.adr || 0)] }), _jsxs("div", { children: ["RevPAR ", money2(cell.data.revpar || 0)] })] })) : (_jsx("div", { className: "mt-2 text-[10px] text-slate-600", children: "No Data" }))] }, i));
                        })] }) }), _jsx("div", { className: "grid gap-4 lg:grid-cols-3", children: ["high", "medium", "low"].map((g) => {
                    const stats = groupStats(groups[g]);
                    const color = g === "high" ? "#4ade80" : g === "medium" ? "#94a3b8" : "#ff6b6b";
                    return (_jsx(Card, { title: getRevenueGroupLabel(g), subtitle: `${stats.days} days · ${pct(stats.pct)} of revenue`, children: _jsxs("div", { className: "space-y-2", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx("div", { className: "h-3 w-3 rounded-full", style: { backgroundColor: color } }), _jsx("span", { className: "text-2xl font-heading font-semibold text-white", children: money(stats.revenue) })] }), _jsxs("div", { className: "grid grid-cols-3 gap-2 text-xs", children: [_jsxs("div", { children: [_jsx("p", { className: "text-slate-500", children: "Occ" }), _jsx("p", { className: "text-slate-200", children: pct(stats.occupancy) })] }), _jsxs("div", { children: [_jsx("p", { className: "text-slate-500", children: "ADR" }), _jsx("p", { className: "text-slate-200", children: money2(stats.adr) })] }), _jsxs("div", { children: [_jsx("p", { className: "text-slate-500", children: "RevPAR" }), _jsx("p", { className: "text-slate-200", children: money2(stats.revpar) })] })] })] }) }, g));
                }) }), groups.nodata.length > 0 && (_jsx("div", { className: "rounded-xl border border-[#FFB547]/20 bg-[#FFB547]/[0.06] p-4", children: _jsxs("p", { className: "text-sm text-[#FFB547]", children: ["\u26A0 ", groups.nodata.length, " days have no imported data for ", MONTHS_LONG[calMonth], " ", calYear, ". Import reports to see full performance."] }) })), selectedDay && (_jsxs("div", { className: "fixed inset-0 z-50 flex items-end justify-end sm:items-center sm:justify-center", onClick: () => setSelectedDay(null), children: [_jsx("div", { className: "absolute inset-0 bg-black/60" }), _jsxs("div", { className: "relative w-full max-w-lg rounded-t-3xl border border-white/10 bg-[#0F1F35] p-6 sm:rounded-2xl", onClick: (e) => e.stopPropagation(), style: { maxHeight: "85vh", overflowY: "auto" }, children: [_jsxs("div", { className: "mb-4 flex items-center justify-between", children: [_jsx("h3", { className: "font-heading text-xl font-semibold text-white", children: new Date(selectedDay).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }) }), _jsx("button", { onClick: () => setSelectedDay(null), className: "text-slate-400 hover:text-white", children: _jsx(X, { className: "h-5 w-5" }) })] }), selectedData ? (_jsxs("div", { className: "space-y-4", children: [_jsxs("div", { className: "grid grid-cols-2 gap-3", children: [_jsx(Metric, { label: "Total Room Revenue", current: selectedData.total_revenue || 0, previous: prevDayData?.total_revenue || 0, fmt: money }), _jsx(Metric, { label: "Occupancy", current: selectedData.occupancy > 1 ? selectedData.occupancy / 100 : selectedData.occupancy || 0, previous: prevDayData?.occupancy > 1 ? prevDayData.occupancy / 100 : prevDayData?.occupancy || 0, fmt: pct, suffix: " pts" }), _jsx(Metric, { label: "ADR", current: selectedData.adr || 0, previous: prevDayData?.adr || 0, fmt: money2 }), _jsx(Metric, { label: "RevPAR", current: selectedData.revpar || 0, previous: prevDayData?.revpar || 0, fmt: money2 })] }), _jsxs("div", { className: "rounded-xl border border-white/5 bg-[#0A1628] p-4", children: [_jsx("p", { className: "text-xs text-slate-500", children: "Rooms Sold" }), _jsxs("p", { className: "text-lg text-white", children: [num(selectedData.rooms_sold || 0), " / ", num(selectedData.total_rooms || 0)] })] }), channelRanking.length > 0 && (_jsxs("div", { children: [_jsx("p", { className: "mb-2 text-xs uppercase tracking-widest text-slate-500", children: "Channel Ecosystem \u00B7 Ranked by Net Revenue" }), _jsx("div", { className: "space-y-1.5", children: channelRanking.slice(0, 10).map((ch) => (_jsxs("div", { className: "flex items-center justify-between rounded-lg bg-[#0A1628] px-3 py-2 text-sm", children: [_jsxs("span", { className: "flex items-center gap-2 text-slate-200", children: [_jsxs("span", { className: "w-5 text-xs text-slate-500", children: ["#", ch.rank] }), ch.name] }), _jsxs("span", { className: "tabular-nums text-slate-300", children: [money(ch.gross), " \u00B7 ", pct(ch.pct)] })] }, ch.rank))) })] }))] })) : (_jsxs("div", { className: "py-8 text-center", children: [_jsx("p", { className: "text-slate-500", children: "No data imported for this day." }), _jsx(Link, { to: "/upload", className: "mt-2 inline-block text-sm text-[#00D4FF] underline", children: "Import reports \u2192" })] }))] })] }))] }));
}
function Metric({ label, current, previous, fmt, suffix = "" }) {
    const diff = current - previous;
    const pctCh = previous > 0 ? (diff / previous) * 100 : 0;
    return (_jsxs("div", { className: "rounded-xl border border-white/5 bg-[#0A1628] p-3", children: [_jsx("p", { className: "text-[10px] uppercase tracking-widest text-slate-500", children: label }), _jsx("p", { className: "mt-1 text-lg font-heading font-semibold text-white", children: fmt(current) }), _jsxs("p", { className: "text-xs text-slate-500", children: ["Previous: ", fmt(previous)] }), _jsx("p", { className: `text-xs ${diff >= 0 ? "text-[#00E096]" : "text-[#FF6B6B]"}`, children: previous === 0 ? "N/A" : `${diff >= 0 ? "+" : ""}${fmt(diff)}${suffix} (${pctCh >= 0 ? "+" : ""}${pctCh.toFixed(1)}%)` })] }));
}
