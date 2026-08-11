import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React, { useMemo, useState } from "react";
import { Search, ChevronLeft, ChevronRight, Download } from "lucide-react";
import Card from "@/components/ui-exec/Card";
import { money2, num, C } from "@/lib/hotel";
import { LEDGER_SIDE_CHARGE } from "@/lib/transactionNorm";
const PAGE_SIZE = 50;
const SIDE_STYLE = {
    charge: { label: "Charge", color: C.purple },
    payment: { label: "Settlement", color: C.cyan },
};
// Every line, searchable, paged.
//
// 16,921 rows is far too many to put in the DOM at once, so this pages at 50.
// Filtering runs over the in-memory array the rest of the page already holds —
// no extra query — and is memoised on the search term so typing does not
// re-scan on every keystroke's render.
export default function LedgerTable({ rows = [], onExport }) {
    const [q, setQ] = useState("");
    const [side, setSide] = useState("all");
    const [page, setPage] = useState(0);
    const filtered = useMemo(() => {
        const term = q.trim().toLowerCase();
        let out = rows;
        if (side !== "all")
            out = out.filter((r) => r.ledger_side === side);
        if (term) {
            out = out.filter((r) => (r.guest_name || "").toLowerCase().includes(term) ||
                (r.folio_number || "").toLowerCase().includes(term) ||
                (r.confirmation_number || "").toLowerCase().includes(term) ||
                (r.room_number || "").toLowerCase().includes(term) ||
                (r.transaction_code || "").toLowerCase().includes(term) ||
                (r.username || "").toLowerCase().includes(term));
        }
        return out;
    }, [rows, q, side]);
    // Newest first for a drill-down; the page-level data is date-ascending.
    const sorted = useMemo(() => [...filtered].sort((a, b) => (a.date === b.date ? String(b.time || "").localeCompare(String(a.time || "")) : (a.date < b.date ? 1 : -1))), [filtered]);
    const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
    const safePage = Math.min(page, pageCount - 1);
    const slice = sorted.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);
    const reset = (fn) => (v) => { fn(v); setPage(0); };
    return (_jsxs(Card, { title: "Every line", subtitle: `${num(sorted.length)} of ${num(rows.length)} rows`, right: onExport && (_jsxs("div", { className: "flex gap-2", children: [_jsxs("button", { onClick: () => onExport(sorted, 'csv'), className: "flex items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1.5 text-xs text-slate-300 transition-colors hover:border-white/20 hover:text-white", children: [_jsx(Download, { className: "h-3 w-3" }), " CSV"] }), _jsxs("button", { onClick: () => onExport(sorted, 'excel'), className: "flex items-center gap-1.5 rounded-lg border border-white/10 bg-[#107C41]/20 px-2.5 py-1.5 text-xs text-[#107C41] transition-colors hover:bg-[#107C41]/30 hover:text-[#19a557]", children: [_jsx(Download, { className: "h-3 w-3" }), " Excel"] })] })), children: [_jsxs("div", { className: "mb-4 flex flex-col gap-2 sm:flex-row", children: [_jsxs("div", { className: "relative flex-1", children: [_jsx(Search, { className: "absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" }), _jsx("input", { value: q, onChange: (e) => reset(setQ)(e.target.value), placeholder: "Guest, folio, room, confirmation, code or user", className: "h-10 w-full rounded-lg border border-white/10 bg-[#0A1628] pl-9 pr-3 text-sm text-slate-200 outline-none transition-colors placeholder:text-slate-600 focus:border-[#6C63FF]" })] }), _jsx("div", { className: "flex gap-1 rounded-lg bg-[#0A1628] p-1", children: [["all", "All"], ["charge", "Charges"], ["payment", "Settlements"]].map(([key, label]) => (_jsx("button", { onClick: () => reset(setSide)(key), className: `rounded-md px-3 py-1.5 text-xs transition-colors ${side === key ? "bg-[#6C63FF] text-white" : "text-slate-400 hover:text-slate-200"}`, children: label }, key))) })] }), slice.length === 0 ? (_jsx("p", { className: "py-8 text-center text-sm text-slate-500", children: "No lines match this search." })) : (_jsx("div", { className: "overflow-x-auto", children: _jsxs("table", { className: "w-full min-w-[860px] text-sm", children: [_jsx("thead", { children: _jsx("tr", { className: "border-b border-white/5 text-left", children: ["Date", "Guest", "Room", "Folio", "Code", "Type", "Posted by", "Amount"].map((h) => (_jsx("th", { className: `pb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-slate-500 ${h === "Amount" ? "text-right" : ""}`, children: h }, h))) }) }), _jsx("tbody", { children: slice.map((r) => {
                                const s = SIDE_STYLE[r.ledger_side] || SIDE_STYLE.charge;
                                return (_jsxs("tr", { className: "border-b border-white/5 transition-colors last:border-0 hover:bg-white/[0.02]", children: [_jsxs("td", { className: "whitespace-nowrap py-2.5 tabular-nums text-slate-400", children: [r.date, r.time && _jsx("span", { className: "ml-1.5 text-slate-600", children: String(r.time).slice(0, 5) })] }), _jsx("td", { className: "max-w-[180px] truncate py-2.5 text-slate-300", title: r.guest_name, children: r.guest_name || "—" }), _jsx("td", { className: "py-2.5 tabular-nums text-slate-400", children: r.room_number || "—" }), _jsx("td", { className: "py-2.5 tabular-nums text-slate-400", children: r.folio_number || "—" }), _jsx("td", { className: "py-2.5 text-slate-300", title: r.transaction_description, children: r.transaction_code || "—" }), _jsx("td", { className: "py-2.5", children: _jsx("span", { className: "rounded-full px-2 py-0.5 text-[11px]", style: { background: `${s.color}14`, color: s.color }, children: r.ledger_side === LEDGER_SIDE_CHARGE ? (r.charge_category || s.label) : (r.payment_method || s.label) }) }), _jsx("td", { className: "max-w-[150px] truncate py-2.5 text-slate-400", title: r.username, children: r.employee_label || "—" }), _jsx("td", { className: "whitespace-nowrap py-2.5 text-right font-medium tabular-nums", style: { color: s.color }, children: money2(r.amount) })] }, r.id ?? r.dedupe_key));
                            }) })] }) })), pageCount > 1 && (_jsxs("div", { className: "mt-4 flex items-center justify-between border-t border-white/5 pt-3", children: [_jsxs("p", { className: "text-xs text-slate-500 tabular-nums", children: [num(safePage * PAGE_SIZE + 1), "\u2013", num(Math.min((safePage + 1) * PAGE_SIZE, sorted.length)), " of ", num(sorted.length)] }), _jsxs("div", { className: "flex items-center gap-1", children: [_jsx("button", { onClick: () => setPage((p) => Math.max(0, p - 1)), disabled: safePage === 0, className: "rounded-lg border border-white/10 p-1.5 text-slate-300 transition-colors hover:border-white/20 hover:text-white disabled:opacity-30", "aria-label": "Previous page", children: _jsx(ChevronLeft, { className: "h-4 w-4" }) }), _jsxs("span", { className: "px-2 text-xs text-slate-400 tabular-nums", children: [safePage + 1, " / ", pageCount] }), _jsx("button", { onClick: () => setPage((p) => Math.min(pageCount - 1, p + 1)), disabled: safePage >= pageCount - 1, className: "rounded-lg border border-white/10 p-1.5 text-slate-300 transition-colors hover:border-white/20 hover:text-white disabled:opacity-30", "aria-label": "Next page", children: _jsx(ChevronRight, { className: "h-4 w-4" }) })] })] }))] }));
}
