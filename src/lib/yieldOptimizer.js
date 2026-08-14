import { sanitizeText as sanitizeInput } from './securityUtils';

/**
 * Computes optimized daily rate recommendations based on demand elasticity.
 * @param {Object} params
 * @param {number} params.currentBaseRate - Current room base rate ($)
 * @param {number} params.currentOccupancy - Current occupancy percentage (0 - 100)
 * @param {number} [params.historicalAvgOccupancy] - Historical average occupancy for this day-of-week
 * @param {number} [params.daysToArrival] - Days remaining until target date
 * @param {Object} [params.weatherForecast] - Optional weather conditions { rainProbability, tempHigh }
 * @returns {Object} Pricing recommendation with reasoning and confidence score
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
