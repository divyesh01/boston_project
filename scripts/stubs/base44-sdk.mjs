// Test stub for `npm:@base44/sdk` — enough of the SDK surface for the real
// serverless function entry files (base44/functions/*/entry.js) to run in plain
// Node against an in-memory entity store.
//
// Why a fake backend rather than mocking the functions themselves: the audit
// chain's correctness lives in those entry files, and there is no way to run
// them in this environment otherwise (`npm:` specifiers, `base44:runtime`, and a
// hosted entity API). Reimplementing the hashing in a probe would only prove the
// probe agrees with itself. This runs the shipped code.
//
// Deliberately faithful in the two places the chain depends on:
//   * `filter(query, sort, limit, offset)` supports '-field' descending sorts.
//   * rows carry a hidden monotonic insertion counter used ONLY as the sort
//     tie-breaker, so two rows written in the same millisecond come back in
//     insertion order instead of an arbitrary one. Without this the probe would
//     report chain breaks that are artefacts of the fake store.
//
// Deliberately NOT faithful: no auth, no validation, no property scoping. The
// handlers do all of that themselves and that is what is under test.

let installed = null;

// Query-value matching. Scalars compare as strings (the hosted API is loose about
// number-vs-string ids); `{ $in: [...] }` is the multi-value operator the real
// backend supports and that base44/functions/aiAssistant/entry.ts and
// base44/functions/audit_list/entry.js both build for multi-property scoping.
//
// Added 2026-08-20. Without $in here, a handler that correctly scopes a
// two-property actor to { $in: ["prop_1", "prop_3"] } matched ZERO rows in the
// stub, so a probe asserting "no unauthorized row is returned" passed on an empty
// result and proved nothing. A test double that cannot express the query under
// test converts a real assertion into a vacuous one.
function matches(cell, expected) {
  if (expected && typeof expected === "object" && !Array.isArray(expected)) {
    if (Array.isArray(expected.$in)) return expected.$in.some((v) => String(cell) === String(v));
    throw new Error(
      `base44 sdk stub: unsupported query operator ${JSON.stringify(Object.keys(expected))}`,
    );
  }
  return String(cell) === String(expected);
}

export function createClientFromRequest(_req) {
  if (!installed) throw new Error("base44 sdk stub: call __installBackend() first");
  return installed.client;
}

function makeTable(name, seed = []) {
  const rows = [];
  let seq = 0;
  let idSeq = 0;

  const push = (data) => {
    const row = { ...data };
    if (row.id === undefined || row.id === null) row.id = `${name.toLowerCase()}_${++idSeq}`;
    Object.defineProperty(row, "__seq", { value: ++seq, enumerable: false, writable: false });
    rows.push(row);
    return row;
  };

  seed.forEach(push);

  return {
    // ── SDK surface used by the functions ──
    async filter(query = {}, sort = null, limit = null, offset = 0) {
      let out = rows.filter((r) => Object.entries(query || {}).every(([k, v]) => matches(r[k], v)));
      if (sort) {
        const desc = sort.startsWith("-");
        const key = desc ? sort.slice(1) : sort;
        out = [...out].sort((a, b) => {
          const av = a[key] ?? "";
          const bv = b[key] ?? "";
          if (av !== bv) return (av < bv ? -1 : 1) * (desc ? -1 : 1);
          return (a.__seq - b.__seq) * (desc ? -1 : 1);
        });
      }
      const end = typeof limit === "number" ? offset + limit : undefined;
      return out.slice(offset, end).map((r) => ({ ...r }));
    },
    async get(id) {
      const r = rows.find((x) => String(x.id) === String(id));
      return r ? { ...r } : null;
    },
    async create(data) {
      return { ...push(data) };
    },
    async update(id, patch) {
      const r = rows.find((x) => String(x.id) === String(id));
      if (!r) throw new Error(`${name}.update: no row ${id}`);
      Object.assign(r, patch);
      return { ...r };
    },
    async delete(id) {
      const i = rows.findIndex((x) => String(x.id) === String(id));
      if (i >= 0) rows.splice(i, 1);
      return { success: true };
    },

    // ── Probe-only accessors (not part of the SDK) ──
    /** Live internal rows, for asserting on and for simulating DB-admin tampering. */
    __rows: () => rows,
  };
}

/**
 * Build a fake backend and install it as the client `createClientFromRequest`
 * hands to every function. Returns the tables so the probe can seed and inspect.
 */
export function __installBackend({ users = [], sessions = [], auditLog = [], rateLimits = [] } = {}) {
  const tables = {
    User: makeTable("User", users),
    Session: makeTable("Session", sessions),
    AuditLog: makeTable("AuditLog", auditLog),
    // custom_auth_login throttles per IP through this table before it looks a
    // user up, so a probe of the login path needs it to exist.
    RateLimit: makeTable("RateLimit", rateLimits),
  };

  // Outbound mail. custom_auth_register and custom_auth_reset_request send the
  // one-time secret this way, and both wrap the call in a try/catch — so without
  // a stub here the call throws "cannot read properties of undefined", is
  // swallowed, and a probe cannot tell a delivered token from a lost one.
  // Recorded rather than sent, so a probe can assert both that mail was
  // attempted and what was in it.
  const sentEmails = [];
  const integrations = {
    Core: {
      async SendEmail({ to, subject, body }) {
        sentEmails.push({ to, subject, body });
        return { status: "success" };
      },
    },
  };

  installed = {
    tables,
    client: {
      asServiceRole: { entities: tables, integrations },
      entities: tables,
      integrations,
    },
  };
  // Probe-only accessor, on the same object the tables come back on.
  tables.__emails = () => sentEmails;
  return tables;
}
