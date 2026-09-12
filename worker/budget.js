// worker/budget.js — Canonical Cloudflare D1 write budget model and estimation.
//
// Cloudflare Free Plan limits:
//   - 100,000 D1 rows written per day (account-wide)
//   - Resets daily at 00:00 UTC
//
// Essential Reserve:
//   - 20,000 rows written reserved for authentication (login, MFA, session touch),
//     user management, settings, property updates, and audit logging.
//
// Safe Import Budget:
//   - 80,000 rows written per day for bulk imports on Free tier.
//
// Measured lifecycle formula (proven by scripts/probe-d1-write-budget.mjs):
//   Total writes = 9M + 4 * ceil(M / 13) + 17
//   where M = operationCount, C = ceil(M / 13) is chunk count at chunk size 13.

export const CHUNK_SIZE = 13;
export const FREE_PLAN_DAILY_D1_WRITE_CAP = 100_000;
export const ESSENTIAL_AUTH_RESERVE = 20_000;
export const FREE_PLAN_SAFE_IMPORT_BUDGET = FREE_PLAN_DAILY_D1_WRITE_CAP - ESSENTIAL_AUTH_RESERVE; // 80,000

/**
 * Canonical formula for estimating total D1 rows written across a complete
 * transaction lifecycle (staging, commit journal, data write, change feed,
 * and staging cleanup).
 *
 * @param {number} operationCount
 * @returns {number} Estimated D1 rows written
 */
export function estimateAuthoritativeTransactionWrites(operationCount) {
  const m = Math.max(0, Math.floor(Number(operationCount) || 0));
  if (m === 0) return 0;
  const chunks = Math.ceil(m / CHUNK_SIZE);
  return 9 * m + 4 * chunks + 17;
}

/**
 * Returns the current or given date's UTC day key formatted as YYYY-MM-DD.
 * Ensures all budget windows align bit-exact with Cloudflare's 00:00 UTC reset.
 *
 * @param {Date | number | string} [date]
 * @returns {string} YYYY-MM-DD in UTC
 */
export function getUtcDayKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Returns the ISO string of the next 00:00:00.000Z boundary.
 *
 * @param {Date | number | string} [date]
 * @returns {string} ISO timestamp of next UTC midnight
 */
export function getNextUtcMidnight(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0));
  return next.toISOString();
}

/**
 * Evaluates whether an import of the specified size can be safely admitted.
 *
 * @param {number} operationCount
 * @param {number} [committedToday]
 * @param {number} [activeReservedToday]
 * @param {string} [planMode] 'free' | 'paid'
 * @returns {{
 *   admitted: boolean,
 *   operationCount: number,
 *   projectedWrites: number,
 *   committedToday: number,
 *   activeReservedToday: number,
 *   configuredBudget: number,
 *   essentialReserve: number,
 *   remainingBudget: number,
 *   resetBoundaryUtc: string,
 *   rejectionReason: string | null
 * }}
 */
export function evaluateImportAdmission(
  operationCount,
  committedToday = 0,
  activeReservedToday = 0,
  planMode = "free"
) {
  const count = Math.max(0, Math.floor(Number(operationCount) || 0));
  const projected = estimateAuthoritativeTransactionWrites(count);
  const isPaid = String(planMode || "").toLowerCase() === "paid";
  const budget = isPaid ? Infinity : FREE_PLAN_SAFE_IMPORT_BUDGET;
  const committed = Math.max(0, Number(committedToday) || 0);
  const reserved = Math.max(0, Number(activeReservedToday) || 0);
  const remaining = isPaid ? Infinity : Math.max(0, budget - (committed + reserved));
  const nextReset = getNextUtcMidnight();

  if (isPaid) {
    return {
      admitted: true,
      operationCount: count,
      projectedWrites: projected,
      committedToday: committed,
      activeReservedToday: reserved,
      configuredBudget: Infinity,
      essentialReserve: 0,
      remainingBudget: Infinity,
      resetBoundaryUtc: nextReset,
      rejectionReason: null,
    };
  }

  if (projected > budget) {
    return {
      admitted: false,
      operationCount: count,
      projectedWrites: projected,
      committedToday: committed,
      activeReservedToday: reserved,
      configuredBudget: budget,
      essentialReserve: ESSENTIAL_AUTH_RESERVE,
      remainingBudget: remaining,
      resetBoundaryUtc: nextReset,
      rejectionReason: `File requires ${projected.toLocaleString()} database writes, exceeding the maximum safe Free plan import limit of ${budget.toLocaleString()} writes (100k daily cap minus 20k essential auth reserve).`,
    };
  }

  if (projected > remaining) {
    return {
      admitted: false,
      operationCount: count,
      projectedWrites: projected,
      committedToday: committed,
      activeReservedToday: reserved,
      configuredBudget: budget,
      essentialReserve: ESSENTIAL_AUTH_RESERVE,
      remainingBudget: remaining,
      resetBoundaryUtc: nextReset,
      rejectionReason: `File requires ${projected.toLocaleString()} database writes, but only ${remaining.toLocaleString()} writes remain in the daily Free plan import budget for UTC day ${getUtcDayKey()}. Capacity resets at 00:00 UTC.`,
    };
  }

  return {
    admitted: true,
    operationCount: count,
    projectedWrites: projected,
    committedToday: committed,
    activeReservedToday: reserved,
    configuredBudget: budget,
    essentialReserve: ESSENTIAL_AUTH_RESERVE,
    remainingBudget: remaining,
    resetBoundaryUtc: nextReset,
    rejectionReason: null,
  };
}
