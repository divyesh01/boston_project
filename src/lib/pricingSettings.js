// Dynamic pricing configuration (feature 8).
//
// Stores the pricing-engine rules and per-room-type base rates in localStorage
// (the same simple persistence used by the weather config and alert thresholds).
// Everything here is a pure function of these settings plus the demand signals
// the engine reads from occupancy/reservations/weather — the calculation itself
// lives in pricingEngine.js so it can be unit-tested in Node.

import { readObjectSetting, writeJsonSetting } from "@/lib/settingsStore";

const KEY = "rri_pricing_config";

export const ROOM_TYPES = ["Standard", "Queen", "King", "Suite", "Double", "Accessible"];

// Integer-cents base (rack) rates per room type. These are the anchor the
// demand/seasonality/competitor multipliers act on. Editable by the operator.
export const DEFAULT_BASE_RATES = {
  Standard: 12900,
  Queen: 14900,
  King: 17900,
  Suite: 27900,
  Double: 13900,
  Accessible: 11900,
};

export const DEFAULT_PRICING_CONFIG = {
  enabled: true,
  // Multiplier clamps (fraction of base rate). The engine never recommends
  // below minMultiplier or above maxMultiplier times the base rate.
  minMultiplier: 0.75,
  maxMultiplier: 1.6,
  // How strongly expected occupancy pulls the price off the base (0..1).
  // 0 = flat pricing regardless of demand; 1 = full occupancy swing.
  demandSensitivity: 0.5,
  // Day-of-week uplift. Weekend covers Fri+Sat night stays; weekday the rest.
  dayOfWeek: { weekend: 1.2, weekday: 1.0 },
  // Competitive set blending. competitorWeight (0..1) blends the computed rate
  // toward the competitor's posted rate so you don't drift far from market.
  competitorWeight: 0.3,
  competitorRateCents: 14900,
  // Weather signal. When enabled, foul weather applies a small discount and
  // fair weather a small premium to the leisure-sensitive weekend uplift.
  weatherEnabled: true,
  weatherImpact: 0.1,
  // Occupancy the engine assumes for future dates that have no reservation
  // signal yet (0..1).
  forecastDefaultOccupancy: 0.6,
  baseRates: { ...DEFAULT_BASE_RATES },
};

export function getPricingConfig() {
  return { ...DEFAULT_PRICING_CONFIG, ...readObjectSetting(KEY, {}) };
}

/**
 * @param {Object} cfg - merged over the stored config
 * @returns {boolean} true only if the config is now stored
 */
export function savePricingConfig(cfg) {
  return writeJsonSetting(KEY, { ...getPricingConfig(), ...cfg });
}

export function isPricingEnabled() {
  return Boolean(getPricingConfig().enabled);
}
