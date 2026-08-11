import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React from "react";
import { money, num, C } from "@/lib/hotel";
// The two-sided ledger, stated plainly.
//
// A PMS ledger posts money twice: once when it is billed to the folio (the
// charge side) and once when it is settled (the payment side, which this export
// labels REFUND). Adding both together is the single easiest way to misread
// this file — it overstates revenue by ~31% — so the page leads with the two
// sides shown separately rather than burying the distinction in a tooltip.
//
// The bar widths are proportional to each side, which makes the gap between
// what was billed and what settled inside the selected window legible at a
// glance without asking the reader to compare two numbers.
export default function LedgerStrip({ revenue = 0, collected = 0, methods = [], chargeCount = 0, paymentCount = 0 }) {
    const total = revenue + collected;
    const billedPct = total > 0 ? (revenue / total) * 100 : 50;
    const methodTotal = methods.reduce((a, m) => a + m.value, 0);
    return (_jsxs("div", { className: "rounded-2xl border border-white/5 bg-[#0F1F35]/80 p-5", children: [_jsxs("div", { className: "flex flex-wrap items-end justify-between gap-4", children: [_jsxs("div", { children: [_jsx("h3", { className: "font-heading text-sm font-semibold tracking-wide text-white", children: "Both sides of the ledger" }), _jsx("p", { className: "mt-1 text-xs text-slate-400", children: "Charges are what guests were billed. Settlements are what was taken in. They are separate figures \u2014 adding them together double-counts." })] }), _jsxs("p", { className: "text-xs text-slate-500 tabular-nums", children: [num(chargeCount), " charges \u00B7 ", num(paymentCount), " settlements"] })] }), _jsxs("div", { className: "mt-5 flex h-3 overflow-hidden rounded-full bg-[#0A1628]", children: [_jsx("div", { className: "h-full transition-all duration-500", style: { width: `${billedPct}%`, background: `linear-gradient(90deg, ${C.purple}, ${C.purple}cc)` } }), _jsx("div", { className: "h-full transition-all duration-500", style: { width: `${100 - billedPct}%`, background: `linear-gradient(90deg, ${C.cyan}aa, ${C.cyan})` } })] }), _jsxs("div", { className: "mt-4 grid gap-4 sm:grid-cols-2", children: [_jsxs("div", { children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx("span", { className: "h-2 w-2 rounded-full", style: { background: C.purple } }), _jsx("p", { className: "text-[11px] font-medium uppercase tracking-[0.14em] text-slate-400", children: "Revenue billed" })] }), _jsx("p", { className: "mt-1 font-heading text-2xl font-semibold tabular-nums text-white", children: money(revenue) })] }), _jsxs("div", { children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx("span", { className: "h-2 w-2 rounded-full", style: { background: C.cyan } }), _jsx("p", { className: "text-[11px] font-medium uppercase tracking-[0.14em] text-slate-400", children: "Settlements recorded" })] }), _jsx("p", { className: "mt-1 font-heading text-2xl font-semibold tabular-nums text-white", children: money(collected) }), methodTotal > 0 && (_jsx("div", { className: "mt-2 flex flex-wrap gap-x-3 gap-y-1", children: methods.slice(0, 4).map((m) => (_jsxs("span", { className: "text-[11px] text-slate-400 tabular-nums", children: [m.name, " ", Math.round((m.value / methodTotal) * 100), "%"] }, m.name))) }))] })] })] }));
}
