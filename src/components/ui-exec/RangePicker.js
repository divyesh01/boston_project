import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React from "react";
export default function RangePicker({ from, to, onChange, label }) {
    return (_jsxs("div", { className: "flex flex-wrap items-center gap-2", children: [label && _jsx("span", { className: "text-xs uppercase tracking-widest text-slate-400", children: label }), _jsx("input", { type: "date", value: from, onChange: (e) => onChange(e.target.value, to), className: "rounded-lg border border-white/10 bg-[#0A1628] px-3 py-1.5 text-sm text-slate-200 outline-none focus:border-[#00D4FF]" }), _jsx("span", { className: "text-slate-500", children: "\u2192" }), _jsx("input", { type: "date", value: to, onChange: (e) => onChange(from, e.target.value), className: "rounded-lg border border-white/10 bg-[#0A1628] px-3 py-1.5 text-sm text-slate-200 outline-none focus:border-[#00D4FF]" })] }));
}
