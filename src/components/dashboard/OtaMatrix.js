import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React from "react";
import Card from "@/components/ui-exec/Card";
import { commissionFor, money, pct, C } from "@/lib/hotel";
import { Lightbulb } from "lucide-react";
import { useSettingsVersion } from "@/hooks/useSettingsVersion";
export default function OtaMatrix({ rows }) {
    useSettingsVersion();
    const map = new Map();
    rows.forEach((r) => {
        const key = r.source || r.code || "UNKNOWN";
        const cur = map.get(key) || { source: key, gross: 0, stays: 0 };
        cur.gross += Number(r.net_revenue) || 0;
        cur.stays += Number(r.stays) || 0;
        map.set(key, cur);
    });
    const channels = [...map.values()]
        .filter((c) => c.gross > 0 || c.stays > 0)
        .map((c) => {
        const info = commissionFor(c.source);
        let commission = 0;
        if (info.type === "percentage")
            commission = c.gross * info.rate;
        else if (info.type === "fixed")
            commission = info.rate * c.stays;
        else if (info.type === "actual")
            commission = info.rate;
        return { ...c, rate: info.rate, commission, net: c.gross - commission, margin: c.gross ? (c.gross - commission) / c.gross : 0 };
    })
        .sort((a, b) => b.net - a.net);
    const totalGross = channels.reduce((a, c) => a + c.gross, 0);
    const totalCommission = channels.reduce((a, c) => a + c.commission, 0);
    const bestDirect = channels.filter((c) => c.rate === 0).sort((a, b) => b.gross - a.gross)[0] || null;
    const worstOta = channels.filter((c) => c.rate > 0).sort((a, b) => b.commission - a.commission)[0] || null;
    return (_jsxs(Card, { title: "OTA Channel Net Profitability Matrix", subtitle: `Gross ${money(totalGross)} · Commission leakage ${money(totalCommission)} · Net ${money(totalGross - totalCommission)}`, children: [_jsx("div", { className: "overflow-x-auto", children: _jsxs("table", { className: "w-full text-sm", children: [_jsx("thead", { children: _jsxs("tr", { className: "text-left text-[11px] uppercase tracking-widest text-slate-500", children: [_jsx("th", { className: "pb-3 pr-4", children: "#" }), _jsx("th", { className: "pb-3 pr-4", children: "Channel" }), _jsx("th", { className: "pb-3 pr-4 text-right", children: "Rooms" }), _jsx("th", { className: "pb-3 pr-4 text-right", children: "Gross" }), _jsx("th", { className: "pb-3 pr-4 text-right", children: "Comm." }), _jsx("th", { className: "pb-3 pr-4 text-right", children: "Commission $" }), _jsx("th", { className: "pb-3 pr-4 text-right", children: "Net" }), _jsx("th", { className: "pb-3 text-right", children: "Margin" })] }) }), _jsx("tbody", { children: channels.map((c, i) => (_jsxs("tr", { className: "border-t border-white/5 transition-colors hover:bg-white/[0.03]", children: [_jsx("td", { className: "py-2.5 pr-4 text-slate-500", children: i + 1 }), _jsx("td", { className: "py-2.5 pr-4 text-slate-200", children: c.source }), _jsx("td", { className: "py-2.5 pr-4 text-right tabular-nums text-slate-400", children: c.stays }), _jsx("td", { className: "py-2.5 pr-4 text-right tabular-nums", children: money(c.gross) }), _jsx("td", { className: "py-2.5 pr-4 text-right tabular-nums text-slate-400", children: pct(c.rate, 0) }), _jsx("td", { className: "py-2.5 pr-4 text-right tabular-nums", style: { color: c.commission > 0 ? C.coral : "#64748b" }, children: c.commission > 0 ? `-${money(c.commission)}` : "—" }), _jsx("td", { className: "py-2.5 pr-4 text-right font-medium tabular-nums text-white", children: money(c.net) }), _jsx("td", { className: "py-2.5 text-right tabular-nums", style: { color: c.margin >= 0.9 ? C.green : C.amber }, children: pct(c.margin) })] }, c.source))) })] }) }), bestDirect && worstOta && (_jsxs("div", { className: "mt-5 flex gap-3 rounded-xl border border-[#FFB547]/20 bg-[#FFB547]/[0.06] p-4", children: [_jsx(Lightbulb, { className: "mt-0.5 h-4 w-4 shrink-0 text-[#FFB547]" }), _jsxs("p", { className: "text-sm leading-relaxed text-slate-300", children: [_jsx("span", { className: "text-white", children: bestDirect.source }), " brought ", money(bestDirect.gross), " at 0% commission, while", " ", _jsx("span", { className: "text-white", children: worstOta.source }), " cost you ", money(worstOta.commission), " in commission. Negotiate", " ", worstOta.source, " down by 2% (\u2248", money(worstOta.gross * 0.02), " saved) or push more direct bookings and walk-ins."] })] }))] }));
}
