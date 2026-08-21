// Probe for base44/functions/audit_list/entry.js — the ONLY read path for the
// audit log in production (src/api/base44Client.js#db.audit.list ->
// functions.invoke('audit_list'), consumed by src/pages/AuditLog.jsx).
//
// WHY THIS FILE WAS REWRITTEN (2026-08-20)
// The previous version was three console.logs and `process.exit(0)`. It could
// not fail. It also could not RUN: its first line was
//     import { testWorld } from './probe-auth-hardening.mjs';
// and probe-auth-hardening.mjs exports no such symbol, so every invocation died
// with "SyntaxError: does not provide an export named 'testWorld'" before
// reaching main(). Measured before this rewrite:
//     $ node scripts/probe-audit-list.mjs
//     SyntaxError: The requested module './probe-auth-hardening.mjs' does not
//     provide an export named 'testWorld'
// So the audit read path shipped with zero executed coverage.
//
// It runs the REAL entry file against the in-memory backend stub
// (scripts/stubs/base44-sdk.mjs), because the defects below live in the
// handler's own argument handling — a probe that mocked the handler would only
// prove the probe agrees with itself.
//
// Run: node scripts/probe-audit-list.mjs

import { register } from "node:module";
register(new URL("./resolve-base44.mjs", import.meta.url));

import crypto from "node:crypto";

const auditListFn = (await import("../base44/functions/audit_list/entry.js")).default;
const sdk = await import("./stubs/base44-sdk.mjs");

