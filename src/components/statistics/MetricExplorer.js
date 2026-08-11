import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React, { useMemo, useState } from "react";
import { Search, AlertTriangle } from "lucide-react";
import Card from "@/components/ui-exec/Card";
import { money2, num, C } from "@/lib/hotel";
import { sectionTable, PERIOD_LABEL } from "@/lib/statisticsAnalytics";
// Every metric in the snapshot, grouped by section, all five periods side by side.
//
// The point of this table is completeness: the headline cards above it show six
// numbers, and the file contains a hundred and six. Anything the parser could
// not categorise is shown with a marker rather than dropped, so an unrecognised
// metric is a visible question instead of a silent omission.
const COLUMNS = ["actual_today", "mtd", "ly_mtd", "ytd", "ly_ytd"];
const SHORT = { actual_today: "Today", mtd: "MTD", ly_mtd: "LY MTD", ytd: "YTD", ly_ytd: "LY YTD" };
// Values arrive already typed by the parser, so formatting keys off the unit it
// detected rather than guessing from the magnitude.
function formatValue(value, unit) {
    if (value === null || value === undefined)
        return _jsx("span", { className: "text-slate-600", children: "\u2014" });
    if (unit === "currency")
        return money2(value);
    if (unit === "percentage")
        return `${Number(value).toFixed(2)}%`;
    return num(value);
}
export default function MetricExplorer({ rows = [] }) {
    const [query, setQuery] = useState("");
    const [openSection, setOpenSection] = useState(null);
    const sections = useMemo(() => sectionTable(rows), [rows]);
    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q)
            return sections;
        return sections
            .map((s) => ({ ...s, metrics: s.metrics.filter((m) => m.name.toLowerCase().includes(q)) }))
            .filter((s) => s.metrics.length > 0);
    }, [sections, query]);
    // Searching should reveal what it found rather than leave everything collapsed.
    const isOpen = (name) => (query.trim() ? true : openSection === name);
    const totalMetrics = sections.reduce((a, s) => a + s.metrics.length, 0);
    return (_jsxs(Card, { title: "Every metric in this snapshot", subtitle: `${num(totalMetrics)} metrics across ${sections.length} sections — nothing filtered out`, right: _jsxs("label", { className: "relative flex items-center", children: [_jsx(Search, { className: "pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-slate-500" }), _jsx("input", { value: query, onChange: (e) => setQuery(e.target.value), placeholder: "Find a metric", className: "h-9 w-44 rounded-lg border border-white/10 bg-[#0A1628] pl-8 pr-3 text-sm text-slate-200 outline-none transition-colors placeholder:text-slate-600 focus:border-[#6C63FF] sm:w-56" })] }), children: [filtered.length === 0 && (_jsxs("p", { className: "text-sm text-slate-500", children: ["No metric matches \u201C", query, "\u201D."] })), _jsx("div", { className: "space-y-2", children: filtered.map((section) => (_jsxs("div", { className: "overflow-hidden rounded-xl border border-white/5", children: [_jsxs("button", { onClick: () => setOpenSection(openSection === section.name ? null : section.name), className: "flex w-full items-center justify-between gap-3 bg-[#0A1628]/60 px-4 py-2.5 text-left transition-colors hover:bg-[#0A1628]", children: [_jsx("span", { className: "text-sm font-medium text-slate-200", children: section.name }), _jsxs("span", { className: "text-xs text-slate-500", children: [num(section.metrics.length), " metric", section.metrics.length === 1 ? "" : "s"] })] }), isOpen(section.name) && (_jsx("div", { className: "overflow-x-auto", children: _jsxs("table", { className: "w-full min-w-[620px] text-sm", children: [_jsx("thead", { children: _jsxs("tr", { className: "border-y border-white/5 bg-[#0A1628]/30 text-left", children: [_jsx("th", { className: "px-4 py-2 text-[11px] font-medium uppercase tracking-[0.14em] text-slate-500", children: "Metric" }), COLUMNS.map((p) => (_jsx("th", { title: PERIOD_LABEL[p], className: "px-3 py-2 text-right text-[11px] font-medium uppercase tracking-[0.14em] text-slate-500", children: SHORT[p] }, p)))] }) }), _jsx("tbody", { children: section.metrics.map((m) => (_jsxs("tr", { className: "border-b border-white/5 last:border-0 hover:bg-white/[0.02]", children: [_jsx("td", { className: "px-4 py-2 text-slate-300", children: _jsxs("span", { className: "flex items-center gap-1.5", children: [m.name, m.isUnknown && (_jsx(AlertTriangle, { className: "h-3 w-3 shrink-0", style: { color: C.amber }, "aria-label": "Not in the known metric list \u2014 imported and shown as-is" })), m.isTotal && (_jsx("span", { className: "rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-slate-500", children: "section total" }))] }) }), COLUMNS.map((p) => (_jsx("td", { className: "px-3 py-2 text-right tabular-nums text-slate-300", children: formatValue(m.values[p], m.unit) }, p)))] }, m.name))) })] }) }))] }, section.name))) })] }));
}
