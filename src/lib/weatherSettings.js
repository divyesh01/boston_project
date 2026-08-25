// Weather data configuration (feature 5).
//
// Stores only non-secret property coordinates in localStorage (the same simple
// persistence used by commissionRates/alertThresholds). The OpenWeather API key
// is a server-side secret (#29): the frontend calls the `getWeather` backend
// function, which reads the key from Base44 secrets and proxies the request, so
// the key is never shipped to or stored in the browser.

import { readObjectSetting, writeJsonSetting } from "@/lib/settingsStore";

const KEY = "rri_weather_config";

const DEFAULTS = {
  lat: 41.89, // Middleborough, MA (RRI1416) — user-editable
  lon: -70.91,
};

export function getWeatherConfig() {
  return { ...DEFAULTS, ...readObjectSetting(KEY, {}) };
}

/**
 * @param {Object} cfg
 * @returns {boolean} true only if the coordinates are now stored.
 *
 * A false return matters beyond the weather card. Traced 2026-08-24: these
 * coordinates are read only by WeatherPanel.jsx, which passes them to
 * fetchOpenWeatherForecast and persists the result as WeatherSnapshot rows;
 * usePricing.js then builds its `weatherByDate` map from those same rows and
 * pricingEngine.js turns it into `weatherMultiplierBps`. So a refused write
 * leaves the forecast AND the weather leg of every recommended rate describing
 * the PREVIOUS location, with nothing on screen to say so.
 */
export function saveWeatherConfig(cfg) {
  // Never persist an apiKey — the key is server-side only. Strip it defensively
  // in case an older client wrote one to the same storage key.
  const { apiKey, ...safe } = cfg || {};
  void apiKey;
  return writeJsonSetting(KEY, { ...getWeatherConfig(), ...safe });
}

export function hasApiKey() {
  // The key no longer lives in the browser. The server `getWeather` function
  // decides whether a key is configured. Keep a hook so callers can ask without
  // storing anything; it reflects only whether a key was configured server-side.
  return false;
}
