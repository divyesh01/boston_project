import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip } from "recharts";
import { Settings2 } from "lucide-react";
import Card from "@/components/ui-exec/Card";
import { useWeatherSnapshots } from "@/lib/useHotelData";
import { useGlobalFilters } from "@/lib/useGlobalFilters";
import { db } from "@/api/base44Client";
import { getWeatherConfig, saveWeatherConfig } from "@/lib/weatherSettings";
import { loadWeather, forecastRows, buildDemoForecast, fetchOpenWeatherForecast } from "@/lib/weatherService";

function conditionLabel(cond) {
  const c = String(cond || "");
  if (c.includes("Clear") || c.includes("Sun")) return "Sunny";
  if (c.includes("Rain") || c.includes("Drizzle")) return "Rain";
  if (c.includes("Thunder")) return "Storm";
  if (c.includes("Snow")) return "Snow";
  if (c.includes("Fog") || c.includes("Mist")) return "Foggy";
  if (c.includes("Cloud")) return "Cloudy";
  return c || "—";
}

function tempC(kOrC) {
  const n = Number(kOrC);
  if (Number.isNaN(n)) return "—";
  return n > 150 ? `${Math.round(n - 273.15)}°` : `${Math.round(n)}°`;
}

export default function WeatherPanel() {
  const { property, latestDate } = useGlobalFilters();
  const { data: snapshots = [] } = useWeatherSnapshots(property);

  const [cfgOpen, setCfgOpen] = useState(false);
  const [draftLat, setDraftLat] = useState(getWeatherConfig().lat);
  const [draftLon, setDraftLon] = useState(getWeatherConfig().lon);
  const [cfgError, setCfgError] = useState("");

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
        fetchFn: () => fetchOpenWeatherForecast({
          lat: getWeatherConfig().lat,
          lon: getWeatherConfig().lon,
          invoke: (name, params) => db.functions.invoke(name, params),
        }),
        persistFn: async (rows) => {
          const existing = await db.entities.WeatherSnapshot.filter({ property_id: propertyId }).list("date", 100000);
          const stale = existing.filter((r) => String(r.date).slice(0, 10) === date);
          if (stale.length) {
            for (const s of stale) await db.entities.WeatherSnapshot.delete(s.id);
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
    const stored = saveWeatherConfig({
      lat: Number(draftLat) || 41.89,
      lon: Number(draftLon) || -70.91,
    });
    if (!stored) {
      // Closing this panel is its only "saved" signal, so it must stay open on a
      // refused write: the forecast below would keep describing the old location.
      setCfgError(
        "The browser refused to store these coordinates, so the forecast is still for the previous location. Storage may be full, or this window may be in private browsing — the browser console names the key that failed."
      );
      return;
    }
    setCfgError("");
    setCfgOpen(false);
  };

  return (
    <Card
      title="Weather & Demand"
      subtitle="Forecast for the selected property — weather drives a material share of demand swings"
      right={
        <button onClick={() => setCfgOpen((v) => !v)} className="flex items-center gap-1.5 rounded-lg border border-[var(--line-strong)] bg-gradient-to-b from-[var(--s-overlay)] to-[var(--s-raised)] px-2.5 py-1 text-xs font-medium text-[var(--t-primary)] shadow-[inset_0_1px_0_rgba(255,255,255,0.08),var(--elev-1)] hover:border-white/20 hover:bg-[var(--s-hover)] active:translate-y-px transition-all">
          <Settings2 className="h-3.5 w-3.5" /> Configure
        </button>
      }
    >
      {cfgOpen && (
        <div className="mb-4 rounded-xl border border-white/10 bg-[#0A1628]/80 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_6px_20px_rgba(0,0,0,0.4)]">
          <p className="text-xs text-slate-300">Property coordinates (the OpenWeather API key is configured on the server and never stored in this browser).</p>
          <div className="mt-2.5 grid gap-2.5 sm:grid-cols-2">
            <input value={draftLat} onChange={(e) => setDraftLat(e.target.value)} placeholder="Latitude" className="rounded-lg border border-white/10 bg-[#06101E] px-3 py-2 text-sm text-white focus:border-[#00D4FF]/40 focus:outline-none" />
            <input value={draftLon} onChange={(e) => setDraftLon(e.target.value)} placeholder="Longitude" className="rounded-lg border border-white/10 bg-[#06101E] px-3 py-2 text-sm text-white focus:border-[#00D4FF]/40 focus:outline-none" />
          </div>
          <div className="mt-3 flex gap-2">
            <button onClick={handleSaveCfg} className="rounded-lg bg-gradient-to-b from-[#7C5CFF] to-[#5B3FE0] px-4 py-1.5 text-xs font-semibold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.25),0_4px_12px_rgba(108,99,255,0.3)] hover:-translate-y-0.5 active:translate-y-px transition-all">Save</button>
            <button onClick={() => setCfgOpen(false)} className="rounded-lg border border-white/10 bg-white/5 px-3.5 py-1.5 text-xs text-slate-300 hover:bg-white/10 active:translate-y-px transition-all">Cancel</button>
          </div>
          {cfgError ? (
            <p role="alert" className="mt-2 rounded-lg border border-[#FF6B6B]/30 bg-[#FF6B6B]/10 px-2.5 py-1.5 text-xs text-[#FFB4B4]">
              {cfgError}
            </p>
          ) : null}
        </div>
      )}

      {isLoading && <p className="text-sm text-slate-500">Loading weather…</p>}
      {!isLoading && (
        <div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <div className="rounded-xl border border-white/[0.08] bg-gradient-to-b from-[#101F35]/70 to-[#0A1628]/80 p-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_4px_12px_rgba(0,0,0,0.3)] transition-transform hover:-translate-y-0.5">
              <p className="text-[10px] uppercase tracking-widest text-slate-400">Now</p>
              <p className="mt-1 font-heading text-3xl font-semibold text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.3)]">{tempC(current.temp)}</p>
              <p className="text-xs text-slate-400">{conditionLabel(current.condition)}</p>
            </div>
            <div className="rounded-xl border border-white/[0.08] bg-gradient-to-b from-[#101F35]/70 to-[#0A1628]/80 p-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_4px_12px_rgba(0,0,0,0.3)] transition-transform hover:-translate-y-0.5">
              <p className="text-[10px] uppercase tracking-widest text-slate-400">Feels Like</p>
              <p className="mt-1 font-heading text-2xl font-semibold text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.3)]">{tempC(current.feels_like ?? current.temp)}</p>
              <p className="text-xs text-slate-400">humidity {Math.round(Number(current.humidity) || 0)}%</p>
            </div>
            <div className="rounded-xl border border-white/[0.08] bg-gradient-to-b from-[#101F35]/70 to-[#0A1628]/80 p-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_4px_12px_rgba(0,0,0,0.3)] transition-transform hover:-translate-y-0.5">
              <p className="text-[10px] uppercase tracking-widest text-slate-400">Wind</p>
              <p className="mt-1 font-heading text-2xl font-semibold text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.3)]">{Math.round(Number(current.wind) || 0)}</p>
              <p className="text-xs text-slate-400">m/s</p>
            </div>
            <div className="rounded-xl border border-white/[0.08] bg-gradient-to-b from-[#101F35]/70 to-[#0A1628]/80 p-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_4px_12px_rgba(0,0,0,0.3)] transition-transform hover:-translate-y-0.5">
              <p className="text-[10px] uppercase tracking-widest text-slate-400">Forecast High</p>
              <p className="mt-1 font-heading text-2xl font-semibold text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.3)]">{tempC(forecast[0]?.temp_max)}</p>
              <p className="text-xs text-slate-400">{conditionLabel(forecast[0]?.condition)}</p>
            </div>
            <div className="rounded-xl border border-white/[0.08] bg-gradient-to-b from-[#101F35]/70 to-[#0A1628]/80 p-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_4px_12px_rgba(0,0,0,0.3)] transition-transform hover:-translate-y-0.5">
              <p className="text-[10px] uppercase tracking-widest text-slate-400">Data Source</p>
              <p className="mt-1 font-heading text-2xl font-semibold text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.3)]">{data?.source || "—"}</p>
              <p className="text-xs text-slate-400">{data?.source === "api" ? "Live OpenWeather (server)" : data?.source === "cache" ? "Cached" : "Demo (server key unavailable)"}</p>
            </div>
          </div>

          {chartData.length > 1 && (
            <div className="mt-4">
              <p className="text-xs text-slate-400">5-day temperature forecast</p>
              <ResponsiveContainer width="100%" height={180}>
                <LineChart data={chartData}>
                  <XAxis dataKey="day" stroke="#64748b" fontSize={11} />
                  <YAxis stroke="#64748b" fontSize={11} width={40} />
                  <Tooltip contentStyle={{ background: "#0F1F35", border: "1px solid #ffffff22", borderRadius: 8 }} />
                  <Line type="monotone" dataKey="high" stroke="#FFB547" strokeWidth={2} dot={false} name="High" />
                  <Line type="monotone" dataKey="low" stroke="#00D4FF" strokeWidth={2} dot={false} name="Low" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

          <p className="mt-3 border-t border-white/5 pt-3 text-xs text-slate-500">
            Cross-reference this forecast against your Executive charts: demand tends to shift with temperature and weather
            events, which is useful for pacing dynamic pricing ahead of the week.
          </p>
        </div>
      )}
    </Card>
  );
}