let pass = 0;
let fail = 0;
const T = (name, cond, detail = "") => {
  let ok = false;
  let thrown = "";
  try {
    ok = typeof cond === "function" ? !!cond() : !!cond;
  } catch (err) {
    thrown = ` threw ${err?.name}: ${err?.message}`;
  }
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}${thrown}`); }
};

const TOKEN = "probe_session_token";
const TOKEN_HASH = crypto.createHash("sha256").update(TOKEN).digest("hex");

const session = (user_id, over = {}) => ({
  user_id,
  token_hash: TOKEN_HASH,
  is_revoked: false,
  expires_at: new Date(Date.now() + 600000).toISOString(),
  ...over,
});

const req = (payload, token = TOKEN) => ({
  headers: new Headers(token ? { cookie: `base44_session=${token}` } : {}),
  json: async () => payload,
});

const body = async (res) => {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { __raw: text }; }
};

// Audit rows, deliberately interleaved across properties and NOT in date order,
// so an unsorted read is distinguishable from a newest-first read.
const auditRows = () => {
  const rows = [];
  const at = (d) => new Date(Date.UTC(2026, 1, d, 12, 0, 0)).toISOString();
  //             day  property   action
  const spec = [
    [5, "prop_1", "Login"],
    [1, "prop_2", "Login"],
    [9, "prop_2", "Failed Login"],
    [3, "prop_1", "Password Change"],
    [7, "prop_3", "User Created"],
    [2, "prop_2", "Login"],
    [8, "prop_1", "Import"],
    [4, "prop_3", "Login"],
    [6, "prop_2", "Role Change"],
  ];
  spec.forEach(([d, p, a], i) => {
    rows.push({
      id: `al_${i + 1}`,
      created_date: at(d),
      property_id: p,
      action: a,
      username: `u${i}@x.test`,
      result: a.startsWith("Failed") ? "failed" : "success",
    });
  });
  return rows;
};

// Rebuild the whole world per scenario so one scenario cannot leak into another.
const world = ({ role = "owner", property_access = "all", userOver = {}, sessionOver = {} } = {}) => {
  const tables = sdk.__installBackend({
    users: [{
      id: "u_actor",
      is_active: true,
      is_locked: false,
      role,
      property_access,
      ...userOver,
    }],
    sessions: [session("u_actor", sessionOver)],
    auditLog: auditRows(),
  });
  // Record what the handler actually asked the datastore for. The scoping and
  // ordering guarantees are properties of that call, so asserting only on the
  // returned rows would pass a handler that fetched everything and filtered in
  // JS — which is the bug pattern this file exists to catch.
  const real = tables.AuditLog.filter.bind(tables.AuditLog);
  const calls = [];
  tables.AuditLog.filter = async (q, sort, limit, offset) => {
    calls.push({ q, sort, limit, offset });
    return real(q, sort, limit, offset);
  };
  return { tables, calls };
};

const dates = (logs) => logs.map((l) => String(l.created_date).slice(0, 10));

// ── 1. Authentication and authorization gates ────────────────────────────────
console.log("\n=== 1. Auth gates ===");
{
  world();
  const r = await auditListFn(req({ filter: {} }, null));
  T("no session cookie -> 401", r.status === 401, `got ${r.status}`);
}
{
  world();
  const r = await auditListFn(req({ filter: {} }, "some_other_token"));
  T("unknown token -> 401", r.status === 401, `got ${r.status}`);
}
{
  world({ sessionOver: { is_revoked: true } });
  const r = await auditListFn(req({ filter: {} }));
  T("revoked session -> 401", r.status === 401, `got ${r.status}`);
}
{
  world({ sessionOver: { expires_at: new Date(Date.now() - 1000).toISOString() } });
  const r = await auditListFn(req({ filter: {} }));
  T("expired session -> 401", r.status === 401, `got ${r.status}`);
}
{
  world({ role: "manager" });
  const r = await auditListFn(req({ filter: {} }));
  T("manager role -> 403 (audit log is owner/admin only)", r.status === 403, `got ${r.status}`);
}
{
  world({ userOver: { is_active: false } });
  const r = await auditListFn(req({ filter: {} }));
  T("deactivated user -> 403", r.status === 403, `got ${r.status}`);
}
{
  world({ userOver: { is_locked: true } });
  const r = await auditListFn(req({ filter: {} }));
  T("locked user -> 403", r.status === 403, `got ${r.status}`);
}
{
  world();
  const r = await auditListFn(req({ filter: "not_an_object" }));
  T("string filter -> 400, not a 500 from the ORM", r.status === 400, `got ${r.status}`);
}
{
  world();
  const r = await auditListFn(req({ filter: ["a"] }));
  T("array filter -> 400", r.status === 400, `got ${r.status}`);
}

// ── 2. DEFECT: results came back in arbitrary order ──────────────────────────
// Measured before the fix, with the rows above:
//   AuditLog.filter(filter, null, limit, 0)   <- sort argument is null
//   -> 2026-02-05, 02-01, 02-09, 02-03, 02-07, 02-02, 02-08, 02-04, 02-06
// i.e. insertion order. Two consequences, both worse than untidy:
//   a) AuditLog.jsx renders rows in the order received, so "the audit log" read
//      top-to-bottom is not a timeline.
//   b) Combined with the limit, a truncated read returns an ARBITRARY subset
//      rather than the most recent events. An operator checking "what just
//      happened" would be shown an unrelated slice and told nothing was wrong.
console.log("\n=== 2. Newest-first ordering ===");
{
  const w = world();
  const r = await auditListFn(req({ filter: {} }));
  const b = await body(r);
  T("200 for an unrestricted owner", r.status === 200, `got ${r.status} ${JSON.stringify(b).slice(0, 200)}`);
  T("a sort key is passed to the datastore, not null",
    w.calls[0] && w.calls[0].sort === "-created_date",
    `sort=${JSON.stringify(w.calls[0]?.sort)}`);
  T("rows arrive newest-first",
    dates(b.logs || []).join(",") ===
      "2026-02-09,2026-02-08,2026-02-07,2026-02-06,2026-02-05,2026-02-04,2026-02-03,2026-02-02,2026-02-01",
    dates(b.logs || []).join(","));
}
{
  // The point of ordering: a truncated read must be the NEWEST rows.
  const w = world();
  const r = await auditListFn(req({ filter: {}, limit: 3 }));
  const b = await body(r);
  T("limit 3 returns the three most recent events",
    dates(b.logs || []).join(",") === "2026-02-09,2026-02-08,2026-02-07",
    dates(b.logs || []).join(","));
  T("truncation is reported, not silent", b.truncated === true, JSON.stringify({ truncated: b.truncated, count: b.count }));
  T("count matches the rows returned", b.count === 3, `count=${b.count}`);
  // The handler asks for limit + 1 and returns limit. The extra row is the
  // truncation probe: its presence is what distinguishes "exactly full" from
  // "more available", which `logs.length === limit` cannot do.
  T("the datastore is asked for one row beyond the limit", w.calls[0]?.limit === 4, `limit=${w.calls[0]?.limit}`);
  T("never more rows than the caller asked for", (b.logs || []).length === 3, `n=${(b.logs || []).length}`);
}
{
  const r = await (async () => { world(); return auditListFn(req({ filter: {}, limit: 500 })); })();
  const b = await body(r);
  T("a read that fits is not flagged as truncated", b.truncated === false, `truncated=${b.truncated}`);
}

// ── 3. DEFECT: a property-restricted admin could never read the audit log ─────
// src/pages/AuditLog.jsx calls db.audit.list({}, 100000) — no property_id, and
// the page has no way to know which properties the actor may see. The handler
// answered `400 "Bad Request: property_id filter is required"`, which the page
// renders as "Could not load the audit log." So for any admin whose
// property_access is an array, the audit log was permanently unreachable, while
// src/lib/permissions.js grants that same admin view_audit_logs by default.
//
// The fix scopes the query SERVER-side from the actor's own access list. The
// client never has to be trusted to send its own scope — which is the correct
// direction for a tenant boundary anyway.
console.log("\n=== 3. Property scoping is derived server-side ===");
{
  const w = world({ role: "admin", property_access: ["prop_2"] });
  const r = await auditListFn(req({ filter: {}, limit: 100000 }));
  const b = await body(r);
  T("restricted admin with no filter -> 200, not 400", r.status === 200,
    `got ${r.status} ${JSON.stringify(b).slice(0, 200)}`);
  T("the datastore query is scoped to the actor's property",
    w.calls[0]?.q?.property_id === "prop_2", JSON.stringify(w.calls[0]?.q));
  T("only that property's rows come back",
    (b.logs || []).length === 4 && (b.logs || []).every((l) => l.property_id === "prop_2"),
    JSON.stringify((b.logs || []).map((l) => l.property_id)));
  T("and they are still newest-first",
    dates(b.logs || []).join(",") === "2026-02-09,2026-02-06,2026-02-02,2026-02-01",
    dates(b.logs || []).join(","));
}
{
  const w = world({ role: "admin", property_access: ["prop_1", "prop_3"] });
  const r = await auditListFn(req({ filter: {} }));
  const b = await body(r);
  T("multi-property actor -> 200", r.status === 200, `got ${r.status}`);
  T("multi-property scope uses an $in set, not one arbitrary property",
    JSON.stringify(w.calls[0]?.q?.property_id) === JSON.stringify({ $in: ["prop_1", "prop_3"] }),
    JSON.stringify(w.calls[0]?.q));
  T("every row from BOTH permitted properties is returned",
    dates(b.logs || []).join(",") === "2026-02-08,2026-02-07,2026-02-05,2026-02-04,2026-02-03",
    dates(b.logs || []).join(","));
  T("no row from an unauthorized property is returned",
    (b.logs || []).length > 0 && (b.logs || []).every((l) => l.property_id !== "prop_2"),
    JSON.stringify((b.logs || []).map((l) => l.property_id)));
}
{
  // The negative case. An explicit cross-tenant request must still be refused —
  // scoping server-side must not degrade into silently rewriting the request.
  world({ role: "admin", property_access: ["prop_1"] });
  const r = await auditListFn(req({ filter: { property_id: "prop_2" } }));
  T("explicit cross-tenant property_id -> 403", r.status === 403, `got ${r.status}`);
}
{
  world({ role: "admin", property_access: ["prop_1"] });
  const r = await auditListFn(req({ filter: { property_id: { $in: ["prop_1", "prop_2"] } } }));
  const b = await body(r);
  T("a $in filter smuggling an unauthorized property -> 403", r.status === 403,
    `got ${r.status} ${JSON.stringify(b).slice(0, 160)}`);
}
{
  const w = world({ role: "admin", property_access: ["prop_1", "prop_2"] });
  const r = await auditListFn(req({ filter: { property_id: "prop_2" } }));
  const b = await body(r);
  T("an in-scope explicit property_id is honoured", r.status === 200, `got ${r.status}`);
  T("and narrows the query to just that property",
    w.calls[0]?.q?.property_id === "prop_2", JSON.stringify(w.calls[0]?.q));
  T("returning only its rows", (b.logs || []).every((l) => l.property_id === "prop_2"),
    JSON.stringify((b.logs || []).map((l) => l.property_id)));
}
{
  // property_access === 'all' and a null/absent value are both unrestricted;
  // only an ARRAY restricts. This mirrors base44/functions/aiAssistant/entry.ts.
  const w = world({ role: "admin", property_access: "all" });
  const r = await auditListFn(req({ filter: {} }));
  const b = await body(r);
  T("property_access 'all' is unrestricted", r.status === 200 && (b.logs || []).length === 9,
    `${r.status} n=${(b.logs || []).length}`);
  T("no property_id is injected for an unrestricted actor",
    w.calls[0]?.q?.property_id === undefined, JSON.stringify(w.calls[0]?.q));
}
{
  const w = world({ role: "owner", property_access: null });
  const r = await auditListFn(req({ filter: {} }));
  const b = await body(r);
  T("owner with null property_access is unrestricted", r.status === 200 && (b.logs || []).length === 9,
    `${r.status} n=${(b.logs || []).length}`);
  T("no injected scope for the owner", w.calls[0]?.q?.property_id === undefined,
    JSON.stringify(w.calls[0]?.q));
}
{
  // Fail CLOSED: an empty access array means access to nothing, and must not be
  // read as "no restriction".
  const w = world({ role: "admin", property_access: [] });
  const r = await auditListFn(req({ filter: {} }));
  const b = await body(r);
  T("empty property_access array returns no rows (fails closed)",
    r.status === 200 && (b.logs || []).length === 0,
    `${r.status} n=${(b.logs || []).length} q=${JSON.stringify(w.calls[0]?.q)}`);
  T("and does not query the datastore unscoped",
    w.calls.length === 0 || w.calls[0]?.q?.property_id !== undefined,
    JSON.stringify(w.calls[0]?.q));
}

// ── 4. DEFECT: `payload.limit || 500` trusted the client completely ──────────
// The page asks for 100000. A hostile or buggy caller could ask for 1e12 and
// the value went straight into the datastore call; `limit: -5` or `limit: "abc"`
// went in just as unchecked. A read path with no ceiling is a denial-of-service
// lever on the one table that is never allowed to be unavailable.
console.log("\n=== 4. limit is coerced and bounded ===");
{
  const w = world();
  await auditListFn(req({ filter: {}, limit: 1e12 }));
  T("an absurd limit is clamped, not forwarded",
    typeof w.calls[0]?.limit === "number" && w.calls[0].limit <= 100001,
    `limit=${w.calls[0]?.limit}`);
}
{
  const w = world();
  const r = await auditListFn(req({ filter: {}, limit: -5 }));
  T("a negative limit does not 500", r.status === 200, `got ${r.status}`);
  T("a negative limit is clamped to at least 1", (w.calls[0]?.limit ?? 0) >= 1, `limit=${w.calls[0]?.limit}`);
}
{
  const w = world();
  await auditListFn(req({ filter: {}, limit: "abc" }));
  T("a non-numeric limit falls back to the default, never NaN",
    Number.isFinite(w.calls[0]?.limit) && w.calls[0].limit > 0, `limit=${w.calls[0]?.limit}`);
}
{
  const w = world();
  await auditListFn(req({ filter: {}, limit: 4.7 }));
  T("a fractional limit is floored to an integer",
    Number.isInteger(w.calls[0]?.limit), `limit=${w.calls[0]?.limit}`);
}
{
  const w = world();
  await auditListFn(req({}));
  T("a missing limit uses the default", (w.calls[0]?.limit ?? 0) > 0, `limit=${w.calls[0]?.limit}`);
}
{
  const w = world();
  const r = await auditListFn(req({ filter: {}, limit: 100000 }));
  const b = await body(r);
  T("the page's own limit of 100000 is honoured (asked as 100001, capped on return)",
    w.calls[0]?.limit === 100001 && b.limit === 100000,
    `asked=${w.calls[0]?.limit} returned-limit=${b.limit}`);
}

// ── 5. Other filters still work, and offset is not injectable ────────────────
console.log("\n=== 5. Caller filters ===");
{
  const w = world();
  const r = await auditListFn(req({ filter: { action: "Login" } }));
  const b = await body(r);
  T("an action filter reaches the datastore", w.calls[0]?.q?.action === "Login",
    JSON.stringify(w.calls[0]?.q));
  T("only matching rows return", (b.logs || []).every((l) => l.action === "Login"),
    JSON.stringify((b.logs || []).map((l) => l.action)));
  T("filtered rows are newest-first too",
    dates(b.logs || []).join(",") === "2026-02-05,2026-02-04,2026-02-02,2026-02-01",
    dates(b.logs || []).join(","));
}
{
  const w = world();
  await auditListFn(req({ filter: {} }));
  T("offset stays 0 — this endpoint returns a single page", w.calls[0]?.offset === 0,
    `offset=${w.calls[0]?.offset}`);
}
{
  // A missing body must not become a 500. `req.json()` throwing is the shape a
  // GET or an empty POST arrives in.
  world();
  const r = await auditListFn({
    headers: new Headers({ cookie: `base44_session=${TOKEN}` }),
    json: async () => { throw new SyntaxError("Unexpected end of JSON input"); },
  });
  T("an unparseable body -> 400, not 500", r.status === 400, `got ${r.status}`);
}

// ── 6. The response shape src/api/base44Client.js depends on ────────────────
// db.audit.list() returns `res.logs || []`. If `logs` is ever renamed or nested,
// the page silently shows an empty audit log — the single most dangerous false
// statement this screen can make. base44Client.js is a PROTECTED file and cannot
// be adapted, so the contract is pinned here.
console.log("\n=== 6. Response contract ===");
{
  world();
  const r = await auditListFn(req({ filter: {} }));
  const b = await body(r);
  T("responds with success: true", b.success === true, JSON.stringify(b).slice(0, 120));
  T("logs is an array at the top level", Array.isArray(b.logs), typeof b.logs);
  T("every row keeps its id", (b.logs || []).every((l) => !!l.id));
  T("count is present and agrees with logs.length", b.count === (b.logs || []).length,
    `count=${b.count} n=${(b.logs || []).length}`);
}

console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
