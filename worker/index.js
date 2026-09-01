// ===========================================================================
// boston-project-api — Cloudflare Worker (Phase 1, off-production)
//
// This Worker stands up a fail-closed /api/* JSON surface. It does NOT wire the
// browser client to the backend and does NOT enable /api/* on production.
//
// Increment 2 fills the three seams increment 1 stubbed:
//   * worker/auth.js   — real Cloudflare Access RS256 JWT validation.
//   * worker/scope.js  — fail-closed, default-deny property scope resolver.
//   * worker/import.js — atomic, resumable, idempotent chunked import.
//
// HARD RULES honoured here:
//   * No import from src/ — the Worker runtime cannot load the browser bundle.
//   * Fail closed: every /api/* request runs auth (401 on failure) BEFORE any
//     handler; then scope resolution (403 on an unprovisioned/denied caller).
//   * Money/identity/access contracts live in worker/schema.sql, not here.
//
// REAL Cloudflare Access verification is BLOCKED/UNPROVEN until Access is
// enabled on this Worker; auth is validated only against synthetic JWKS/tokens.
// ===========================================================================

import { authenticate } from "./auth.js";
import { resolveScope, scopeConstraint } from "./scope.js";
import { parseChunk, importChunk } from "./import.js";
import { queryAll } from "./db.js";
import { handleEntityRequest } from "./entities.js";
import { handleUsersRequest } from "./users.js";
import { appSessionCookiePresent, authenticateAppSession, handleAppAuthRequest, sameOriginMutation } from "./app-auth.js";
import { permissionsForSession } from "./session-permissions.js";

/**
 * D1 + Access bindings. Secrets (ACCESS_AUD, ACCESS_TEAM_DOMAIN) are provided as
 * Worker secrets / vars (see wrangler.api.jsonc) and are NEVER committed.
 * @typedef {Object} Env
 * @property {D1Database} [DB]                 Bound D1 database ("boston_shared_local").
 * @property {string}     [ACCESS_AUD]         Cloudflare Access application audience (AUD) tag.
 * @property {string}     [ACCESS_TEAM_DOMAIN] Cloudflare Access team domain, e.g. "acme.cloudflareaccess.com".
 * @property {string}     [ACCESS_CERTS_URL]   TEST-ONLY override for the JWKS certs URL (synthetic JWKS).
 * @property {string}     [ENABLE_D1_DATA_API] Must be exactly "true" before any business-data endpoint is reachable.
 * @property {typeof fetch} [FETCH]            TEST-ONLY injectable fetch for the JWKS request.
 */

/**
 * Minimal shape of the D1 binding this Worker uses. The full type ships with
 * `@cloudflare/workers-types`, which is intentionally not a dependency this
 * increment; this local typedef keeps `checkJs` honest without a browser/Node
 * type leaking in.
 * @typedef {Object} D1Database
 * @property {(query: string) => D1PreparedStatement} prepare
 * @property {(statements: D1PreparedStatement[]) => Promise<unknown[]>} batch
 */

/**
 * @typedef {Object} D1PreparedStatement
 * @property {(...values: unknown[]) => D1PreparedStatement} bind
 * @property {() => Promise<unknown>} run
 * @property {<T>() => Promise<T | null>} first
 * @property {<T>() => Promise<{ results: T[] }>} all
 */

/**
 * Cloudflare Worker execution context (subset).
 * @typedef {Object} ExecutionContext
 * @property {(promise: Promise<unknown>) => void} waitUntil
 * @property {() => void} passThroughOnException
 */

/**
 * A resolved caller identity. Produced ONLY by a successful JWT validation.
 * @typedef {Object} Principal
 * @property {string} subject         Stable user id (Access `sub`).
 * @property {string} email          Verified email from the Access token.
 */

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

/**
 * @param {unknown} body
 * @param {number} status
 * @returns {Response}
 */
function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

// ---------------------------------------------------------------------------
// SCOPED READ HANDLER — every read is constrained to the caller's property set.
// Money columns are RETURNED, never SQL-SUM'd (totals are a JS concern).
// ---------------------------------------------------------------------------

/**
 * @param {URL} url
 * @param {Env} env
 * @param {import("./scope.js").Scope} scope
 * @returns {Promise<Response>}
 */
