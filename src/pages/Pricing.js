import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
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
const toDollars = (cents) => Math.round((Number(cents) || 0) / 100);
const toCentsFromDollars = (d) => Math.round((Number(d) || 0) * 100);
const PRESETS = {
    Conservative: { minMultiplier: 0.85, maxMultiplier: 1.3, demandSensitivity: 0.35, competitorWeight: 0.4 },
    Balanced: { minMultiplier: 0.75, maxMultiplier: 1.6, demandSensitivity: 0.5, competitorWeight: 0.3 },
    Aggressive: { minMultiplier: 0.65, maxMultiplier: 2.0, demandSensitivity: 0.7, competitorWeight: 0.15 },
};
export default function Pricing() {
    const { property, properties } = useGlobalFilters();
    const { data: rooms = [] } = useRooms(property);
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
    const { forecast, enabled } = usePricingForecast(horizon);
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
    const basePeriodRev = useMemo(() => forecast.reduce((s, d) => {
        const baseAdr = Object.values(d.types).reduce((a, t) => a + t.baseCents, 0) / Math.max(1, Object.values(d.types).filter((t) => t.baseCents > 0).length);
        return s + Math.round(d.occupancy * (rooms.length || 0)) * baseAdr;
    }, 0), [forecast, rooms.length]);
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
        if (isPortfolio) {
            setNotice({ type: "error", text: "Select a specific property to push rates." });
            return;
        }
        if (!today)
            return;
        setPushing(true);
        setNotice(null);
        try {
            const rateMap = {};
            for (const type of ROOM_TYPES) {
                if (today.types && today.types[type])
                    rateMap[type] = money2(today.types[type].recommendedCents);
            }
            await db.integrations.ChannelManager.PushInventory(singlePropertyId, rateMap);
            setNotice({ type: "ok", text: `Pushed recommended rates for ${propName} to connected channels.` });
        }
        catch (e) {
            setNotice({ type: "error", text: `Push failed: ${e.message}` });
        }
        finally {
            setPushing(false);
        }
    };
    const Input = ({ label, hint = "", children }) => (_jsxs("label", { className: "flex flex-col gap-1 text-xs text-slate-400", children: [_jsxs("span", { className: "flex items-center justify-between", children: [label, hint && _jsx("span", { className: "text-[10px] normal-case tracking-normal text-slate-500", children: hint })] }), children] }));
    return (_jsxs("div", { className: "space-y-6", children: [_jsxs("header", { children: [_jsx("p", { className: "text-[11px] uppercase tracking-[0.3em] text-[#6C63FF]", children: "Revenue" }), _jsx("h1", { className: "mt-2 font-heading text-3xl font-semibold text-white", children: "Dynamic Pricing" }), _jsxs("p", { className: "mt-1 text-sm text-slate-400", children: ["Auto-adjust nightly rates from demand, seasonality, weather, and the competitive set \u00B7 ", propName] })] }), notice && (_jsxs("div", { className: `flex items-center gap-2 rounded-lg border px-3 py-2 text-xs ${notice.type === "ok" ? "border-[#00E096]/30 bg-[#00E096]/10 text-[#00E096]" : "border-[#FF6B6B]/30 bg-[#FF6B6B]/10 text-[#FF6B6B]"}`, children: [notice.type === "ok" ? _jsx(CheckCircle, { className: "h-4 w-4" }) : _jsx(AlertTriangle, { className: "h-4 w-4" }), " ", notice.text] })), _jsxs("div", { className: "grid gap-4 sm:grid-cols-2 lg:grid-cols-4", children: [_jsxs("div", { className: "rounded-2xl border border-white/5 bg-[#0F1F35]/80 p-4", children: [_jsx("p", { className: "text-[11px] uppercase tracking-widest text-slate-400", children: "Engine Status" }), _jsx("p", { className: "mt-2 font-heading text-2xl font-semibold text-white", children: enabled ? "Auto" : "Manual" }), _jsx("p", { className: "text-xs text-slate-500", children: enabled ? "Rates auto-adjust daily" : "Rates are at base (rack)" })] }), today && (_jsxs(_Fragment, { children: [_jsxs("div", { className: "rounded-2xl border border-white/5 bg-[#0A1628]/60 p-4", children: [_jsx("p", { className: "text-[11px] uppercase tracking-widest text-slate-500", children: "Tonight's Recommended Rate" }), _jsx("p", { className: "mt-2 font-heading text-2xl font-semibold text-white", children: money2(avgRecCents) }), _jsxs("p", { className: `mt-0.5 text-xs ${avgRecCents >= avgBaseCents ? "text-[#00E096]" : "text-[#FF6B6B]"}`, children: [avgRecCents >= avgBaseCents ? "+" : "", money2(avgRecCents - avgBaseCents), " vs base ", money2(avgBaseCents)] })] }), _jsxs("div", { className: "rounded-2xl border border-white/5 bg-[#0A1628]/60 p-4", children: [_jsx("p", { className: "text-[11px] uppercase tracking-widest text-slate-500", children: "Occupancy Forecast" }), _jsxs("p", { className: "mt-2 font-heading text-2xl font-semibold text-white", children: [Math.round(occ * 100), "%"] }), _jsxs("p", { className: "text-xs text-slate-500", children: [rooms.length, " rooms on the register"] })] }), _jsxs("div", { className: "rounded-2xl border border-white/5 bg-[#0A1628]/60 p-4", children: [_jsx("p", { className: "text-[11px] uppercase tracking-widest text-slate-500", children: `${horizon}d Revenue Opportunity` }), _jsx("p", { className: "mt-2 font-heading text-2xl font-semibold text-white", children: money2(upliftCents) }), _jsxs("p", { className: `mt-0.5 text-xs ${upliftPct >= 0 ? "text-[#00E096]" : "text-[#FF6B6B]"}`, children: [upliftPct >= 0 ? "+" : "", upliftPct, "% vs base rates"] })] })] }))] }), _jsx(Card, { title: "Why this rate?", subtitle: "Plain-English explanation of today's recommendation", children: _jsx("p", { className: "text-sm text-slate-300", children: reason }) }), _jsxs("div", { className: "grid gap-6 lg:grid-cols-3", children: [_jsxs(Card, { title: "Strategy Presets", subtitle: "Pick how boldly the engine rides demand", right: _jsxs("button", { onClick: () => update({ enabled: !cfg.enabled }), className: `flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs ${cfg.enabled ? "border-[#00E096]/40 bg-[#00E096]/10 text-[#00E096]" : "border-white/10 text-slate-300 hover:bg-white/5"}`, children: [_jsx(Settings2, { className: "h-3.5 w-3.5" }), " ", cfg.enabled ? "On" : "Off"] }), children: [_jsx("div", { className: "grid grid-cols-3 gap-2", children: Object.entries(PRESETS).map(([name]) => (_jsxs("button", { onClick: () => applyPreset(name), className: "rounded-lg border border-white/10 bg-[#0A1628] px-3 py-2 text-center text-xs hover:border-[#6C63FF]/40", children: [_jsx("span", { className: "block font-semibold text-white", children: name }), _jsx("span", { className: "text-slate-500", children: name === "Conservative" ? "±30% × 0.35" : name === "Balanced" ? "±60% × 0.5" : "±100% × 0.7" })] }, name))) }), _jsx("button", { onClick: () => update({ minMultiplier: DEFAULT_PRICING_CONFIG.minMultiplier, maxMultiplier: DEFAULT_PRICING_CONFIG.maxMultiplier, demandSensitivity: DEFAULT_PRICING_CONFIG.demandSensitivity, competitorWeight: DEFAULT_PRICING_CONFIG.competitorWeight }), className: "mt-3 text-xs text-[#00D4FF] hover:underline", children: "Reset to Balanced defaults" })] }), _jsx(Card, { title: "Competitive Set", subtitle: "Your position vs the market benchmark", children: _jsxs("div", { className: "space-y-2 text-xs", children: [_jsxs("div", { className: "flex items-center justify-between rounded-lg bg-[#0A1628]/40 px-3 py-2", children: [_jsx("span", { className: "text-slate-400", children: "Your recommended ADR" }), _jsx("span", { className: "font-medium text-white", children: money2(avgRecCents) })] }), _jsxs("div", { className: "flex items-center justify-between rounded-lg bg-[#0A1628]/40 px-3 py-2", children: [_jsx("span", { className: "text-slate-400", children: "Comp set rate" }), _jsx("span", { className: "font-medium text-slate-300", children: money2(cfg.competitorRateCents) })] }), _jsxs("div", { className: "flex items-center justify-between rounded-lg bg-[#0A1628]/40 px-3 py-2", children: [_jsx("span", { className: "text-slate-400", children: "Position" }), _jsx("span", { className: `font-medium ${avgRecCents > cfg.competitorRateCents ? "text-[#FF6B6B]" : avgRecCents < cfg.competitorRateCents ? "text-[#00E096]" : "text-slate-300"}`, children: avgRecCents > cfg.competitorRateCents ? `Premium (${money2(avgRecCents - cfg.competitorRateCents)})` : avgRecCents < cfg.competitorRateCents ? `Discounted (${money2(cfg.competitorRateCents - avgRecCents)})` : "Parity" })] })] }) }), _jsxs(Card, { title: "Push to Channels", subtitle: "Send today's recommended rates to connected OTAs", children: [_jsx("p", { className: "text-sm text-slate-400", children: "Dispatches the current recommended rate for each room type to the channel manager, which pushes it to every connected OTA." }), _jsx("div", { className: "mt-3 space-y-2", children: ROOM_TYPES.map((type) => {
                                    const rec = today?.types?.[type]?.recommendedCents;
                                    return (_jsxs("div", { className: "flex items-center justify-between text-xs", children: [_jsx("span", { className: "text-slate-400", children: type }), _jsx("span", { className: "font-medium text-white", children: rec ? money2(rec) : "—" })] }, type));
                                }) }), _jsxs("button", { onClick: handlePush, disabled: pushing || isPortfolio || !enabled || !today, className: "mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-[#6C63FF] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#5b52e8] disabled:opacity-50", children: [_jsx(RefreshCw, { className: `h-4 w-4 ${pushing ? "animate-spin" : ""}` }), pushing ? "Pushing…" : "Push Recommended Rates"] }), isPortfolio && _jsxs("p", { className: "mt-2 text-center text-xs text-amber-400", children: [_jsx(AlertTriangle, { className: "mr-1 inline h-3 w-3" }), " Select a specific property to push."] })] })] }), _jsxs(Card, { title: "Rate Forecast", subtitle: `Recommended sell rate per room type (${horizon}-day view)`, right: _jsxs("div", { className: "flex items-center gap-1", children: [_jsxs("button", { onClick: () => setExpanded((v) => !v), className: "flex items-center gap-1 rounded-lg border border-white/10 px-2 py-1 text-xs text-slate-300 hover:bg-white/5", children: [expanded ? _jsx(ChevronUp, { className: "h-3 w-3" }) : _jsx(ChevronDown, { className: "h-3 w-3" }), expanded ? "Hide" : "Show"] }), [7, 14, 30].map((d) => (_jsxs("button", { onClick: () => setHorizon(d), className: `rounded px-2 py-1 text-xs ${horizon === d ? "bg-[#6C63FF] text-white" : "text-slate-400 hover:bg-white/5"}`, children: [d, "d"] }, d)))] }), children: [!expanded && (_jsx("div", { className: "grid grid-cols-2 gap-2 sm:grid-cols-4", children: [7, 14, 30, 90].map((d) => {
                            const slice = forecast.slice(0, d);
                            const rev = slice.reduce((s, x) => s + x.projectedRevenueCents, 0);
                            return (_jsxs("div", { className: "rounded-xl border border-white/5 bg-[#0A1628]/50 p-3", children: [_jsxs("p", { className: "text-xs text-slate-400", children: [d, "-day"] }), _jsx("p", { className: "font-heading text-lg font-semibold text-white", children: money2(rev) }), _jsx("p", { className: "text-[10px] text-slate-500", children: "projected revenue" })] }, d));
                        }) })), rooms.length === 0 ? (_jsx("p", { className: "mt-2 text-sm text-slate-400", children: "No room register yet. Create one on the Room Board to drive per-type recommendations." })) : expanded ? (_jsx("div", { className: "mt-2 overflow-x-auto", children: _jsxs("table", { className: "w-full min-w-[640px] text-sm", children: [_jsx("thead", { children: _jsxs("tr", { className: "border-b border-white/5 text-left text-[11px] uppercase tracking-widest text-slate-500", children: [_jsx("th", { className: "px-2 py-2", children: "Date" }), _jsx("th", { className: "px-2 py-2", children: "Occ" }), ROOM_TYPES.map((t) => _jsx("th", { className: "px-2 py-2 text-right", children: t }, t)), _jsx("th", { className: "px-2 py-2 text-right", children: "Proj Rev" })] }) }), _jsx("tbody", { children: forecast.map((day) => (_jsxs("tr", { className: "border-b border-white/5", children: [_jsxs("td", { className: "whitespace-nowrap px-2 py-2 text-white", children: [day.date, day.isWeekend && _jsx("span", { className: "ml-1 text-[10px] text-[#FFB547]", children: "WKND" })] }), _jsxs("td", { className: "px-2 py-2 text-slate-400", children: [Math.round(day.occupancy * 100), "%"] }), ROOM_TYPES.map((t) => {
                                                const r = day.types?.[t];
                                                if (!r)
                                                    return _jsx("td", { className: "px-2 py-2 text-right text-slate-600", children: "\u2014" }, t);
                                                const delta = r.recommendedCents - r.baseCents;
                                                return (_jsxs("td", { className: "px-2 py-2 text-right", children: [_jsx("span", { className: "text-white", children: money2(r.recommendedCents) }), delta !== 0 && _jsxs("span", { className: `ml-1 inline-flex items-center text-[10px] ${delta > 0 ? "text-[#00E096]" : "text-[#FF6B6B]"}`, children: [delta > 0 ? _jsx(ArrowUpRight, { className: "h-3 w-3" }) : "↓", _jsx("span", { className: "text-slate-500", children: (Math.abs(delta) / 100).toFixed(0) })] })] }, t));
                                            }), _jsx("td", { className: "px-2 py-2 text-right font-medium text-slate-300", children: money2(day.projectedRevenueCents) })] }, day.date))) })] }) })) : null] })] }));
}
