// Proves that one server-side credential can create independent sessions in
// two fresh browser cookie jars. This uses the real Worker router and schema
// with the repository's in-memory D1 shim; it does not contact or deploy to
// Cloudflare.

import worker from "../worker/index.js";
import { createCredential } from "../worker/password-credential.js";
import { makeDb, makeEnv, seedProperties, seedUser, assert, assertEqual, makeRunner } from "./_worker-testkit.mjs";

const run = makeRunner("probe-worker-app-auth");
const origin = "https://app.test";
const password = "Probe-Password-9!";
const salt = "0123456789abcdef0123456789abcdef";
const pepper = "probe-only-pepper-that-is-at-least-32-characters";

function cookieValue(setCookie) {
  return String(setCookie || "").split(";", 1)[0];
}

async function request(env, path, { method = "GET", body, cookie, originHeader = origin, requestedWith = true } = {}) {
  const headers = {};
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    if (requestedWith) headers["X-Requested-With"] = "XMLHttpRequest";
    if (originHeader !== null) headers.origin = originHeader;
  }
  if (cookie) headers.cookie = cookie;
  return worker.fetch(new Request(`${origin}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env, { waitUntil() {}, passThroughOnException() {} });
}

const db = makeDb();
seedProperties(db);
seedUser(db, { id: "U_SHARED", email: "shared@example.com", role: "owner", mode: "all" });
seedUser(db, { id: "U_LOCK", email: "locked@example.com", role: "owner", mode: "all" });
seedUser(db, { id: "U_MFA", email: "mfa@example.com", role: "owner", mode: "all" });
seedUser(db, { id: "U_STAFF", email: "staff@example.com", role: "staff", mode: "specific" });
const credential = await createCredential(password, pepper, new TextEncoder().encode(salt));
db.prepare("UPDATE user SET username=?,password_hash=?,salt=?,is_active=1,is_locked=0,failed_login_count=0 WHERE id=?")
  .run("shared-user", credential.encoded, credential.salt, "U_SHARED");
db.prepare("UPDATE user SET username=?,password_hash=?,salt=?,is_active=1,is_locked=0,failed_login_count=0 WHERE id=?")
  .run("locked-user", credential.encoded, credential.salt, "U_LOCK");
db.prepare("UPDATE user SET username=?,password_hash=?,salt=?,is_active=1,is_locked=0,failed_login_count=0,mfa_enabled=1,mfa_secret=? WHERE id=?")
  .run("mfa-user", credential.encoded, credential.salt, "JBSWY3DPEHPK3PXP", "U_MFA");
db.prepare("UPDATE user SET username=?,password_hash=?,salt=?,permissions=?,is_active=1,is_locked=0 WHERE id=?")
  .run("staff-user", credential.encoded, credential.salt, JSON.stringify({ view_dashboard: true }), "U_STAFF");
const env = makeEnv(db, { ENABLE_D1_DATA_API: "false", PASSWORD_PEPPER_V1: pepper });

await run.check("legacy and unsupported credential versions fail closed without HTTP 500", async () => {
  db.prepare("UPDATE user SET password_hash=? WHERE id=?").run("$pbkdf2$legacy", "U_SHARED");
  const legacy = await request(env, "/api/auth/login", { method: "POST", body: { identifier: "shared-user", password } });
  assertEqual(legacy.status, 401);
  db.prepare("UPDATE user SET password_hash=? WHERE id=?").run(credential.encoded.replace("$v=1$", "$v=99$"), "U_SHARED");
  const unsupported = await request(env, "/api/auth/login", { method: "POST", body: { identifier: "shared-user", password } });
  assertEqual(unsupported.status, 401);
  db.prepare("UPDATE user SET password_hash=? WHERE id=?").run(credential.encoded, "U_SHARED");
});

await run.check("cross-origin login is rejected before credential processing", async () => {
  const response = await request(env, "/api/auth/login", {
    method: "POST",
    body: { identifier: "shared-user", password },
    originHeader: "https://evil.test",
  });
  assertEqual(response.status, 403);
  assertEqual(Number(db.prepare("SELECT COUNT(*) count FROM app_session").get().count), 0);
});

let browserOneCookie = "";
await run.check("fresh browser one logs in with app username/password", async () => {
  const response = await request(env, "/api/auth/login", {
    method: "POST",
    body: { identifier: "shared-user", password, remember: true },
  });
  assertEqual(response.status, 200);
  const setCookie = response.headers.get("set-cookie");
  assert(setCookie.includes("__Host-rri_session="), "missing host-only session cookie");
  assert(/HttpOnly/i.test(setCookie), "cookie is not HttpOnly");
  assert(/Secure/i.test(setCookie), "cookie is not Secure");
  assert(/SameSite=Strict/i.test(setCookie), "cookie is not SameSite=Strict");
  assert(/Max-Age=2592000/i.test(setCookie), "remember-me cookie is not 30 days");
  browserOneCookie = cookieValue(setCookie);
});

await run.check("browser one session resolves the D1 user", async () => {
  const response = await request(env, "/api/session", { cookie: browserOneCookie });
  const body = await response.json();
  assertEqual(response.status, 200);
  assertEqual(body.user.email, "shared@example.com");
  assertEqual(body.user.id, "U_SHARED");
  assertEqual(body.user.permissions.view_dashboard, true);
  assertEqual(body.user.permissions.manage_users, true);
});

await run.check("non-owner session permissions do not inherit owner capabilities", async () => {
  const login = await request(env, "/api/auth/login", {
    method: "POST",
    body: { identifier: "staff-user", password },
  });
  assertEqual(login.status, 200);
  const response = await request(env, "/api/session", { cookie: cookieValue(login.headers.get("set-cookie")) });
  const body = await response.json();
  assertEqual(response.status, 200);
  assertEqual(body.user.permissions.view_dashboard, true);
  assertEqual(body.user.permissions.manage_users, undefined);
});

let browserTwoCookie = "";
await run.check("fresh browser two independently logs in with the same credential", async () => {
  const response = await request(env, "/api/auth/login", {
    method: "POST",
    body: { identifier: "shared@example.com", password, remember: false },
  });
  assertEqual(response.status, 200);
  browserTwoCookie = cookieValue(response.headers.get("set-cookie"));
  assert(browserTwoCookie && browserTwoCookie !== browserOneCookie, "browser sessions reused a bearer token");
  assertEqual(Number(db.prepare("SELECT COUNT(*) count FROM app_session WHERE user_id='U_SHARED'").get().count), 2);
});

await run.check("D1 stores only token digests, not either browser bearer token", async () => {
  const rawOne = browserOneCookie.split("=")[1];
  const rawTwo = browserTwoCookie.split("=")[1];
  const rows = db.prepare("SELECT token_hash FROM app_session WHERE user_id='U_SHARED'").all();
  assert(rows.every((row) => row.token_hash !== rawOne && row.token_hash !== rawTwo));
  assert(rows.every((row) => /^[a-f0-9]{64}$/.test(row.token_hash)));
});

await run.check("browser two session remains valid independently", async () => {
  const response = await request(env, "/api/session", { cookie: browserTwoCookie });
  assertEqual(response.status, 200);
  assertEqual((await response.json()).authenticated, true);
});

await run.check("missing cookie fails closed with JSON, never SPA HTML", async () => {
  const response = await request(env, "/api/session");
  assertEqual(response.status, 401);
  assert((response.headers.get("content-type") || "").includes("application/json"));
  assertEqual((await response.json()).authenticated, false);
});

await run.check("five bad passwords lock the account and a correct password cannot bypass it", async () => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await request(env, "/api/auth/login", {
      method: "POST",
      body: { identifier: "locked-user", password: "hunter2" },
    });
    assertEqual(response.status, 401);
  }
  const user = db.prepare("SELECT failed_login_count,locked_until FROM user WHERE id='U_LOCK'").get();
  assertEqual(Number(user.failed_login_count), 5);
  assert(Date.parse(user.locked_until) > Date.now());
  const response = await request(env, "/api/auth/login", {
    method: "POST",
    body: { identifier: "locked-user", password },
  });
  assertEqual(response.status, 401);
});

await run.check("an expired lockout restarts at failure one instead of instantly re-locking", async () => {
  db.prepare("UPDATE user SET failed_login_count=5,locked_until=? WHERE id='U_LOCK'")
    .run(new Date(Date.now() - 60_000).toISOString());
  const response = await request(env, "/api/auth/login", {
    method: "POST",
    body: { identifier: "locked-user", password: "hunter2" },
  });
  assertEqual(response.status, 401);
  const user = db.prepare("SELECT failed_login_count,locked_until FROM user WHERE id='U_LOCK'").get();
  assertEqual(Number(user.failed_login_count), 1);
  assertEqual(user.locked_until, null);
});

function base32(value) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of value) bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  return new Uint8Array(bytes);
}

async function currentTotp(secret) {
  let counter = BigInt(Math.floor(Date.now() / 30_000));
  const message = new Uint8Array(8);
  for (let i = 7; i >= 0; i -= 1) { message[i] = Number(counter & 255n); counter >>= 8n; }
  const key = await crypto.subtle.importKey("raw", base32(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const digestBytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  const offset = digestBytes[digestBytes.length - 1] & 15;
  const binary = (((digestBytes[offset] & 127) << 24) | (digestBytes[offset + 1] << 16) | (digestBytes[offset + 2] << 8) | digestBytes[offset + 3]) >>> 0;
  return String(binary % 1_000_000).padStart(6, "0");
}

await run.check("MFA uses a single-use server challenge and does not re-check the plaintext password", async () => {
  const first = await request(env, "/api/auth/login", {
    method: "POST",
    body: { identifier: "mfa-user", password },
  });
  assertEqual(first.status, 200);
  assertEqual((await first.json()).require_mfa, true);
  const challengeCookie = cookieValue(first.headers.get("set-cookie"));
  assert(challengeCookie.startsWith("__Host-rri_mfa="));
  const second = await request(env, "/api/auth/login", {
    method: "POST",
    cookie: challengeCookie,
    body: { identifier: "mfa-user", totpToken: await currentTotp("JBSWY3DPEHPK3PXP") },
  });
  assertEqual(second.status, 200);
  assert(cookieValue(second.headers.get("set-cookie")).startsWith("__Host-rri_session="));
  const replay = await request(env, "/api/auth/login", {
    method: "POST",
    cookie: challengeCookie,
    body: { identifier: "mfa-user", password: "hunter2", totpToken: await currentTotp("JBSWY3DPEHPK3PXP") },
  });
  assertEqual(replay.status, 401);
});

await run.check("all state-changing API routes require the same-origin mutation header", async () => {
  const response = await request(env, "/api/entities/Property", {
    method: "POST",
    cookie: browserTwoCookie,
    requestedWith: false,
    body: { data: { code: "NOPE", name: "Blocked" } },
  });
  assertEqual(response.status, 403);
});

await run.check("authenticated business-data API access remains disabled by default", async () => {
  const response = await request(env, "/api/entities/Property/query", {
    method: "POST",
    cookie: browserTwoCookie,
    body: { filter: {} },
  });
  assertEqual(response.status, 404);
  assertEqual((await response.json()).error, "D1 business-data storage is disabled");
});

await run.check("an invalid app cookie cannot fall through to Cloudflare Access", async () => {
  let accessFetches = 0;
  const accessEnv = makeEnv(db, {
    ACCESS_AUD: "test-aud",
    ACCESS_TEAM_DOMAIN: "access.test",
    FETCH: async () => { accessFetches += 1; return new Response("{}", { status: 200 }); },
  });
  const response = await request(accessEnv, "/api/session", { cookie: "__Host-rri_session=invalid" });
  assertEqual(response.status, 401);
  assertEqual(accessFetches, 0);
});

await run.check("logging browser one out revokes only browser one", async () => {
  const logout = await request(env, "/api/auth/logout", { method: "POST", body: {}, cookie: browserOneCookie });
  assertEqual(logout.status, 200);
  assert(/Max-Age=0/i.test(logout.headers.get("set-cookie")));
  assertEqual((await request(env, "/api/session", { cookie: browserOneCookie })).status, 401);
  assertEqual((await request(env, "/api/session", { cookie: browserTwoCookie })).status, 200);
});

run.done();
if (process.exitCode) process.exit(1);
console.log("PASSED: Worker application-authentication contract completed.");
