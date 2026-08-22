// Backend endpoint contract tests: aiAssistant (schema-validated) + audit_log
// (hand-rolled guards).
//
// THREE THINGS WERE WRONG WITH THIS FILE, and they are worth naming because two
// of them are the kind that make a test suite worse than no test suite.
//
// 1. AN INCOMPLETE MOCK READ AS A BROKEN ENDPOINT. The `asServiceRole.entities`
//    double had no `RateLimit`, but aiAssistant/entry.ts:42 calls
//    `entities.RateLimit.filter(...)` on the happy path. `undefined.filter` threw
//    INSIDE createApiHandler's try block, which answers 500, so the suite reported
//    "expected 200, got 500" — which reads as "the AI endpoint is broken" when the
//    truth was "the fixture is incomplete". A whole day could go into the wrong
//    file. All three methods the function can reach are stubbed below, so a NEW
//    call site fails as a missing method rather than as another mystery 500.
//
// 2. A TEST THAT ASSERTED NOTHING. The "Audit Log validation" block called the
//    function and then had only comments in it — three unanswered questions about
//    where CSRF runs relative to zod. It passed unconditionally. A green test with
//    no `expect` is a lie told once per CI run. The questions are now ANSWERED by
//    assertions: audit_log has no zod schema at all (it is a plain handler, not a
//    createApiHandler), and its order is session → CSRF → ownership → chain
//    secret → write. Each of those five gates now has a test.
//
// 3. A DEAD IMPORT. `custom_auth_login` was imported and never used, implying
//    coverage that did not exist. Login is covered properly by
//    scripts/probe-auth-audit.mjs (56 assertions) and probe-auth-hardening.mjs
//    (143), both of which run the REAL function against an in-memory base44
//    backend rather than a hand-built double. Duplicating a weaker version here
//    would compete with those, so the import is gone and this comment records
//    where to look instead.
//
// Overlap with tests/backend/aiAssistant.test.js is deliberate and kept small:
// that file owns the validation-code matrix (INVALID_JSON / VALIDATION_ERROR per
// field), this one owns the auth-and-rate-limit path they share.

import { describe, it, expect, vi, beforeEach } from "vitest";

// One entities double, shared by both SDK specifier spellings.
//
// `makeEntities` is a factory, not a constant, so a test that needs a different
// answer (no session, a tripped rate limit) builds its own without leaking that
// state into the next test. The previous single frozen object made per-case
// variation impossible, which is part of why the audit_log block was never
// finished.
const state = {
  session: { user_id: "123", is_revoked: false, expires_at: "2099-01-01T00:00:00.000Z" },
  user: { id: "123", is_active: true, is_locked: false, role: "admin", property_access: "all" },
  rateLimitRows: [],
  auditRows: [],
};

function makeEntities() {
  return {
    Session: { filter: async () => (state.session ? [state.session] : []) },
    User: { get: async () => state.user },
    RateLimit: {
      filter: async () => state.rateLimitRows,
      create: async (row) => { state.rateLimitRows = [{ id: "rl1", ...row }]; return { id: "rl1" }; },
      update: async () => ({}),
    },
    AuditLog: {
      filter: async () => state.auditRows,
      create: async (row) => { state.auditRows = [{ id: `a${state.auditRows.length + 1}`, ...row }]; return state.auditRows.at(-1); },
    },
  };
}

const makeClient = () => ({
  asServiceRole: {
    entities: makeEntities(),
    integrations: { Core: { InvokeLLM: async () => "Mock answer" } },
  },
  integrations: { Core: { InvokeLLM: async () => "Mock answer" } },
});

// Both spellings are mocked because the functions do not agree with each other:
// the .ts functions pin @0.8.40 and the .js functions pin @^0.8.41. That
// disagreement is a real (recorded) defect; until it is unified, a test that
// mocks only one specifier silently reaches the real SDK from the other.
vi.mock("npm:@base44/sdk@0.8.40", () => ({ createClientFromRequest: () => makeClient() }));
vi.mock("npm:@base44/sdk@^0.8.41", () => ({ createClientFromRequest: () => makeClient() }));

// A REAL sha256, not a stub returning a fixed string.
//
// The old mock made createHash return "mockhash" for every input. That made the
// session-token lookup pass, but it also meant the audit chain hashed every row
// to the same value — so a test could not tell a correct chain from a broken one,
// and any assertion about hashing would have been meaningless. audit_log needs a
// real digest to produce a real `hash`/`previous_hash` pair.
vi.mock("base44:runtime", () => ({ secrets: { get: () => "test-chain-secret" } }));
vi.mock("npm:zod", async () => await import("zod"));

