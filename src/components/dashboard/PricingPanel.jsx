import React from "react";
import { Link } from "react-router-dom";
import { Settings2, TrendingUp, TrendingDown, ArrowRight } from "lucide-react";
import { ResponsiveContainer, LineChart, Line, Tooltip } from "recharts";
import Card from "@/components/ui-exec/Card";
import { usePricingForecast } from "@/lib/usePricing";
import { useRealtimeInvalidation } from "@/lib/realtime";
import { ErrorState } from "@/components/ui/status";
import { money2 } from "@/lib/hotel";
import { fromCents } from "@/lib/decimal";
import { PricingScenarioNotice } from "@/components/OwnerTrustNotices";

// Compact dynamic-pricing widget for the Executive Dashboard.
// Shows the enabled state, the dated scenario ADR vs base, the revenue uplift
// the engine is projecting, and a 14-day recommended-rate trend so the owner
// sees the pricing posture at a glance. The full forecast, settings, and
// local scenario controls live on the /pricing page. No OTA publishing exists.
export default function PricingPanel() {
  useRealtimeInvalidation(["rooms", "reservations", "weather"]);
  const { forecast, config, enabled, isLoading, isError, error, refetch } = usePricingForecast(14);

  const today = forecast[0] || null;
  const baseAdrCents = today
    ? Math.round(
        Object.values(today.types).reduce((s, t) => s + t.baseCents, 0) /
          Math.max(1, Object.values(today.types).filter((t) => t.baseCents > 0).length)
      )
    : 0;
  // Every figure this panel derives is integer cents, because that is all the
  // pricing engine emits. The names carry the unit so the guard in
  // scripts/probe-cents-unit-mismatch.mjs can see them: these were `recAdr`,
  // `delta`, `projectedRev` and `revUplift`, handed straight to money2(), which
  // takes DOLLARS — so a $149.00 recommended rate was advertised on the owner's
  // dashboard as "$14,900.00".
  const recAdrCents = today ? today.adrCents : 0;
  const deltaCents = recAdrCents - baseAdrCents;
  const occ = today ? today.occupancy : 0;

  // Owner KPI: projected revenue uplift vs keeping flat base rates over the
  // 7-day window. This is the dollar value the engine is fighting for.
  const periodSlices = forecast.slice(0, 7);
  const projectedRevCents = periodSlices.reduce((s, d) => s + d.projectedRevenueCents, 0);
  // The base leg comes from buildPricingForecast so that both legs value the SAME
  // room nights. It used to be rebuilt here as
  //   Math.round(d.occupancy * Math.round(d.occupancy * 100)) * meanBaseCents
  // which squares occupancy against a hardcoded 100 rooms — this panel has no room
  // register to read. Measured at 85% occupancy against a 20-room register
  // (probe-cents-unit-mismatch.mjs section 7) that formula valued 72 room nights
  // where 17 were sold, so the "vs base rates" figure below was arithmetic on a
  // hotel that does not exist.
  const baseRevCents = periodSlices.reduce((s, d) => s + (d.projectedBaseRevenueCents || 0), 0);
  const revUpliftCents = projectedRevCents - baseRevCents;
  // Charted in dollars, so the tooltip formats the same unit the axis plots.
  const chartData = forecast.map((d) => ({ day: String(d.date).slice(5), adr: fromCents(d.adrCents) }));

  return (
    <Card
      title="Pricing Scenario"
      subtitle={enabled ? "Local model — not live market rates" : "Pricing scenario is disabled"}
      right={
        <Link to="/pricing" className="flex items-center gap-1.5 rounded-lg border border-white/10 px-2 py-1 text-xs text-slate-300 hover:bg-white/5">
          <Settings2 className="h-3.5 w-3.5" /> Configure
        </Link>
      }
    >
      <PricingScenarioNotice startDate={isLoading ? '' : today?.date} />
      {!enabled ? (
        <p className="text-sm text-slate-400">
          The pricing engine is off.{" "}
          <Link to="/pricing" className="text-[#00D4FF] underline">
            Enable it
          </Link>{" "}
          to explore a local what-if scenario. This does not change live rates.
        </p>
      ) : isError ? (
        // Checked before `today`, because a failed read still yields a forecast:
        // buildPricingForecast() answers empty inputs with base rates and the
        // default occupancy assumption, so this panel used to print a confident
        // "Today's Rate" and a 7-day revenue uplift computed from no reservations.
        <ErrorState
          title="Could not load the demand signals"
          description="Rates, occupancy and the projected uplift are all computed from the room register, the reservation book and cached weather, and at least one of those reads failed. The numbers this panel would show are the engine's defaults, not your demand."
          error={error}
          onRetry={refetch}
        />
      ) : isLoading ? (
        <p role="status" className="mt-3 text-sm text-slate-300">Loading local scenario inputs…</p>
      ) : today ? (
        <div>
          <div className="grid gap-3 sm:grid-cols-4">
            <div className="rounded-xl border border-white/5 bg-[#0A1628]/60 p-3">
              <p className="text-[10px] uppercase tracking-widest text-slate-400">Scenario Rate · {today.date}</p>
              <p className="mt-1 font-heading text-2xl font-semibold text-white">{money2(fromCents(recAdrCents))}</p>
              <div className="mt-0.5 flex items-center gap-1 text-xs">
                {deltaCents >= 0 ? <TrendingUp className="h-3 w-3 text-[#00E096]" /> : <TrendingDown className="h-3 w-3 text-[#FF6B6B]" />}
                <span className={deltaCents >= 0 ? "text-[#00E096]" : "text-[#FF6B6B]"}>{deltaCents >= 0 ? "+" : ""}{money2(fromCents(deltaCents))} vs base</span>
              </div>
            </div>
            <div className="rounded-xl border border-white/5 bg-[#0A1628]/60 p-3">
              <p className="text-[10px] uppercase tracking-widest text-slate-500">Occupancy</p>
              <p className="mt-1 font-heading text-2xl font-semibold text-white">{Math.round(occ * 100)}%</p>
              <p className="text-xs text-slate-400">model for {today.date}</p>
            </div>
            <div className="rounded-xl border border-white/5 bg-[#0A1628]/60 p-3">
              <p className="text-[10px] uppercase tracking-widest text-slate-500">7-Day Revenue</p>
              <p className="mt-1 font-heading text-2xl font-semibold text-white">{money2(fromCents(projectedRevCents))}</p>
              <p className={`mt-0.5 text-xs ${revUpliftCents >= 0 ? "text-[#00E096]" : "text-[#FF6B6B]"}`}>{revUpliftCents >= 0 ? "+" : ""}{money2(fromCents(revUpliftCents))} vs base rates</p>
            </div>
            <div className="rounded-xl border border-white/5 bg-[#0A1628]/60 p-3">
              <p className="text-[10px] uppercase tracking-widest text-slate-500">Sensitivity</p>
              <p className="mt-1 font-heading text-2xl font-semibold text-white">{Math.round((config.demandSensitivity || 0) * 100)}%</p>
              <p className="text-xs text-slate-400">demand response</p>
            </div>
          </div>

          {chartData.length > 1 && (
            <div className="mt-4">
              <div className="mb-1 flex items-center justify-between">
                <p className="text-xs text-slate-400">14-day recommended ADR trend</p>
                <Link to="/pricing" className="flex items-center gap-1 text-xs text-[#00D4FF] hover:underline">
                  Open full forecast <ArrowRight className="h-3 w-3" />
                </Link>
              </div>
              <ResponsiveContainer width="100%" height={150}>
                <LineChart data={chartData}>
                  <Line type="monotone" dataKey="adr" stroke="#6C63FF" strokeWidth={2} dot={false} />
                  <Tooltip contentStyle={{ background: "#0F1F35", border: "1px solid #ffffff22", borderRadius: 8 }} formatter={(v) => [money2(v), "ADR"]} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      ) : (
        <p className="text-sm text-slate-400">No room register yet. Build one on the Room Board to see recommendations.</p>
      )}
    </Card>
  );
}
