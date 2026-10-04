import React, { useState, useEffect } from "react";
import { Settings2, ArrowUpRight, CheckCircle, AlertTriangle, ChevronDown, ChevronUp } from "lucide-react";
import Card from "@/components/ui-exec/Card";
import { useGlobalFilters } from "@/lib/useGlobalFilters";
import { useRooms } from "@/lib/useHotelData";
import { usePricingForecast } from "@/lib/usePricing";
import { getPricingConfig, savePricingConfig, DEFAULT_PRICING_CONFIG, ROOM_TYPES } from "@/lib/pricingSettings";
import { money2 } from "@/lib/hotel";
import { fromCents } from "@/lib/decimal";
import { useRealtimeInvalidation } from "@/lib/realtime";
import { ErrorState } from "@/components/ui/status";
import { useSettingsVersion } from "@/hooks/useSettingsVersion";
import { singleSelectedProperty } from "@/lib/propertySelection";

const toCentsFromDollars = (d) => Math.round((Number(d) || 0) * 100);

// savePricingConfig returns false when the browser refuses the write. This page
// has no Save button — every control writes on change — so without this the panel
// would show the new multipliers and base rates while the engine kept quoting
// from the old stored config, and the edit would vanish on reload.
const WRITE_REFUSED =
  "The browser refused to store this pricing change, so the engine is still using the previous configuration and this edit will be gone when you reload. Storage may be full, or this window may be in private browsing — the browser console names the key that failed.";

const PRESETS = {
  Conservative: { minMultiplier: 0.85, maxMultiplier: 1.3, demandSensitivity: 0.35, competitorWeight: 0.4 },
  Balanced: { minMultiplier: 0.75, maxMultiplier: 1.6, demandSensitivity: 0.5, competitorWeight: 0.3 },
  Aggressive: { minMultiplier: 0.65, maxMultiplier: 2.0, demandSensitivity: 0.7, competitorWeight: 0.15 },
};

const Input = ({ label, hint = "", children }) => (
    <label className="flex flex-col gap-1 text-xs text-slate-400">
      <span className="flex items-center justify-between">{label}{hint && <span className="text-[10px] normal-case tracking-normal text-slate-500">{hint}</span>}</span>
      {children}
    </label>
  );