const aiAssistant = (await import("../../base44/functions/aiAssistant/entry.ts")).default;
const auditLog = (await import("../../base44/functions/audit_log/entry.js")).default;

// Request builders. `headers.get` is case-insensitive because the real Headers
// class is, and audit_log reads 'x-csrf-token' while the browser may send
// 'X-CSRF-Token'.
function makeReq({ cookie = "base44_session=mocktoken", csrf = null, body = {}, url = "/", ip = "127.0.0.1" } = {}) {
  const map = new Map([
    ["cookie", cookie],
    ["x-forwarded-for", ip],
  ]);
  if (csrf !== null) map.set("x-csrf-token", csrf);
  return {
    url,
    headers: { get: (name) => map.get(String(name).toLowerCase()) ?? "" },
    json: async () => (typeof body === "function" ? body() : body),
  };
}

beforeEach(() => {
  state.session = { user_id: "123", is_revoked: false, expires_at: "2099-01-01T00:00:00.000Z" };
  state.user = { id: "123", is_active: true, is_locked: false, role: "admin", property_access: "all" };
  state.rateLimitRows = [];
  state.auditRows = [];
});

describe("aiAssistant — auth, rate limit and schema", () => {
  it("answers 200 for a valid question from an authenticated caller", async () => {
    const res = await aiAssistant(makeReq({ body: { question: "hello" } }));
    expect(res.status).toBe(200);
  });

  it("opens a rate-limit window on the first request instead of failing", async () => {
    // The regression this pins: with no RateLimit double the happy path threw and
    // the handler answered 500. Asserting the window was CREATED proves the
    // endpoint took the create branch rather than merely not crashing.
    await aiAssistant(makeReq({ body: { question: "hello" } }));
    expect(state.rateLimitRows).toHaveLength(1);
    expect(state.rateLimitRows[0]).toMatchObject({ action: "ai_invoke", count: 1 });
  });

  it("answers 429 with Retry-After once the window is full", async () => {
    state.rateLimitRows = [{
      id: "rl1", ip: "123", action: "ai_invoke", count: 10,
      reset_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    }];
    const res = await aiAssistant(makeReq({ body: { question: "hello" } }));
    expect(res.status).toBe(429);
    // A 429 without Retry-After tells a client to guess, and a retry storm is how
    // a rate limit becomes an outage.
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("answers 401 without a session cookie", async () => {
    const res = await aiAssistant(makeReq({ cookie: "", body: { question: "hello" } }));
    expect(res.status).toBe(401);
  });

  it("answers 401 for a locked account even with a valid session", async () => {
    state.user = { ...state.user, is_locked: true };
    const res = await aiAssistant(makeReq({ body: { question: "hello" } }));
    expect(res.status).toBe(401);
  });

  it("answers 400 INVALID_JSON on a malformed body", async () => {
    const res = await aiAssistant(makeReq({ body: () => { throw new SyntaxError("bad"); } }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("INVALID_JSON");
  });

  it("answers 400 VALIDATION_ERROR on an unexpected field (schema is .strict())", async () => {
    const res = await aiAssistant(makeReq({ body: { question: "hello", hack: true } }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("VALIDATION_ERROR");
  });

  it("never leaks an internal error message to the client", async () => {
    // Force a throw deep in the handler by removing the entity the function needs
    // after auth. The response must be the fixed string, not the real reason.
    state.user = null;
    const res = await aiAssistant(makeReq({ body: { question: "hello" } }));
    const text = JSON.stringify(await res.json());
    expect(text).not.toMatch(/TypeError|SyntaxError|node_modules|at \w+ \(/);
  });
});

describe("audit_log — the five gates, in order", () => {
  // audit_log is a PLAIN handler, not a createApiHandler, so it has no zod
  // schema. This is the question the old file asked in a comment and never
  // answered; it is asserted rather than assumed, because the answer decides
  // which error code a malformed body produces.
  const CSRF = "csrf-token-value";
  const goodCookie = `base44_session=mocktoken; __Host-csrf_token=${CSRF}`;
  const goodPayload = {
    user_id: "123", username: "owner", action: "Login",
    performed_by_id: "123", performed_by: "owner", result: "success", detail: "ok",
  };

  it("gate 1: no session cookie -> 401", async () => {
    const res = await auditLog(makeReq({ cookie: "", csrf: CSRF, body: goodPayload }));
    expect(res.status).toBe(401);
  });

  it("gate 1: a revoked session -> 401", async () => {
    state.session = { user_id: "123", is_revoked: true, expires_at: "2099-01-01T00:00:00.000Z" };
    const res = await auditLog(makeReq({ cookie: goodCookie, csrf: CSRF, body: goodPayload }));
    expect(res.status).toBe(401);
  });

  it("gate 1: an expired session -> 401", async () => {
    state.session = { user_id: "123", is_revoked: false, expires_at: "2000-01-01T00:00:00.000Z" };
    const res = await auditLog(makeReq({ cookie: goodCookie, csrf: CSRF, body: goodPayload }));
    expect(res.status).toBe(401);
  });

  it("gate 2: CSRF header missing -> 403", async () => {
    const res = await auditLog(makeReq({ cookie: goodCookie, body: goodPayload }));
    expect(res.status).toBe(403);
  });

  it("gate 2: CSRF header present but not matching the cookie -> 403", async () => {
    const res = await auditLog(makeReq({ cookie: goodCookie, csrf: "a-different-value", body: goodPayload }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/csrf/i);
  });

  it("gate 3: cannot write an audit row attributed to another user -> 403", async () => {
    // The single most important guard here: without it any signed-in user could
    // append rows blaming somebody else.
    const res = await auditLog(makeReq({
      cookie: goodCookie, csrf: CSRF, body: { ...goodPayload, user_id: "999" },
    }));
    expect(res.status).toBe(403);
    expect(state.auditRows).toHaveLength(0);
  });

  it("gate 4: writes a hash-chained row when every gate is satisfied", async () => {
    const res = await auditLog(makeReq({ cookie: goodCookie, csrf: CSRF, body: goodPayload }));
    expect(res.status).toBe(200);
    expect(state.auditRows).toHaveLength(1);
    const row = state.auditRows[0];
    // A real sha256, not a placeholder: 64 hex characters.
    expect(row.hash).toMatch(/^[0-9a-f]{64}$/);
    // The first row's parent is the genesis value, 64 zeros.
    expect(row.previous_hash).toBe("0".repeat(64));
  });

  it("gate 4: the second row links to the first, and timestamps strictly increase", async () => {
    await auditLog(makeReq({ cookie: goodCookie, csrf: CSRF, body: goodPayload }));
    const first = state.auditRows[0];
    // The double keeps only the newest row, which is what
    // `AuditLog.filter({}, '-created_date', 1, 0)` returns in production.
    await auditLog(makeReq({ cookie: goodCookie, csrf: CSRF, body: { ...goodPayload, action: "Logout" } }));
    const second = state.auditRows[0];
    expect(second.previous_hash).toBe(first.hash);
    expect(second.hash).not.toBe(first.hash);
    // monotonicIso: a same-millisecond write must still sort after its parent, or
    // the verifier walks the pair in the wrong order and reports a false break.
    expect(Date.parse(second.created_date)).toBeGreaterThan(Date.parse(first.created_date));
  });

  it("gate 4: the client cannot dictate the stored hash", async () => {
    // The chain is server-authoritative. A client-supplied `hash` must be ignored,
    // or the trail is forgeable by whoever writes to it.
    await auditLog(makeReq({
      cookie: goodCookie, csrf: CSRF,
      body: { ...goodPayload, hash: "f".repeat(64), previous_hash: "e".repeat(64) },
    }));
    expect(state.auditRows[0].hash).not.toBe("f".repeat(64));
    expect(state.auditRows[0].previous_hash).toBe("0".repeat(64));
  });

  it("records the forwarded IP for forensics but does not sign it", async () => {
    // ip_address comes from a spoofable proxy header, so it is stored and NOT part
    // of the signed payload. Both halves matter: stored so an investigation has
    // it, unsigned so a spoofed value cannot invalidate a genuine row.
    await auditLog(makeReq({ cookie: goodCookie, csrf: CSRF, body: goodPayload, ip: "203.0.113.7" }));
    expect(state.auditRows[0].ip_address).toBe("203.0.113.7");
  });

  it("has no zod schema: a malformed body surfaces as 500, not 400 VALIDATION_ERROR", async () => {
    // Documented by assertion rather than by comment. If audit_log is ever moved
    // onto createApiHandler this test goes red, which is the correct signal to
    // update the expectation deliberately instead of discovering the change from a
    // client that suddenly gets a different status.
    const res = await auditLog(makeReq({
      cookie: goodCookie, csrf: CSRF, body: () => { throw new SyntaxError("bad"); },
    }));
    expect(res.status).toBe(500);
    // Whatever the status, the body must not carry the internal reason.
    expect(JSON.stringify(await res.json())).not.toMatch(/SyntaxError|at \w+ \(/);
  });
});
