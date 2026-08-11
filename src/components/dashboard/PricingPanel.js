import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React from "react";
import { Link } from "react-router-dom";
import { Settings2, TrendingUp, TrendingDown, ArrowRight } from "lucide-react";
import { ResponsiveContainer, LineChart, Line, Tooltip } from "recharts";
import Card from "@/components/ui-exec/Card";
import { usePricingForecast } from "@/lib/usePricing";
import { useRealtimeInvalidation } from "@/lib/realtime";
import { money2 } from "@/lib/hotel";
// Compact dynamic-pricing widget for the Executive Dashboard.
// Shows the enabled state, today's recommended ADR vs base, the revenue uplift
// the engine is projecting, and a 14-day recommended-rate trend so the owner
// sees the pricing posture at a glance. The full forecast, settings, and
// channel push live on the /pricing page.
export default function PricingPanel() {
    useRealtimeInvalidation(["rooms", "reservations", "weather"]);
    const { forecast, config, enabled } = usePricingForecast(14);
    const today = forecast[0] || null;
    const baseAdr = today
        ? Math.round(Object.values(today.types).reduce((s, t) => s + t.baseCents, 0) /
            Math.max(1, Object.values(today.types).filter((t) => t.baseCents > 0).length))
        : 0;
    const recAdr = today ? today.adrCents : 0;
    const delta = recAdr - baseAdr;
    const occ = today ? today.occupancy : 0;
    // Owner KPI: projected revenue uplift vs keeping flat base rates over the
    // 7-day window. This is the dollar value the engine is fighting for.
    const periodSlices = forecast.slice(0, 7);
    const projectedRev = periodSlices.reduce((s, d) => s + d.projectedRevenueCents, 0);
    const baseRev = periodSlices.reduce((s, d) => {
        const b = Object.values(d.types).reduce((a, t) => a + t.baseCents, 0) / Math.max(1, Object.values(d.types).filter((t) => t.baseCents > 0).length);
        return s + Math.round(d.occupancy * Math.round(d.occupancy * 100)) * b;
    }, 0);
    const revUplift = projectedRev - baseRev;
    const chartData = forecast.map((d) => ({ day: String(d.date).slice(5), adr: d.adrCents }));
    return (_jsx(Card, { title: "Dynamic Pricing", subtitle: enabled ? "Recommended rates from live demand signals" : "Pricing engine is disabled", right: _jsxs(Link, { to: "/pricing", className: "flex items-center gap-1.5 rounded-lg border border-white/10 px-2 py-1 text-xs text-slate-300 hover:bg-white/5", children: [_jsx(Settings2, { className: "h-3.5 w-3.5" }), " Configure"] }), children: !enabled ? (_jsxs("p", { className: "text-sm text-slate-400", children: ["The pricing engine is off.", " ", _jsx(Link, { to: "/pricing", className: "text-[#00D4FF] underline", children: "Enable it" }), " ", "to auto-adjust rates from demand."] })) : today ? (_jsxs("div", { children: [_jsxs("div", { className: "grid gap-3 sm:grid-cols-4", children: [_jsxs("div", { className: "rounded-xl border border-white/5 bg-[#0A1628]/60 p-3", children: [_jsx("p", { className: "text-[10px] uppercase tracking-widest text-slate-500", children: "Today\u2019s Rate" }), _jsx("p", { className: "mt-1 font-heading text-2xl font-semibold text-white", children: money2(recAdr) }), _jsxs("div", { className: "mt-0.5 flex items-center gap-1 text-xs", children: [delta >= 0 ? _jsx(TrendingUp, { className: "h-3 w-3 text-[#00E096]" }) : _jsx(TrendingDown, { className: "h-3 w-3 text-[#FF6B6B]" }), _jsxs("span", { className: delta >= 0 ? "text-[#00E096]" : "text-[#FF6B6B]", children: [delta >= 0 ? "+" : "", money2(delta), " vs base"] })] })] }), _jsxs("div", { className: "rounded-xl border border-white/5 bg-[#0A1628]/60 p-3", children: [_jsx("p", { className: "text-[10px] uppercase tracking-widest text-slate-500", children: "Occupancy" }), _jsxs("p", { className: "mt-1 font-heading text-2xl font-semibold text-white", children: [Math.round(occ * 100), "%"] }), _jsx("p", { className: "text-xs text-slate-400", children: "forecast for tonight" })] }), _jsxs("div", { className: "rounded-xl border border-white/5 bg-[#0A1628]/60 p-3", children: [_jsx("p", { className: "text-[10px] uppercase tracking-widest text-slate-500", children: "7-Day Revenue" }), _jsx("p", { className: "mt-1 font-heading text-2xl font-semibold text-white", children: money2(projectedRev) }), _jsxs("p", { className: `mt-0.5 text-xs ${revUplift >= 0 ? "text-[#00E096]" : "text-[#FF6B6B]"}`, children: [revUplift >= 0 ? "+" : "", money2(revUplift), " vs base rates"] })] }), _jsxs("div", { className: "rounded-xl border border-white/5 bg-[#0A1628]/60 p-3", children: [_jsx("p", { className: "text-[10px] uppercase tracking-widest text-slate-500", children: "Sensitivity" }), _jsxs("p", { className: "mt-1 font-heading text-2xl font-semibold text-white", children: [Math.round((config.demandSensitivity || 0) * 100), "%"] }), _jsx("p", { className: "text-xs text-slate-400", children: "demand response" })] })] }), chartData.length > 1 && (_jsxs("div", { className: "mt-4", children: [_jsxs("div", { className: "mb-1 flex items-center justify-between", children: [_jsx("p", { className: "text-xs text-slate-400", children: "14-day recommended ADR trend" }), _jsxs(Link, { to: "/pricing", className: "flex items-center gap-1 text-xs text-[#00D4FF] hover:underline", children: ["Open full forecast ", _jsx(ArrowRight, { className: "h-3 w-3" })] })] }), _jsx(ResponsiveContainer, { width: "100%", height: 150, children: _jsxs(LineChart, { data: chartData, children: [_jsx(Line, { type: "monotone", dataKey: "adr", stroke: "#6C63FF", strokeWidth: 2, dot: false }), _jsx(Tooltip, { contentStyle: { background: "#0F1F35", border: "1px solid #ffffff22", borderRadius: 8 }, formatter: (v) => [money2(v), "ADR"] })] }) })] }))] })) : (_jsx("p", { className: "text-sm text-slate-400", children: "No room register yet. Build one on the Room Board to see recommendations." })) }));
}
