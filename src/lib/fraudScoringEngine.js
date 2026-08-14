import { sanitizeText as sanitizeInput } from './securityUtils';

// ─── Online Welford Streaming Tracker (O(1) space/time) ──────────────────

class WelfordTracker {
  constructor() {
    this.count = 0;
    this.mean = 0;
    this.M2 = 0;
  }
  update(x) {
    this.count += 1;
    const delta = x - this.mean;
    this.mean += delta / this.count;
    const delta2 = x - this.mean;
    this.M2 += delta * delta2;
  }
  variance() {
    return this.count > 1 ? this.M2 / (this.count - 1) : 0;
  }
  stdDev() {
    return Math.sqrt(this.variance());
  }
  zScore(x) {
    const s = this.stdDev();
    return s === 0 ? 0 : (x - this.mean) / s;
  }
}

// ─── Benford's Law First-Digit Deviation ─────────────────────────────────

function computeBenfordDeviation(numbers = []) {
  if (numbers.length < 20) return { deviation: 0, suspicious: false };
  const positive = numbers.map(Math.abs).filter((n) => n >= 1 && Number.isFinite(n));
  if (positive.length < 15) return { deviation: 0, suspicious: false };
  const firstDigits = positive.map((n) => parseInt(String(n)[0], 10)).filter((d) => d >= 1 && d <= 9);
  const counts = new Array(10).fill(0);
  firstDigits.forEach((d) => (counts[d] += 1));
  const N = firstDigits.length;
  let chiSquare = 0;
  for (let d = 1; d <= 9; d++) {
    const observed = counts[d];
    const expected = N * Math.log10(1 + 1 / d);
    chiSquare += Math.pow(observed - expected, 2) / expected;
  }
  // Critical value at p=0.01 with 8 df ≈ 20.09
  const suspicious = chiSquare > 20.09;
  return { deviation: Math.round(chiSquare * 100) / 100, suspicious };
}

function calculateStats(values = []) {
  if (values.length === 0) return { mean: 0, stdDev: 0 };
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
  return { mean, stdDev: Math.sqrt(variance) };
}

// ─── Multivariate Clerk Risk Index (CRI) ───────────────────────────────

export function computeClerkRiskIndex(shiftRecord, historicalShifts = []) {
  const cashTracker = new WelfordTracker();
  const voidTracker = new WelfordTracker();
  const overrideTracker = new WelfordTracker();
  const adjustmentTracker = new WelfordTracker();

  // Seed trackers with historical values
  historicalShifts.forEach((s) => {
    cashTracker.update(Math.abs(Number(s.cash_adjustments) || 0));
    voidTracker.update(Number(s.void_count) || 0);
    overrideTracker.update(Number(s.rate_override_count) || 0);
  });
  // Update with current shift
  const currentCashAdj = Math.abs(Number(shiftRecord.cash_adjustments) || 0);
  const currentOverrides = Number(shiftRecord.rate_override_count) || 0;
  const currentVoids = Number(shiftRecord.void_count) || 0;
  const currentAdjustments = Math.abs(Number(shiftRecord.cash_adjustments) || 0);
  cashTracker.update(currentCashAdj);
  voidTracker.update(currentVoids);
  overrideTracker.update(currentOverrides);
  adjustmentTracker.update(currentAdjustments);

  const zCash = cashTracker.zScore(currentCashAdj);
  const zVoid = voidTracker.zScore(currentVoids);
  const zOverride = overrideTracker.zScore(currentOverrides);

  // Benford analysis on historical + current adjustments
  const histAdjAmounts = historicalShifts.map((s) => Math.abs(Number(s.cash_adjustments) || 0)).filter((n) => n > 0);
  const allAdjAmounts = [...histAdjAmounts, currentAdjustments].filter((n) => n > 0);
  const benford = computeBenfordDeviation(allAdjAmounts);

  // Composite CRI weights (normalized)
  let cri = 0;
  const flags = [];
  if (Math.abs(zCash) >= 3.0) {
    cri += 35;
    flags.push(`Extreme cash adjustment variance (Z=${zCash.toFixed(2)})`);
  } else if (Math.abs(zCash) >= 2.0) cri += 20;

  if (zOverride >= 2.5) {
    cri += 30;
    flags.push(`Excessive rate overrides (Z=${zOverride.toFixed(2)})`);
  } else if (zOverride >= 2.0) cri += 15;

  if (zVoid >= 2.5 && currentVoids >= 3) {
    cri += 25;
    flags.push(`High void velocity (Z=${zVoid.toFixed(2)}, count=${currentVoids})`);
  }

  if (benford.suspicious) {
    cri += 25;
    flags.push(`Synthetic digit pattern in adjustments (Benford Chi²=${benford.deviation})`);
  } else if (benford.deviation > 10) cri += 10;

  // Shift-close velocity clustering: off-hours high-value adjustments
  const shiftHour = new Date(shiftRecord.shift_timestamp || Date.now()).getHours();
  const isOffHours = shiftHour >= 1 && shiftHour <= 5;
  if (isOffHours && (currentCashAdj > 50 || currentOverrides > 2)) {
    cri += 15;
    flags.push('High-value manual transactions during graveyard shift');
  }

  const finalScore = Math.min(100, Math.max(0, Math.round(cri)));
  let severity = 'LOW';
  if (finalScore >= 60) severity = 'CRITICAL';
  else if (finalScore >= 30) severity = 'WARNING';

  return {
    clerkName: sanitizeInput(shiftRecord.clerk_name || 'Unknown'),
    shiftDate: shiftRecord.shift_date,
    riskScore: finalScore,
    severity,
    flags: flags.map((f) => sanitizeInput(f)),
    requiresManagerReview: finalScore >= 30,
    compositeZScores: { cash: Math.round(zCash * 100) / 100, void: Math.round(zVoid * 100) / 100, override: Math.round(zOverride * 100) / 100 },
    benfordDeviation: benford.deviation,
    benfordSuspicious: benford.suspicious,
  };
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
