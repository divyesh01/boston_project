import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React, { useState } from "react";
import { AlertTriangle, ChevronDown, ChevronUp, Lightbulb } from "lucide-react";
import { money, money2, pct, num, getOccThreshold } from "@/lib/hotel";
export default function LowOccAlert({ occRows, sources }) {
    const [expanded, setExpanded] = useState(null);
    const threshold = getOccThreshold();
    const lowDays = occRows
        .filter((r) => Number(r.occupancy || 0) < threshold)
        .sort((a, b) => Number(a.occupancy) - Number(b.occupancy));
    if (!lowDays.length)
        return null;
    const getBookings = (date) => {
        const daySources = sources.filter((s) => String(s.date).slice(0, 10) === String(date).slice(0, 10));
        return daySources.reduce((a, s) => a + (Number(s.stays) || 0), 0);
    };
    const suggestedActions = (occ) => {
        const actions = [];
        if (occ < 0.4) {
            actions.push("Launch last-minute flash sale on OTAs");
            actions.push("Offer deep discount for direct bookings tonight");
            actions.push("Consider reducing room rates by 15-20%");
        }
        else if (occ < threshold) {
            actions.push("Promote same-day booking discounts");
            actions.push("Reach out to corporate accounts for last-minute bookings");
            actions.push("Adjust OTA pricing to increase visibility");
        }
        actions.push("Review cancellation policy to reduce no-shows");
        return actions;
    };
    return (_jsxs("div", { className: "rounded-2xl border border-[#FF6B6B]/20 bg-[#FF6B6B]/[0.04] p-4", children: [_jsxs("div", { className: "mb-3 flex items-center gap-2", children: [_jsx(AlertTriangle, { className: "h-5 w-5 text-[#FF6B6B]" }), _jsxs("p", { className: "text-sm font-medium text-white", children: ["\uD83D\uDD34 Low Occupancy Alert \u00B7 ", lowDays.length, " day", lowDays.length === 1 ? "" : "s", " below ", (threshold * 100).toFixed(0), "%"] })] }), _jsxs("div", { className: "space-y-2", children: [lowDays.slice(0, 10).map((r) => {
                        const idx = expanded === r.date;
                        const bookings = getBookings(r.date);
                        const available = (Number(r.total_rooms) || 100) - (Number(r.rooms_sold) || 0);
                        return (_jsxs("div", { className: "rounded-xl border border-white/10 bg-[#0A1628]/60", children: [_jsxs("button", { onClick: () => setExpanded(idx ? null : r.date), className: "flex w-full items-center justify-between px-4 py-3 text-left", children: [_jsxs("div", { className: "flex items-center gap-3", children: [_jsx("span", { className: "flex h-8 w-8 items-center justify-center rounded-full bg-[#FF6B6B]/15 text-xs font-semibold text-[#FF6B6B]", children: pct(r.occupancy, 0) }), _jsxs("div", { children: [_jsx("p", { className: "text-sm text-white", children: String(r.date).slice(0, 10) }), _jsx("p", { className: "text-xs text-slate-500", children: r.property_name || "" })] })] }), _jsxs("div", { className: "flex items-center gap-3", children: [_jsxs("span", { className: "text-xs text-slate-400", children: ["Target: ", (threshold * 100).toFixed(0), "%"] }), idx ? _jsx(ChevronUp, { className: "h-4 w-4 text-slate-400" }) : _jsx(ChevronDown, { className: "h-4 w-4 text-slate-400" })] })] }), idx && (_jsxs("div", { className: "border-t border-white/5 px-4 py-3", children: [_jsxs("div", { className: "grid gap-3 sm:grid-cols-3 lg:grid-cols-6", children: [_jsxs("div", { children: [_jsx("p", { className: "text-[10px] uppercase tracking-widest text-slate-500", children: "Revenue" }), _jsx("p", { className: "text-sm text-white", children: money(r.total_revenue) })] }), _jsxs("div", { children: [_jsx("p", { className: "text-[10px] uppercase tracking-widest text-slate-500", children: "ADR" }), _jsx("p", { className: "text-sm text-white", children: money2(r.adr) })] }), _jsxs("div", { children: [_jsx("p", { className: "text-[10px] uppercase tracking-widest text-slate-500", children: "RevPAR" }), _jsx("p", { className: "text-sm text-white", children: money2(r.revpar) })] }), _jsxs("div", { children: [_jsx("p", { className: "text-[10px] uppercase tracking-widest text-slate-500", children: "Bookings" }), _jsx("p", { className: "text-sm text-white", children: num(bookings) })] }), _jsxs("div", { children: [_jsx("p", { className: "text-[10px] uppercase tracking-widest text-slate-500", children: "Rooms Sold" }), _jsx("p", { className: "text-sm text-white", children: num(r.rooms_sold) })] }), _jsxs("div", { children: [_jsx("p", { className: "text-[10px] uppercase tracking-widest text-slate-500", children: "Available" }), _jsx("p", { className: "text-sm text-white", children: num(available) })] })] }), _jsxs("div", { className: "mt-3 rounded-lg bg-[#FFB547]/[0.06] p-3", children: [_jsxs("p", { className: "flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-[#FFB547]", children: [_jsx(Lightbulb, { className: "h-3.5 w-3.5" }), " Suggested actions"] }), _jsx("ul", { className: "mt-2 space-y-1", children: suggestedActions(Number(r.occupancy)).map((a, i) => (_jsxs("li", { className: "text-xs text-slate-300", children: ["\u2022 ", a] }, i))) })] })] }))] }, r.date));
                    }), lowDays.length > 10 && (_jsxs("p", { className: "text-center text-xs text-slate-500", children: ["+ ", lowDays.length - 10, " more days below threshold"] }))] })] }));
}
