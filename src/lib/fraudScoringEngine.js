import { sanitizeText as sanitizeInput } from './securityUtils';

function calculateStats(values = []) {
  if (values.length === 0) return { mean: 0, stdDev: 0 };
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
  return { mean, stdDev: Math.sqrt(variance) };
}

export function evaluateClerkShiftRisk(shiftRecord, historicalShifts = []) {
  const currentCashAdjustments = Math.abs(Number(shiftRecord.cash_adjustments) || 0);
  const currentRateOverrides = Number(shiftRecord.rate_override_count) || 0;
  const shiftHour = new Date(shiftRecord.shift_timestamp || Date.now()).getHours();
  
  const histAdjustments = historicalShifts.map(s => Math.abs(Number(s.cash_adjustments) || 0));
  const histOverrides = historicalShifts.map(s => Number(s.rate_override_count) || 0);

  const adjStats = calculateStats(histAdjustments);
  const overrideStats = calculateStats(histOverrides);

  let riskScore = 0;
  const flags = [];

  if (adjStats.stdDev > 0) {
    const adjZScore = (currentCashAdjustments - adjStats.mean) / adjStats.stdDev;
    if (adjZScore >= 3.0) {
      riskScore += 45;
      flags.push(`Extreme cash adjustment variance (Z-Score: ${adjZScore.toFixed(2)}).`);
    } else if (adjZScore >= 2.0) {
      riskScore += 25;
      flags.push(`Unusual cash adjustment variance (Z-Score: ${adjZScore.toFixed(2)}).`);
    }
  }

  if (overrideStats.stdDev > 0) {
    const overrideZScore = (currentRateOverrides - overrideStats.mean) / overrideStats.stdDev;
    if (overrideZScore >= 2.5) {
      riskScore += 30;
      flags.push(`Excessive rate overrides (${currentRateOverrides} overrides in shift).`);
    }
  }

  const isOffHours = shiftHour >= 1 && shiftHour <= 5;
  if (isOffHours && (currentCashAdjustments > 50 || currentRateOverrides > 2)) {
    riskScore += 20;
    flags.push('High-value manual transactions posted during off-hours (01:00-05:00).');
  }

  const finalScore = Math.min(100, riskScore);
  let severity = 'LOW';
  if (finalScore >= 70) severity = 'CRITICAL';
  else if (finalScore >= 40) severity = 'WARNING';

  return {
    clerkName: sanitizeInput(shiftRecord.clerk_name || 'Unknown'),
    shiftDate: shiftRecord.shift_date,
    riskScore: finalScore,
    severity,
    flags: flags.map(f => sanitizeInput(f)),
    requiresManagerReview: finalScore >= 40
  };
}
