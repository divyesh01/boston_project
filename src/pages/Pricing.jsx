import React, { useMemo, useState } from "react";
import { Settings2, RefreshCw, ArrowUpRight, CheckCircle, AlertTriangle, ChevronDown, ChevronUp } from "lucide-react";
import Card from "@/components/ui-exec/Card";
import { useGlobalFilters } from "@/lib/useGlobalFilters";
import { useRooms } from "@/lib/useHotelData";
import { db } from "@/api/base44Client";
import { usePricingForecast } from "@/lib/usePricing";
import { getPricingConfig, savePricingConfig, DEFAULT_PRICING_CONFIG, ROOM_TYPES } from "@/lib/pricingSettings";
import { money2 } from "@/lib/hotel";
import { useRealtimeInvalidation } from "@/lib/realtime";
import { applyDynamicRateOverride } from "@/lib/pricingOverride";
import { ErrorState } from "@/components/ui/status";

const toDollars = (cents) => Math.round((Number(cents) || 0) / 100);
const toCentsFromDollars = (d) => Math.round((Number(d) || 0) * 100);

const PRESETS = {
  Conservative: { minMultiplier: 0.85, maxMultiplier: 1.3, demandSensitivity: 0.35, competitorWeight: 0.4 },
  Balanced: { minMultiplier: 0.75, maxMultiplier: 1.6, demandSensitivity: 0.5, competitorWeight: 0.3 },
  Aggressive: { minMultiplier: 0.65, maxMultiplier: 2.0, demandSensitivity: 0.7, competitorWeight: 0.15 },
};

