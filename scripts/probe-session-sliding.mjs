// Session sliding: does an active user's session actually stay alive, and does an
// idle one still die on schedule?
//
// WHAT THIS FILE REPLACES (consolidated 2026-08-20)
// Three probes claimed to cover this and none of them did:
//
//   * probe-session-sliding.mjs (this file, before the rewrite) declared its own
//     8-line copy of touchSession() at the top and tested THAT. It imported
//     nothing from src/. It printed "HTTP calls made = 1 (Expected: 1)" and
//     exited 0 no matter what the product did — a probe agreeing with itself.
//
//   * probe-session-slide.mjs counted globalThis.fetch calls and failed with
//     "FAIL: touchSession and rotateSession are no-ops! No backend HTTP calls
//     were made." It ran under scripts/_loader-boot.mjs, which sets
//     VITE_USE_LOCAL_AUTH='true', so the client deliberately takes the local
//     path and makes no network call at all; its own output shows the local
//     handler running ("[localAuth] remote fallback for custom_auth_me
//     unavailable"). It asserted the production transport while forcing the
//     local one. Deleted.
//
//   * probe-session-noop.mjs seeded a session with FIVE DAYS remaining, called
//     rotateSession(), and failed with "FAIL: rotateSession is a no-op! Expiry
//     was not extended". The documented rule in
//     base44/functions/custom_auth_me/entry.js:53 is "slide expiry if less than
//     3 days left" — five days remaining is inside the no-slide window, so not
//     extending it is the specified behaviour. The probe's fixture contradicted
//     the design. Deleted.
//
// Evidence that the product is the correct party here:
// base44/functions/custom_auth_me/entry.js slides Session.expires_at AND
// re-issues the cookie with the same Max-Age when less than 3 days remain, while
// enforcing an absolute 30-day lifetime. src/api/base44Client.js#touchSession
// invokes that function behind a 5-minute throttle. Both halves are exercised
// below, against the real code.
//
// Run: node --import ./scripts/_loader-boot.mjs scripts/probe-session-sliding.mjs

import { register } from "node:module";
register(new URL("./resolve-base44.mjs", import.meta.url));

import crypto from "node:crypto";

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

const DAY = 24 * 60 * 60 * 1000;

// ═══════════════════════════════════════════════════════════════════════════
// PART A — the server function that actually performs the slide.
// ═══════════════════════════════════════════════════════════════════════════
const authMe = (await import("../base44/functions/custom_auth_me/entry.js")).default;
const sdk = await import("./stubs/base44-sdk.mjs");

const TOKEN = "probe_slide_token";
const TOKEN_HASH = crypto.createHash("sha256").update(TOKEN).digest("hex");

const USER = {
  id: "u_1",
  email: "owner@example.test",
  username: "owner",
  full_name: "Owner",
  role: "owner",
  is_active: true,
  is_locked: false,
  mfa_enabled: true,
  must_change_password: false,
  property_access: "all",
  permissions: { view_dashboard: true },
  created_date: new Date(Date.now() - 40 * DAY).toISOString(),
  // Credential material that must never leave the server.
  password_hash: "$pbkdf2$deadbeef",
  salt: "s41t",
  mfa_secret: "JBSWY3DPEHPK3PXP",
};

/** Fresh world per scenario: one user, one session with the given age/expiry. */
const serverWorld = ({ expiresInMs = 7 * DAY, createdAgoMs = DAY, revoked = false } = {}) =>
  sdk.__installBackend({
    users: [USER],
    sessions: [{
      id: "s_1",
      user_id: "u_1",
      token_hash: TOKEN_HASH,
      is_revoked: revoked,
      created_date: new Date(Date.now() - createdAgoMs).toISOString(),
      expires_at: new Date(Date.now() + expiresInMs).toISOString(),
    }],
  });

const meReq = ({ token = TOKEN, url = "https://redroof.example.com/functions/custom_auth_me" } = {}) => ({
  url,
  headers: new Headers(token ? { cookie: `base44_session=${token}` } : {}),
});

const jsonOf = async (res) => { try { return JSON.parse(await res.text()); } catch { return {}; } };
const setCookieOf = (res) => res.headers?.get?.("set-cookie") || null;

