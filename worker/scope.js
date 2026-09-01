// ===========================================================================
// worker/scope.js — fail-closed, default-deny property scope resolution.
//
// Given a VERIFIED principal (from worker/auth.js), decide which property ids
// the caller may touch. The database is the source of truth; there is no
// auto-provisioning and no implicit "all".
//
//   * Unknown email                    => DENY (403). Never create a user.
//   * role owner|admin|gm              => ALL ACCOUNT property ids.
//   * property_access_mode = 'all'     => ALL property ids.
//   * property_access_mode = 'specific'=> ONLY the ids in user_property_access
//                                         (zero grants => empty set => sees
//                                         nothing; still fail-closed).
//
// Every scoped read/aggregate/join/import MUST be constrained through
// `scopeConstraint()` (which yields `1 = 0` for the empty set) or checked with
// `assertPropertyInScope()`. The `property` roster itself is scoped by id.
//
// No import from src/ — Cloudflare Workers runtime.
// ===========================================================================

import { queryFirst, queryAll, inClause } from "./db.js";

/**
 * @typedef {import("./index.js").Env} Env
 * @typedef {import("./index.js").Principal} Principal
 */

/**
 * The user row we need for scope decisions.
 * @typedef {Object} ScopeUser
 * @property {string} id
 * @property {string} account_id
 * @property {string} email
 * @property {string} role
 * @property {'all'|'specific'} property_access_mode
 * @property {string|null} [username]
 * @property {string|null} [display_name]
 * @property {string|null} permissions
 * @property {number|null} is_active
 * @property {number|null} is_locked
 * @property {number|null} must_change_password
 */

/**
 * A resolved scope. `propertyIds` is ALWAYS a concrete set (materialized even
 * for 'all'), so callers never branch on a magic value.
 * @typedef {Object} Scope
 * @property {ScopeUser} user
 * @property {string} accountId
 * @property {boolean} all       True when the caller is unrestricted (owner/admin/'all').
 * @property {string[]} propertyIds
 */

/**
 * @typedef {{ ok: true, scope: Scope } | { ok: false, status: number, error: string }} ScopeResult
 */

/** Roles that are always unrestricted, regardless of the stored access mode. */
const UNRESTRICTED_ROLES = new Set(["owner", "admin", "gm"]);

/** Thrown by assertPropertyInScope; caught by handlers and mapped to 403. */
export class ScopeError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "ScopeError";
  }
}

/**
 * Resolve the caller's property scope from D1.
 * @param {Env} env
 * @param {Principal} principal
 * @returns {Promise<ScopeResult>}
 */
export async function resolveScope(env, principal) {
  const user = await queryFirst(
    env,
    "SELECT id, account_id, username, display_name, email, role, property_access_mode, permissions, is_active, is_locked, must_change_password FROM user WHERE lower(email) = lower(?) LIMIT 1",
    [principal.email],
  );
  const u = /** @type {ScopeUser | null} */ (user);
  // Unknown email => deny. NO auto-provisioning.
  if (!u) return { ok: false, status: 403, error: "user not provisioned" };

  const role = String(u.role || "").toLowerCase();
  if (!role) return { ok: false, status: 403, error: "user role is not authorized" };
  if (u.is_active === 0) return { ok: false, status: 403, error: "user is inactive" };
  if (u.is_locked === 1) return { ok: false, status: 423, error: "user is locked" };
  const accountId = String(u.account_id || "");
  if (!accountId) return { ok: false, status: 403, error: "user has no account assignment" };
  const unrestricted = UNRESTRICTED_ROLES.has(role) || u.property_access_mode === "all";

  if (unrestricted) {
    const rows = await queryAll(env, "SELECT id FROM property WHERE account_id = ?", [accountId]);
    const ids = rows.map((r) => String(/** @type {{ id: unknown }} */ (r).id));
    return { ok: true, scope: { user: u, accountId, all: true, propertyIds: ids } };
  }

  // 'specific' — only explicitly granted ids. Zero grants => empty set.
  const grants = await queryAll(
    env,
    "SELECT property_id FROM user_property_access WHERE account_id = ? AND user_id = ?",
    [accountId, u.id],
  );
  const ids = grants.map((r) => String(/** @type {{ property_id: unknown }} */ (r).property_id));
  return { ok: true, scope: { user: u, accountId, all: false, propertyIds: ids } };
}

/**
 * Build a `property_id IN (…)` constraint for the resolved scope. An empty set
 * yields `1 = 0` (matches nothing) — the fail-closed default.
 * @param {Scope} scope
 * @param {string} [column]
 * @returns {{ sql: string, params: string[] }}
 */
export function scopeConstraint(scope, column = "property_id") {
  return inClause(column, scope.propertyIds);
}

/**
 * Throw if `propertyId` is not in the resolved scope. Handlers catch ScopeError
 * and return 403 — this NEVER silently allows.
 * @param {Scope} scope
 * @param {string} propertyId
 * @returns {void}
 */
export function assertPropertyInScope(scope, propertyId) {
  if (!scope.propertyIds.includes(propertyId)) {
    throw new ScopeError(`property ${propertyId} is outside caller scope`);
  }
}

/**
 * Project the resolved scope back to the legacy client shape
 * (`'all' | string[]`). NOT wired to any client this phase; provided for
 * eventual Phase-2 consumption.
 * @param {ScopeUser} _user
 * @param {Scope} scope
 * @returns {'all' | string[]}
 */
export function projectLegacyPropertyAccess(_user, scope) {
  return scope.all ? "all" : [...scope.propertyIds];
}
