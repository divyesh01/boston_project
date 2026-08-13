// Weather data integration (feature 5).
//
// Pulls a 5-day OpenWeather forecast for a property's coordinates and caches it
// in the WeatherSnapshot Dexie table (one row per property+date+kind) to respect
// the API rate limit. The OpenWeather API key is a server-side secret (#29): the
// dashboard panel calls the `getWeather` backend function (via a caller-supplied
// `invoke`), which proxies OpenWeather without ever exposing the key to the
// browser. When the server is unreachable or has no key configured — or the
// network is unavailable — it falls back to a clearly-labelled deterministic
// demo forecast so the dashboard panel never shows a broken/blank state (UI_UX).
//
// Node-testable surfaces (no DOM/fetch/DB coupling required):
//   * buildDemoForecast()  — deterministic demo data
//   * forecastRows()       — normalize raw OpenWeather payload into snapshot rows
//   * cacheIsFresh()       — whether the cache for a property+date is fresh

export const WEATHER_KINDS = ["current", "forecast"];

// Cache fresh for N minutes so we don't hammer OpenWeather on every dashboard
// render and every live poll.
export const CACHE_TTL_MIN = 30;

export function cacheIsFresh(cachedRows, date, now = Date.now()) {
  const rows = cachedRows || [];
  if (!rows.length) return false;
  // The cache is only fresh if it already covers today's business date.
  const hasToday = rows.some((r) => String(r.date).slice(0, 10) === String(date).slice(0, 10));
  if (!hasToday) return false;
  const newest = rows.reduce((a, r) => Math.max(a, new Date(r.created_date || 0).getTime()), 0);
  return now - newest < CACHE_TTL_MIN * 60 * 1000;
}

// Deterministic demo forecast so the panel renders without an API key. Temp is
// in Celsius, shaped like OpenWeather's list entries the consumer expects.
export function buildDemoForecast(lat = 41.89, lon = -70.91) {
  const base = Math.round((lat + lon) * 10) % 8 + 4;
  const out = { current: {}, hourly: [] };
  out.current = {
    temp: base,
    feels_like: base,
    weather: [{ main: "Clouds", description: "scattered clouds", icon: "03d" }],
    humidity: 60,
    wind_speed: 5.4,
  };
  for (let i = 0; i < 24; i += 3) {    const t = base + Math.round((i / 3) % 3);
    out.hourly.push({
      dt: i * 3600,
      temp: t,
      weather: [{ main: i % 4 === 0 ? "Clear" : "Clouds", description: i % 4 === 0 ? "clear sky" : "partly cloudy", icon: i % 4 === 0 ? "01d" : "02d" }],
    });
  }
  return out;
}

// Normalize a raw OpenWeather One Call payload into WeatherSnapshot rows
// (daily forecast). `property_id` and the business `date` are caller-supplied so
// this stays free of DB concerns.
export function forecastRows(propertyId, date, raw) {
  const rows = [];
  const day = String(date).slice(0, 10);
  const daily = raw?.daily || [];
  // Current conditions as a snapshot row.
  if (raw?.current) {
    rows.push({
      property_id: propertyId,
      date: day,
      kind: "current",
      temp: raw.current.temp,
      temp_min: raw.current.temp,
      temp_max: raw.current.temp,
      condition: raw.current.weather?.[0]?.main || "Unknown",
      description: raw.current.weather?.[0]?.description || "",
      icon: raw.current.weather?.[0]?.icon || "",
      humidity: raw.current.humidity,
      wind: raw.current.wind_speed,
    });
  }
  for (let i = 0; i < 5 && i < daily.length; i += 1) {
    const d = daily[i];
    const dStr = new Date(d.dt * 1000).toISOString().slice(0, 10);
    rows.push({
      property_id: propertyId,
      date: dStr,
      kind: "forecast",
      temp: d.temp?.day ?? d.temp,
      temp_min: d.temp?.min ?? d.temp?.night ?? d.temp,
      temp_max: d.temp?.max ?? d.temp?.day ?? d.temp,
      condition: d.weather?.[0]?.main || "Unknown",
      description: d.weather?.[0]?.description || "",
      icon: d.weather?.[0]?.icon || "",
      humidity: d.humidity,
      wind: d.wind_speed,
    });
  }
  return rows;
}

// Fetch the OpenWeather forecast through the server-side `getWeather` backend
// function. The caller must supply an `invoke(name, params)` connector (e.g.
// db.functions.invoke) so the API key stays server-side. Returns the raw
// OpenWeather payload. Throws when the server is unreachable or has no key.
export async function fetchOpenWeatherForecast({ lat, lon, invoke }) {
  if (typeof invoke !== "function") throw new Error("No server weather connector provided.");
  const res = await invoke("getWeather", { lat: Number(lat), lon: Number(lon) });
  if (!res || !res.data) throw new Error("Server weather function returned no data.");
  if (res.data.error) throw new Error(res.data.error);
  return res.data;
}

// High-level loader used by the dashboard panel: uses cached rows when fresh,
// otherwise fetches via the server proxy (if a connector is provided) and
// persists rows, otherwise returns the demo forecast flagged as demo. Needs the
// Dexie table + owner write permissions, so callers pass `{ fetchFn, persistFn }`.
/**
 * @param {{
 *   propertyId: string,
 *   date: string,
 *   cacheRows?: any[],
 *   fetchFn?: () => Promise<any>,
 *   persistFn?: (rows: any[]) => Promise<void>,
 * }} opts
 */
export async function loadWeather({ propertyId, date, cacheRows, fetchFn, persistFn }) {
  if (cacheIsFresh(cacheRows, date)) {
    return { rows: cacheRows, source: "cache" };
  }
  if (typeof fetchFn === "function") {
    try {
      const raw = await fetchFn();
      const rows = forecastRows(propertyId, date, raw);
      await persistFn(rows);
      return { rows, source: "api" };
    } catch (e) {
      // Fall through to demo rather than leave the panel broken.
      const rows = forecastRows(propertyId, date, buildDemoForecast());
      return { rows, source: "demo", error: e.message };
    }
  }
  const rows = forecastRows(propertyId, date, buildDemoForecast());
  return { rows, source: "demo" };
}
