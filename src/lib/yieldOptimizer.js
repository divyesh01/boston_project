import { sanitizeText as sanitizeInput } from './securityUtils';

// THE THIRD RATE RECOMMENDER, AND THE ONLY ONE NOTHING SHIPS (measured 2026-08-24).
//
// Three separate pieces of code in this repo answer "what should we charge
// tonight", and they do not agree:
//
//   1. src/lib/pricingEngine.js — LIVE. Imported by usePricing.js, RoomBoard.jsx
//      and pricingSettings.js. Works in basis points on integer cents
//      (RATE_SCALE = 10000), clamps to [base × 0.75, base × 2.0], returns
//      { recommendedRateCents, formattedRate, recommendations }.
//   2. src/components/dashboard/YieldAdvisor.jsx — LIVE, and it is the panel the
//      owner actually sees ("Yield & ADR Optimizer" on the Dashboard). It computes
//      nothing: three if-branches on occupancy emit prose with literal amounts
//      ("Increase Rack Rate by $10–$15/night"). It imports NEITHER engine.
//   3. this file — imported only by src/lib/hotelKeyRegression.test.js:3. No page,
//      component or probe reads it.
//
// So the engine with the most pricing logic in it is the one with no consumer, and
// the surface with a consumer has no engine behind it.
//
// The two engines disagree materially. Measured on identical inputs:
//
//   base $200, occ 92%, hist 70%, 1 day out  →  this: $254.00   pricingEngine: $279.60
//   base $200, occ 55%, hist 75%, 1 day out  →  this: $184.00   pricingEngine: $180.00
//   base $149, occ 85%, hist 70%, 3 days out →  this: $170.00   pricingEngine: $165.76
//
// That is up to $25.60 per room-night of disagreement in the same direction as the
// wider guardrails, and it is not a tuning difference — the two use different pace
// thresholds (±15/±5 here vs ±10 there), different ceilings ([0.85, 1.35] here vs
// [0.75, 2.0] there) and a flat −4% weather rule that pricingEngine does not have.
// Wiring this in beside pricingEngine would put two different prices for the same
// night on two different screens with nothing to reconcile them.
//
// TWO DEFECTS TO FIX BEFORE ANY CALLER IS ADDED — left in place because a change
// to code nothing calls cannot be verified against a real screen, and inventing a
// new behaviour is not the same thing as fixing one:
//
//   FLOAT DOLLARS. `Math.round(baseRate * adjustmentMultiplier)` is float math on
//   a dollar value, which CLAUDE.md's BUSINESS directive forbids outright, and it
//   rounds to whole DOLLARS rather than cents: the $149 case above computes
//   $169.86 and reports $170.00, discarding 14¢ on every room-night, in the
//   direction of overcharging. pricingEngine.js already does this correctly in
//   cents; this should call it rather than re-derive it.
//
//   FABRICATED CONFIDENCE. `confidence: daysToArrival <= 3 ? 0.92 : 0.78` is
//   derived from nothing — not sample size, not variance, not forecast error. It
//   is two constants dressed as a statistic, and it is the field a manager would
//   most reasonably trust when deciding whether to accept the recommendation. A
//   confidence number that cannot be traced to a measurement should not be
//   rendered at all.
//
// Recommendation on record: delete this file and make YieldAdvisor.jsx render
// pricingEngine's output, so the Dashboard shows the same number RoomBoard does.
// That is one engine, one price, and a real figure on the panel that currently
// only offers advice.

/**
 * Computes optimized daily rate recommendations based on demand elasticity.
 *
 * NOT a rounding nicety: `recommendedRate` is whole dollars (see the module header
 * above), so it is not comparable to pricingEngine.js's cents without loss.
 *
 * @param {Object} params
 * @param {number} params.currentBaseRate - Current room base rate ($)
 * @param {number} params.currentOccupancy - Current occupancy percentage (0 - 100)
 * @param {number} [params.historicalAvgOccupancy] - Historical average occupancy for this day-of-week
 * @param {number} [params.daysToArrival] - Days remaining until target date
 * @param {Object} [params.weatherForecast] - Optional weather conditions { rainProbability, tempHigh }
 * @returns {Object} Pricing recommendation with reasoning and a hardcoded confidence constant
 */
export function calculateDynamicRateRecommendation({
  currentBaseRate,
  currentOccupancy,
  historicalAvgOccupancy = 70,
  daysToArrival = 1,
  weatherForecast = null
}) {
  const baseRate = Number(currentBaseRate) || 0;
  const occ = Math.max(0, Math.min(100, Number(currentOccupancy) || 0));
  const histOcc = Math.max(0, Math.min(100, Number(historicalAvgOccupancy) || 70));
  
  if (baseRate <= 0) {
    return { recommendedRate: 0, delta: 0, reason: 'Invalid base rate provided', confidence: 0 };
  }

  let adjustmentMultiplier = 1.0;
  const reasons = [];

  // 1. Demand Pacing & Pickup Velocity Logic
  const occupancyDelta = occ - histOcc;
  if (occupancyDelta > 15) {
    adjustmentMultiplier += 0.12; // High demand acceleration: +12%
    reasons.push(`Occupancy pacing +${occupancyDelta.toFixed(0)}% above historical average.`);
  } else if (occupancyDelta > 5) {
    adjustmentMultiplier += 0.06; // Moderate demand: +6%
    reasons.push(`Healthy booking pace (+${occupancyDelta.toFixed(0)}% above average).`);
  } else if (occupancyDelta < -15 && daysToArrival <= 2) {
    adjustmentMultiplier -= 0.08; // Distressed inventory close to date: -8%
    reasons.push(`Occupancy lagging (-${Math.abs(occupancyDelta).toFixed(0)}%); discount recommended to stimulate volume.`);
  }

  // 2. Critical Capacity Thresholds
  if (occ >= 90) {
    adjustmentMultiplier += 0.15; // Scarcity premium: +15%
    reasons.push('Property at >90% capacity; max rate compression enabled.');
  } else if (occ >= 80) {
    adjustmentMultiplier += 0.08;
    reasons.push('Approaching sellout (>80% occupied).');
  }

  // 3. Weather Sensitivity Factor
  if (weatherForecast && weatherForecast.rainProbability > 75 && daysToArrival <= 1) {
    adjustmentMultiplier -= 0.04;
    reasons.push('Adverse weather forecasted; minor discount applied to maintain drive-in demand.');
  }

  // Cap adjustments within safety guardrails: -15% floor, +35% ceiling
  adjustmentMultiplier = Math.max(0.85, Math.min(1.35, adjustmentMultiplier));
  const finalRate = Math.round(baseRate * adjustmentMultiplier);
  const delta = finalRate - baseRate;

  return {
    originalRate: baseRate,
    recommendedRate: finalRate,
    delta,
    percentageChange: Number(((adjustmentMultiplier - 1) * 100).toFixed(1)),
    reasons: reasons.map(r => sanitizeInput(r)),
    confidence: daysToArrival <= 3 ? 0.92 : 0.78
  };
}