export default function Pricing() {
  const { property, properties } = useGlobalFilters();
  const settingsVersion = useSettingsVersion();
  const roomsQ = useRooms(property);
  const { data: rooms = [] } = roomsQ;
  useRealtimeInvalidation(["rooms", "reservations", "weather"]);

  const selectedProperty = singleSelectedProperty(property, properties);
  const singlePropertyId = selectedProperty?.id ?? null;
  const isPortfolio = singlePropertyId == null;
  const propName = isPortfolio
    ? (Array.isArray(property) ? `${property.length} Properties` : "Portfolio")
    : (selectedProperty?.name || "Property");

  const [cfg, setCfg] = useState(() => getPricingConfig(singlePropertyId ?? "*"));

  useEffect(() => {
    setCfg(getPricingConfig(singlePropertyId ?? "*"));
  }, [settingsVersion, singlePropertyId]);

  const [expanded, setExpanded] = useState(false);
  const [notice, setNotice] = useState(null);
  const [horizon, setHorizon] = useState(14);

  const {
    forecast,
    availabilityMessage,
    freshnessNotice,
    enabled,
    isError: forecastError,
    error: forecastErr,
    refetch: refetchForecast,
    isHistoricalSimulation,
    forecastStartDate,
    calendarToday,
  } = usePricingForecast(90);
  const visibleForecast = forecast.slice(0, horizon);

  const update = (patch) => {
    const next = { ...cfg, ...patch };
    setCfg(next);
    const stored = savePricingConfig(next, singlePropertyId ?? "*");
    // Clear only this page's own storage warning on a later success — any other
    // notice (a preset confirmation, a push result) is left where it was.
    setNotice((prev) =>
      stored ? (prev && prev.text === WRITE_REFUSED ? null : prev) : { type: "error", text: WRITE_REFUSED }
    );
    return stored;
  };
  const applyPreset = (name) => {
    if (!update(PRESETS[name])) return;
    setNotice({ type: "ok", text: `Applied ${name} pricing profile.` });
  };
  const updateBaseRate = (type, dollars) => update({ baseRates: { ...cfg.baseRates, [type]: toCentsFromDollars(dollars) } });

  const today = forecast[0];
  const avgBaseCents = today?.baseAdrCents ?? 0;
  const avgRecCents = today?.adrCents ?? 0;
  const occ = today ? today.occupancy : 0;

  // Both legs come from buildPricingForecast, so they value the SAME room nights.
  // This used to rebuild the base case here from `rooms.length` and an unweighted
  // mean of base rates, which is not the per-type inventory split the engine uses
  // to project revenue, so the uplift compared two different room counts.
  const projectedPeriodRev = visibleForecast.reduce((s, d) => s + d.projectedRevenueCents, 0);
  const basePeriodRev = visibleForecast.reduce((s, d) => s + (d.projectedBaseRevenueCents || 0), 0);
  const upliftCents = projectedPeriodRev - basePeriodRev;
  const upliftPct = basePeriodRev > 0 ? Math.round((upliftCents / basePeriodRev) * 1000) / 10 : 0;

  const reason = today
    ? occ > 0.8
      ? `Occupancy forecast ${Math.round(occ * 100)}% tonight — demand is strong, so the engine raises rates toward the competitive set.`
      : occ > 0.6
      ? `Moderate demand (${Math.round(occ * 100)}% occupancy forecast) — rates hold at a modest premium on weekends.`
      : `Light demand (${Math.round(occ * 100)}% occupancy forecast) — prices ease within the floor to protect fill.`
    : availabilityMessage;



  return (
    <div className="space-y-6">
      <header>
        <p className="text-[11px] uppercase tracking-[0.3em] text-[#6C63FF]">Revenue</p>
        <h1 className="mt-2 font-heading text-3xl font-semibold text-white">Dynamic Pricing</h1>
        <p className="mt-1 text-sm text-slate-400">Auto-adjust nightly rates from demand, seasonality, weather, and the competitive set · {propName}</p>
      </header>

      {isHistoricalSimulation && (
        <div className="flex items-center gap-2 rounded-xl border border-sky-500/20 bg-sky-500/10 px-4 py-3 text-xs text-sky-200">
          <span className="font-semibold text-sky-300">Historical Simulation Horizon:</span>
          <span>
            Rates and demand signals are anchored to historical report date <strong className="text-white">{forecastStartDate}</strong> (calendar today is {calendarToday}). Rate push to live channels is disabled for historical backtesting.
          </span>
        </div>
      )}

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
              <p className="text-[11px] uppercase tracking-widest text-slate-500">
                {isHistoricalSimulation ? `Anchor (${forecastStartDate}) Recommended Rate` : "Tonight's Recommended Rate"}
              </p>
              <p className="mt-2 font-heading text-2xl font-semibold text-white">{money2(fromCents(avgRecCents))}</p>
              <p className={`mt-0.5 text-xs ${avgRecCents >= avgBaseCents ? "text-[#00E096]" : "text-[#FF6B6B]"}`}>
                {avgRecCents >= avgBaseCents ? "+" : ""}{money2(fromCents(avgRecCents - avgBaseCents))} vs base {money2(fromCents(avgBaseCents))}
              </p>
            </div>
            <div className="rounded-2xl border border-white/5 bg-[#0A1628]/60 p-4">
              <p className="text-[11px] uppercase tracking-widest text-slate-500">Occupancy Forecast</p>
              <p className="mt-2 font-heading text-2xl font-semibold text-white">{Math.round(occ * 100)}%</p>
              <p className="text-xs text-slate-500">{rooms.length} rooms on the register</p>
            </div>
            <div className="rounded-2xl border border-white/5 bg-[#0A1628]/60 p-4">
              <p className="text-[11px] uppercase tracking-widest text-slate-500">{`${horizon}d Revenue Opportunity`}</p>
              <p className="mt-2 font-heading text-2xl font-semibold text-white">{money2(fromCents(upliftCents))}</p>
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
            <div className="flex items-center justify-between rounded-lg bg-[#0A1628]/40 px-3 py-2"><span className="text-slate-400">Your recommended ADR</span><span className="font-medium text-white">{today ? money2(fromCents(avgRecCents)) : "Unavailable"}</span></div>
            <div className="flex items-center justify-between rounded-lg bg-[#0A1628]/40 px-3 py-2"><span className="text-slate-400">Comp set rate</span><span className="font-medium text-slate-300">{money2(fromCents(cfg.competitorRateCents))}</span></div>
            <div className="flex items-center justify-between rounded-lg bg-[#0A1628]/40 px-3 py-2">
              <span className="text-slate-400">Position</span>
              <span className={`font-medium ${avgRecCents > cfg.competitorRateCents ? "text-[#FF6B6B]" : avgRecCents < cfg.competitorRateCents ? "text-[#00E096]" : "text-slate-300"}`}>
                {!today ? "Unavailable" : avgRecCents > cfg.competitorRateCents ? `Premium (${money2(fromCents(avgRecCents - cfg.competitorRateCents))})` : avgRecCents < cfg.competitorRateCents ? `Discounted (${money2(fromCents(cfg.competitorRateCents - avgRecCents))})` : "Parity"}
              </span>
            </div>
          </div>
        </Card>

        <Card title="Channel publishing" subtitle="Publish rates through your connected channel provider">
          <p className="text-sm text-slate-400">Automatic rate publishing is unavailable. Review the recommendations here, then enter approved rates in your channel manager.</p>
        </Card>
      </div>

      <Card
        title="Base Rates"
        subtitle="The rack rate per room type the engine multiplies — the anchor for every recommended and pushed rate"
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {ROOM_TYPES.map((type) => {
            const cents = cfg.baseRates?.[type] ?? 0;
            return (
              // key includes the stored cents so a blur that rounds the entry
              // (129.999 → $130.00) remounts the field showing the canonical value.
              <Input key={`${type}-${cents}`} label={type} hint={money2(fromCents(cents))}>
                <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-[#0A1628] px-2 py-1.5 focus-within:border-[#6C63FF]/50">
                  <span className="text-slate-500">$</span>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    inputMode="decimal"
                    defaultValue={(cents / 100).toFixed(2)}
                    onBlur={(e) => updateBaseRate(type, e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                    aria-label={`${type} base rate in dollars`}
                    className="w-full bg-transparent text-sm tabular-nums text-white outline-none"
                  />
                </div>
              </Input>
            );
          })}
        </div>
        <p className="mt-3 text-xs text-slate-500">
          Changes save on blur, cent-exact. The engine clamps every recommendation between{" "}
          {Math.round((cfg.minMultiplier ?? 0) * 100)}% and {Math.round((cfg.maxMultiplier ?? 0) * 100)}% of these.
        </p>
      </Card>

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
        {!expanded && forecast.length > 0 && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[7, 14, 30, 90].map((d) => {
              const slice = forecast.slice(0, d);
              const rev = slice.reduce((s, x) => s + x.projectedRevenueCents, 0);
              return (<div key={d} className="rounded-xl border border-white/5 bg-[#0A1628]/50 p-3"><p className="text-xs text-slate-400">{d}-day</p><p className="font-heading text-lg font-semibold text-white">{money2(fromCents(rev))}</p><p className="text-[10px] text-slate-500">projected revenue</p></div>);
            })}
          </div>
        )}
        {forecast.length === 0 ? (
          <div><p className="mt-2 text-sm text-slate-400">{availabilityMessage}</p>
          <p className="mt-2 text-xs text-slate-500">{freshnessNotice}</p></div>
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
                {visibleForecast.map((day) => (
                  <tr key={day.date} className="border-b border-white/5">
                    <td className="whitespace-nowrap px-2 py-2 text-white">{day.date}{day.isWeekend && <span className="ml-1 text-[10px] text-[#FFB547]">WKND</span>}</td>
                    <td className="px-2 py-2 text-slate-400">{Math.round(day.occupancy * 100)}%</td>
                    {ROOM_TYPES.map((t) => {
                      const r = day.types?.[t];
                      if (!r) return <td key={t} className="px-2 py-2 text-right text-slate-600">—</td>;
                      const delta = r.recommendedCents - r.baseCents;
                      return (
                        <td key={t} className="px-2 py-2 text-right">
                          <span className="text-white">{money2(fromCents(r.recommendedCents))}</span>
                          {delta !== 0 && <span className={`ml-1 inline-flex items-center text-[10px] ${delta > 0 ? "text-[#00E096]" : "text-[#FF6B6B]"}`}>{delta > 0 ? <ArrowUpRight className="h-3 w-3" /> : "↓"}<span className="text-slate-500">{(Math.abs(delta) / 100).toFixed(0)}</span></span>}
                        </td>
                      );
                    })}
                    <td className="px-2 py-2 text-right font-medium text-slate-300">{money2(fromCents(day.projectedRevenueCents))}</td>
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
