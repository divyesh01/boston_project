// Clerk-shift fraud scoring.
//
// TWO ENTRY POINTS, AND THEY DISAGREE (measured 2026-08-24). Neither is imported
// by a page yet: `evaluateClerkShiftRisk` is imported only by
// src/lib/hotelKeyRegression.test.js, and `computeClerkRiskIndex` is exported and
// imported by nothing at all. They are not two variants of one policy — they
// disagree on the weights (45/25 vs 35/20 for a cash-adjustment outlier), on the
// severity cut-offs (CRITICAL at 70 vs at 60, manager review at 40 vs at 30) and
// on what they measure (only the CRI path scores voids and Benford digit
// deviation). Whoever wires clerk risk into a page has to choose deliberately;
// taking whichever function appears first in the file gives a materially
// different verdict on the same shift.
//
// Known defect in the unreachable path, left in place because there is no way to
// verify a change to code nothing calls: computeClerkRiskIndex updates each
// tracker with the CURRENT shift before taking that shift's z-score, so the
// observation sits inside its own baseline and every z is pulled toward zero — it
// under-reports exactly the outliers it exists to catch. It also seeds
// `adjustmentTracker` and then never reads it. evaluateClerkShiftRisk builds its
// statistics from the history alone, which is the correct comparison.
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

// One definition of sigma for the whole module. This used to divide the squared
// deviations by `values.length` while WelfordTracker above divides by
// `count - 1`, so the two risk entry points below scored the same shift against
// two different scales.
//
// The Bessel-corrected divisor is the right one here: the historical cohort is a
// SAMPLE standing in for "this clerk's normal", not the whole population.
// Dividing by n understates sigma — 11% at the five-shift cohort the regression
// suite uses — and an understated sigma overstates every z-score, so the bias
// ran toward flagging a clerk who simply has few recorded shifts.
//
// Measured: switching the divisor leaves both regression verdicts unchanged
// (95/CRITICAL and 0/LOW). The thresholds are nowhere near the boundary on those
// fixtures, which is exactly why the divergence survived unnoticed.
function calculateStats(values = []) {
  const tracker = new WelfordTracker();
  values.forEach((v) => tracker.update(v));
  return { mean: tracker.mean, stdDev: tracker.stdDev() };
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
