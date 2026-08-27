// Server-side property-scope enforcement for the aiAssistant function.
//
// The aiAssistant summary is built entirely from the `synthetic` aggregate rows
// the CLIENT posts. The request also carries a propertyId that we authorize
// against the caller's property_access — but that check only guards the STATED
// scope, not the rows themselves. A restricted user could request a property
// they are allowed to see while posting another property's rows in `synthetic`,
// and the summary would report the other property's money.
//
// This module makes the caller's allowed-property set load-bearing: it resolves
// the set from the session User and drops every synthetic row whose property_id
// is not inside it. An unrestricted caller (owner/admin, or property_access
// 'all') resolves to `null` and the rows pass through untouched — so the happy
// path is byte-identical and only cross-property smuggling is removed.

// Unrestricted sentinel. Callers MUST treat null as "keep everything" and an
// empty Set as "keep nothing" (fail-closed), matching src/lib/aiEngine.js.
const UNRESTRICTED = null;

// Every array field the aiAssistant summary reads out of `synthetic`.
const ROW_FIELDS = ["occRows", "srcRows", "payRows", "expenseRows", "payroll", "clerkRecords", "uploads"];

/**
 * Resolve the set of property_id strings a user may read, or null when
 * unrestricted. Fail-closed: a non-root account with a missing or non-array
 * property_access resolves to an EMPTY Set (no access), matching the frontend
 * default and aiEngine.js.
 * @param {{ role?: string, property_access?: unknown }} user
 * @returns {Set<string> | null}
 */
export function resolveAllowedIds(user) {
  const isRoot = user?.role === "owner" || user?.role === "admin";
  if (isRoot || user?.property_access === "all") return UNRESTRICTED;
  return new Set(Array.isArray(user?.property_access) ? user.property_access.map(String) : []);
}

/**
 * Return a copy of `synthetic` with every row array narrowed to the allowed
 * property set. `allowedIds === null` (unrestricted) returns the input object
 * untouched. Rows whose property_id is not in the set — including rows with a
 * missing/blank property_id — are dropped for restricted callers (fail-closed).
 * @param {Record<string, unknown> | null | undefined} synthetic
 * @param {Set<string> | null} allowedIds
 * @returns {Record<string, unknown>}
 */
export function scopeSyntheticRows(synthetic, allowedIds) {
  const src = synthetic || {};
  if (allowedIds === UNRESTRICTED) return src;
  const keep = (r) => allowedIds.has(String(r?.property_id ?? ""));
  const out = { ...src };
  for (const field of ROW_FIELDS) {
    if (Array.isArray(src[field])) out[field] = src[field].filter(keep);
  }
  return out;
}
