/**
 * Dynamic Pricing / Forecasting — Time-Series Prediction.
 * Cross-references occupancy pace + external events.
 */
export function predictDemand(occupancyData, events) {
  const pace = occupancyData.map(d => d.occupancy);
  const avg = pace.reduce((s,a)=>s+a,0)/pace.length || 0;
  const trend = events.length ? 0.1 : 0;
  return Math.round(avg * (1 + trend) * 100) / 100;
}
