import React from "react";
import { Link } from "react-router-dom";
import { Settings2, TrendingUp, TrendingDown, ArrowRight } from "lucide-react";
import { ResponsiveContainer, LineChart, Line, Tooltip } from "recharts";
import Card from "@/components/ui-exec/Card";
import { usePricingForecast } from "@/lib/usePricing";
import { useRealtimeInvalidation } from "@/lib/realtime";
import { money2 } from "@/lib/hotel";

// Compact dynamic-pricing widget for the Executive Dashboard.
// Shows the enabled state, today's recommended ADR vs base, the revenue uplift
// the engine is projecting, and a 14-day recommended-rate trend so the owner
// sees the pricing posture at a glance. The full forecast, settings, and
// channel push live on the /pricing page.
export default function PricingPanel() {
  useRealtimeInvalidation(["rooms", "reservations", "weather"]);
  const { forecast, config, enabled } = usePricingForecast(14);

  const today = forecast[0] || null;
  const baseAdr = today
    ? Math.round(
        Object.values(today.types).reduce((s, t) => s + t.baseCents, 0) /
          Math.max(1, Object.values(today.types).filter((t) => t.baseCents > 0).length)
      )
    : 0;
  const recAdr = today ? today.adrCents : 0;
  const delta = recAdr - baseAdr;
  const occ = today ? today.occupancy : 0;

  // Owner KPI: projected revenue uplift vs keeping flat base rates over the
  // 7-day window. This is the dollar value the engine is fighting for.
  const periodSlices = forecast.slice(0, 7);
  const projectedRev = periodSlices.reduce((s, d) => s + d.projectedRevenueCents, 0);
  const baseRev = periodSlices.reduce((s, d) => {
    const b = Object.values(d.types).reduce((a, t) => a + t.baseCents, 0) / Math.max(1, Object.values(d.types).filter((t) => t.baseCents > 0).length);
    return s + Math.round(d.occupancy * Math.round(d.occupancy * 100)) * b;
  }, 0);
  const revUplift = projectedRev - baseRev;
  const chartData = forecast.map((d) => ({ day: String(d.date).slice(5), adr: d.adrCents }));

  return (
    <Card
      title="Dynamic Pricing"
      subtitle={enabled ? "Recommended rates from live demand signals" : "Pricing engine is disabled"}
      right={
        <Link to="/pricing" className="flex items-center gap-1.5 rounded-lg border border-white/10 px-2 py-1 text-xs text-slate-300 hover:bg-white/5">
          <Settings2 className="h-3.5 w-3.5" /> Configure
        </Link>
      }
    >
      {!enabled ? (
        <p className="text-sm text-slate-400">
          The pricing engine is off.{" "}
          <Link to="/pricing" className="text-[#00D4FF] underline">
            Enable it
          </Link>{" "}
          to auto-adjust rates from demand.
        </p>
      ) : today ? (
        <div>
          <div className="grid gap-3 sm:grid-cols-4">
            <div className="rounded-xl border border-white/5 bg-[#0A1628]/60 p-3">
              <p className="text-[10px] uppercase tracking-widest text-slate-500">Today&rsquo;s Rate</p>
              <p className="mt-1 font-heading text-2xl font-semibold text-white">{money2(recAdr)}</p>
              <div className="mt-0.5 flex items-center gap-1 text-xs">
                {delta >= 0 ? <TrendingUp className="h-3 w-3 text-[#00E096]" /> : <TrendingDown className="h-3 w-3 text-[#FF6B6B]" />}
                <span className={delta >= 0 ? "text-[#00E096]" : "text-[#FF6B6B]"}>{delta >= 0 ? "+" : ""}{money2(delta)} vs base</span>
              </div>
            </div>
            <div className="rounded-xl border border-white/5 bg-[#0A1628]/60 p-3">
              <p className="text-[10px] uppercase tracking-widest text-slate-500">Occupancy</p>
              <p className="mt-1 font-heading text-2xl font-semibold text-white">{Math.round(occ * 100)}%</p>
              <p className="text-xs text-slate-400">forecast for tonight</p>
            </div>
            <div className="rounded-xl border border-white/5 bg-[#0A1628]/60 p-3">
              <p className="text-[10px] uppercase tracking-widest text-slate-500">7-Day Revenue</p>
              <p className="mt-1 font-heading text-2xl font-semibold text-white">{money2(projectedRev)}</p>
              <p className={`mt-0.5 text-xs ${revUplift >= 0 ? "text-[#00E096]" : "text-[#FF6B6B]"}`}>{revUplift >= 0 ? "+" : ""}{money2(revUplift)} vs base rates</p>
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
