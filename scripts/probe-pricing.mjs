// Probe for feature 8 — dynamic pricing engine.
// Exercises the real src/lib/pricingEngine.js in Node (pure, React-free).
import {
  demandMultiplierBps, seasonalityMultiplierBps, weatherMultiplierBps,
  combineMultipliers, applyMultiplier, blendWithCompetitor, recommendRate,
  forecastOccupancy, isWeekend, addDays, buildPricingForecast, suggestedRateForDate,
  RATE_SCALE,
} from "../src/lib/pricingEngine.js";

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed += 1; console.log("  ok -", msg); }
  else { failed += 1; console.error("  FAIL -", msg); }
}

assert(demandMultiplierBps(0.5, 0.5) === RATE_SCALE, "demand at occ 0.5 is par");
assert(demandMultiplierBps(1.0, 0.5) === 15000, "demand occ 1.0 sens 0.5 -> 1.50x");
assert(demandMultiplierBps(0.0, 0.5) === 5000, "demand occ 0.0 sens 0.5 -> 0.50x");
assert(seasonalityMultiplierBps(true, null) === 12000, "weekend -> 1.20x");
assert(seasonalityMultiplierBps(false, null) === 10000, "weekday -> 1.00x");
assert(weatherMultiplierBps("Rain showers", null) === 9000, "rain -> 0.90x");
assert(weatherMultiplierBps("Clear sky", null) === 10500, "clear -> 1.05x");
assert(weatherMultiplierBps("Cloudy", null) === 10000, "cloudy neutral -> 1.00x");
assert(weatherMultiplierBps("Snow", { weatherEnabled: true, weatherImpact: 0.2 }) === 8000, "snow impact .2 -> .80x");
assert(weatherMultiplierBps("Rain", { weatherEnabled: false, weatherImpact: 0.1 }) === 10000, "weather disabled -> 1.00x");

const low = combineMultipliers({ demandBps: 5000, seasonBps: 10000, weatherBps: 10000, config: { minMultiplier: 0.75, maxMultiplier: 1.6 } });
assert(low.bps === 7500 && low.clamped === true, "combined clamped to floor 0.75x");
const high = combineMultipliers({ demandBps: 15000, seasonBps: 12000, weatherBps: 10000, config: { minMultiplier: 0.75, maxMultiplier: 1.6 } });
assert(high.bps === 16000, "combined clamped to ceiling 1.60x");

assert(applyMultiplier(12900, 12000) === 15480, "129.00 * 1.20 = 154.80 integer cents");
assert(applyMultiplier(10000, RATE_SCALE) === 10000, "par multiplier unchanged");
assert(blendWithCompetitor(20000, 10000, 0.5) === 15000, "50/50 blend -> 150");
assert(blendWithCompetitor(20000, 10000, 0) === 20000, "weight 0 -> computed rate");
assert(blendWithCompetitor(20000, 0, 0.5) === 20000, "no competitor -> computed rate");

const rec = recommendRate({ baseCents: 14900, occupancy: 0.8, isWeekend: true, weatherCondition: "Clear", config: null });
assert(rec.recommendedCents > 14900, "high occ+weekend+clear above base");
assert(rec.multiplierBps >= rec.minBps && rec.multiplierBps <= rec.maxBps, "within clamp band");
assert(rec.breakdown.demandBps > RATE_SCALE, "demand bps above par at occ 0.8");

const rooms = [{ room_type: "King" }, { room_type: "Queen" }, { room_type: "Standard" }, { room_type: "Suite" }];
const reservations = [
  { check_in: "2026-08-10", check_out: "2026-08-12" },
  { check_in: "2026-08-10", check_out: "2026-08-11" },
];
assert(Math.abs(forecastOccupancy({ reservations, rooms, date: "2026-08-10", defaultOccupancy: 0.5 }) - 0.5) < 1e-9, "2/4 booked -> 0.5");
assert(Math.abs(forecastOccupancy({ reservations, rooms, date: "2026-08-11", defaultOccupancy: 0.5 }) - 0.25) < 1e-9, "1/4 booked -> 0.25");
assert(forecastOccupancy({ reservations: [], rooms, date: "2026-12-01", defaultOccupancy: 0.6 }) === 0.6, "no bookings -> default");

assert(isWeekend("2026-08-08") === true, "Saturday weekend");
assert(isWeekend("2026-08-07") === true, "Friday weekend");
assert(isWeekend("2026-08-10") === false, "Monday weekday");
assert(addDays("2026-08-10", 3) === "2026-08-13", "addDays +3");

const forecast = buildPricingForecast({
  rooms, reservations,
  weatherByDate: { "2026-08-08": "Rain", "2026-08-09": "Clear" },
  config: null, days: 7, fromDate: "2026-08-07",
});
assert(forecast.length === 7, "one row per forecast day");
assert(forecast[0].date === "2026-08-07", "forecast starts at fromDate");
assert(forecast[1].isWeekend === true, "Aug 8 flagged weekend");
assert(typeof forecast[0].types.King.recommendedCents === "number", "per-type recommended cents present");
assert(forecast.every((d) => d.adrCents >= 0), "ADR non-negative every day");
assert(forecast.reduce((s, d) => s + d.projectedRevenueCents, 0) > 0, "projected revenue positive");

// 11. Per-room-type suggestion for a single date (room-board integration).
const suggestion = suggestedRateForDate({ roomType: "King", date: "2026-08-09", occupancy: 1, reservations, rooms, weatherByDate: { "2026-08-09": "Clear" }, config: null });
assert(suggestion.baseCents === 17900, "King base rate from defaults");
assert(suggestion.recommendedCents > 14900, "King recommended > competitor rate");
assert(suggestion.occupancy === 1, "suggestion reports the occupancy it used");
assert(suggestion.multiplierBps >= suggestion.minBps && suggestion.multiplierBps <= suggestion.maxBps, "suggestion within clamp band");

console.log(failed ? `\n${failed} assertion(s) FAILED` : "\nALL PRICING ENGINE ASSERTIONS PASSED");
console.log(`\n${failed === 0 ? "PASSED" : "FAILED"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
