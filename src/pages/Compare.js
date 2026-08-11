import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React, { useMemo } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import CompareCard from "@/components/compare/CompareCard";
import CompareBars from "@/components/compare/CompareBars";
import ChannelRevenue from "@/components/compare/ChannelRevenue";
import { useOccupancy, useSources } from "@/lib/useHotelData";
import { useGlobalFilters } from "@/lib/useGlobalFilters";
import { money, money2, num, pct, inRange, occupancyStats } from "@/lib/hotel";
export default function Compare() {
    const { dateRange, compareDateRange, channel, property, properties, months, compareMonths } = useGlobalFilters();
    const { data: occ = [], isLoading } = useOccupancy(dateRange, property, months);
    const { data: prevOcc = [] } = useOccupancy(compareDateRange, property, compareMonths);
    const { data: sources = [] } = useSources(dateRange, property, months);
    // Shared engine — capacity is summed per property, so portfolio mode no longer
    // collapses to a flat 100 rooms and this page cannot disagree with Dashboard.
    const stats = (rows) => occupancyStats(rows, properties);
    const sa = stats(occ.filter((x) => inRange(x.date, dateRange.from, dateRange.to)));
    const sb = stats(prevOcc.filter((x) => inRange(x.date, compareDateRange.from, compareDateRange.to)));
    const srcRows = useMemo(() => {
        let r = sources.filter((x) => inRange(x.date, dateRange.from, dateRange.to));
        if (channel !== "all")
            r = r.filter((x) => x.source === channel || x.code === channel);
        return r;
    }, [sources, dateRange, channel]);
    if (isLoading)
        return _jsx("p", { className: "text-slate-500", children: "Loading comparison engine\u2026" });
    return (_jsxs("div", { className: "space-y-6", children: [_jsxs("header", { children: [_jsx("p", { className: "text-[11px] uppercase tracking-[0.3em] text-[#00D4FF]", children: "Module 3" }), _jsx("h1", { className: "mt-2 font-heading text-3xl font-semibold text-white", children: "Multi-Period Comparison" }), _jsxs("p", { className: "mt-1 text-sm text-slate-400", children: ["Period A: ", dateRange.from || "—", " \u2192 ", dateRange.to || "—", " \u00B7 Period B: ", compareDateRange.from || "—", " \u2192 ", compareDateRange.to || "—"] })] }), _jsxs(Tabs, { defaultValue: "period", children: [_jsxs(TabsList, { className: "bg-[#0A1628]", children: [_jsx(TabsTrigger, { value: "period", className: "data-[state=active]:bg-[#6C63FF]/15 data-[state=active]:text-white", children: "Period Comparison" }), _jsx(TabsTrigger, { value: "channel", className: "data-[state=active]:bg-[#6C63FF]/15 data-[state=active]:text-white", children: "Revenue by Channel" })] }), _jsxs(TabsContent, { value: "period", className: "mt-6 space-y-6", children: [_jsxs("div", { className: "grid gap-4 sm:grid-cols-2 xl:grid-cols-4", children: [_jsx(CompareCard, { label: "Revenue", a: sa.revenue, b: sb.revenue, format: money }), _jsx(CompareCard, { label: "Rooms Sold", a: sa.roomsSold, b: sb.roomsSold, format: num }), _jsx(CompareCard, { label: "ADR", a: sa.adr, b: sb.adr, format: money2 }), _jsx(CompareCard, { label: "Occupancy", a: sa.occupancy, b: sb.occupancy, format: (v) => pct(v) })] }), _jsx(CompareBars, { dateRange: `Period A: ${dateRange.from} to ${dateRange.to} | Period B: ${compareDateRange.from} to ${compareDateRange.to}`, data: [
                                    { metric: "Revenue ($k)", "Period A": Math.round(sa.revenue / 100) / 10, "Period B": Math.round(sb.revenue / 100) / 10 },
                                    { metric: "Rooms Sold", "Period A": sa.roomsSold, "Period B": sb.roomsSold },
                                    { metric: "ADR ($)", "Period A": Math.round(sa.adr), "Period B": Math.round(sb.adr) },
                                ] }), _jsxs("p", { className: "text-xs text-slate-500", children: ["Period A: ", sa.days, " days \u00B7 Period B: ", sb.days, " days"] })] }), _jsx(TabsContent, { value: "channel", className: "mt-6", children: _jsx(ChannelRevenue, { rows: srcRows, dateRange: `Period A: ${dateRange.from} to ${dateRange.to}` }) })] })] }));
}
