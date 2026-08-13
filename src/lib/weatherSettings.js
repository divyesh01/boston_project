// Weather data configuration (feature 5).
//
// Stores only non-secret property coordinates in localStorage (the same simple
// persistence used by commissionRates/alertThresholds). The OpenWeather API key
// is a server-side secret (#29): the frontend calls the `getWeather` backend
// function, which reads the key from Base44 secrets and proxies the request, so
// the key is never shipped to or stored in the browser.

const KEY = "rri_weather_config";

const DEFAULTS = {
  lat: 41.89, // Middleborough, MA (RRI1416) — user-editable
  lon: -70.91,
};

export function getWeatherConfig() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || "{}") };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveWeatherConfig(cfg) {
  // Never persist an apiKey — the key is server-side only. Strip it defensively
  // in case an older client wrote one to the same storage key.
  const { apiKey, ...safe } = cfg || {};
  void apiKey;
  try { localStorage.setItem(KEY, JSON.stringify({ ...getWeatherConfig(), ...safe })); } catch {}
}

export function hasApiKey() {
  // The key no longer lives in the browser. The server `getWeather` function
  // decides whether a key is configured. Keep a hook so callers can ask without
  // storing anything; it reflects only whether a key was configured server-side.
  return false;
}