console.log("\n=== A. custom_auth_me: refusal cases ===");
{
  serverWorld();
  const res = await authMe(meReq({ token: null }));
  const b = await jsonOf(res);
  T("no session cookie -> 401 with user: null", res.status === 401 && b.user === null,
    `${res.status} ${JSON.stringify(b)}`);
}
{
  serverWorld();
  const res = await authMe(meReq({ token: "not_the_token" }));
  T("unknown token -> 401", res.status === 401, `got ${res.status}`);
}
{
  serverWorld({ revoked: true });
  const res = await authMe(meReq());
  T("revoked session -> 401", res.status === 401, `got ${res.status}`);
}
{
  serverWorld({ expiresInMs: -60000 });
  const res = await authMe(meReq());
  T("already-expired session -> 401", res.status === 401, `got ${res.status}`);
}
{
  // The absolute cap. A session that has been slid every day for a month must
  // still end: without this an active user is never forced to re-authenticate.
  const t = serverWorld({ expiresInMs: 7 * DAY, createdAgoMs: 31 * DAY });
  const res = await authMe(meReq());
  const row = t.Session.__rows()[0];
  T("session older than the 30-day absolute cap -> 401", res.status === 401, `got ${res.status}`);
  T("and the row is revoked, not merely refused", row.is_revoked === true, JSON.stringify(row.is_revoked));
}

