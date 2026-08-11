import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React, { useMemo, useRef } from "react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from "recharts";
import Card from "@/components/ui-exec/Card";
import ChartToolbar from "@/components/charts/ChartToolbar";
import UniversalChart from "@/components/charts/UniversalChart";
import { commissionFor, money, num, pct, C, CHART_COLORS } from "@/lib/hotel";
import { useSettingsVersion } from "@/hooks/useSettingsVersion";
export default function ChannelRevenue({ rows, dateRange }) {
    const settingsVersion = useSettingsVersion();
    const chartRef = useRef(null);
    const channels = useMemo(() => {
        const map = new Map();
        (rows || []).forEach((r) => {
            const src = r.source || "Unknown";
            const net = Number(r.net_revenue || 0);
            const stays = Number(r.stays || 0);
            const info = commissionFor(src);
            let gross = 0;
            if (info.type === "percentage" && info.rate > 0)
                gross = net / (1 - info.rate);
            else if (info.type === "fixed")
                gross = net + info.rate * stays;
            else
                gross = net;
            const commission = gross - net;
            const cur = map.get(src) || { source: src, gross: 0, net: 0, stays: 0, commission: 0, adr: 0 };
            cur.gross += gross;
            cur.net += net;
            cur.stays += stays;
            cur.commission += commission;
            cur.adr += Number(r.adr || 0);
            map.set(src, cur);
        });
        return [...map.values()].sort((a, b) => b.net - a.net);
    }, [rows, settingsVersion]);
    const totalGross = channels.reduce((a, c) => a + c.gross, 0);
    const totalNet = channels.reduce((a, c) => a + c.net, 0);
    const totalCommission = channels.reduce((a, c) => a + c.commission, 0);
    const chartData = channels.slice(0, 10).map((c, i) => ({
        name: c.source,
        value: Math.round(c.net),
    }));
    if (!channels.length) {
        return (_jsx(Card, { title: "Revenue by Channel", subtitle: "No source data available for the selected period", children: _jsx("p", { className: "text-sm text-slate-500", children: "Import Source Summary reports to see channel profitability." }) }));
    }
    return (_jsxs("div", { className: "space-y-6", children: [_jsxs("div", { className: "grid gap-4 sm:grid-cols-3", children: [_jsxs("div", { className: "rounded-2xl border border-white/5 bg-[#0F1F35]/80 p-5", children: [_jsx("p", { className: "text-[11px] font-medium uppercase tracking-[0.14em] text-slate-400", children: "Gross Revenue" }), _jsx("p", { className: "mt-3 font-heading text-3xl font-semibold text-white", children: money(totalGross) })] }), _jsxs("div", { className: "rounded-2xl border border-white/5 bg-[#0F1F35]/80 p-5", children: [_jsx("p", { className: "text-[11px] font-medium uppercase tracking-[0.14em] text-slate-400", children: "Total Commission" }), _jsx("p", { className: "mt-3 font-heading text-3xl font-semibold text-[#FFB547]", children: money(totalCommission) })] }), _jsxs("div", { className: "rounded-2xl border border-white/5 bg-[#0F1F35]/80 p-5", children: [_jsx("p", { className: "text-[11px] font-medium uppercase tracking-[0.14em] text-slate-400", children: "Net Profitability" }), _jsx("p", { className: "mt-3 font-heading text-3xl font-semibold text-[#00E096]", children: money(totalNet) })] })] }), _jsx(Card, { title: "Channel net revenue distribution", subtitle: dateRange, right: _jsx(ChartToolbar, { targetRef: chartRef, title: "Channel Revenue", dateRange: dateRange }), children: _jsxs("div", { ref: chartRef, children: [_jsx("div", { className: "h-80", children: _jsx(ResponsiveContainer, { width: "100%", height: "100%", children: _jsxs(BarChart, { data: chartData, margin: { top: 10, right: 10, left: 0, bottom: 40 }, children: [_jsx(CartesianGrid, { strokeDasharray: "3 3", stroke: "#ffffff10", vertical: false }), _jsx(XAxis, { dataKey: "name", tick: { fill: "#64748b", fontSize: 11 }, angle: -35, textAnchor: "end", interval: 0, height: 60 }), _jsx(YAxis, { tick: { fill: "#64748b", fontSize: 11 }, tickFormatter: (v) => `$${(v / 1000).toFixed(0)}k` }), _jsx(Tooltip, { cursor: { fill: "#ffffff08" }, contentStyle: { background: "#0A1628", border: "1px solid #ffffff14", borderRadius: 12, color: "#e2e8f0" }, formatter: (v) => [money(v), "Net Revenue"] }), _jsx(Bar, { dataKey: "value", radius: [6, 6, 0, 0], children: chartData.map((_, i) => (_jsx(Cell, { fill: CHART_COLORS[i % CHART_COLORS.length] }, i))) })] }) }) }), _jsx("div", { className: "mt-4 h-64", children: _jsx(UniversalChart, { type: "donut", data: chartData }) })] }) }), _jsxs(Card, { title: "Revenue & profitability by channel", subtitle: "Ranked by highest net profitability", children: [_jsx("div", { className: "overflow-x-auto", children: _jsxs("table", { className: "w-full text-sm", children: [_jsx("thead", { children: _jsxs("tr", { className: "border-b border-white/10 text-xs text-slate-500", children: [_jsx("th", { className: "pb-3 text-left", children: "Channel" }), _jsx("th", { className: "pb-3 text-right", children: "Gross Rev" }), _jsx("th", { className: "pb-3 text-right", children: "Stays" }), _jsx("th", { className: "pb-3 text-right", children: "Commission" }), _jsx("th", { className: "pb-3 text-right", children: "Net Rev" }), _jsx("th", { className: "pb-3 text-right", children: "% Rev" }), _jsx("th", { className: "pb-3 text-right", children: "Margin" })] }) }), _jsx("tbody", { children: channels.map((c, i) => {
                                        const revPct = totalNet ? c.net / totalNet : 0;
                                        const marginPct = c.gross > 0 ? c.net / c.gross : 0;
                                        return (_jsxs("tr", { className: "border-b border-white/5", children: [_jsxs("td", { className: "py-3", children: [_jsxs("span", { className: "text-white", children: [i + 1, ". "] }), _jsx("span", { className: "text-slate-200", children: c.source })] }), _jsx("td", { className: "py-3 text-right tabular-nums text-slate-300", children: money(c.gross) }), _jsx("td", { className: "py-3 text-right tabular-nums text-slate-400", children: num(c.stays) }), _jsx("td", { className: "py-3 text-right tabular-nums text-[#FFB547]", children: money(c.commission) }), _jsx("td", { className: "py-3 text-right tabular-nums text-[#00E096]", children: money(c.net) }), _jsx("td", { className: "py-3 text-right tabular-nums text-slate-400", children: pct(revPct) }), _jsx("td", { className: "py-3 text-right", children: _jsx("span", { className: "rounded-full px-2 py-0.5 text-xs font-medium", style: { background: marginPct >= 0.85 ? "rgba(0,224,150,0.12)" : "rgba(255,181,71,0.12)", color: marginPct >= 0.85 ? C.green : C.amber }, children: pct(marginPct, 0) }) })] }, c.source));
                                    }) }), _jsx("tfoot", { children: _jsxs("tr", { className: "border-t-2 border-white/10 bg-[#0A1628]/80", children: [_jsxs("td", { className: "py-3 font-semibold text-white", children: ["TOTAL (", channels.length, " channels)"] }), _jsx("td", { className: "py-3 text-right font-heading text-base font-semibold text-slate-300", children: money(totalGross) }), _jsx("td", { className: "py-3 text-right tabular-nums text-slate-400", children: channels.reduce((a, c) => a + c.stays, 0) }), _jsx("td", { className: "py-3 text-right font-heading text-base font-semibold text-[#FFB547]", children: money(totalCommission) }), _jsx("td", { className: "py-3 text-right font-heading text-base font-semibold text-[#00E096]", children: money(totalNet) }), _jsx("td", { className: "py-3 text-right tabular-nums text-slate-400", children: "100.0%" }), _jsx("td", { className: "py-3 text-right text-xs text-slate-500", children: "\u2014" })] }) })] }) }), _jsx("p", { className: "mt-4 text-xs text-slate-500", children: "Net profitability = Gross revenue \u2212 commissions \u2212 channel fees. Walk-ins and direct bookings use zero commission unless configured in Settings." })] })] }));
}
