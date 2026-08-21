// Dynamic pricing engine (feature 8) — pure, integer-cents, React-free.
//
// Given a per-room-type base (rack) rate and a set of demand signals for a
// future date, produce a recommended sell rate in integer cents. The
// recommendation is a multiplicative blend of four signals, each expressed in
// basis points (RATE_SCALE = 10000 == 1.00x) so the whole pipeline stays in
// integer arithmetic (per BUSINESS.md — no floating-point money):
//
//   demand      pulls the rate up as expected occupancy rises, down as it falls
//   seasonality weekend vs weekday uplift
//   weather     foul-weather discount / fair-weather premium
//   competitor  blend toward the competitive set's posted rate
//
// The combined multiplier is clamped to [minMultiplier, maxMultiplier] so a
// signal spike can never produce an unbounded rate. The module is React-free so
// scripts/probe-pricing.mjs can exercise the real implementation in Node.

import { DEFAULT_PRICING_CONFIG, ROOM_TYPES } from "./pricingSettings.js";
import { predictDemand } from "./forecasting.js";

export const RATE_SCALE = 10000; // basis points: 10000 == 1.00x

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ─── Signal functions (each returns a multiplier in basis points) ───

// Demand signal. Symmetric around occupancy 0.5:
//   occ 0.5 -> 1.00x, occ 1.0 -> (1+sensitivity)x, occ 0.0 -> (1-sensitivity)x.
export function demandMultiplierBps(occupancy, sensitivity) {
  const occ = clamp(Number(occupancy) || 0, 0, 1);
  const sens = clamp(Number(sensitivity) || 0, 0, 1);
  return Math.round(RATE_SCALE + sens * (occ - 0.5) * 2 * RATE_SCALE);
}

// Seasonality signal. Weekend night stays command an uplift; weekdays are par.
export function seasonalityMultiplierBps(isWeekend, config) {
  const dow = (config && config.dayOfWeek) || DEFAULT_PRICING_CONFIG.dayOfWeek;
  return Math.round((isWeekend ? dow.weekend : dow.weekday) * RATE_SCALE);
}

// Weather signal. Foul weather trims leisure demand; fair weather adds a
// smaller premium. Neutral/missing conditions are par (no effect).
export function weatherMultiplierBps(condition, config) {
  const cfg = { ...DEFAULT_PRICING_CONFIG, ...(config || {}) };
  if (!cfg.weatherEnabled) return RATE_SCALE;
  if (!condition) return RATE_SCALE;
  const impact = clamp(Number(cfg.weatherImpact) || 0, 0, 0.5);
  const c = String(condition).toLowerCase();
  const foul = c.includes("rain") || c.includes("storm") || c.includes("snow") || c.includes("fog") || c.includes("sleet");
  const fair = c.includes("clear") || c.includes("sun") || c.includes("fair");
  if (foul) return Math.round((1 - impact) * RATE_SCALE);
  if (fair) return Math.round((1 + impact * 0.5) * RATE_SCALE);
  return RATE_SCALE;
}

// ─── Combination ───

// Multiply basis-point multipliers in integer space: (a*b)/RATE_SCALE.
function mulBps(a, b) {
  return Math.round((a * b) / RATE_SCALE);
}

// Combine the three multiplicative signals and clamp to the configured band.
// Returns { bps, clamped } where clamped reports whether the cap was hit.
export function combineMultipliers({ demandBps, seasonBps, weatherBps, config }) {
  const cfg = { ...DEFAULT_PRICING_CONFIG, ...(config || {}) };
  const minBps = Math.round(cfg.minMultiplier * RATE_SCALE);
  const maxBps = Math.round(cfg.maxMultiplier * RATE_SCALE);
  const raw = mulBps(mulBps(demandBps, seasonBps), weatherBps);
  const bps = clamp(raw, minBps, maxBps);
  return { bps, clamped: bps !== raw, minBps, maxBps };
}

// Convert a combined basis-point multiplier into an integer-cents rate.
export function applyMultiplier(baseCents, multiplierBps) {
  return Math.round((Number(baseCents) || 0) * multiplierBps / RATE_SCALE);
}

