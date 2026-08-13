export function computeZScore(value, history) {
  const mean = history.reduce((s, a) => s + a, 0) / history.length || 1;
  const variance =
    history.reduce((s, a) => s + Math.pow(a - mean, 2), 0) / history.length || 1;
  const std = Math.sqrt(variance) || 1;
  return (value - mean) / std;
}

export function fireAlert(metric, zScore, message) {
  console.log(`[ALERT] z-score=${zScore} | ${message}`);
  return { metric, zScore, message, timestamp: new Date().toISOString() };
}