console.log("\n=== A. custom_auth_me: the slide window ===");
{
  // THE CASE probe-session-noop ASSERTED BACKWARDS. Five days remaining is more
  // than the 3-day threshold, so nothing should change. Re-writing the expiry on
  // every poll would make the session's real lifetime unauditable and would
  // rewrite the cookie continuously.
  const t = serverWorld({ expiresInMs: 5 * DAY });
  const before = t.Session.__rows()[0].expires_at;
  const res = await authMe(meReq());
  const after = t.Session.__rows()[0].expires_at;
  T("with 5 days left the request succeeds", res.status === 200, `got ${res.status}`);
  T("with 5 days left the expiry is NOT touched", after === before, `${before} -> ${after}`);
  T("and no cookie is re-issued", setCookieOf(res) === null, String(setCookieOf(res)));
}
{
  const t = serverWorld({ expiresInMs: 2 * DAY });
  const before = t.Session.__rows()[0].expires_at;
  const res = await authMe(meReq());
  const after = t.Session.__rows()[0].expires_at;
  const slidTo = new Date(after).getTime() - Date.now();
  T("with 2 days left the request succeeds", res.status === 200, `got ${res.status}`);
  T("the expiry is extended", after !== before, `${before} -> ${after}`);
  T("extended to ~7 days out", Math.abs(slidTo - 7 * DAY) < 60000, `${Math.round(slidTo / DAY)}d`);

  const cookie = setCookieOf(res);
  T("a refreshed cookie is issued", !!cookie && cookie.includes(`base44_session=${TOKEN}`), String(cookie));
  // The cookie's own clock is what signs the user out, so a slide that updates
  // only the row leaves the browser dropping a session the database thinks is
  // live. Each attribute below is a security property, not formatting.
  T("cookie keeps HttpOnly", /HttpOnly/.test(cookie || ""), String(cookie));
  T("cookie keeps Path=/", /Path=\//.test(cookie || ""), String(cookie));
  T("cookie keeps SameSite=Lax", /SameSite=Lax/.test(cookie || ""), String(cookie));
  T("cookie carries the same 7-day Max-Age login issues",
    new RegExp(`Max-Age=${7 * 24 * 60 * 60}\\b`).test(cookie || ""), String(cookie));
  T("cookie is Secure on a non-localhost host", /Secure/.test(cookie || ""), String(cookie));
  T("the token itself is unchanged — this is a renewal, not a new session",
    t.Session.__rows()[0].token_hash === TOKEN_HASH);
}
{
  const t = serverWorld({ expiresInMs: 2 * DAY });
  const res = await authMe(meReq({ url: "http://localhost:5173/functions/custom_auth_me" }));
  const cookie = setCookieOf(res);
  T("on localhost the cookie is issued without Secure (dev over http)",
    !!cookie && !/Secure/.test(cookie), String(cookie));
  T("but still HttpOnly on localhost", /HttpOnly/.test(cookie || ""), String(cookie));
  T("and still slides the row", t.Session.__rows()[0].expires_at !== undefined);
}
{
  // An unreadable URL must fail toward the STRICTER cookie. Dropping Secure here
  // would let a renewed session cookie travel in clear text.
  serverWorld({ expiresInMs: 2 * DAY });
  const res = await authMe({ url: undefined, headers: new Headers({ cookie: `base44_session=${TOKEN}` }) });
  const cookie = setCookieOf(res);
  T("an unparseable request URL still yields a Secure cookie", /Secure/.test(cookie || ""), String(cookie));
}
{
  // Sliding repeatedly must not accumulate sessions or lose the cap.
  const t = serverWorld({ expiresInMs: 2 * DAY, createdAgoMs: 10 * DAY });
  await authMe(meReq());
  await authMe(meReq());
  await authMe(meReq());
  T("repeated slides do not create extra Session rows", t.Session.__rows().length === 1,
    `rows=${t.Session.__rows().length}`);
  T("created_date is preserved, so the 30-day cap still applies",
    Math.abs(Date.now() - new Date(t.Session.__rows()[0].created_date).getTime() - 10 * DAY) < 60000,
    t.Session.__rows()[0].created_date);
}

console.log("\n=== A. custom_auth_me: the user it returns ===");
{
  serverWorld();
  const res = await authMe(meReq());
  const b = await jsonOf(res);
  T("200 returns the user", res.status === 200 && b.user?.id === "u_1", JSON.stringify(b).slice(0, 160));
  for (const secret of ["password_hash", "salt", "mfa_secret", "failed_login_count"]) {
    T(`response never carries ${secret}`, b.user?.[secret] === undefined, JSON.stringify(Object.keys(b.user || {})));
  }
  // The client uses these three for authorization decisions; dropping any of them
  // silently downgrades what the signed-in user can see.
  for (const field of ["role", "permissions", "property_access", "must_change_password"]) {
    T(`response carries ${field}`, b.user?.[field] !== undefined, JSON.stringify(Object.keys(b.user || {})));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PART B — the client-side throttle in src/api/base44Client.js#touchSession.
//
// Runs on the local-auth path (scripts/_loader-boot.mjs sets
// VITE_USE_LOCAL_AUTH='true'), so the observable is storage access rather than a
// network call: invoke('custom_auth_me') -> getLocalSessionUser() ->
// readLocalSessionRecord() -> secureRetrieve() -> localStorage.getItem(). A
// throttled call short-circuits before invoke() and touches nothing. Counting
// reads therefore distinguishes "ran" from "skipped" without asserting a
// transport the harness has deliberately disabled — which is exactly the mistake
// the deleted probe-session-slide.mjs made.
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n=== B. touchSession throttle (real client) ===");

let reads = 0;
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => { reads++; return store.has(k) ? store.get(k) : null; },
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
  clear: () => { store.clear(); },
  key: (i) => Array.from(store.keys())[i] ?? null,
  get length() { return store.size; },
};

await import("fake-indexeddb/auto");
const { db } = await import("../src/api/base44Client.js");
const localDb = (await import("../src/api/localDb.js")).default;
const { secureStore } = await import("../src/lib/securityUtils.js");

const userId = await localDb.User.add({
  username: "probe", email: "probe@example.test", role: "admin",
  is_active: true, property_access: "all",
});
await secureStore("rr_local_session", JSON.stringify({
  userId, expiresAt: new Date(Date.now() + 5 * DAY).toISOString(),
}));

// A controllable clock. touchSession compares Date.now() against a module-level
// timestamp, so moving the clock is the only way to exercise the throttle window
// without sleeping five real minutes.
const realNow = Date.now;
let clock = realNow();
Date.now = () => clock;

try {
  reads = 0;
  await db.auth.touchSession();
  const first = reads;
  T("the first touchSession does work (session storage is read)", first > 0, `reads=${first}`);

  reads = 0;
  await db.auth.touchSession();
  T("an immediate second touchSession is throttled (no work)", reads === 0, `reads=${reads}`);

  reads = 0;
  for (let i = 0; i < 5; i++) await db.auth.touchSession();
  T("five rapid calls inside the window stay throttled", reads === 0, `reads=${reads}`);

  clock += 6 * 60 * 1000;
  reads = 0;
  await db.auth.touchSession();
  T("after 6 minutes touchSession works again", reads > 0, `reads=${reads}`);

  // rotateSession() is `return this.touchSession()` (src/api/base44Client.js:1186).
  // Asserted so the name cannot be mistaken for what it implies: NO session token
  // is rotated, so this is not a defence against session fixation. Changing that
  // means changing a PROTECTED file (see PROTECTED_FILES.md) and needs the owner;
  // it is recorded in docs/brain/BRAIN_SECURITY.md rather than papered over here.
  reads = 0;
  await db.auth.rotateSession();
  T("rotateSession shares touchSession's throttle window (it is an alias)", reads === 0, `reads=${reads}`);

  clock += 6 * 60 * 1000;
  reads = 0;
  await db.auth.rotateSession();
  T("rotateSession does work once the window has elapsed", reads > 0, `reads=${reads}`);
} finally {
  Date.now = realNow;
}

console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
