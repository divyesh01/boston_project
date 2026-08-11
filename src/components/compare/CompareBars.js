import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React, { useRef } from "react";
import Card from "@/components/ui-exec/Card";
import ChartToolbar from "@/components/charts/ChartToolbar";
import { BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid } from "recharts";
import { C } from "@/lib/hotel";
export default function CompareBars({ data, dateRange }) {
    const chartRef = useRef(null);
    return (_jsx(Card, { title: "Period A vs Period B", subtitle: "Revenue, rooms sold and ADR side by side", right: _jsx(ChartToolbar, { targetRef: chartRef, title: "Period A vs Period B", dateRange: dateRange }), children: _jsx("div", { ref: chartRef, className: "h-80", children: _jsx(ResponsiveContainer, { width: "100%", height: "100%", children: _jsxs(BarChart, { data: data, margin: { left: -10, right: 8, top: 8 }, children: [_jsx(CartesianGrid, { stroke: "#ffffff0a", vertical: false }), _jsx(XAxis, { dataKey: "metric", tick: { fill: "#64748b", fontSize: 11 }, stroke: "#ffffff10" }), _jsx(YAxis, { tick: { fill: "#64748b", fontSize: 11 }, stroke: "#ffffff10" }), _jsx(Tooltip, { contentStyle: { background: "#0A1628", border: "1px solid #ffffff14", borderRadius: 12 } }), _jsx(Legend, { wrapperStyle: { fontSize: 12, color: "#94a3b8" } }), _jsx(Bar, { dataKey: "Period A", fill: C.purple, radius: [6, 6, 0, 0] }), _jsx(Bar, { dataKey: "Period B", fill: C.cyan, radius: [6, 6, 0, 0] })] }) }) }) }));
}
