import React from "react";
import { Trophy, TrendingDown } from "lucide-react";
import Card from "@/components/ui-exec/Card";
import { money, money2, pct, perPropertyStats } from "@/lib/hotel";
import { sumCents, fromCents } from "@/lib/decimal";

export default function PropertyRanking({ occRows, properties }) {
  const stats = perPropertyStats(occRows, properties);
  if (!stats.length) return null;

  // Portfolio revenue is owner-facing money and must reconcile to the cent with
  // the per-property figures it sums. A float `reduce((a, s) => a + s.revenue)`
  // over the cent-exact per-property revenues re-introduces binary residue, so
  // sum in integer cents and convert back once.
  const totalRev = fromCents(sumCents(stats.map((s) => s.revenue)));
  const totalRoomsSold = stats.reduce((a, s) => a + s.roomsSold, 0);
  const totalCapacity = stats.reduce((a, s) => a + s.capacity, 0);
  const portfolioOcc = totalCapacity ? totalRoomsSold / totalCapacity : 0;
  const portfolioAdr = totalRoomsSold ? totalRev / totalRoomsSold : 0;
  const portfolioRevpar = totalCapacity ? totalRev / totalCapacity : 0;

  const best = stats[0];
  const worst = stats[stats.length - 1];

  return (
    <Card
      title="Portfolio breakdown & rankings"
      subtitle="Weighted portfolio totals — property identity preserved"
    >
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10 text-left text-[10px] uppercase tracking-widest text-slate-500">
              <th className="pb-2 pr-4">Property</th>
              <th className="pb-2 pr-4 text-right">Revenue</th>
              <th className="pb-2 pr-4 text-right">Occupancy</th>
              <th className="pb-2 pr-4 text-right">ADR</th>
              <th className="pb-2 pr-4 text-right">RevPAR</th>
              <th className="pb-2 text-right">Days</th>
            </tr>
          </thead>
          <tbody>
            {stats.map((s, i) => (
              <tr
                key={s.property_id}
                className={`border-b border-white/5 ${i === 0 ? "bg-[#00E096]/[0.04]" : i === stats.length - 1 && stats.length > 1 ? "bg-[#FF6B6B]/[0.04]" : ""}`}
              >
                <td className="py-3 pr-4">
                  <div className="flex items-center gap-2">
                    {i === 0 && <Trophy className="h-3.5 w-3.5 text-[#FFB547]" />}
                    {i === stats.length - 1 && stats.length > 1 && <TrendingDown className="h-3.5 w-3.5 text-[#FF6B6B]" />}
                    <span className="text-white">{s.property_name}</span>
                  </div>
                </td>
                <td className="py-3 pr-4 text-right tabular-nums text-slate-300">{money(s.revenue)}</td>
                <td className="py-3 pr-4 text-right tabular-nums text-slate-300">{pct(s.occupancy)}</td>
                <td className="py-3 pr-4 text-right tabular-nums text-slate-300">{money2(s.adr)}</td>
                <td className="py-3 pr-4 text-right tabular-nums text-slate-300">{money2(s.revpar)}</td>
                <td className="py-3 text-right tabular-nums text-slate-500">{s.days}</td>
              </tr>
            ))}
            <tr className="border-t-2 border-[#6C63FF]/30 bg-[#6C63FF]/[0.06] font-semibold">
              <td className="py-3 pr-4 text-white">Portfolio Total</td>
              <td className="py-3 pr-4 text-right tabular-nums text-white">{money(totalRev)}</td>
              <td className="py-3 pr-4 text-right tabular-nums text-white">{pct(portfolioOcc)}</td>
              <td className="py-3 pr-4 text-right tabular-nums text-white">{money2(portfolioAdr)}</td>
              <td className="py-3 pr-4 text-right tabular-nums text-white">{money2(portfolioRevpar)}</td>
              <td className="py-3 text-right tabular-nums text-slate-400">{stats.reduce((a, s) => a + s.days, 0)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      {stats.length > 1 && (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-[#FFB547]/20 bg-[#FFB547]/[0.06] p-3">
            <p className="text-[10px] uppercase tracking-widest text-[#FFB547]">Best performer</p>
            <p className="mt-1 text-sm text-white">{best.property_name}</p>
            <p className="text-xs text-slate-400">{money(best.revenue)} · {pct(best.occupancy)} occupancy</p>
          </div>
          <div className="rounded-xl border border-[#FF6B6B]/20 bg-[#FF6B6B]/[0.06] p-3">
            <p className="text-[10px] uppercase tracking-widest text-[#FF6B6B]">Needs attention</p>
            <p className="mt-1 text-sm text-white">{worst.property_name}</p>
            <p className="text-xs text-slate-400">{money(worst.revenue)} · {pct(worst.occupancy)} occupancy</p>
          </div>
        </div>
      )}
    </Card>
  );
}