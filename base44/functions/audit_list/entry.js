import { createClientFromRequest } from "npm:@base44/sdk@^0.8.41";

// Audit-log read path. This is the ONLY way the audit log is read in production:
//   src/pages/AuditLog.jsx -> db.audit.list(filter, limit)
//   -> src/api/base44Client.js#audit.list -> functions.invoke('audit_list')
//
// Four defects were measured here on 2026-08-20 and fixed below; each is marked
// [FIX 1..4] at the code that addresses it. scripts/probe-audit-list.mjs
// reproduces all four against this file and is the regression gate — the probe
// that used to "cover" this endpoint could neither run nor fail (it imported a
// symbol that does not exist and ended in an unconditional process.exit(0)).
//
// Response contract, pinned: the caller reads `res.logs`. src/api/base44Client.js
// is a PROTECTED file (see PROTECTED_FILES.md) and cannot be adapted, so `logs`
// must stay an array at the top level. `count`, `truncated`, `limit` and `scope`
// are additive and ignored by the current client.

// A read path with no ceiling is a denial-of-service lever on the one table that
// must never be unavailable. 100000 is the value src/pages/AuditLog.jsx asks for,
// so it is the honest ceiling: high enough that no real deployment is truncated,
// bounded enough that `limit: 1e12` cannot be forwarded to the datastore.
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 100000;

// Every audit row carries created_date. Sorting descending on it is what makes a
// truncated read "the most recent events" instead of an arbitrary subset.
const AUDIT_SORT = "-created_date";

/**
 * Normalize a caller-supplied limit. Returns an integer in [1, MAX_LIMIT];
 * anything non-numeric falls back to DEFAULT_LIMIT rather than reaching the
 * datastore as NaN, "abc" or -5.
 */
function boundLimit(raw) {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(n)));
}

/**
 * Read the property scope the caller asked for out of their filter.
 *   undefined            -> null  ("everything I am allowed to see")
 *   "prop_1"             -> ["prop_1"]
 *   { $in: [...] }       -> [...]
 *   anything else        -> Error (rejected as a 400)
 * Accepting only these two shapes is deliberate: an unrecognized operator
 * ({ $ne }, { $regex }, a bare object) must not slip through the tenant check
 * and reach the datastore unexamined.
 */
function requestedProperties(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || typeof value === "number") return [String(value)];
  if (typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === "$in" && Array.isArray(value.$in)) {
      return value.$in.map(String);
    }
  }
  throw new Error("unsupported property_id filter");
}

