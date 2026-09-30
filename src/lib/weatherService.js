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
export function buildDemoForecast(lat = 41.89, lon = -70.91, date = null) {
  const base = Math.round((lat + lon) * 10) % 8 + 4;
  const out = { current: {}, hourly: [], daily: [] };
  out.current = {
    temp: base,
    feels_like: base,
    weather: [{ main: "Clouds", description: "scattered clouds", icon: "03d" }],
    humidity: 60,
    wind_speed: 5.4,
  };
  for (let i = 0; i < 24; i += 3) {
    const t = base + Math.round((i / 3) % 3);
    out.hourly.push({
      dt: i * 3600,
      temp: t,
      weather: [{ main: i % 4 === 0 ? "Clear" : "Clouds", description: i % 4 === 0 ? "clear sky" : "partly cloudy", icon: i % 4 === 0 ? "01d" : "02d" }],
    });
  }

  const baseEpoch = Math.floor(new Date(date || Date.now()).setUTCHours(12, 0, 0, 0) / 1000);
  for (let i = 0; i < 5; i += 1) {
    const t = base + Math.round((i * 1.5) % 5);
    out.daily.push({
      dt: baseEpoch + i * 86400,
      temp: {
        day: t,
        min: t - 3,
        max: t + 3,
      },
      weather: [{
        main: i % 3 === 0 ? "Clear" : i % 3 === 1 ? "Clouds" : "Rain",
        description: i % 3 === 0 ? "clear sky" : i % 3 === 1 ? "scattered clouds" : "light rain",
        icon: i % 3 === 0 ? "01d" : i % 3 === 1 ? "03d" : "10d",
      }],
      humidity: 55 + (i * 3) % 20,
      wind_speed: 4.0 + (i * 0.5),
    });
  }

  return out;
}

// Normalize a raw OpenWeather One Call (raw.daily) or 5-day / 3-hour (raw.list)
// payload into WeatherSnapshot rows (daily forecast). `property_id` and the business
// `date` are caller-supplied so this stays free of DB concerns.
export function forecastRows(propertyId, date, raw) {
  const rows = [];
  const day = String(date).slice(0, 10);

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

  // 1. OneCall payload format (raw.daily)
  if (Array.isArray(raw?.daily) && raw.daily.length > 0) {
    for (let i = 0; i < 5 && i < raw.daily.length; i += 1) {
      const d = raw.daily[i];
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
  } else if (Array.isArray(raw?.list) && raw.list.length > 0) {
    // 2. Standard OpenWeather 5-day / 3-hour payload format (raw.list)
    const byDay = new Map();
    for (const item of raw.list) {
      const dStr = new Date(item.dt * 1000).toISOString().slice(0, 10);
      if (!byDay.has(dStr)) {
        byDay.set(dStr, []);
      }
      byDay.get(dStr).push(item);
    }
    const days = Array.from(byDay.keys()).sort().slice(0, 5);
    for (const dStr of days) {
      const items = byDay.get(dStr);
      let minTemp = Infinity;
      let maxTemp = -Infinity;
      let sumTemp = 0;
      let sumHumid = 0;
      let sumWind = 0;
      for (const it of items) {
        const t = it.main?.temp ?? 0;
        const lo = it.main?.temp_min ?? t;
        const hi = it.main?.temp_max ?? t;
        if (lo < minTemp) minTemp = lo;
        if (hi > maxTemp) maxTemp = hi;
        sumTemp += t;
        sumHumid += it.main?.humidity ?? 0;
        sumWind += it.wind?.speed ?? 0;
      }
      const midItem = items[Math.floor(items.length / 2)] || items[0];
      rows.push({
        property_id: propertyId,
        date: dStr,
        kind: "forecast",
        temp: Math.round((sumTemp / items.length) * 10) / 10,
        temp_min: minTemp === Infinity ? 0 : Math.round(minTemp * 10) / 10,
        temp_max: maxTemp === -Infinity ? 0 : Math.round(maxTemp * 10) / 10,
        condition: midItem.weather?.[0]?.main || "Unknown",
        description: midItem.weather?.[0]?.description || "",
        icon: midItem.weather?.[0]?.icon || "",
        humidity: Math.round(sumHumid / items.length),
        wind: Math.round((sumWind / items.length) * 10) / 10,
      });
    }
  }
  return rows;
}

// Fetch the OpenWeather forecast through the server-side `getWeather` backend
// function. The caller must supply an `invoke(name, params)` connector (e.g.
// db.functions.invoke) so the API key stays server-side. Returns the raw
// OpenWeather payload. Throws when the server is unreachable or has no key.
export async function fetchOpenWeatherForecast({ lat, lon, invoke }) {
  if (typeof invoke !== "function") throw new Error("No server weather connector provided.");
  if (lat == null || lon == null || String(lat).trim() === "" || String(lon).trim() === "") {
    throw new Error("Invalid coordinates: lat and lon are required.");
  }
  const numLat = Number(lat);
  const numLon = Number(lon);
  if (!Number.isFinite(numLat) || !Number.isFinite(numLon) || Math.abs(numLat) > 90 || Math.abs(numLon) > 180) {
    throw new Error("Invalid coordinates: lat and lon must be finite numbers.");
  }
  const res = await invoke("getWeather", { lat: numLat, lon: numLon });
  if (!res || !res.data) throw new Error("Server weather function returned no data.");
  if (res.data.error) throw new Error(res.data.error);
  return res.data;
}

// High-level loader used by the dashboard panel: uses cached rows when fresh,
// otherwise fetches via the server proxy (if a connector is provided) and
// persists measured rows, otherwise reports unavailable. Needs the
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
      if (persistFn) await persistFn(rows);
      return { rows, source: "api" };
    } catch (e) {
      // An unavailable provider must not become measured weather.
      return { rows: [], source: "unavailable", error: e.message };
    }
  }
  return { rows: [], source: "unavailable" };
}
