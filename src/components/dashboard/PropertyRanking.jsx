import React, { useState, useMemo } from "react";
import {
  Trophy, TrendingDown, TrendingUp, ChevronDown, ChevronUp,
  AlertCircle, CheckCircle2, AlertTriangle, Sparkles, BarChart2, X,
} from "lucide-react";
import Card from "@/components/ui-exec/Card";
import { money, money2, pct, perPropertyStats } from "@/lib/hotel";
import { sumCents, fromCents } from "@/lib/decimal";
import { decomposeRevenueVariance } from "@/lib/varianceDecomposition";

export default function PropertyRanking({ occRows, properties, compareOccRows }) {
  const [sortBy, setSortBy] = useState("revenue");
  const [selectedPropertyId, setSelectedPropertyId] = useState(null);

  const stats = useMemo(() => perPropertyStats(occRows, properties), [occRows, properties]);
  const compareStats = useMemo(() => {
    if (!compareOccRows || !compareOccRows.length) return [];
    return perPropertyStats(compareOccRows, properties);
  }, [compareOccRows, properties]);

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

  // Sort based on active criteria
  const sortedStats = [...stats].sort((a, b) => {
    const valA = Number(a[sortBy]) || 0;
    const valB = Number(b[sortBy]) || 0;
    return valB - valA;
  });

  const best = sortedStats[0];
  const worst = sortedStats[sortedStats.length - 1];

  const selectedCurrent = selectedPropertyId
    ? stats.find((s) => String(s.property_id) === String(selectedPropertyId))
    : null;

  const selectedPrior = selectedPropertyId && compareStats.length
    ? compareStats.find((s) => String(s.property_id) === String(selectedPropertyId))
    : null;

  const varianceResult = useMemo(() => {
    if (!selectedCurrent) return null;
    if (selectedPrior) {
      return decomposeRevenueVariance(
        {
          propertyId: selectedCurrent.property_id,
          propertyName: selectedCurrent.property_name,
          roomRevenue: selectedCurrent.revenue,
          roomsSold: selectedCurrent.roomsSold,
          adr: selectedCurrent.adr,
          capacity: selectedCurrent.capacity,
          occupancy: selectedCurrent.occupancy,
        },
        {
          propertyId: selectedPrior.property_id,
          propertyName: selectedPrior.property_name,
          roomRevenue: selectedPrior.revenue,
          roomsSold: selectedPrior.roomsSold,
          adr: selectedPrior.adr,
          capacity: selectedPrior.capacity,
          occupancy: selectedPrior.occupancy,
        }
      );
    }
    // Synthetic baseline against portfolio average if no prior period is loaded
    const portfolioAvgRate = portfolioAdr;
    const expectedRev = selectedCurrent.roomsSold * portfolioAvgRate;
    return {
      propertyId: selectedCurrent.property_id,
      propertyName: selectedCurrent.property_name,
      currentRevenue: selectedCurrent.revenue,
      priorRevenue: expectedRev,
      totalVariance: selectedCurrent.revenue - expectedRev,
      pctChange: expectedRev > 0 ? (selectedCurrent.revenue - expectedRev) / expectedRev : 0,
      volumeEffect: 0,
      rateEffect: selectedCurrent.revenue - expectedRev,
      isReconciled: true,
      drivers: [
        {
          key: 'rate',
          label: 'Rate Premium / Discount vs Portfolio ADR',
          amount: Math.round((selectedCurrent.revenue - expectedRev) * 100) / 100,
          description: `Achieving ${money2(selectedCurrent.adr)} vs portfolio average ${money2(portfolioAvgRate)} (${selectedCurrent.adr >= portfolioAvgRate ? '+' : ''}${money2(selectedCurrent.adr - portfolioAvgRate)}/room)`,
          isFavorable: selectedCurrent.adr >= portfolioAvgRate,
        },
      ],
      summary: selectedCurrent.adr >= portfolioAvgRate
        ? `${selectedCurrent.property_name} is pacing at a premium to portfolio ADR (+${money2(selectedCurrent.adr - portfolioAvgRate)}).`
        : `${selectedCurrent.property_name} is discounting below portfolio ADR (-${money2(portfolioAvgRate - selectedCurrent.adr)}).`,
    };
  }, [selectedCurrent, selectedPrior, portfolioAdr]);

  const getStatusBadge = (occ) => {
    if (occ >= 0.70) {
      return (
        <span className="inline-flex items-center gap-1 rounded-full border border-[#00E096]/30 bg-[#00E096]/10 px-2 py-0.5 text-[10px] font-medium text-[#00E096]">
          <CheckCircle2 className="h-3 w-3" /> On Target
        </span>
      );
    }
    if (occ >= 0.55) {
      return (
        <span className="inline-flex items-center gap-1 rounded-full border border-[#FFB547]/30 bg-[#FFB547]/10 px-2 py-0.5 text-[10px] font-medium text-[#FFB547]">
          <AlertTriangle className="h-3 w-3" /> Caution
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-[#FF6B6B]/30 bg-[#FF6B6B]/10 px-2 py-0.5 text-[10px] font-medium text-[#FF6B6B]">
        <AlertCircle className="h-3 w-3" /> Needs Attention
      </span>
    );
  };

  return (
    <Card
      title="Portfolio Breakdown & Rankings"
      subtitle="Weighted portfolio totals — property identity preserved"
    >
      {/* Sorting Controls */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-[11px] uppercase tracking-wider text-slate-400">Rank by:</span>
          <div className="flex rounded-lg border border-white/10 bg-[#0A1628] p-0.5 text-xs">
            {[
              ['revenue', 'Revenue'],
              ['occupancy', 'Occupancy'],
              ['adr', 'ADR'],
              ['revpar', 'RevPAR'],
            ].map(([k, label]) => (
              <button
                key={k}
                onClick={() => setSortBy(k)}
                className={`rounded-md px-2.5 py-1 font-medium transition-colors ${sortBy === k ? 'bg-[#6C63FF] text-white' : 'text-slate-400 hover:text-slate-200'}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <span className="text-xs text-slate-400">Click any property row to inspect variance drivers</span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10 text-left text-[10px] uppercase tracking-widest text-slate-500">
              <th className="pb-2 pr-4">Property</th>
              <th className="pb-2 pr-4 text-right">Revenue</th>
              <th className="pb-2 pr-4 text-right">Occupancy</th>
              <th className="pb-2 pr-4 text-right">ADR</th>
              <th className="pb-2 pr-4 text-right">RevPAR</th>
              <th className="pb-2 pr-4 text-center">Status</th>
              <th className="pb-2 text-right">Days</th>
            </tr>
          </thead>
          <tbody>
            {sortedStats.map((s, i) => {
              const isSelected = selectedPropertyId === s.property_id;
              return (
                <tr
                  key={s.property_id}
                  onClick={() => setSelectedPropertyId(isSelected ? null : s.property_id)}
                  className={`cursor-pointer border-b border-white/5 transition-colors hover:bg-white/[0.04] ${isSelected ? 'bg-[#6C63FF]/15' : i === 0 ? 'bg-[#00E096]/[0.04]' : i === sortedStats.length - 1 && sortedStats.length > 1 ? 'bg-[#FF6B6B]/[0.04]' : ''}`}
                >
                  <td className="py-3 pr-4">
                    <div className="flex items-center gap-2">
                      {i === 0 && <Trophy className="h-3.5 w-3.5 text-[#FFB547]" />}
                      {i === sortedStats.length - 1 && sortedStats.length > 1 && <TrendingDown className="h-3.5 w-3.5 text-[#FF6B6B]" />}
                      <span className="font-medium text-white">{s.property_name}</span>
                    </div>
                  </td>
                  <td className="py-3 pr-4 text-right tabular-nums text-slate-300">{money(s.revenue)}</td>
                  <td className="py-3 pr-4 text-right tabular-nums text-slate-300">{pct(s.occupancy)}</td>
                  <td className="py-3 pr-4 text-right tabular-nums text-slate-300">{money2(s.adr)}</td>
                  <td className="py-3 pr-4 text-right tabular-nums text-slate-300">{money2(s.revpar)}</td>
                  <td className="py-3 pr-4 text-center">{getStatusBadge(s.occupancy)}</td>
                  <td className="py-3 text-right tabular-nums text-slate-500">{s.days}</td>
                </tr>
              );
            })}
            <tr className="border-t-2 border-[#6C63FF]/30 bg-[#6C63FF]/[0.06] font-semibold">
              <td className="py-3 pr-4 text-white">Portfolio Total</td>
              <td className="py-3 pr-4 text-right tabular-nums text-white">{money(totalRev)}</td>
              <td className="py-3 pr-4 text-right tabular-nums text-white">{pct(portfolioOcc)}</td>
              <td className="py-3 pr-4 text-right tabular-nums text-white">{money2(portfolioAdr)}</td>
              <td className="py-3 pr-4 text-right tabular-nums text-white">{money2(portfolioRevpar)}</td>
              <td className="py-3 pr-4 text-center">{getStatusBadge(portfolioOcc)}</td>
              <td className="py-3 text-right tabular-nums text-slate-400">{stats.reduce((a, s) => a + s.days, 0)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Variance Decomposition Card (Shown on row click) */}
      {selectedPropertyId && varianceResult && (
        <div className="mt-5 rounded-2xl border border-[#6C63FF]/30 bg-[#0A1628]/90 p-5 shadow-lg backdrop-blur-sm">
          <div className="flex items-center justify-between border-b border-white/10 pb-3">
            <div className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-[#6C63FF]" />
              <h3 className="font-heading text-base font-semibold text-white">
                Variance Diagnosis: {varianceResult.propertyName}
              </h3>
            </div>
            <button
              onClick={() => setSelectedPropertyId(null)}
              className="rounded-lg p-1 text-slate-400 hover:bg-white/10 hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <p className="mt-3 text-sm text-slate-300">{varianceResult.summary}</p>

          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {varianceResult.drivers.map((d) => (
              <div
                key={d.key}
                className="rounded-xl border border-white/5 bg-white/[0.02] p-3 transition-colors"
              >
                <div className="flex items-center justify-between">
                  <span className="text-[11px] uppercase tracking-wider text-slate-400">{d.label}</span>
                  <span className={`text-xs font-semibold ${d.isFavorable ? 'text-[#00E096]' : 'text-[#FF6B6B]'}`}>
                    {d.amount >= 0 ? `+${money(d.amount)}` : `-${money(Math.abs(d.amount))}`}
                  </span>
                </div>
                <p className="mt-1 text-xs text-slate-300">{d.description}</p>
              </div>
            ))}
          </div>
        </div>
      )}

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