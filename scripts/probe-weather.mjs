// Probe for feature 5 — weather service logic.
import { forecastRows, buildDemoForecast, cacheIsFresh } from "../src/lib/weatherService.js";

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed += 1; console.log("  ok -", msg); }
  else { failed += 1; console.error("  FAIL -", msg); }
}

const raw = {
  current: { temp: 21, feels_like: 22, weather: [{ main: "Clear", description: "clear sky", icon: "01d" }], humidity: 55, wind_speed: 3 },
  daily: Array.from({ length: 5 }, (_, i) => ({
    dt: (new Date("2026-08-06T12:00:00Z").getTime() / 1000) + i * 86400,
    temp: { day: 20 + i, min: 12 + i, max: 24 + i },
    weather: [{ main: i % 2 ? "Clouds" : "Clear", description: "x", icon: "01d" }],
    humidity: 60,
    wind_speed: 4,
  })),
};

const rows = forecastRows("p1", "2026-08-06", raw);
assert(rows.length === 6, "forecast rows = 1 current + 5 daily");
assert(rows[0].kind === "current" && rows[0].temp === 21, "current row populated");
assert(rows[0].date === "2026-08-06", "current row labelled with business date");
const forecast = rows.filter((r) => r.kind === "forecast");
assert(forecast.length === 5, "5 forecast rows");
assert(forecast.every((f) => String(f.date).length === 10), "forecast rows carry ISO dates");

assert(cacheIsFresh([], "2026-08-06") === false, "empty cache is not fresh");
const now = Date.now();
const cached = [{ date: "2026-08-06", kind: "current", created_date: new Date(now).toISOString() }];
assert(cacheIsFresh(cached, "2026-08-06", now) === true, "recent today cache is fresh");
assert(cacheIsFresh(cached, "2026-08-06", now + 45 * 60 * 1000) === false, "cache older than TTL is stale");
assert(cacheIsFresh(cached, "2026-08-10", now) === false, "cache without the requested date is stale");

const demo = buildDemoForecast();
assert(Number.isFinite(demo.current.temp), "demo forecast has a finite current temp");
assert(demo.hourly.length === 8, "demo forecast has 8 three-hourly points (0..21h)");

console.log(failed ? `\n${failed} assertion(s) FAILED` : "\nALL WEATHER ASSERTIONS PASSED");
console.log(`\n${failed === 0 ? "PASSED" : "FAILED"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);