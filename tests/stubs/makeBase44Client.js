// tests/stubs/makeBase44Client.js
//
// SHARED TEST-DOUBLE FACTORY
// ==========================
// Previously, every backend test file (all_endpoints, deleteAccount,
// aiAssistant) hand-rolled its own makeClient() and makeEntities().  That
// meant:
//   1. When Base44 adds a new entity method, 3+ files need updating.
//   2. A missing method in one file silently masquerades as a broken endpoint
//      (the original all_endpoints regression — see the header of that file).
//   3. Per-test state leaks were possible because each file invented its own
//      state management.
//
// This factory is the single, authoritative double for the Base44 SDK client.
// Each test file imports makeClient() and makeStore() instead of building its
// own. Per-test overrides still work: pass a partial override object, or
// vi.doMock('npm:@base44/sdk@^0.8.41', ...) for test-specific behaviour.
//
// METHODS IMPLEMENTED (surface area the functions actually call):
//
//   base44.asServiceRole.entities.Session.filter(predicate, sort, limit, offset)
//   base44.asServiceRole.entities.User.get(id)
//   base44.asServiceRole.entities.AuditLog.filter(predicate, sort, limit, offset)
//   base44.asServiceRole.entities.AuditLog.create(row)
//   base44.asServiceRole.entities.RateLimit.filter / create / update
//   base44.asServiceRole.integrations.Core.InvokeLLM()
//   base44.asServiceRole.connectors.getConnection(name)
//   base44.integrations.Core.InvokeLLM()
//   base44.integrations.Core.UploadFile(args)
//   base44.entities[name].filter(predicate, sort, limit, offset)
//   base44.entities[name].delete(id)
//   base44.entities[name].create(row)
//
// INTENTIONALLY ABSENT:
//   .list()  — if any function regresses to .list() the test throws
//              "TypeError: list is not a function" at the call site, which is a
//              loud failure rather than a silent wrong answer. Any function that
//              legitimately needs .list() on a data entity has a bug (see the
//              deleteAccount pagination fix); add it only with a documented reason.

/**
 * Create a fresh per-test state store. Call this inside beforeEach.
 *
 * @param {object} [overrides] - Per-test initial values. Supported keys:
 *   session, user, rateLimitRows, auditRows, and any entity name from DATA_ENTITIES.
 */
export function makeStore(overrides = {}) {
  return {
    session: { user_id: "123", is_revoked: false, expires_at: "2099-01-01T00:00:00.000Z" },
    user: { id: "123", is_active: true, is_locked: false, role: "admin", property_access: "all" },
    rateLimitRows: [],
    auditRows: [],
    // Data entities — each test populates as needed.
    OccupancyDay:     [],
    SourceDay:        [],
    GrossRevenueDay:  [],
    ClerkShiftRecord: [],
    UploadedReport:   [],
    Staff:            [],
    PayrollRun:       [],
    TimecardPunch:    [],
    Property:         [],
    ...overrides,
  };
}

// Names of data entities exposed on base44.entities (the write path).
// These are the entities backend functions filter/delete on behalf of a user.
const DATA_ENTITIES = [
  "OccupancyDay",
  "SourceDay",
  "GrossRevenueDay",
  "ClerkShiftRecord",
  "UploadedReport",
  "Staff",
  "PayrollRun",
  "TimecardPunch",
  "Property",
];

/**
 * Build a Base44 SDK client double backed by `store`.
 *
 * @param {object} store - The store returned by makeStore().
 * @param {object} [methodOverrides] - Optional overrides for any top-level method.
 *   Keys may be "asServiceRole", "entities", or "integrations" — merged shallowly.
 */
export function makeClient(store, methodOverrides = {}) {
  // ── Entity double factory ────────────────────────────────────────────────
  //
  // Builds a CRUD double for a named entity backed by store[name].
  // The double intentionally does NOT implement .list() — see header.
  function entityDouble(name) {
    return {
      filter: async (predicate, _sort, limit, _offset) => {
        let rows = store[name] || [];
        if (predicate && typeof predicate === "object") {
          for (const [k, v] of Object.entries(predicate)) {
            rows = rows.filter(r => r[k] === v);
          }
        }
        return rows.slice(0, limit ?? rows.length);
      },
      get: async (id) => (store[name] || []).find(r => r.id === id) ?? null,
      create: async (row) => {
        const saved = { id: `${name}-${Date.now()}-${Math.random()}`, ...row };
        if (!store[name]) store[name] = [];
        store[name].push(saved);
        return saved;
      },
      update: async (id, patch) => {
        const idx = (store[name] || []).findIndex(r => r.id === id);
        if (idx !== -1) store[name][idx] = { ...store[name][idx], ...patch };
        return store[name]?.[idx] ?? null;
      },
      delete: async (id) => {
        const before = (store[name] || []).length;
        store[name] = (store[name] || []).filter(r => r.id !== id);
        if (store[name].length === before) {
          throw new Error(`[makeBase44Client] No row with id=${id} in ${name}`);
        }
      },
    };
  }

  // ── asServiceRole.entities ───────────────────────────────────────────────
  const serviceEntities = {
    Session: {
      filter: async () => (store.session ? [store.session] : []),
    },
    User: {
      get: async () => store.user,
    },
    RateLimit: {
      filter: async () => store.rateLimitRows,
      create: async (row) => {
        const saved = { id: `rl-${store.rateLimitRows.length + 1}`, ...row };
        store.rateLimitRows = [saved];
        return saved;
      },
      update: async () => ({}),
    },
    AuditLog: {
      // Returns the MOST RECENT row as a single-item array (mirrors production
      // AuditLog.filter({}, '-created_date', 1, 0) for chain linking).
      filter: async (_pred, _sort, limit) => {
        const rows = [...store.auditRows].reverse();
        return limit ? rows.slice(0, limit) : rows;
      },
      create: async (row) => {
        const saved = { id: `audit-${store.auditRows.length + 1}`, ...row };
        store.auditRows.push(saved);
        return saved;
      },
    },
    // Data entities exposed via asServiceRole for cron / admin reads.
    ...Object.fromEntries(DATA_ENTITIES.map(n => [n, entityDouble(n)])),
  };

  // ── base44.entities (write path — filter + delete) ───────────────────────
  const dataEntities = Object.fromEntries(
    DATA_ENTITIES.map(n => [n, entityDouble(n)])
  );

  const client = {
    asServiceRole: {
      entities: serviceEntities,
      integrations: {
        Core: { InvokeLLM: async () => "Mock LLM answer" },
      },
      connectors: {
        getConnection: async (name) => ({
          accessToken: `mock-access-token-for:${name}`,
        }),
      },
    },
    entities: dataEntities,
    integrations: {
      Core: {
        InvokeLLM: async () => "Mock LLM answer",
        UploadFile: async ({ file }) => ({
          file_url: `https://cdn.example.com/mock/${file?.name ?? "file"}`,
        }),
      },
    },
    ...methodOverrides,
  };

  return client;
}
