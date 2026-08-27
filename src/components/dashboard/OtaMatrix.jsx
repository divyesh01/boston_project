import React from "react";
import Card from "@/components/ui-exec/Card";
import { money, pct, C } from "@/lib/hotel";
import { CalculationService } from "@/lib/calculationService";
import { sumCents, fromCents } from "@/lib/decimal";
import { Lightbulb } from "lucide-react";
import { useSettingsVersion } from "@/hooks/useSettingsVersion";

export default function OtaMatrix({ rows }) {
  useSettingsVersion();
  // Cent-exact channel engine (integer cents via toCents/multiply) — the same
  // source OtaChannels and Money Kept read, so the subtitle totals reconcile to
  // the cent instead of re-summing net_revenue and applying commission in float.
  const channels = CalculationService.calculateChannelMetrics(rows);

  const totalGross = fromCents(sumCents(channels.map((c) => c.gross)));
  const totalCommission = fromCents(sumCents(channels.map((c) => c.commission)));
  const totalNet = fromCents(sumCents(channels.map((c) => c.net)));
  const bestDirect = channels.filter((c) => c.rate === 0).sort((a, b) => b.gross - a.gross)[0] || null;
  const worstOta = channels.filter((c) => c.rate > 0).sort((a, b) => b.commission - a.commission)[0] || null;

  return (
    <Card
      title="OTA Channel Net Profitability Matrix"
      subtitle={`Gross ${money(totalGross)} · Commission leakage ${money(totalCommission)} · Net ${money(totalNet)}`}
    >
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-widest text-slate-500">
              <th className="pb-3 pr-4">#</th>
              <th className="pb-3 pr-4">Channel</th>
              <th className="pb-3 pr-4 text-right">Rooms</th>
              <th className="pb-3 pr-4 text-right">Gross</th>
              <th className="pb-3 pr-4 text-right">Comm.</th>
              <th className="pb-3 pr-4 text-right">Commission $</th>
              <th className="pb-3 pr-4 text-right">Net</th>
              <th className="pb-3 text-right">Margin</th>
            </tr>
          </thead>
          <tbody>
            {channels.map((c, i) => (
              <tr key={c.source} className="border-t border-white/5 transition-colors hover:bg-white/[0.03]">
                <td className="py-2.5 pr-4 text-slate-500">{i + 1}</td>
                <td className="py-2.5 pr-4 text-slate-200">{c.source}</td>
                <td className="py-2.5 pr-4 text-right tabular-nums text-slate-400">{c.stays}</td>
                <td className="py-2.5 pr-4 text-right tabular-nums">{money(c.gross)}</td>
                <td className="py-2.5 pr-4 text-right tabular-nums text-slate-400">{pct(c.rate, 0)}</td>
                <td className="py-2.5 pr-4 text-right tabular-nums" style={{ color: c.commission > 0 ? C.coral : "#64748b" }}>
                  {c.commission > 0 ? `-${money(c.commission)}` : "—"}
                </td>
                <td className="py-2.5 pr-4 text-right font-medium tabular-nums text-white">{money(c.net)}</td>
                <td className="py-2.5 text-right tabular-nums" style={{ color: c.margin >= 0.9 ? C.green : C.amber }}>
                  {pct(c.margin)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {bestDirect && worstOta && (
        <div className="mt-5 flex gap-3 rounded-xl border border-[#FFB547]/20 bg-[#FFB547]/[0.06] p-4">
          <Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-[#FFB547]" />
          <p className="text-sm leading-relaxed text-slate-300">
            <span className="text-white">{bestDirect.source}</span> brought {money(bestDirect.gross)} at 0% commission, while{" "}
            <span className="text-white">{worstOta.source}</span> cost you {money(worstOta.commission)} in commission. Negotiate{" "}
            {worstOta.source} down by 2% (≈{money(worstOta.gross * 0.02)} saved) or push more direct bookings and walk-ins.
          </p>
        </div>
      )}
    </Card>
  );
}