// Blend a computed rate toward the competitive set's posted rate.
export function blendWithCompetitor(rateCents, competitorCents, weight) {
  const w = clamp(Number(weight) || 0, 0, 1);
  const comp = Number(competitorCents) || 0;
  if (w === 0 || comp <= 0) return Math.round(rateCents);
  return Math.round((1 - w) * rateCents + w * comp);
}

// ─── Single-date, single-room-type recommendation ───

export function recommendRate({ baseCents, occupancy, isWeekend, weatherCondition, config }) {
  const cfg = { ...DEFAULT_PRICING_CONFIG, ...(config || {}) };
  const demandBps = demandMultiplierBps(occupancy, cfg.demandSensitivity);
  const seasonBps = seasonalityMultiplierBps(isWeekend, cfg);
  const weatherBps = weatherMultiplierBps(weatherCondition, cfg);
  const { bps, clamped, minBps, maxBps } = combineMultipliers({ demandBps, seasonBps, weatherBps, config: cfg });
  const demandCents = applyMultiplier(baseCents, bps);
  const competitorCents = blendWithCompetitor(demandCents, cfg.competitorRateCents, cfg.competitorWeight);
  return {
    baseCents: Math.round(baseCents),
    recommendedCents: competitorCents,
    multiplierBps: bps,
    clamped,
    minBps,
    maxBps,
    breakdown: { demandBps, seasonBps, weatherBps },
  };
}

// ─── Occupancy signal derivation ───

// Expected occupancy for a date from the reservation book: rooms with
// check_in <= date < check_out divided by total inventory. Falls back to the
// configured default when there is no inventory or no bookings.
export function forecastOccupancy({ reservations, rooms, date, defaultOccupancy }) {
  const totalRooms = Array.isArray(rooms) ? rooms.length : 0;
  if (totalRooms === 0) return clamp(Number(defaultOccupancy) || 0, 0, 1);
  const target = String(date).slice(0, 10);
  let booked = 0;
  for (const r of reservations || []) {
    const ci = String(r.check_in || "").slice(0, 10);
    const co = String(r.check_out || "").slice(0, 10);
    if (ci && co && ci <= target && co > target) booked += 1;
  }
  if (booked === 0) return clamp(Number(defaultOccupancy) || 0, 0, 1);
  return clamp(booked / totalRooms, 0, 1);
}

// ─── Date helpers (pure) ───

