import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React, { useRef } from "react";
import Card from "@/components/ui-exec/Card";
import ChartToolbar from "@/components/charts/ChartToolbar";
import { AreaChart, Area, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from "recharts";
import { C, money, getOccThreshold } from "@/lib/hotel";
export default function RevenueTrend({ rows, dateRange }) {
    const chartRef = useRef(null);
    const occThreshold = getOccThreshold();
    const data = rows
        .filter((r) => Number(r.total_revenue || 0) > 0)
        .map((r) => ({
        date: String(r.date).slice(5),
        revenue: r.total_revenue || 0,
        adr: r.adr || 0,
        occupancyPct: Math.round(Number(r.occupancy || 0) * 100),
    }));
    const hasOccData = data.some((d) => d.occupancyPct > 0);
    return (_jsx(Card, { title: "Daily Revenue Trend", subtitle: "Total room revenue per day \u00B7 occupancy line with 60% threshold", right: _jsx(ChartToolbar, { targetRef: chartRef, title: "Daily Revenue Trend", dateRange: dateRange }), children: _jsx("div", { ref: chartRef, className: "h-72", children: _jsx(ResponsiveContainer, { width: "100%", height: "100%", children: _jsxs(AreaChart, { data: data, margin: { left: -12, right: 8, top: 8 }, children: [_jsx("defs", { children: _jsxs("linearGradient", { id: "revGrad", x1: "0", y1: "0", x2: "0", y2: "1", children: [_jsx("stop", { offset: "0%", stopColor: C.purple, stopOpacity: 0.6 }), _jsx("stop", { offset: "100%", stopColor: C.purple, stopOpacity: 0 })] }) }), _jsx(CartesianGrid, { stroke: "#ffffff0a", vertical: false }), _jsx(XAxis, { dataKey: "date", tick: { fill: "#64748b", fontSize: 11 }, stroke: "#ffffff10" }), _jsx(YAxis, { yAxisId: "revenue", orientation: "left", tick: { fill: "#64748b", fontSize: 11 }, stroke: "#ffffff10", tickFormatter: (v) => `${v / 1000}k` }), hasOccData && (_jsx(YAxis, { yAxisId: "occ", orientation: "right", domain: [0, 100], tick: { fill: C.green, fontSize: 10 }, stroke: "#ffffff10", tickFormatter: (v) => `${v}%` })), _jsx(Tooltip, { contentStyle: { background: "#0A1628", border: "1px solid #ffffff14", borderRadius: 12, color: "#e2e8f0" }, formatter: (v, name) => (name === "occupancyPct" ? `${v}%` : money(v)) }), _jsx(Area, { yAxisId: "revenue", type: "monotone", dataKey: "revenue", stroke: C.cyan, strokeWidth: 2, fill: "url(#revGrad)" }), hasOccData && (_jsx(Line, { yAxisId: "occ", type: "monotone", dataKey: "occupancyPct", stroke: C.green, strokeWidth: 1.5, dot: false })), hasOccData && (_jsx(ReferenceLine, { yAxisId: "occ", y: occThreshold * 100, stroke: C.coral, strokeDasharray: "4 4", label: { value: `${Math.round(occThreshold * 100)}%`, fill: C.coral, fontSize: 10 } }))] }) }) }) }));
}
