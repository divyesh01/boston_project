import React from "react";
import Card from "@/components/ui-exec/Card";
import { pct, money2, C } from "@/lib/hotel";
import { buildYieldAdvice } from "@/lib/yieldAdvice";
import { TrendingUp, TrendingDown, Minus, Info } from "lucide-react";

// Renders src/lib/yieldAdvice.js and adds no arithmetic of its own. The five
// defects this panel used to carry — invented dollar amounts, float-dollar math on
// ADR, a hardcoded 100-room capacity caption, a hardcoded occupancy band that
// disagreed with LowOccAlert on the same screen, and rate advice for an empty
// database — are all documented and asserted where the logic now lives. See
// scripts/probe-yield-advisor.mjs.
const BAND_STYLE = {
  strong: { tone: C.green, Icon: TrendingUp },
  healthy: { tone: C.cyan, Icon: Minus },
  soft: { tone: C.amber, Icon: TrendingDown },
  unknown: { tone: "#64748B", Icon: Info },
};

export default function YieldAdvisor({ occupancy, adr, revpar, capacity, roomsSold }) {
  const advice = buildYieldAdvice({ occupancy, capacity, roomsSold });
  const { tone, Icon } = BAND_STYLE[advice.band] || BAND_STYLE.unknown;
  const measured = advice.band !== "unknown";

  return (
    <Card
      title="Yield & ADR"
      subtitle={measured ? `ADR ${money2(adr)} · RevPAR ${money2(revpar)}` : "Nothing measured for this period"}
    >
      <div className="flex gap-3 rounded-xl border p-4" style={{ borderColor: `${tone}33`, background: `${tone}0f` }}>
        <Icon className="mt-0.5 h-4 w-4 shrink-0" style={{ color: tone }} />
        <div>
          <p className="text-sm font-medium" style={{ color: tone }}>
            {advice.headline}
            {measured ? ` — ${pct(advice.occupancy)} vs a ${pct(advice.target)} target` : ""}
          </p>
          <p className="mt-1 text-sm leading-relaxed text-slate-300">{advice.action}</p>
        </div>
      </div>
      <div className="mt-4 h-2 overflow-hidden rounded-full bg-white/5">
        <div
          className="h-full rounded-full transition-all duration-700"
          style={{
            width: `${measured ? Math.min(100, Math.max(0, advice.occupancy * 100)) : 0}%`,
            background: `linear-gradient(90deg,${C.purple},${tone})`,
          }}
        />
      </div>
      <p className="mt-2 text-xs text-slate-500">{advice.basis}</p>
    </Card>
  );
}