export default function Pricing() {
  const { property, properties } = useGlobalFilters();
  const roomsQ = useRooms(property);
  const { data: rooms = [] } = roomsQ;
  useRealtimeInvalidation(["rooms", "reservations", "weather"]);

  const isPortfolio = property === "all" || Array.isArray(property);
  const singlePropertyId = !isPortfolio ? property : null;
  const propName = isPortfolio
    ? (Array.isArray(property) ? `${property.length} Properties` : "Portfolio")
    : (properties.find((p) => p.id === property)?.name || "Property");

  const [cfg, setCfg] = useState(() => getPricingConfig());
  const [expanded, setExpanded] = useState(false);
  const [notice, setNotice] = useState(null);
  const [pushing, setPushing] = useState(false);
  const [horizon, setHorizon] = useState(14);

  const { forecast, enabled, isError: forecastError, error: forecastErr, refetch: refetchForecast } = usePricingForecast(horizon);

  const update = (patch) => { const next = { ...cfg, ...patch }; setCfg(next); savePricingConfig(next); };
  const applyPreset = (name) => { update(PRESETS[name]); setNotice({ type: "ok", text: `Applied ${name} pricing profile.` }); };
  const updateBaseRate = (type, dollars) => update({ baseRates: { ...cfg.baseRates, [type]: toCentsFromDollars(dollars) } });

  const today = forecast[0];
  const avgBaseCents = today
    ? Math.round(Object.values(today.types).reduce((s, t) => s + t.baseCents, 0) / Math.max(1, Object.values(today.types).filter((t) => t.baseCents > 0).length))
    : 0;
  const avgRecCents = today
    ? Math.round(Object.values(today.types).reduce((s, t) => s + t.recommendedCents, 0) / Math.max(1, Object.values(today.types).filter((t) => t.baseCents > 0).length))
    : 0;
  const occ = today ? today.occupancy : 0;

  const projectedPeriodRev = forecast.reduce((s, d) => s + d.projectedRevenueCents, 0);
  const basePeriodRev = useMemo(
    () => forecast.reduce((s, d) => {
      const baseAdr = Object.values(d.types).reduce((a, t) => a + t.baseCents, 0) / Math.max(1, Object.values(d.types).filter((t) => t.baseCents > 0).length);
      return s + Math.round(d.occupancy * (rooms.length || 0)) * baseAdr;
    }, 0),
    [forecast, rooms.length]
  );
  const upliftCents = projectedPeriodRev - basePeriodRev;
  const upliftPct = basePeriodRev > 0 ? Math.round((upliftCents / basePeriodRev) * 1000) / 10 : 0;

  const reason = today
    ? occ > 0.8
      ? `Occupancy forecast ${Math.round(occ * 100)}% tonight — demand is strong, so the engine raises rates toward the competitive set.`
      : occ > 0.6
      ? `Moderate demand (${Math.round(occ * 100)}% occupancy forecast) — rates hold at a modest premium on weekends.`
      : `Light demand (${Math.round(occ * 100)}% occupancy forecast) — prices ease within the floor to protect fill.`
    : "No room register yet to size demand.";

  const handlePush = async () => {
    if (isPortfolio) { setNotice({ type: "error", text: "Select a specific property to push rates." }); return; }
    if (!today) return;
    setPushing(true); setNotice(null);
    try {
      const rateMap = {};
      for (const type of ROOM_TYPES) {
        if (today.types && today.types[type]) rateMap[type] = money2(today.types[type].recommendedCents);
      }
      await db.integrations.ChannelManager.PushInventory(singlePropertyId, rateMap);
      // Audit each applied rate override (best-effort — never blocks the push).
      for (const type of ROOM_TYPES) {
        const rec = today.types?.[type]?.recommendedCents;
        if (rec) {
          try {
            await applyDynamicRateOverride({
              propertyId: singlePropertyId,
              newRate: toDollars(rec),
              roomType: type,
              justification: `Yield push to ${propName}`,
              user: null,
            });
          } catch { /* audit trail is non-critical */ }
        }
      }
      setNotice({ type: "ok", text: `Pushed recommended rates for ${propName} to connected channels.` });
    } catch (e) {
      setNotice({ type: "error", text: `Push failed: ${e.message}` });
    } finally {
      setPushing(false);
    }
  };

  const Input = ({ label, hint = "", children }) => (
    <label className="flex flex-col gap-1 text-xs text-slate-400">
      <span className="flex items-center justify-between">{label}{hint && <span className="text-[10px] normal-case tracking-normal text-slate-500">{hint}</span>}</span>
      {children}
    </label>
  );

  return (
    <div className="space-y-6">
      <header>
        <p className="text-[11px] uppercase tracking-[0.3em] text-[#6C63FF]">Revenue</p>
        <h1 className="mt-2 font-heading text-3xl font-semibold text-white">Dynamic Pricing</h1>
        <p className="mt-1 text-sm text-slate-400">Auto-adjust nightly rates from demand, seasonality, weather, and the competitive set · {propName}</p>
      </header>

      {/* Without this, a failed room read still printed a full rate card — the page said
          "No room register yet to size demand", which reads as an empty hotel rather
          than a failed read. The forecast hook is checked as well: it reads the
          reservation book and the weather snapshots too, and either of those failing
          also produces a complete-looking rate card built on nothing. */}
      {(roomsQ.isError || forecastError) && (
        <ErrorState
          title="Could not load the demand signals"
          description="The engine sizes demand from your room register, your reservation book and cached weather, and at least one of those reads failed. Any recommended rate, occupancy forecast, or revenue opportunity shown below was computed without that data — do not push these rates to your channels."
          error={roomsQ.error || forecastErr}
          onRetry={() => { roomsQ.refetch(); refetchForecast(); }}
        />
      )}

      {notice && (
        <div className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs ${notice.type === "ok" ? "border-[#00E096]/30 bg-[#00E096]/10 text-[#00E096]" : "border-[#FF6B6B]/30 bg-[#FF6B6B]/10 text-[#FF6B6B]"}`}>
          {notice.type === "ok" ? <CheckCircle className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />} {notice.text}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-2xl border border-white/5 bg-[#0F1F35]/80 p-4">
          <p className="text-[11px] uppercase tracking-widest text-slate-400">Engine Status</p>
          <p className="mt-2 font-heading text-2xl font-semibold text-white">{enabled ? "Auto" : "Manual"}</p>
          <p className="text-xs text-slate-500">{enabled ? "Rates auto-adjust daily" : "Rates are at base (rack)"}</p>
        </div>
        {today && (
          <>
            <div className="rounded-2xl border border-white/5 bg-[#0A1628]/60 p-4">
              <p className="text-[11px] uppercase tracking-widest text-slate-500">Tonight's Recommended Rate</p>
              <p className="mt-2 font-heading text-2xl font-semibold text-white">{money2(avgRecCents)}</p>
              <p className={`mt-0.5 text-xs ${avgRecCents >= avgBaseCents ? "text-[#00E096]" : "text-[#FF6B6B]"}`}>
                {avgRecCents >= avgBaseCents ? "+" : ""}{money2(avgRecCents - avgBaseCents)} vs base {money2(avgBaseCents)}
              </p>
            </div>
            <div className="rounded-2xl border border-white/5 bg-[#0A1628]/60 p-4">
              <p className="text-[11px] uppercase tracking-widest text-slate-500">Occupancy Forecast</p>
              <p className="mt-2 font-heading text-2xl font-semibold text-white">{Math.round(occ * 100)}%</p>
              <p className="text-xs text-slate-500">{rooms.length} rooms on the register</p>
            </div>
            <div className="rounded-2xl border border-white/5 bg-[#0A1628]/60 p-4">
              <p className="text-[11px] uppercase tracking-widest text-slate-500">{`${horizon}d Revenue Opportunity`}</p>
              <p className="mt-2 font-heading text-2xl font-semibold text-white">{money2(upliftCents)}</p>
              <p className={`mt-0.5 text-xs ${upliftPct >= 0 ? "text-[#00E096]" : "text-[#FF6B6B]"}`}>{upliftPct >= 0 ? "+" : ""}{upliftPct}% vs base rates</p>
            </div>
          </>
        )}
      </div>

      <Card title="Why this rate?" subtitle="Plain-English explanation of today's recommendation">
        <p className="text-sm text-slate-300">{reason}</p>
      </Card>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card
          title="Strategy Presets"
          subtitle="Pick how boldly the engine rides demand"
          right={
            <button onClick={() => update({ enabled: !cfg.enabled })} className={`flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs ${cfg.enabled ? "border-[#00E096]/40 bg-[#00E096]/10 text-[#00E096]" : "border-white/10 text-slate-300 hover:bg-white/5"}`}>
              <Settings2 className="h-3.5 w-3.5" /> {cfg.enabled ? "On" : "Off"}
            </button>
          }
        >
          <div className="grid grid-cols-3 gap-2">
            {Object.entries(PRESETS).map(([name]) => (
              <button key={name} onClick={() => applyPreset(name)} className="rounded-lg border border-white/10 bg-[#0A1628] px-3 py-2 text-center text-xs hover:border-[#6C63FF]/40">
                <span className="block font-semibold text-white">{name}</span>
                <span className="text-slate-500">{name === "Conservative" ? "±30% × 0.35" : name === "Balanced" ? "±60% × 0.5" : "±100% × 0.7"}</span>
              </button>
            ))}
          </div>
          <button onClick={() => update({ minMultiplier: DEFAULT_PRICING_CONFIG.minMultiplier, maxMultiplier: DEFAULT_PRICING_CONFIG.maxMultiplier, demandSensitivity: DEFAULT_PRICING_CONFIG.demandSensitivity, competitorWeight: DEFAULT_PRICING_CONFIG.competitorWeight })} className="mt-3 text-xs text-[#00D4FF] hover:underline">Reset to Balanced defaults</button>
        </Card>

        <Card title="Competitive Set" subtitle="Your position vs the market benchmark">
          <div className="space-y-2 text-xs">
            <div className="flex items-center justify-between rounded-lg bg-[#0A1628]/40 px-3 py-2"><span className="text-slate-400">Your recommended ADR</span><span className="font-medium text-white">{money2(avgRecCents)}</span></div>
            <div className="flex items-center justify-between rounded-lg bg-[#0A1628]/40 px-3 py-2"><span className="text-slate-400">Comp set rate</span><span className="font-medium text-slate-300">{money2(cfg.competitorRateCents)}</span></div>
            <div className="flex items-center justify-between rounded-lg bg-[#0A1628]/40 px-3 py-2">
              <span className="text-slate-400">Position</span>
              <span className={`font-medium ${avgRecCents > cfg.competitorRateCents ? "text-[#FF6B6B]" : avgRecCents < cfg.competitorRateCents ? "text-[#00E096]" : "text-slate-300"}`}>
                {avgRecCents > cfg.competitorRateCents ? `Premium (${money2(avgRecCents - cfg.competitorRateCents)})` : avgRecCents < cfg.competitorRateCents ? `Discounted (${money2(cfg.competitorRateCents - avgRecCents)})` : "Parity"}
              </span>
            </div>
          </div>
        </Card>

        <Card title="Push to Channels" subtitle="Send today's recommended rates to connected OTAs">
          <p className="text-sm text-slate-400">Dispatches the current recommended rate for each room type to the channel manager, which pushes it to every connected OTA.</p>
          <div className="mt-3 space-y-2">
            {ROOM_TYPES.map((type) => {
              const rec = today?.types?.[type]?.recommendedCents;
              return (<div key={type} className="flex items-center justify-between text-xs"><span className="text-slate-400">{type}</span><span className="font-medium text-white">{rec ? money2(rec) : "—"}</span></div>);
            })}
          </div>
          <button onClick={handlePush} disabled={pushing || isPortfolio || !enabled || !today} className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-[#6C63FF] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#5b52e8] disabled:opacity-50">
            <RefreshCw className={`h-4 w-4 ${pushing ? "animate-spin" : ""}`} />{pushing ? "Pushing…" : "Push Recommended Rates"}
          </button>
          {isPortfolio && <p className="mt-2 text-center text-xs text-amber-400"><AlertTriangle className="mr-1 inline h-3 w-3" /> Select a specific property to push.</p>}
        </Card>
      </div>

      <Card
        title="Rate Forecast"
        subtitle={`Recommended sell rate per room type (${horizon}-day view)`}
        right={
          <div className="flex items-center gap-1">
            <button onClick={() => setExpanded((v) => !v)} className="flex items-center gap-1 rounded-lg border border-white/10 px-2 py-1 text-xs text-slate-300 hover:bg-white/5">{expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}{expanded ? "Hide" : "Show"}</button>
            {[7, 14, 30].map((d) => (<button key={d} onClick={() => setHorizon(d)} className={`rounded px-2 py-1 text-xs ${horizon === d ? "bg-[#6C63FF] text-white" : "text-slate-400 hover:bg-white/5"}`}>{d}d</button>))}
          </div>
        }
      >
        {!expanded && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[7, 14, 30, 90].map((d) => {
              const slice = forecast.slice(0, d);
              const rev = slice.reduce((s, x) => s + x.projectedRevenueCents, 0);
              return (<div key={d} className="rounded-xl border border-white/5 bg-[#0A1628]/50 p-3"><p className="text-xs text-slate-400">{d}-day</p><p className="font-heading text-lg font-semibold text-white">{money2(rev)}</p><p className="text-[10px] text-slate-500">projected revenue</p></div>);
            })}
          </div>
        )}
        {rooms.length === 0 ? (
          <p className="mt-2 text-sm text-slate-400">No room register yet. Create one on the Room Board to drive per-type recommendations.</p>
        ) : expanded ? (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-white/5 text-left text-[11px] uppercase tracking-widest text-slate-500">
                  <th className="px-2 py-2">Date</th><th className="px-2 py-2">Occ</th>
                  {ROOM_TYPES.map((t) => <th key={t} className="px-2 py-2 text-right">{t}</th>)}
                  <th className="px-2 py-2 text-right">Proj Rev</th>
                </tr>
              </thead>
              <tbody>
                {forecast.map((day) => (
                  <tr key={day.date} className="border-b border-white/5">
                    <td className="whitespace-nowrap px-2 py-2 text-white">{day.date}{day.isWeekend && <span className="ml-1 text-[10px] text-[#FFB547]">WKND</span>}</td>
                    <td className="px-2 py-2 text-slate-400">{Math.round(day.occupancy * 100)}%</td>
                    {ROOM_TYPES.map((t) => {
                      const r = day.types?.[t];
                      if (!r) return <td key={t} className="px-2 py-2 text-right text-slate-600">—</td>;
                      const delta = r.recommendedCents - r.baseCents;
                      return (
                        <td key={t} className="px-2 py-2 text-right">
                          <span className="text-white">{money2(r.recommendedCents)}</span>
                          {delta !== 0 && <span className={`ml-1 inline-flex items-center text-[10px] ${delta > 0 ? "text-[#00E096]" : "text-[#FF6B6B]"}`}>{delta > 0 ? <ArrowUpRight className="h-3 w-3" /> : "↓"}<span className="text-slate-500">{(Math.abs(delta) / 100).toFixed(0)}</span></span>}
                        </td>
                      );
                    })}
                    <td className="px-2 py-2 text-right font-medium text-slate-300">{money2(day.projectedRevenueCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>
    </div>
  );
}
