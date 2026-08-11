import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React from "react";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, AreaChart, Area, Tooltip, } from "recharts";
import PieDonut from "@/components/charts/PieDonut";
import { C, money2 } from "@/lib/hotel";
const tip = { background: "#0A1628", border: "1px solid #ffffff14", borderRadius: 12, color: "#e2e8f0" };
const axis = { fill: "#64748b", fontSize: 11 };
export default function UniversalChart({ data, type }) {
    if (!data.length)
        return _jsx("p", { className: "text-sm text-slate-500", children: "No data for this selection." });
    const top = data.slice(0, 25);
    return (_jsx("div", { className: "h-96", children: _jsx(ResponsiveContainer, { width: "100%", height: "100%", children: type === "pie" || type === "donut" ? (_jsx(PieDonut, { data: top, type: type, height: "100%", formatter: money2, maxSlices: 25 })) : type === "hbar" ? (_jsxs(BarChart, { data: top, layout: "vertical", margin: { left: 40, right: 16 }, children: [_jsx(CartesianGrid, { stroke: "#ffffff0a", horizontal: false }), _jsx(XAxis, { type: "number", tick: axis, stroke: "#ffffff10" }), _jsx(YAxis, { type: "category", dataKey: "name", tick: axis, width: 130, stroke: "#ffffff10" }), _jsx(Tooltip, { contentStyle: tip }), _jsx(Bar, { dataKey: "value", fill: C.cyan, radius: [0, 6, 6, 0] })] })) : type === "line" ? (_jsxs(AreaChart, { data: top, margin: { left: -10, right: 8, top: 8 }, children: [_jsx("defs", { children: _jsxs("linearGradient", { id: "uGrad", x1: "0", y1: "0", x2: "0", y2: "1", children: [_jsx("stop", { offset: "0%", stopColor: C.green, stopOpacity: 0.5 }), _jsx("stop", { offset: "100%", stopColor: C.green, stopOpacity: 0 })] }) }), _jsx(CartesianGrid, { stroke: "#ffffff0a", vertical: false }), _jsx(XAxis, { dataKey: "name", tick: axis, stroke: "#ffffff10" }), _jsx(YAxis, { tick: axis, stroke: "#ffffff10" }), _jsx(Tooltip, { contentStyle: tip }), _jsx(Area, { type: "monotone", dataKey: "value", stroke: C.green, strokeWidth: 2, fill: "url(#uGrad)" })] })) : (_jsxs(BarChart, { data: top, margin: { left: -10, right: 8, top: 8 }, children: [_jsx(CartesianGrid, { stroke: "#ffffff0a", vertical: false }), _jsx(XAxis, { dataKey: "name", tick: axis, stroke: "#ffffff10", interval: 0, angle: -25, textAnchor: "end", height: 70 }), _jsx(YAxis, { tick: axis, stroke: "#ffffff10" }), _jsx(Tooltip, { contentStyle: tip }), _jsx(Bar, { dataKey: "value", fill: C.purple, radius: [6, 6, 0, 0] })] })) }) }));
}