export function addDays(isoDate, days) {
  const d = new Date(`${String(isoDate).slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function isWeekend(isoDate) {
  const day = new Date(`${String(isoDate).slice(0, 10)}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 5 || day === 6; // Sun, Fri, Sat
}

// ─── Convenience: per-room-type recommendation for a single date ───

// Look up the configured base rate for a room type and produce a full
// recommendation (integer cents). Used by the Room Board "suggested rate"
// indicator when an operator is checking a guest in.
export function suggestedRateForDate({ roomType, date, occupancy, reservations, rooms, weatherByDate, config }) {
  const cfg = { ...DEFAULT_PRICING_CONFIG, ...(config || {}) };
  const base = cfg.baseRates[roomType] || 0;
  const occ = Number.isFinite(occupancy)
    ? occupancy
    : forecastOccupancy({ reservations, rooms, date, defaultOccupancy: cfg.forecastDefaultOccupancy });
  const rec = recommendRate({
    baseCents: base,
    occupancy: occ,
    isWeekend: isWeekend(date),
    weatherCondition: (weatherByDate || {})[date] || null,
    config: cfg,
  });
  return { ...rec, occupancy: occ };
}

// Build a per-day, per-room-type pricing forecast starting at fromDate.
//   rooms         — room register (for inventory + which types exist)
//   reservations  — active reservation book
//   weatherByDate — optional { [isoDate]: conditionString }
//   config        — pricing config (defaults applied)
//   days          — how many days ahead (default 14)
//
// Returns an array of day rows, each carrying the per-type recommendations and
// an aggregate ADR + projected revenue for the day.
export function predictiveRate({ occupancyHistory, events, baseCents, config }) {
  const forecasted = predictDemand(occupancyHistory, events);
  const forecastOcc = Math.min(forecasted, 1);
  const rec = recommendRate({ baseCents, occupancy: forecastOcc, isWeekend: false, weatherCondition: null, config });
  return { ...rec, forecastedDemand: forecasted };
}

// ─── Price Elasticity of Demand (PED) ───────────────────────────────────

export function priceElasticityDemand(priceRatio, elasticity) {
  // Q(P) = Q0 * (P / P0)^(-ε)
  const e = clamp(Number(elasticity) || 1.5, 0.5, 3.0);
  return Math.pow(priceRatio, -e);
}

export function computeOptimalElasticPrice({ baseCents, targetOccupancy, currentOccupancy, elasticity }) {
  const priceRatio = currentOccupancy > 0 ? targetOccupancy / currentOccupancy : 1;
  const multiplier = priceElasticityDemand(priceRatio, elasticity);
  return Math.round(baseCents * multiplier);
}

// ─── Pickup Velocity & Booking Pace Forecasting ────────────────────────

export function computeBookingPace(occupancyHistory = [], daysToArrival = 7) {
  // Simplified velocity: difference between current occupancy trajectory
  // and historical baseline at same lead time.
  const pace = (occupancyHistory || []).map((o) => Number(o) || 0);
  const avgPace = pace.length ? pace.reduce((a, b) => a + b, 0) / pace.length : 0.5;
  const velocity = (pace[pace.length - 1] || 0) - avgPace;
  return { velocity, pace, avgPace, acceleration: pace.length > 1 ? pace[pace.length - 1] - pace[pace.length - 2] : 0 };
}

export function demandMultiplierFromPace(occupancy, historicalPaceOccupancy, daysToArrival) {
  const paceDifferential = (Number(occupancy) || 0) - (Number(historicalPaceOccupancy) || 0);
  let multiplier = 1.0;
  if (paceDifferential > 10) multiplier = 1.0 + (paceDifferential / 100) * 0.75;
  else if (paceDifferential < -10 && daysToArrival <= 3) multiplier = 1.0 + (paceDifferential / 100) * 0.50;
  return clamp(multiplier, 0.7, 1.6);
}

// ─── Net-RevPAR Optimization (Direct vs OTA Commission) ───────────────

export function netRevenuePerBooking(priceCents, commissionRate) {
  const net = Math.round(priceCents * (1 - (Number(commissionRate) || 0)));
  return { publishedRateCents: Math.round(priceCents), netYieldCents: net, commissionPercent: Math.round((Number(commissionRate) || 0) * 100) };
}

export function optimizeChannelRate({ baseCents, currentOccupancy, daysToArrival, historicalPaceOccupancy, weatherRiskFactor = 0, channelCosts }) {
  const paceMult = demandMultiplierFromPace(currentOccupancy, historicalPaceOccupancy, daysToArrival);
  const urgency = daysToArrival === 0 ? (currentOccupancy > 90 ? 1.35 : (currentOccupancy < 70 ? 0.88 : 1.0)) : (daysToArrival <= 3 && currentOccupancy > 85 ? 1.20 : 1.0);
  const shock = 1.0 + (clamp(Number(weatherRiskFactor) || 0, 0, 1) * 0.25);
  let target = Math.round(baseCents * paceMult * urgency * shock);
  target = Math.max(Math.round(baseCents * 0.75), Math.min(Math.round(baseCents * 2.0), target));

  const recommendations = (channelCosts || [
    { channel: 'Direct_Web', commissionRate: 0.02 },
    { channel: 'OTA_Expedia', commissionRate: 0.18 },
    { channel: 'OTA_Booking', commissionRate: 0.15 },
  ]).map((ch) => {
    const net = Math.round(target * (1 - ch.commissionRate));
    const throttle = currentOccupancy > 88 && ch.commissionRate >= 0.15;
    return {
      channel: ch.channel,
      publishedRateCents: target,
      formattedRate: `$${(target / 100).toFixed(2)}`,
      netYieldCents: net,
      formattedNetYield: `$${(net / 100).toFixed(2)}`,
      action: throttle ? 'THROTTLE_ALLOTMENT' : 'OPEN',
    };
  });

  return { recommendedRateCents: target, formattedRate: `$${(target / 100).toFixed(2)}`, recommendations };
}

// ─── Weather & Event Shock Elasticity ───────────────────────────────────

export function weatherShockMultiplier(weatherCondition, eventImpactFactor = 0) {
  // Event impact factor 0-1 for regional conventions, storms, etc.
  const shock = clamp(Number(eventImpactFactor) || 0, 0, 1);
  let baseMult = 1.0;
  const c = String(weatherCondition || '').toLowerCase();
  if (c.includes('storm') || c.includes('blizzard') || c.includes('snow')) baseMult = 1.25;
  else if (c.includes('rain') || c.includes('fog')) baseMult = 0.85;
  else if (c.includes('sun') || c.includes('clear')) baseMult = 1.1;
  return baseMult * (1 + shock * 0.2);
}

export function buildPricingForecast({ rooms, reservations, weatherByDate = {}, config, days = 14, fromDate }) {
  const cfg = { ...DEFAULT_PRICING_CONFIG, ...(config || {}) };
  const start = fromDate || new Date().toISOString().slice(0, 10);
  const presentTypes = (Array.isArray(rooms) && rooms.length > 0)
    ? [...new Set(rooms.map((r) => r.room_type).filter(Boolean))]
    : ROOM_TYPES;
  const out = [];
  for (let i = 0; i < days; i += 1) {
    const date = addDays(start, i);
    const weekend = isWeekend(date);
    const occupancy = forecastOccupancy({ reservations, rooms, date, defaultOccupancy: cfg.forecastDefaultOccupancy });
    const condition = weatherByDate[date] || null;
    const types = {};
    let adrNum = 0;
    let adrDen = 0;
    let projectedRevenue = 0;
    let projectedBaseRevenue = 0;
    let projectedRoomNights = 0;
    for (const type of presentTypes) {
      const base = cfg.baseRates[type] || 0;
      const rec = recommendRate({ baseCents: base, occupancy, isWeekend: weekend, weatherCondition: condition, config: cfg });
      types[type] = rec;
      if (rec.recommendedCents > 0) {
        adrNum += rec.recommendedCents;
        adrDen += 1;
      }
      // Projected rooms sold for this type scales with occupancy and a simple
      // per-type inventory share (equal split across present types).
      const typeRooms = Math.max(1, Math.round((rooms ? rooms.length : 0) / presentTypes.length));
      const sold = Math.round(occupancy * typeRooms);
      projectedRoomNights += sold;
      projectedRevenue += sold * rec.recommendedCents;
      // The same room nights valued at the RACK rate. Emitted here, next to the
      // recommendation, because this is the only place `sold` exists.
      //
      // ADDED 2026-08-20. Both consumers were reconstructing this figure and both
      // got it wrong, because neither had the per-type inventory split this loop
      // uses. Pricing.jsx multiplied `occupancy * rooms.length` by an unweighted
      // mean of base rates — a different room count from the one above — and
      // PricingPanel.jsx, which has no room list at all, wrote
      // `Math.round(d.occupancy * Math.round(d.occupancy * 100))`, squaring
      // occupancy against a hardcoded 100 rooms. Measured against a 20-room
      // register at 85% occupancy (probe-cents-unit-mismatch.mjs section 7) that
      // formula valued 72 room nights where 17 were sold — so the base case, and
      // therefore the "uplift vs base rates" the panel advertised, bore no fixed
      // relation to the truth: it overstates the base case for any property under
      // 100 rooms and understates it above. A derived figure whose inputs are
      // private to this function must be returned by it, not guessed at by every
      // caller.
      projectedBaseRevenue += sold * base;
    }
    out.push({
      date,
      isWeekend: weekend,
      occupancy,
      weatherCondition: condition,
      types,
      adrCents: adrDen ? Math.round(adrNum / adrDen) : 0,
      projectedRoomNights,
      projectedRevenueCents: projectedRevenue,
      projectedBaseRevenueCents: projectedBaseRevenue,
    });
  }
  return out;
}
