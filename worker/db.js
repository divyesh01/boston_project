// ===========================================================================
// worker/db.js — thin, stubbable helpers over the D1 `env.DB` binding.
//
// The surface here is deliberately TINY so a test harness can shim `env.DB`
// with better-sqlite3 / node:sqlite (DatabaseSync) without re-implementing a
// whole D1 client. Everything routes through `prepare().bind().first()/all()/
// run()` and `batch()` — the exact four methods the Workers D1 API exposes and
// the only ones a shim must provide.
//
// No import from src/ — this runs on the Cloudflare Workers runtime.
// ===========================================================================

/**
 * @typedef {import("./index.js").Env} Env
 */

/**
 * Run a query and return the first row (or null).
 * @template T
 * @param {Env} env
 * @param {string} sql
 * @param {unknown[]} [params]
 * @returns {Promise<T | null>}
 */
export async function queryFirst(env, sql, params = []) {
  const db = requireDb(env);
  return db.prepare(sql).bind(...params).first();
}

/**
 * Run a query and return all rows.
 * @template T
 * @param {Env} env
 * @param {string} sql
 * @param {unknown[]} [params]
 * @returns {Promise<T[]>}
 */
export async function queryAll(env, sql, params = []) {
  const db = requireDb(env);
  const res = /** @type {{ results?: T[] }} */ (await db.prepare(sql).bind(...params).all());
  return res && Array.isArray(res.results) ? res.results : [];
}

/**
 * Build a single prepared+bound statement (for composing a `batch()`).
 * @param {Env} env
 * @param {string} sql
 * @param {unknown[]} [params]
 * @returns {import("./index.js").D1PreparedStatement}
 */
export function statement(env, sql, params = []) {
  return requireDb(env).prepare(sql).bind(...params);
}

/**
 * Execute an array of statements as ONE atomic D1 transaction. D1 `batch()`
 * wraps its statements in an implicit transaction: either all commit or none
 * do. This is the ONLY write path the import uses, so a chunk's data rows and
 * its progress marker land together or not at all.
 * @param {Env} env
 * @param {import("./index.js").D1PreparedStatement[]} statements
 * @returns {Promise<unknown[]>}
 */
export async function batch(env, statements) {
  return requireDb(env).batch(statements);
}

/**
 * Build a `col IN (?, ?, …)` fragment for a set of values. An EMPTY set yields
 * `1 = 0` (matches nothing) — the fail-closed default, so an out-of-scope or
 * zero-grant caller can never widen a query to "everything".
 * @param {string} column
 * @param {readonly string[]} values
 * @returns {{ sql: string, params: string[] }}
 */
export function inClause(column, values) {
  if (!values || values.length === 0) {
    return { sql: "1 = 0", params: [] };
  }
  const placeholders = values.map(() => "?").join(", ");
  return { sql: `${column} IN (${placeholders})`, params: [...values] };
}

/**
 * @param {Env} env
 * @returns {import("./index.js").D1Database}
 */
function requireDb(env) {
  if (!env || !env.DB) {
    throw new Error("D1 binding `env.DB` is not configured");
  }
  return env.DB;
}
