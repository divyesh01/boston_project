import React, { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip } from "recharts";
import { Settings2 } from "lucide-react";
import Card from "@/components/ui-exec/Card";
import { useWeatherSnapshots } from "@/lib/useHotelData";
import { useGlobalFilters } from "@/lib/useGlobalFilters";
import { db } from "@/api/base44Client";
import { getWeatherConfig, saveWeatherConfig } from "@/lib/weatherSettings";
import { loadWeather, fetchOpenWeatherForecast } from "@/lib/weatherService";
import { singleSelectedProperty } from "@/lib/propertySelection";

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

function finiteReading(value) {
  if (value == null || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function displayReading(value, suffix = "") {
  const number = finiteReading(value);
  return number == null ? "Unavailable" : `${Math.round(number)}${suffix}`;
}

function tempC(kOrC) {
  const n = finiteReading(kOrC);
  if (n == null) return "Unavailable";
  return n > 150 ? `${Math.round(n - 273.15)}°` : `${Math.round(n)}°`;
}

export default function WeatherPanel() {
  const { property, properties } = useGlobalFilters();
  const selectedProperty = singleSelectedProperty(property, properties);
  const isPortfolio = !selectedProperty;
  const propertyId = selectedProperty?.id ?? "all";
  const snapshotsQ = useWeatherSnapshots(property);
  const { data: snapshots = [] } = snapshotsQ;

  const [cfgOpen, setCfgOpen] = useState(false);
  const [draftLat, setDraftLat] = useState(getWeatherConfig(propertyId).lat);
  const [draftLon, setDraftLon] = useState(getWeatherConfig(propertyId).lon);
  const [cfgError, setCfgError] = useState("");

  const [locationVersion,setLocationVersion] = useState(0);
  useEffect(()=>{const cfg=getWeatherConfig(propertyId);setDraftLat(cfg.lat);setDraftLon(cfg.lon);},[propertyId]);
  const date = new Intl.DateTimeFormat("en-CA", {timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());

  const { data, isLoading: weatherLoading } = useQuery({
    queryKey: ["weather-load", propertyId, date, locationVersion],
    enabled: isPortfolio || !snapshotsQ.isPending,
    queryFn: async () => {
      const cfg = getWeatherConfig(propertyId);
      if (isPortfolio) {
        return { rows: [], source: "unavailable" };
      }
      return loadWeather({
        propertyId,
        date,
        cacheRows: locationVersion ? [] : snapshots,
        fetchFn: import.meta.env.VITE_USE_SERVER_AUTH === 'true'
          ? undefined
          : () => fetchOpenWeatherForecast({
          lat: cfg.lat,
          lon: cfg.lon,
          invoke: (name, params) => db.functions.invoke(name, params),
        }),
        persistFn: async (rows) => {
          const existing = await db.entities.WeatherSnapshot.filter({ property_id: propertyId }, "date", 100000);
          const keys = new Set(rows.map(r => `${String(r.date).slice(0,10)}|${r.kind}`));
          const stale = existing.filter(r => keys.has(`${String(r.date).slice(0,10)}|${r.kind}`));
          if (stale.length) {
            for (const s of stale) await db.entities.WeatherSnapshot.delete(s.id);
          }
          await db.entities.WeatherSnapshot.bulkCreate(rows);
        },
      });
    },
  });
  const isLoading = weatherLoading || (!isPortfolio && snapshotsQ.isPending);

  const rows = data?.rows || [];
  const current = rows.find((r) => r.kind === "current") || rows.find((r) => String(r.date).slice(0, 10) === date) || {};
  const forecast = rows.filter((r) => r.kind === "forecast");
  const chartData = forecast.map((f) => ({ day: String(f.date).slice(5), high: finiteReading(f.temp_max), low: finiteReading(f.temp_min) }));

  const handleSaveCfg = () => {
    if (!String(draftLat).trim() || !String(draftLon).trim() || !Number.isFinite(Number(draftLat)) || !Number.isFinite(Number(draftLon)) || Math.abs(Number(draftLat)) > 90 || Math.abs(Number(draftLon)) > 180) {setCfgError("Enter valid latitude (-90 to 90) and longitude (-180 to 180)."); return;}
    const stored = saveWeatherConfig({
      lat: Number(draftLat),
      lon: Number(draftLon),
    }, propertyId);
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
    setLocationVersion(v=>v+1);
  };

  return (
    <Card
      title="Weather & Demand"
      subtitle="Forecast for the selected property — weather drives a material share of demand swings"
      right={
        <button onClick={() => setCfgOpen((v) => !v)} className="flex items-center gap-1.5 rounded-lg border border-white/10 px-2 py-1 text-xs text-slate-300 hover:bg-white/5">
          <Settings2 className="h-3.5 w-3.5" /> Configure
        </button>
      }
    >
      {cfgOpen && (
        <div className="mb-4 rounded-xl border border-white/5 bg-[#0A1628]/50 p-3">
          <p className="text-xs text-slate-400">Property coordinates (the OpenWeather API key is configured on the server and never stored in this browser).</p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <label className="space-y-1 text-xs text-slate-300">Latitude
              <input value={draftLat ?? ""} onChange={(e) => setDraftLat(e.target.value)} inputMode="decimal" placeholder="Latitude" className="block w-full rounded-lg border border-white/10 bg-[#0A1628] px-2 py-2 text-sm text-white" />
            </label>
            <label className="space-y-1 text-xs text-slate-300">Longitude
              <input value={draftLon ?? ""} onChange={(e) => setDraftLon(e.target.value)} inputMode="decimal" placeholder="Longitude" className="block w-full rounded-lg border border-white/10 bg-[#0A1628] px-2 py-2 text-sm text-white" />
            </label>
          </div>
          <div className="mt-2 flex gap-2">
            <button onClick={handleSaveCfg} className="rounded-lg bg-[#6C63FF] px-3 py-1.5 text-xs font-medium text-white">Save</button>
            <button onClick={() => setCfgOpen(false)} className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-slate-300">Cancel</button>
          </div>
          {cfgError ? (
            <p role="alert" className="mt-2 rounded-lg border border-[#FF6B6B]/30 bg-[#FF6B6B]/10 px-2 py-1.5 text-xs text-[#FFB4B4]">
              {cfgError}
            </p>
          ) : null}
        </div>
      )}

      {isLoading && <p className="text-sm text-slate-500">Loading weather…</p>}
      {!isLoading && rows.length === 0 && (
        <div className="flex h-32 items-center justify-center text-xs text-slate-500">
          {isPortfolio ? "Select one property to view weather." : "Live weather unavailable for this property/location."}
        </div>
      )}
      {!isLoading && rows.length > 0 && (
        <div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <div className="rounded-xl border border-white/5 bg-[#0A1628]/60 p-3">
              <p className="text-[10px] uppercase tracking-widest text-slate-500">Now</p>
              <p className="mt-1 font-heading text-3xl font-semibold text-white">{tempC(current.temp)}</p>
              <p className="text-xs text-slate-400">{conditionLabel(current.condition)}</p>
            </div>
            <div className="rounded-xl border border-white/5 bg-[#0A1628]/60 p-3">
              <p className="text-[10px] uppercase tracking-widest text-slate-500">Feels Like</p>
              <p className="mt-1 font-heading text-2xl font-semibold text-white">{tempC(current.feels_like ?? current.temp)}</p>
              <p className="text-xs text-slate-400">Humidity: {displayReading(current.humidity, "%")}</p>
            </div>
            <div className="rounded-xl border border-white/5 bg-[#0A1628]/60 p-3">
              <p className="text-[10px] uppercase tracking-widest text-slate-500">Wind</p>
              <p className="mt-1 font-heading text-2xl font-semibold text-white">{displayReading(current.wind)}</p>
              <p className="text-xs text-slate-400">m/s</p>
            </div>
            <div className="rounded-xl border border-white/5 bg-[#0A1628]/60 p-3">
              <p className="text-[10px] uppercase tracking-widest text-slate-500">Forecast High</p>
              <p className="mt-1 font-heading text-2xl font-semibold text-white">{tempC(forecast[0]?.temp_max)}</p>
              <p className="text-xs text-slate-400">{conditionLabel(forecast[0]?.condition)}</p>
            </div>
            <div className="rounded-xl border border-white/5 bg-[#0A1628]/60 p-3">
              <p className="text-[10px] uppercase tracking-widest text-slate-500">Data Source</p>
              <p className="mt-1 font-heading text-2xl font-semibold text-white">{data?.source || "—"}</p>
              <p className="text-xs text-slate-400">
                {data?.source === "api"
                  ? "Live OpenWeather (server)"
                  : data?.source === "cache"
                  ? "Cached Live Forecast"
                  : data?.source === "portfolio"
                  ? "Portfolio Regional Benchmark"
                  : "Demo (server key unconfigured)"}
              </p>
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
