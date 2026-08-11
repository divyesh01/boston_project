import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip } from "recharts";
import { Settings2 } from "lucide-react";
import Card from "@/components/ui-exec/Card";
import { useWeatherSnapshots } from "@/lib/useHotelData";
import { useGlobalFilters } from "@/lib/useGlobalFilters";
import { db } from "@/api/base44Client";
import { getWeatherConfig, saveWeatherConfig } from "@/lib/weatherSettings";
import { loadWeather, forecastRows, buildDemoForecast } from "@/lib/weatherService";
function conditionLabel(cond) {
    const c = String(cond || "");
    if (c.includes("Clear") || c.includes("Sun"))
        return "Sunny";
    if (c.includes("Rain") || c.includes("Drizzle"))
        return "Rain";
    if (c.includes("Thunder"))
        return "Storm";
    if (c.includes("Snow"))
        return "Snow";
    if (c.includes("Fog") || c.includes("Mist"))
        return "Foggy";
    if (c.includes("Cloud"))
        return "Cloudy";
    return c || "—";
}
function tempC(kOrC) {
    const n = Number(kOrC);
    if (Number.isNaN(n))
        return "—";
    return n > 150 ? `${Math.round(n - 273.15)}°` : `${Math.round(n)}°`;
}
export default function WeatherPanel() {
    const { property, latestDate } = useGlobalFilters();
    const { data: snapshots = [] } = useWeatherSnapshots(property);
    const [cfgOpen, setCfgOpen] = useState(false);
    const [draftKey, setDraftKey] = useState(getWeatherConfig().apiKey || "");
    const [draftLat, setDraftLat] = useState(getWeatherConfig().lat);
    const [draftLon, setDraftLon] = useState(getWeatherConfig().lon);
    const isPortfolio = property === "all" || Array.isArray(property);
    const propertyId = !isPortfolio ? property : "all";
    const date = latestDate || new Date().toISOString().slice(0, 10);
    const { data, isLoading } = useQuery({
        queryKey: ["weather-load", propertyId, date, (snapshots || []).length],
        queryFn: async () => {
            if (isPortfolio) {
                return { rows: forecastRows("all", date, buildDemoForecast()), source: "portfolio" };
            }
            return loadWeather({
                propertyId,
                date,
                cacheRows: snapshots,
                persistFn: async (rows) => {
                    const existing = await db.entities.WeatherSnapshot.filter({ property_id: propertyId }).list("date", 100000);
                    const stale = existing.filter((r) => String(r.date).slice(0, 10) === date);
                    if (stale.length) {
                        for (const s of stale)
                            await db.entities.WeatherSnapshot.delete(s.id);
                    }
                    await db.entities.WeatherSnapshot.bulkCreate(rows);
                },
            });
        },
    });
    const rows = data?.rows || [];
    const current = rows.find((r) => r.kind === "current") || rows.find((r) => String(r.date).slice(0, 10) === date) || {};
    const forecast = rows.filter((r) => r.kind === "forecast");
    const chartData = forecast.map((f) => ({ day: String(f.date).slice(5), high: Number(f.temp_max), low: Number(f.temp_min) }));
    const handleSaveCfg = () => {
        saveWeatherConfig({
            apiKey: String(draftKey || "").trim(),
            lat: Number(draftLat) || 41.89,
            lon: Number(draftLon) || -70.91,
        });
        setCfgOpen(false);
    };
    return (_jsxs(Card, { title: "Weather & Demand", subtitle: "Forecast for the selected property \u2014 weather drives a material share of demand swings", right: _jsxs("button", { onClick: () => setCfgOpen((v) => !v), className: "flex items-center gap-1.5 rounded-lg border border-white/10 px-2 py-1 text-xs text-slate-300 hover:bg-white/5", children: [_jsx(Settings2, { className: "h-3.5 w-3.5" }), " Configure"] }), children: [cfgOpen && (_jsxs("div", { className: "mb-4 rounded-xl border border-white/5 bg-[#0A1628]/50 p-3", children: [_jsx("p", { className: "text-xs text-slate-400", children: "OpenWeather API key and property coordinates (kept in local storage only)." }), _jsxs("div", { className: "mt-2 grid gap-2 sm:grid-cols-3", children: [_jsx("input", { value: draftKey, onChange: (e) => setDraftKey(e.target.value), placeholder: "API key", className: "rounded-lg border border-white/10 bg-[#0A1628] px-2 py-2 text-sm text-white" }), _jsx("input", { value: draftLat, onChange: (e) => setDraftLat(e.target.value), placeholder: "Latitude", className: "rounded-lg border border-white/10 bg-[#0A1628] px-2 py-2 text-sm text-white" }), _jsx("input", { value: draftLon, onChange: (e) => setDraftLon(e.target.value), placeholder: "Longitude", className: "rounded-lg border border-white/10 bg-[#0A1628] px-2 py-2 text-sm text-white" })] }), _jsxs("div", { className: "mt-2 flex gap-2", children: [_jsx("button", { onClick: handleSaveCfg, className: "rounded-lg bg-[#6C63FF] px-3 py-1.5 text-xs font-medium text-white", children: "Save" }), _jsx("button", { onClick: () => setCfgOpen(false), className: "rounded-lg border border-white/10 px-3 py-1.5 text-xs text-slate-300", children: "Cancel" })] })] })), isLoading && _jsx("p", { className: "text-sm text-slate-500", children: "Loading weather\u2026" }), !isLoading && (_jsxs("div", { children: [_jsxs("div", { className: "grid gap-3 sm:grid-cols-2 lg:grid-cols-5", children: [_jsxs("div", { className: "rounded-xl border border-white/5 bg-[#0A1628]/60 p-3", children: [_jsx("p", { className: "text-[10px] uppercase tracking-widest text-slate-500", children: "Now" }), _jsx("p", { className: "mt-1 font-heading text-3xl font-semibold text-white", children: tempC(current.temp) }), _jsx("p", { className: "text-xs text-slate-400", children: conditionLabel(current.condition) })] }), _jsxs("div", { className: "rounded-xl border border-white/5 bg-[#0A1628]/60 p-3", children: [_jsx("p", { className: "text-[10px] uppercase tracking-widest text-slate-500", children: "Feels Like" }), _jsx("p", { className: "mt-1 font-heading text-2xl font-semibold text-white", children: tempC(current.feels_like ?? current.temp) }), _jsxs("p", { className: "text-xs text-slate-400", children: ["humidity ", Math.round(Number(current.humidity) || 0), "%"] })] }), _jsxs("div", { className: "rounded-xl border border-white/5 bg-[#0A1628]/60 p-3", children: [_jsx("p", { className: "text-[10px] uppercase tracking-widest text-slate-500", children: "Wind" }), _jsx("p", { className: "mt-1 font-heading text-2xl font-semibold text-white", children: Math.round(Number(current.wind) || 0) }), _jsx("p", { className: "text-xs text-slate-400", children: "m/s" })] }), _jsxs("div", { className: "rounded-xl border border-white/5 bg-[#0A1628]/60 p-3", children: [_jsx("p", { className: "text-[10px] uppercase tracking-widest text-slate-500", children: "Forecast High" }), _jsx("p", { className: "mt-1 font-heading text-2xl font-semibold text-white", children: tempC(forecast[0]?.temp_max) }), _jsx("p", { className: "text-xs text-slate-400", children: conditionLabel(forecast[0]?.condition) })] }), _jsxs("div", { className: "rounded-xl border border-white/5 bg-[#0A1628]/60 p-3", children: [_jsx("p", { className: "text-[10px] uppercase tracking-widest text-slate-500", children: "Data Source" }), _jsx("p", { className: "mt-1 font-heading text-2xl font-semibold text-white", children: data?.source || "—" }), _jsx("p", { className: "text-xs text-slate-400", children: data?.source === "api" ? "Live OpenWeather" : data?.source === "cache" ? "Cached" : "Demo (no key)" })] })] }), chartData.length > 1 && (_jsxs("div", { className: "mt-4", children: [_jsx("p", { className: "text-xs text-slate-400", children: "5-day temperature forecast" }), _jsx(ResponsiveContainer, { width: "100%", height: 180, children: _jsxs(LineChart, { data: chartData, children: [_jsx(XAxis, { dataKey: "day", stroke: "#64748b", fontSize: 11 }), _jsx(YAxis, { stroke: "#64748b", fontSize: 11, width: 40 }), _jsx(Tooltip, { contentStyle: { background: "#0F1F35", border: "1px solid #ffffff22", borderRadius: 8 } }), _jsx(Line, { type: "monotone", dataKey: "high", stroke: "#FFB547", strokeWidth: 2, dot: false, name: "High" }), _jsx(Line, { type: "monotone", dataKey: "low", stroke: "#00D4FF", strokeWidth: 2, dot: false, name: "Low" })] }) })] })), _jsx("p", { className: "mt-3 border-t border-white/5 pt-3 text-xs text-slate-500", children: "Cross-reference this forecast against your Executive charts: demand tends to shift with temperature and weather events, which is useful for pacing dynamic pricing ahead of the week." })] }))] }));
}
