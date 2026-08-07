import React from "react";

export default function RangePicker({ from, to, onChange, label }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {label && <span className="text-xs uppercase tracking-widest text-slate-400">{label}</span>}
      <input
        type="date"
        value={from}
        onChange={(e) => onChange(e.target.value, to)}
        className="rounded-lg border border-white/10 bg-[#0A1628] px-3 py-1.5 text-sm text-slate-200 outline-none focus:border-[#00D4FF]"
      />
      <span className="text-slate-500">→</span>
      <input
        type="date"
        value={to}
        onChange={(e) => onChange(from, e.target.value)}
        className="rounded-lg border border-white/10 bg-[#0A1628] px-3 py-1.5 text-sm text-slate-200 outline-none focus:border-[#00D4FF]"
      />
    </div>
  );
}