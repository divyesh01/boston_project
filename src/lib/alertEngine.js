export function computeZScore(value, history) {
  const mean = history.reduce((s, a) => s + a, 0) / history.length || 1;
  const variance =
    history.reduce((s, a) => s + Math.pow(a - mean, 2), 0) / history.length || 1;
  const std = Math.sqrt(variance) || 1;
  return (value - mean) / std;
}

export function fireAlert(metric, zScore, message) {
  // console.warn, not console.log: the production build strips console.log
  // (vite.config.js `esbuild.pure`), and the console write is this function's
  // only side effect — under .log, "firing" an alert in production would do
  // nothing but return an object. Nothing calls fireAlert today; keeping the
  // write at warn level means the first caller that does gets the behaviour the
  // name promises.
  console.warn(`[ALERT] z-score=${zScore} | ${message}`);
  return { metric, zScore, message, timestamp: new Date().toISOString() };
}
