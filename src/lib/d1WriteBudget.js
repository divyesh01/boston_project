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
 * Writes consumed during staging (chunk uploads):
 * 1 row in business_record_staging + 1 in business_staging_target + 1 index write
 * per operation = 3 writes/op; plus 1 chunk receipt + 1 cursor update per chunk = 2 writes/chunk;
 * plus 2 startup writes.
 */
export function estimateStagingWrites(operationCount, chunkCount) {
  const o = Math.max(0, Math.floor(Number(operationCount) || 0));
  const c = Math.max(0, Math.floor(Number(chunkCount) || 0));
  if (o === 0 && c === 0) return 0;
  return 3 * o + 2 * c + 2;
}

/**
 * Writes consumed during commit action:
 * Staged deltas applied to active business_record, change feed, rollback journal,
 * active pointer swap, revision update, and UploadedReport history settlement.
 */
export function estimateCommitActionWrites(operationCount, chunkCount) {
  const o = Math.max(0, Math.floor(Number(operationCount) || 0));
  const c = Math.max(0, Math.floor(Number(chunkCount) || 0));
  if (o === 0 && c === 0) return 0;
  return 6 * o + 2 * c + 15;
}

/**
 * Writes consumed during abort/expiry cleanup action:
 * Deleting staged records, targets, and chunk receipts, plus status update.
 */
export function estimateCleanupActionWrites(operationCount, chunkCount) {
  const o = Math.max(0, Math.floor(Number(operationCount) || 0));
  const c = Math.max(0, Math.floor(Number(chunkCount) || 0));
  if (o === 0 && c === 0) return 0;
  return 3 * o + c + 1;
}

/**
 * Total writes consumed by an aborted transaction across both staging and cleanup.
 */
export function estimateAbortedTransactionWrites(operationCount, chunkCount) {
  const o = Math.max(0, Math.floor(Number(operationCount) || 0));
  const c = Math.max(0, Math.floor(Number(chunkCount) || 0));
  if (o === 0 && c === 0) return 0;
  return 6 * o + 3 * c + 3;
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
 * Calculates exact consumed writes today and active reserved writes today from
 * the set of transactions that touched or reserve capacity in today's UTC window.
 *
 * @param {Array<object>} transactions
 * @param {string} [nowIso]
 * @param {string} [utcDayStart]
 * @returns {{ consumedWritesToday: number, activeReservedWritesToday: number, totalWritesToday: number, remainingDailyBudget: number, totalCommittedWrites: number, totalPendingReservedWrites: number }}
 */
export function calculateDailyWritesFromTransactions(
  transactions = [],
  nowIso = new Date().toISOString(),
  utcDayStart = `${getUtcDayKey()}T00:00:00.000Z`
) {
  let consumedWritesToday = 0;
  let activeReservedWritesToday = 0;

  for (const t of transactions) {
    const opCount = Math.max(0, Math.floor(Number(t.operation_count) || 0));
    const chunks = Math.max(1, Math.floor(Number(t.expected_chunks) || 0) || Math.ceil(opCount / CHUNK_SIZE));
    const createdAt = String(t.created_at || "");
    const committedAt = String(t.committed_at || "");
    const rolledBackAt = String(t.rolled_back_at || "");
    const expiresAt = String(t.expires_at || "");
    const status = String(t.status || "");

    if (createdAt >= utcDayStart) {
      // Created today:
      if (status === "committed") {
        consumedWritesToday += estimateAuthoritativeTransactionWrites(opCount);
      } else if (status === "pending" && expiresAt > nowIso) {
        activeReservedWritesToday += estimateAuthoritativeTransactionWrites(opCount);
      } else if (status === "aborted" || status === "expired" || status === "conflict") {
        // Staged writes + cleanup deletes executed today
        consumedWritesToday += estimateAbortedTransactionWrites(opCount, chunks);
      }
    } else {
      // Created before today:
      if (committedAt >= utcDayStart) {
        // Committed today
        consumedWritesToday += estimateCommitActionWrites(opCount, chunks);
      } else if (rolledBackAt >= utcDayStart) {
        // Aborted or expired today -> cleanup deletes hit today's quota!
        consumedWritesToday += estimateCleanupActionWrites(opCount, chunks);
      } else if (status === "pending" && expiresAt > nowIso) {
        // Created yesterday, still pending today -> reserves commit/cleanup writes today
        activeReservedWritesToday += estimateCommitActionWrites(opCount, chunks);
      }
    }
  }

  const totalWritesToday = consumedWritesToday + activeReservedWritesToday;
  const remainingDailyBudget = Math.max(0, FREE_PLAN_SAFE_IMPORT_BUDGET - totalWritesToday);

  return {
    consumedWritesToday,
    activeReservedWritesToday,
    totalWritesToday,
    totalCommittedWrites: consumedWritesToday,
    totalPendingReservedWrites: activeReservedWritesToday,
    remainingDailyBudget,
  };
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
