// Weather data configuration (feature 5).
//
// Stores the OpenWeather API key and property coordinates in localStorage (the
// same simple persistence used by commissionRates/alertThresholds). The key is a
// personal secret — it is kept out of git and never logged. Runtime values are
// read through getWeatherConfig() so every caller shares one source of truth.

const KEY = "rri_weather_config";

const DEFAULTS = {
  apiKey: "",
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
  try { localStorage.setItem(KEY, JSON.stringify({ ...getWeatherConfig(), ...cfg })); } catch {}
}

export function hasApiKey() {
  return Boolean(getWeatherConfig().apiKey && getWeatherConfig().apiKey.trim());
}