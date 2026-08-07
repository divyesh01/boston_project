import React from "react";
import { ArrowUpRight, ArrowDownRight, Minus } from "lucide-react";
import { C } from "@/lib/hotel";

export default function CompareCard({ label, a, b, format }) {
  const growth = b ? (a - b) / Math.abs(b) : 0;
  const up = growth > 0.001;
  const down = growth < -0.001;
  const color = up ? C.green : down ? C.coral : "#94a3b8";
  const Icon = up ? ArrowUpRight : down ? ArrowDownRight : Minus;

  return (
    <div className="rounded-2xl border border-white/5 bg-[#0F1F35]/80 p-5 transition-all duration-300 hover:border-white/10">
      <p className="text-[11px] uppercase tracking-[0.14em] text-slate-400">{label}</p>
      <p className="mt-3 font-heading text-2xl font-semibold text-white">{format(a)}</p>
      <div className="mt-2 flex items-center gap-2 text-xs">
        <span className="flex items-center gap-1 font-medium" style={{ color }}>
          <Icon className="h-3.5 w-3.5" />
          {(growth * 100).toFixed(1)}%
        </span>
        <span className="text-slate-500">vs {format(b)}</span>
      </div>
    </div>
  );
}