import React from "react";

export default function KpiCard(
  /** @type {{
   *   label: string;
   *   value: string | number;
   *   sub?: string;
   *   accent?: string;
   *   icon?: import('react').ComponentType<{ className?: string; style?: import('react').CSSProperties }>;
   * }} */
  { label, value, sub, accent = "#6C63FF", icon: Icon }) {
  return (
    <div className="group relative overflow-hidden rounded-2xl border border-white/5 bg-[#0F1F35]/80 p-5 transition-all duration-300 hover:-translate-y-0.5 hover:border-white/10">
      <div
        className="absolute inset-x-0 top-0 h-[2px] opacity-70 transition-opacity duration-300 group-hover:opacity-100"
        style={{ background: `linear-gradient(90deg, transparent, ${accent}, transparent)` }}
      />
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-slate-400">{label}</p>
        {Icon && <Icon className="h-4 w-4" style={{ color: accent }} />}
      </div>
      <p className="mt-3 font-heading text-3xl font-semibold tabular-nums text-white">{value}</p>
      {sub && <p className="mt-1 text-xs text-slate-400">{sub}</p>}
    </div>
  );
}