/** One id -> scalar equality; many -> $in. Matches base44/functions/aiAssistant/entry.ts. */
function propertyFilterFor(ids) {
  return ids.length === 1 ? ids[0] : { $in: ids };
}

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);

    // Check caller authentication
    const cookieHeader = req.headers.get("cookie") || "";
    const match = cookieHeader.match(/base44_session=([^;]+)/);
    const token = match ? match[1] : null;

    if (!token) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const crypto = await import('node:crypto');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const sessions = await base44.asServiceRole.entities.Session.filter({ token_hash: tokenHash }, null, 1, 0);
    const session = sessions[0];

    if (!session || session.is_revoked || new Date(session.expires_at) < new Date()) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const actor = await base44.asServiceRole.entities.User.get(session.user_id);
    if (!actor || !actor.is_active || actor.is_locked || (actor.role !== 'owner' && actor.role !== 'admin')) {
      return Response.json({ error: "Forbidden: Only owners and admins can list audit logs" }, { status: 403 });
    }

    // [FIX 4a] `await req.json()` on an empty or malformed body throws, and the
    // catch-all below turned that into a 500 "Internal server error" — which
    // reads as a broken server rather than a bad request, and is what an
    // operator would escalate on.
    let payload;
    try {
      payload = await req.json();
    } catch {
      return Response.json({ error: "Bad Request: body must be JSON" }, { status: 400 });
    }
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      return Response.json({ error: "Bad Request: body must be a JSON object" }, { status: 400 });
    }

    const filter = payload.filter || {};

    if (typeof filter !== 'object' || filter === null || Array.isArray(filter)) {
      return Response.json({ error: "Bad Request: filter must be an object" }, { status: 400 });
    }

    // [FIX 2] Property scoping is derived from the ACTOR, server-side.
    //
    // Before: a caller whose property_access was an array had to send its own
    // property_id or receive `400 "Bad Request: property_id filter is required"`.
    // src/pages/AuditLog.jsx calls db.audit.list({}, 100000) — it has no way to
    // know the actor's access list — so every property-restricted admin got a
    // hard 400 and the page rendered "Could not load the audit log." Meanwhile
    // src/lib/permissions.js grants admin view_audit_logs by default, so the
    // permission was real and the screen was unreachable.
    //
    // Deriving the scope here is also the correct direction for a tenant
    // boundary: the client is never trusted to declare which tenant it is. An
    // explicit in-scope property_id still narrows the read, and an explicit
    // out-of-scope one is still refused with 403 — scoping server-side must not
    // degrade into silently rewriting a request the caller is not allowed to make.
    //
    // Access rules (same as base44/functions/aiAssistant/entry.ts): 'all', null,
    // or any non-array value is unrestricted; an ARRAY restricts to its members.
    // Divergence, deliberate: aiAssistant treats owner/admin as root roles that
    // override property_access. This endpoint does not — if an owner's
    // property_access is an array, the array wins. The audit log is the forensic
    // record, so where the two readings disagree this one fails closed.
    const restricted = Array.isArray(actor.property_access);
    const allowed = restricted ? actor.property_access.map(String) : null;

    let requested;
    try {
      requested = requestedProperties(filter.property_id);
    } catch {
      return Response.json(
        { error: "Bad Request: property_id must be an id or { $in: [...] }" },
        { status: 400 },
      );
    }

    const effectiveFilter = { ...filter };

    if (restricted) {
      if (requested) {
        const denied = requested.filter((id) => !allowed.includes(id));
        if (denied.length > 0) {
          return Response.json({ error: "Forbidden: cross-tenant access denied" }, { status: 403 });
        }
      }
      const scope = requested || allowed;
      if (scope.length === 0) {
        // An empty access array means access to nothing. Reading it as "no
        // restriction" would hand a locked-down account the entire audit log, so
        // this returns empty WITHOUT querying rather than falling through.
        return Response.json({
          success: true, logs: [], count: 0, truncated: false,
          limit: boundLimit(payload.limit), scope: [],
        });
      }
      effectiveFilter.property_id = propertyFilterFor(scope);
    }

    // [FIX 3] `payload.limit || 500` forwarded whatever the caller sent.
    const limit = boundLimit(payload.limit);

    // [FIX 1] Sort was `null`, so rows came back in datastore/insertion order.
    // Two consequences, both worse than untidy: the page renders rows in the
    // order received, so the "audit log" read top-to-bottom was not a timeline;
    // and a truncated read returned an ARBITRARY subset rather than the newest
    // events, so an operator checking "what just happened" could be shown an
    // unrelated slice and conclude nothing had.
    //
    // [FIX 4b] Ask for one row more than we return. If that extra row exists the
    // read was truncated, and we can say so exactly instead of guessing from
    // `logs.length === limit` (which cannot distinguish "exactly full" from
    // "more available"). Silent truncation on an audit view is the same class of
    // lie as an empty table on a failed read.
    const fetched = await base44.asServiceRole.entities.AuditLog.filter(
      effectiveFilter,
      AUDIT_SORT,
      limit + 1,
      0,
    );

    const truncated = Array.isArray(fetched) && fetched.length > limit;
    const logs = truncated ? fetched.slice(0, limit) : (fetched || []);

    return Response.json({
      success: true,
      logs,
      count: logs.length,
      truncated,
      limit,
      scope: allowed ?? "all",
    });

  } catch (err) {
    console.error("Audit list error:", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