async function handleRead(url, env, scope) {
  if (url.pathname === "/api/session") {
    const permissions = permissionsForSession(scope.user.role, scope.user.permissions);
    return jsonResponse({
      authenticated: true,
      initialized: true,
      user: {
        id: scope.user.id,
        account_id: scope.accountId,
        username: scope.user.username,
        display_name: scope.user.display_name,
        full_name: scope.user.display_name,
        email: scope.user.email,
        role: scope.user.role,
        property_access: scope.all ? "all" : scope.propertyIds,
        permissions,
        is_active: scope.user.is_active !== 0,
        is_locked: scope.user.is_locked === 1,
        must_change_password: scope.user.must_change_password === 1,
      },
    }, 200);
  }
  if (url.pathname === "/api/account/status") {
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS user_count FROM user WHERE account_id = ?",
    ).bind(scope.accountId).first();
    const userCount = Number(row?.user_count || 0);
    return jsonResponse({ account_id: scope.accountId, initialized: userCount > 0, user_count: userCount }, 200);
  }

  if (url.pathname === "/api/users") {
    const role = String(scope.user.role || "").toLowerCase();
    if (!["owner", "admin", "gm", "manager"].includes(role)) {
      return jsonResponse({ error: "forbidden" }, 403);
    }
    const rows = await queryAll(
      env,
      `SELECT u.id, u.username, u.display_name, u.email, u.role,
              u.property_access_mode, u.permissions, u.is_active, u.is_locked,
              GROUP_CONCAT(upa.property_id) AS property_ids
         FROM user u
         LEFT JOIN user_property_access upa
           ON upa.account_id = u.account_id AND upa.user_id = u.id
        WHERE u.account_id = ?
        GROUP BY u.id
        ORDER BY lower(u.username)`,
      [scope.accountId],
    );
    const users = rows.map((raw) => {
      const row = /** @type {Record<string, unknown>} */ (raw);
      let permissions = {};
      try {
        permissions = row.permissions ? JSON.parse(String(row.permissions)) : {};
      } catch {
        permissions = {};
      }
      return {
        id: row.id,
        username: row.username,
        display_name: row.display_name,
        email: row.email,
        role: row.role,
        property_access: row.property_access_mode === "all"
          ? "all"
          : String(row.property_ids || "").split(",").filter(Boolean),
        permissions,
        is_active: row.is_active !== 0,
        is_locked: row.is_locked === 1,
      };
    });
    return jsonResponse({ users }, 200);
  }

  if (url.pathname === "/api/properties") {
    // The property roster itself is scoped by id ∈ set.
    const c = scopeConstraint(scope, "id");
    const rows = await queryAll(
      env,
      `SELECT id, code, name, rooms, city, state, active FROM property WHERE ${c.sql}`,
      c.params,
    );
    return jsonResponse({ properties: rows }, 200);
  }

  if (url.pathname === "/api/transactions") {
    const c = scopeConstraint(scope, "property_id");
    // Return rows; NO SQL SUM on the REAL `amount` column.
    const rows = await queryAll(
      env,
      `SELECT id, property_id, date, ledger_side, amount, folio_number, transaction_code ` +
        `FROM transaction_line WHERE ${c.sql} ORDER BY date LIMIT 500`,
      c.params,
    );
    return jsonResponse({ transactions: rows }, 200);
  }

  return jsonResponse({ error: "not found" }, 404);
}

// ---------------------------------------------------------------------------
// IMPORT HANDLER — one atomic, resumable, idempotent chunk per request.
// ---------------------------------------------------------------------------

/**
 * @param {Request} request
 * @param {Env} env
 * @param {import("./scope.js").Scope} scope
 * @returns {Promise<Response>}
 */
async function handleImport(request, env, scope) {
  if (request.method !== "POST") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }
  const role = String(scope.user.role || "").toLowerCase();
  if (!["owner", "admin", "gm", "manager"].includes(role)) {
    return jsonResponse({ error: "forbidden" }, 403);
  }
  /** @type {unknown} */
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }
  const parsed = parseChunk(body);
  if (parsed.ok === false) return jsonResponse({ error: parsed.error }, 400);

  const final = !!(body && typeof body === "object" && /** @type {Record<string, unknown>} */ (body).final === true);
  const result = await importChunk(env, scope, parsed.value, final);
  return jsonResponse(result.body, result.status);
}

// ---------------------------------------------------------------------------
// ROUTER — only /api/* is served. auth (401) -> scope (403) -> dispatch.
// ---------------------------------------------------------------------------

/**
 * @param {Request} request
 * @param {Env} env
 * @param {ExecutionContext} _ctx
 * @returns {Promise<Response>}
 */
async function handleRequest(request, env, _ctx) {
  const url = new URL(request.url);

  // This Worker owns the /api/* surface only. Nothing else is routed here.
  if (!url.pathname.startsWith("/api/")) {
    return jsonResponse({ error: "not found" }, 404);
  }

  if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method) && !sameOriginMutation(request)) {
    return jsonResponse({ error: "forbidden" }, 403);
  }

  if (url.pathname.startsWith("/api/auth/")) {
    return handleAppAuthRequest(request, env, url.pathname);
  }

  // App sessions are the primary identity and work in every browser profile.
  // Access JWTs remain a compatibility fallback for the existing staged API.
  let auth = await authenticateAppSession(request, env);
  if (auth.ok === false && !appSessionCookiePresent(request) && env.ACCESS_AUD && env.ACCESS_TEAM_DOMAIN) {
    auth = await authenticate(request, env);
  }
  if (auth.ok === false) {
    return jsonResponse({ authenticated: false, error: "unauthorized" }, 401);
  }

  // Resolve property scope; an unprovisioned or denied caller => 403.
  const scoped = await resolveScope(env, auth.principal);
  if (scoped.ok === false) {
    return jsonResponse({ error: scoped.error }, scoped.status);
  }

  const parts = url.pathname.split("/").filter(Boolean);
  const dataApiEnabled = env.ENABLE_D1_DATA_API === "true";
  const isBusinessDataRoute = url.pathname === "/api/import"
    || url.pathname === "/api/properties"
    || url.pathname === "/api/transactions"
    || parts[1] === "entities";
  if (isBusinessDataRoute && !dataApiEnabled) {
    return jsonResponse({ error: "D1 business-data storage is disabled" }, 404);
  }
  if (url.pathname === "/api/import") {
    return handleImport(request, env, scoped.scope);
  }
  if (parts[1] === "entities") {
    return handleEntityRequest(request, env, scoped.scope, parts);
  }
  if (parts[1] === "users") {
    return handleUsersRequest(request, env, scoped.scope, parts);
  }
  if (request.method !== "GET") return jsonResponse({ error: "method not allowed" }, 405);
  return handleRead(url, env, scoped.scope);
}

export default {
  /**
   * @param {Request} request
   * @param {Env} env
   * @param {ExecutionContext} ctx
   * @returns {Promise<Response>}
   */
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request, env, ctx);
    } catch (error) {
      console.error(JSON.stringify({
        message: "unhandled worker request failure",
        path: new URL(request.url).pathname,
        error: error instanceof Error ? error.message : String(error),
      }));
      return jsonResponse({ error: "internal server error" }, 500);
    }
  },
};
