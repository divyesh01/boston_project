import React, { useMemo } from "react";
import Card from "@/components/ui-exec/Card";
import { money, pct, C } from "@/lib/hotel";
import { CalculationService } from "@/lib/calculationService";
import { sumCents, fromCents } from "@/lib/decimal";
import { Lightbulb, ArrowRight, TrendingUp } from "lucide-react";
import { useSettingsVersion } from "@/hooks/useSettingsVersion";
import { calculateOtaDependence, calculateDirectShiftOpportunity, CHANNEL_GROUPS } from "@/lib/channelDictionary";

export default function OtaMatrix({ rows, onOpenSimulator }) {
  useSettingsVersion();

  // Cent-exact channel engine (integer cents via toCents/multiply) — the same
  // source OtaChannels and Money Kept read, so the subtitle totals reconcile to
  // the cent instead of re-summing net_revenue and applying commission in float.
  const channels = CalculationService.calculateChannelMetrics(rows);

  const totalGross = fromCents(sumCents(channels.map((c) => c.gross)));
  const totalCommission = fromCents(sumCents(channels.map((c) => c.commission)));
  const totalPaymentFee = fromCents(sumCents(channels.map((c) => c.paymentFee || 0)));
  const totalNet = fromCents(sumCents(channels.map((c) => c.net)));
  const totalNetContribution = fromCents(sumCents(channels.map((c) => c.netContribution ?? c.net)));

  // OTA Dependence Score
  const otaGross = fromCents(sumCents(channels.filter((c) => c.isOta).map((c) => c.gross)));
  const otaDependence = useMemo(
    () => calculateOtaDependence(otaGross, totalGross),
    [otaGross, totalGross]
  );

  // Direct Shift Opportunity (10% shift model)
  const shiftOpportunity = useMemo(
    () => calculateDirectShiftOpportunity(channels, 0.10),
    [channels]
  );

  const bestDirect = channels.filter((c) => c.isDirect || c.rate === 0).sort((a, b) => b.gross - a.gross)[0] || null;
  const worstOta = channels.filter((c) => c.isOta || c.rate > 0).sort((a, b) => b.commission - a.commission)[0] || null;

  const getGroupBadgeClass = (group) => {
    switch (group) {
      case CHANNEL_GROUPS.OTA:
        return 'border-[#6C63FF]/30 bg-[#6C63FF]/15 text-[#A39BFF]';
      case CHANNEL_GROUPS.DIRECT:
        return 'border-[#00E096]/30 bg-[#00E096]/15 text-[#00E096]';
      case CHANNEL_GROUPS.CORPORATE:
        return 'border-[#00D4FF]/30 bg-[#00D4FF]/15 text-[#00D4FF]';
      case CHANNEL_GROUPS.GDS:
        return 'border-[#FFB547]/30 bg-[#FFB547]/15 text-[#FFB547]';
      default:
        return 'border-slate-600/30 bg-slate-700/20 text-slate-400';
    }
  };

  return (
    <Card
      title="Owner Channel Net Profitability Matrix"
      subtitle={`Gross ${money(totalGross)} · Commission leakage ${money(totalCommission)} · Owner Kept ${money(totalNetContribution)}`}
    >
      {/* Top Owner KPI Strip */}
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-xl border border-white/5 bg-white/[0.02] p-3">
          <p className="text-[10px] uppercase tracking-wider text-slate-400">Total Gross</p>
          <p className="mt-1 text-base font-semibold text-white">{money(totalGross)}</p>
        </div>
        <div className="rounded-xl border border-white/5 bg-white/[0.02] p-3">
          <p className="text-[10px] uppercase tracking-wider text-[#FF6B6B]">Commission Leakage</p>
          <p className="mt-1 text-base font-semibold text-[#FF6B6B]">-{money(totalCommission)}</p>
        </div>
        <div className="rounded-xl border border-white/5 bg-white/[0.02] p-3">
          <p className="text-[10px] uppercase tracking-wider text-[#00E096]">Owner Net Kept</p>
          <p className="mt-1 text-base font-semibold text-[#00E096]">{money(totalNetContribution)}</p>
        </div>
        <div className="rounded-xl border border-white/5 bg-white/[0.02] p-3">
          <p className="text-[10px] uppercase tracking-wider text-slate-400">OTA Dependence</p>
          <div className="mt-1 flex items-center gap-2">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: otaDependence.color }}
            />
            <span className="text-sm font-semibold text-white">
              {otaDependence.percentage}% ({otaDependence.level})
            </span>
          </div>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-widest text-slate-500">
              <th className="pb-3 pr-4">#</th>
              <th className="pb-3 pr-4">Channel</th>
              <th className="pb-3 pr-4">Group</th>
              <th className="pb-3 pr-4 text-right">Rooms</th>
              <th className="pb-3 pr-4 text-right">Gross</th>
              <th className="pb-3 pr-4 text-right">Comm.</th>
              <th className="pb-3 pr-4 text-right">Commission $</th>
              <th className="pb-3 pr-4 text-right">Card Fee $</th>
              <th className="pb-3 pr-4 text-right">Owner Net</th>
              <th className="pb-3 text-right">Margin</th>
            </tr>
          </thead>
          <tbody>
            {channels.map((c, i) => (
              <tr key={c.source} className="border-t border-white/5 transition-colors hover:bg-white/[0.03]">
                <td className="py-2.5 pr-4 text-slate-500">{i + 1}</td>
                <td className="py-2.5 pr-4">
                  <div className="flex flex-col">
                    <span className="font-medium text-slate-200">{c.normalized || c.source}</span>
                    {c.normalized && c.normalized !== c.source && (
                      <span className="text-[10px] text-slate-500">{c.source}</span>
                    )}
                  </div>
                </td>
                <td className="py-2.5 pr-4">
                  <span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${getGroupBadgeClass(c.group)}`}>
                    {c.group || 'Other'}
                  </span>
                </td>
                <td className="py-2.5 pr-4 text-right tabular-nums text-slate-400">{c.stays}</td>
                <td className="py-2.5 pr-4 text-right tabular-nums">{money(c.gross)}</td>
                <td className="py-2.5 pr-4 text-right tabular-nums text-slate-400">{pct(c.rate, 0)}</td>
                <td className="py-2.5 pr-4 text-right tabular-nums" style={{ color: c.commission > 0 ? C.coral : "#64748b" }}>
                  {c.commission > 0 ? `-${money(c.commission)}` : "—"}
                </td>
                <td className="py-2.5 pr-4 text-right tabular-nums text-slate-400">
                  {c.paymentFee > 0 ? `-${money(c.paymentFee)}` : "—"}
                </td>
                <td className="py-2.5 pr-4 text-right font-medium tabular-nums text-white">
                  {money(c.netContribution ?? c.net)}
                </td>
                <td className="py-2.5 text-right tabular-nums font-semibold" style={{ color: (c.contributionMargin ?? c.margin) >= 0.85 ? C.green : C.amber }}>
                  {pct(c.contributionMargin ?? c.margin)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Direct Shift Opportunity Callout Banner */}
      {shiftOpportunity.potentialSavings > 0 && (
        <div className="mt-5 flex flex-col gap-2 rounded-xl border border-[#00E096]/20 bg-[#00E096]/[0.05] p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="rounded-lg bg-[#00E096]/15 p-2 text-[#00E096]">
              <TrendingUp className="h-4 w-4" />
            </div>
            <div>
              <p className="text-sm font-semibold text-white">Direct Shift Opportunity</p>
              <p className="text-xs text-slate-300">
                Shifting 10% of high-commission OTA volume ({shiftOpportunity.roomsShifted} rooms) to Direct Website or Walk-in saves{' '}
                <span className="font-semibold text-[#00E096]">+{money(shiftOpportunity.potentialSavings)}</span> in commission.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-right">
              <span className="text-[10px] uppercase tracking-wider text-slate-400">Potential Gain</span>
              <p className="text-base font-bold text-[#00E096]">+{money(shiftOpportunity.potentialSavings)}</p>
            </div>
            <button
              type="button"
              onClick={onOpenSimulator || (() => document.getElementById("ota-shift-section")?.scrollIntoView({ behavior: "smooth" }))}
              className="flex items-center gap-1.5 rounded-lg border border-[#00E096]/30 bg-[#00E096]/15 px-3 py-1.5 text-xs font-semibold text-[#00E096] hover:bg-[#00E096]/25 transition-all active:scale-[0.98]"
            >
              Simulate <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      {bestDirect && worstOta && (
        <div className="mt-3 flex gap-3 rounded-xl border border-[#FFB547]/20 bg-[#FFB547]/[0.06] p-4">
          <Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-[#FFB547]" />
          <p className="text-sm leading-relaxed text-slate-300">
            <span className="text-white">{bestDirect.normalized || bestDirect.source}</span> brought {money(bestDirect.gross)} at 0% commission, while{" "}
            <span className="text-white">{worstOta.normalized || worstOta.source}</span> cost you {money(worstOta.commission)} in commission. Negotiate{" "}
            {worstOta.normalized || worstOta.source} down by 2% (≈{money(worstOta.gross * 0.02)} saved) or push more direct bookings and walk-ins.
          </p>
        </div>
      )}
    </Card>
  );
}