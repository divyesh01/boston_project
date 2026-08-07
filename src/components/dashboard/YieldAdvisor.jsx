import React from "react";
import Card from "@/components/ui-exec/Card";
import { pct, money2, C } from "@/lib/hotel";
import { TrendingUp } from "lucide-react";

export default function YieldAdvisor({ occupancy, adr, revpar }) {
  let advice, tone;
  if (occupancy > 0.8) {
    advice = `High Occupancy (${pct(occupancy)}). Increase Rack Rate by $10–$15/night on peak days and close discount channels.`;
    tone = C.green;
  } else if (occupancy > 0.6) {
    advice = `Healthy Occupancy (${pct(occupancy)}). Hold rate, push mid-week direct promos to lift ADR above ${money2(adr * 1.05)}.`;
    tone = C.cyan;
  } else {
    advice = `Soft Occupancy (${pct(occupancy)}). Drop rate $5–$8 on low-demand days and open OTA inventory to fill rooms.`;
    tone = C.amber;
  }

  return (
    <Card title="Yield & ADR Optimizer" subtitle={`ADR ${money2(adr)} · RevPAR ${money2(revpar)}`}>
      <div className="flex gap-3 rounded-xl border p-4" style={{ borderColor: `${tone}33`, background: `${tone}0f` }}>
        <TrendingUp className="mt-0.5 h-4 w-4 shrink-0" style={{ color: tone }} />
        <p className="text-sm leading-relaxed text-slate-300">{advice}</p>
      </div>
      <div className="mt-4 h-2 overflow-hidden rounded-full bg-white/5">
        <div
          className="h-full rounded-full transition-all duration-700"
          style={{ width: `${Math.min(100, occupancy * 100)}%`, background: `linear-gradient(90deg,${C.purple},${tone})` }}
        />
      </div>
      <p className="mt-2 text-xs text-slate-500">Occupancy vs 100-room capacity</p>
    </Card>
  );
}