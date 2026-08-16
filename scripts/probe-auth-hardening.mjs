// Probe: authentication, MFA and session hardening.
//
// Everything here runs the REAL serverless entry files
// (base44/functions/*/entry.js) against the in-memory backend in
// scripts/stubs/*, resolved by scripts/resolve-base44.mjs. Those functions are
// the production auth path — src/api/base44Client.js returns invokeBackend()
// before any local shim when VITE_USE_LOCAL_AUTH is off — and eslint.config.js
// ignores base44/**, so this probe is the only automated check on them.
//
// The defects it was written to reproduce, all found by reading the shipped
// source:
//
//   1. crypto.timingSafeEqual THROWS RangeError when its two buffers differ in
//      length. A stored hash that is not '$scrypt$'-prefixed takes the legacy
//      branch, which produces 64 hex characters, so any other stored length
//      makes the comparison throw — out of the handler and into the catch that
//      answers 500. A wrong password on such an account is a server error
//      instead of a refusal, and the difference is observable: 500 vs 401 tells
//      an unauthenticated caller which accounts carry which hash format.
//      Same defect in custom_user_admin#change_own_password.
//   2. A wrong MFA code did not touch failed_login_count, so the 10-failure
//      lockout could not fire on the second factor. Someone holding a valid
//      password could grind six digits against one account for as long as they
//      liked — the only brake was the per-IP limiter, and an attacker chooses
//      their IP.
//   3. A TOTP code stayed valid for its whole ±1 window (~90 seconds) and could
//      be replayed within it, because nothing recorded which counter had
//      already been used.
//   4. The session-revocation block sat in set_status, whose patch can only
//      ever contain is_active / is_locked / failed_login_count — so its
//      roleChanged / permissionsChanged / accessChanged tests were dead code —
//      while `update`, the ONLY action that changes role, permissions or
//      property_access, revoked nothing. Demoting a manager to read_only, or
//      narrowing their property access, left every session they already had
//      logged in at the old privilege.
//   5. Nor did reset_password, set_password, change_own_password, disable_mfa
//      or the token-based custom_auth_reset_password revoke anything: an admin
//      resetting a compromised account's password did not evict the intruder.
//   6. verify_mfa had no requireAdmin() and no self-check, so any authenticated
//      user could submit codes against any other user's id, unthrottled, and
//      each attempt wrote an 'MFA Verified' audit row naming a target the
//      caller had no business touching.
//   7. enable_mfa overwrote an existing mfa_secret and returned the new one,
//      and disable_mfa stripped the second factor outright — both on nothing
//      but a session cookie. A stolen session could therefore remove or
//      re-point the second factor that was supposed to contain it.
//   8. custom_auth_reset_password enforced no password strength at all (not
//      even a length), wrote no audit row, and left existing sessions alive.
//   9. custom_auth_reset_request had no rate limit, and decided whether to
//      return the reset token in the response body with
//      host.includes('localhost') — a substring test on an attacker-influenced
//      Host header, which 'localhost.evil.com' satisfies.
//  10. custom_auth_me slid a session's expiry without re-issuing the cookie, so
//      an actively used session died at the cookie's 7-day Max-Age anyway.
//
// Run: node scripts/probe-auth-hardening.mjs

import { register } from "node:module";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./resolve-base44.mjs", import.meta.url));

const sdk = await import("./stubs/base44-sdk.mjs");
const runtime = await import("./stubs/base44-runtime.mjs");

const login = (await import("../base44/functions/custom_auth_login/entry.js")).default;
const userAdmin = (await import("../base44/functions/custom_user_admin/entry.js")).default;
const authMe = (await import("../base44/functions/custom_auth_me/entry.js")).default;
const resetRequest = (await import("../base44/functions/custom_auth_reset_request/entry.js")).default;
const resetPassword = (await import("../base44/functions/custom_auth_reset_password/entry.js")).default;
const auditVerify = (await import("../base44/functions/audit_verify/entry.js")).default;

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

let pass = 0;
let fail = 0;
const failures = [];
const T = (name, cond, detail = "") => {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`);
  }
};
const section = (t) => console.log(`\n=== ${t} ===`);

// ── Fixtures ────────────────────────────────────────────────────────────────
const SECRET = "probe-chain-secret";
const PASSWORD = "Correct-Horse-Battery-9!";
const NEWPASS = "Rotated-Passphrase-7x";
const SALT = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const CSRF = "probe-csrf-token";

const scrypt = (password, salt) =>
  new Promise((resolve, reject) =>
    crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (err, key) =>
      err ? reject(err) : resolve(key.toString("hex")),
    ),
  );
const scryptHash = async (pw, salt = SALT) => `$scrypt$${await scrypt(pw, salt)}`;
const HASH = await scryptHash(PASSWORD);

const th = (token) => crypto.createHash("sha256").update(token).digest("hex");

// ── TOTP, the same algorithm the functions implement ────────────────────────
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function b32decode(input) {
  const bits = [];
  for (const ch of input.toUpperCase().replace(/[^A-Z2-7]/g, "")) {
    const v = B32.indexOf(ch);
    for (let b = 4; b >= 0; b--) bits.push((v >> b) & 1);
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let byte = 0;
    for (let b = 0; b < 8; b++) byte = (byte << 1) | bits[i + b];
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}
function totpCode(secretBase32, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", b32decode(secretBase32)).update(buf).digest();
  const off = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[off] & 0x7f) << 24) | ((hmac[off + 1] & 0xff) << 16) |
    ((hmac[off + 2] & 0xff) << 8) | (hmac[off + 3] & 0xff);
  return String(code % 1000000).padStart(6, "0");
}
const nowCounter = () => Math.floor(Date.now() / 30000);
const MFA_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

// ── World builders ──────────────────────────────────────────────────────────
const mkUser = (over = {}) => ({
  id: "u_target", username: "clerk1", email: "clerk@example.com", role: "read_only",
  is_active: true, is_locked: false, mfa_enabled: false, property_access: "all",
  password_hash: HASH, salt: SALT, failed_login_count: 0, ...over,
});
const mkAdmin = (over = {}) => ({
  id: "u_admin", username: "admin1", email: "admin@example.com", role: "owner",
  is_active: true, is_locked: false, mfa_enabled: false, property_access: "all",
  password_hash: HASH, salt: SALT, failed_login_count: 0, ...over,
});
// A second owner, so assertNotLastOwner() never blocks a test that is about
// something else.
const mkSpareOwner = () => ({
  id: "u_owner2", username: "owner2", email: "owner2@example.com", role: "owner",
  is_active: true, is_locked: false, property_access: "all", password_hash: HASH, salt: SALT,
});
const mkSession = (id, userId, token, over = {}) => ({
  id, user_id: userId, token_hash: th(token), is_revoked: false,
  created_date: new Date().toISOString(),
  expires_at: new Date(Date.now() + 6 * 24 * 3600e3).toISOString(),
  ...over,
});

function world({ users = [], sessions = [], secret = SECRET } = {}) {
  runtime.__clearSecrets();
  if (secret !== null) runtime.__setSecret("AUDIT_CHAIN_SECRET", secret);
  return sdk.__installBackend({ users, sessions });
}

/** The standard cast: an owner (admin1) with a session, plus a spare owner. */
function adminWorld({ target = mkUser(), targetSessions = ["tok_t1", "tok_t2"] } = {}) {
  return world({
    users: [mkAdmin(), mkSpareOwner(), target],
    sessions: [
      mkSession("s_admin", "u_admin", "tok_admin"),
      ...targetSessions.map((t, i) => mkSession(`s_t${i + 1}`, target.id, t)),
    ],
  });
}

// ── Callers ─────────────────────────────────────────────────────────────────
const loginReq = (body, ip) => ({
  url: "https://probe.local/functions/custom_auth_login",
  headers: new Headers({ "x-forwarded-for": ip, "user-agent": "probe/1.0" }),
  json: async () => body,
});
let ipSeq = 0;
const signIn = async (body, ip = `198.51.100.${(ipSeq += 1) % 250}`) => {
  const res = await login(loginReq(body, ip));
  return { status: res.status ?? 200, body: await res.json(), headers: res.headers };
};

const admin = async (body, { token = "tok_admin", csrf = CSRF, header = CSRF } = {}) => {
  const res = await userAdmin({
    url: "https://probe.local/functions/custom_user_admin",
    headers: new Headers({
      cookie: `base44_session=${token}; __Host-csrf_token=${csrf}`,
      "x-csrf-token": header,
    }),
    json: async () => body,
  });
  return { status: res.status ?? 200, body: await res.json() };
};

const doReset = async (body) => {
  const res = await resetPassword({
    url: "https://probe.local/functions/custom_auth_reset_password",
    headers: new Headers({ cookie: `__Host-csrf_token=${CSRF}`, "x-csrf-token": CSRF }),
    json: async () => body,
  });
  return { status: res.status ?? 200, body: await res.json() };
};

const askReset = async (identifier, host = "hotel.example.com", ip = "203.0.113.9") => {
  const res = await resetRequest({
    url: `https://${host}/functions/custom_auth_reset_request`,
    headers: new Headers({
      cookie: `__Host-csrf_token=${CSRF}`, "x-csrf-token": CSRF, host, "x-forwarded-for": ip,
    }),
    json: async () => ({ identifier }),
  });
  return { status: res.status ?? 200, body: await res.json() };
};

const me = async (token) => {
  const res = await authMe({
    url: "https://probe.local/functions/custom_auth_me",
    headers: new Headers({ cookie: `base44_session=${token}` }),
    json: async () => ({}),
  });
  return { status: res.status ?? 200, body: await res.json(), setCookie: res.headers?.get?.("Set-Cookie") || null };
};

const verifyChain = async (tables) => {
  const res = await auditVerify({
    url: "https://probe.local/functions/audit_verify",
    headers: new Headers({ cookie: "base44_session=tok_admin" }),
    json: async () => ({}),
  });
  void tables;
  return res.json();
};

const live = (tables, userId) =>
  tables.Session.__rows().filter((s) => s.user_id === userId && !s.is_revoked).map((s) => s.id);
const row = (tables, id) => tables.User.__rows().find((u) => u.id === id);
const actions = (tables) => tables.AuditLog.__rows().map((r) => `${r.action}[${r.result}]`).join(",");

// ════════════════════════════════════════════════════════════════════════════
section("1. A hash of an unexpected length is a refusal, not a 500");
{
  // '$pbkdf2$…' is not '$scrypt$…', so the legacy branch runs and produces 64
  // hex characters against a 72-character stored value.
  let tables = world({ users: [mkUser({ password_hash: `$pbkdf2$${"a".repeat(64)}` })] });
  let res = await signIn({ username: "clerk1", password: PASSWORD });
  console.log(`    length-mismatch hash => status=${res.status} body=${JSON.stringify(res.body)}`);
  T("a mismatched hash length is refused, not a server error", res.status === 401,
    `status=${res.status} — crypto.timingSafeEqual threw RangeError into the catch`);
  T("the refusal is generic", res.body?.error === "Invalid email or password", JSON.stringify(res.body));
  T("the refusal is still recorded", tables.AuditLog.__rows().length >= 1, actions(tables));

  // An account with no password hash at all (an invite half-created, a manual
  // row) reached `expectedHash.startsWith` and threw before any comparison.
  tables = world({ users: [mkUser({ password_hash: undefined })] });
  res = await signIn({ username: "clerk1", password: PASSWORD });
  console.log(`    missing hash        => status=${res.status} body=${JSON.stringify(res.body)}`);
  T("an account with no password hash is refused, not a server error", res.status === 401,
    `status=${res.status}`);
  T("the unusable-credential case is recorded", tables.AuditLog.__rows().length >= 1, actions(tables));
}

section("2. A wrong second factor counts toward the lockout");
{
  const tables = world({
    users: [mkUser({ mfa_enabled: true, mfa_secret: MFA_SECRET, failed_login_count: 9 })],
  });
  const res = await signIn({ username: "clerk1", password: PASSWORD, mfa_token: "000000" });
  console.log(`    wrong code => status=${res.status} rows=${actions(tables)}`);
  T("the wrong code is refused", res.status === 401, `status=${res.status}`);
  T("a failed second factor increments the failure count",
    row(tables, "u_target").failed_login_count === 10,
    `failed_login_count=${row(tables, "u_target").failed_login_count} — MFA failures did not count`);
  T("the tenth consecutive failure locks the account",
    row(tables, "u_target").is_locked === true,
    "an attacker with a valid password could grind six digits indefinitely");
  T("both the failed factor and the lockout are recorded",
    /Failed MFA/.test(actions(tables)) && /Lock/i.test(actions(tables)), actions(tables));
}

section("3. A TOTP code cannot be replayed");
{
  const tables = world({ users: [mkUser({ mfa_enabled: true, mfa_secret: MFA_SECRET })] });
  const code = totpCode(MFA_SECRET, nowCounter());
  const first = await signIn({ username: "clerk1", password: PASSWORD, mfa_token: code });
  console.log(`    first  => status=${first.status} body=${JSON.stringify(first.body)}`);
  T("a valid code signs in", first.status === 200 && first.body?.success === true,
    JSON.stringify(first.body));
  T("the counter that was used is recorded",
    Number.isFinite(row(tables, "u_target").mfa_last_counter),
    `mfa_last_counter=${JSON.stringify(row(tables, "u_target").mfa_last_counter)}`);

  const second = await signIn({ username: "clerk1", password: PASSWORD, mfa_token: code });
  console.log(`    replay => status=${second.status} body=${JSON.stringify(second.body)}`);
  T("the same code cannot be used twice", second.status === 401,
    `status=${second.status} — the code stayed valid for its whole ±1 window`);
  T("only one session was created",
    tables.Session.__rows().filter((s) => !s.is_revoked).length === 1,
    `sessions=${tables.Session.__rows().length}`);
  T("the replay attempt is recorded", /Failed MFA/.test(actions(tables)), actions(tables));
}

section("4. Forced enrolment also burns the code it accepted");
{
  const tables = world({ users: [mkAdmin({ mfa_enabled: false })] });
  const setup = await signIn({ username: "admin1", password: PASSWORD });
  T("an owner without MFA is sent to enrolment", setup.body?.require_mfa_setup === true,
    JSON.stringify(setup.body));
  const pending = setup.body?.secret;
  T("a pending secret is issued", typeof pending === "string" && pending.length >= 16, String(pending));

  const code = totpCode(pending, nowCounter());
  const done = await signIn({ username: "admin1", password: PASSWORD, mfa_token: code });
  T("the enrolment code completes the login", done.status === 200 && done.body?.success === true,
    JSON.stringify(done.body));
  T("enrolment turned MFA on", row(tables, "u_admin").mfa_enabled === true);
  const replay = await signIn({ username: "admin1", password: PASSWORD, mfa_token: code });
  T("the enrolment code cannot then be replayed as a login", replay.status === 401,
    `status=${replay.status}`);
}

section("5. Changing privileges revokes the sessions that hold them");
{
  let tables = adminWorld();
  let res = await admin({ action: "update", id: "u_target", data: { role: "manager" } });
  console.log(`    role change => status=${res.status} live target sessions=${JSON.stringify(live(tables, "u_target"))}`);
  T("the update succeeded", res.status === 200, JSON.stringify(res.body));
  T("a role change revokes the target's sessions", live(tables, "u_target").length === 0,
    "the revocation block sat in set_status, where patch.role can never be set");
  T("the admin's own session is untouched", live(tables, "u_admin").length === 1);

  tables = adminWorld();
  res = await admin({ action: "update", id: "u_target", data: { property_access: ["prop_1"] } });
  T("narrowing property access revokes the target's sessions",
    res.status === 200 && live(tables, "u_target").length === 0,
    `status=${res.status} live=${JSON.stringify(live(tables, "u_target"))}`);

  tables = adminWorld();
  res = await admin({ action: "update", id: "u_target", data: { permissions: { view_dashboard: true } } });
  T("a permissions change revokes the target's sessions",
    res.status === 200 && live(tables, "u_target").length === 0,
    `status=${res.status} live=${JSON.stringify(live(tables, "u_target"))}`);

  // The other half of the contract: a cosmetic edit must NOT log anyone out.
  tables = adminWorld();
  res = await admin({ action: "update", id: "u_target", data: { full_name: "Clerk One" } });
  T("editing a name does not log the user out",
    res.status === 200 && live(tables, "u_target").length === 2,
    `status=${res.status} live=${JSON.stringify(live(tables, "u_target"))}`);

  // set_status still has to revoke — and its dead privilege tests should be gone.
  tables = adminWorld();
  res = await admin({ action: "set_status", id: "u_target", status: "disabled" });
  T("disabling an account revokes its sessions",
    res.status === 200 && live(tables, "u_target").length === 0, JSON.stringify(res.body));
  tables = adminWorld();
  res = await admin({ action: "set_status", id: "u_target", status: "locked" });
  T("locking an account revokes its sessions",
    res.status === 200 && live(tables, "u_target").length === 0, JSON.stringify(res.body));

  const src = read("base44/functions/custom_user_admin/entry.js");
  const setStatus = (src.match(/set_status: async \(\) => \{[\s\S]*?\n {6}\},/) || [""])[0];
  T("the set_status handler was located", setStatus.length > 200, `matched ${setStatus.length} chars`);
  T("set_status no longer tests fields its patch cannot contain",
    !/roleChanged|permissionsChanged|accessChanged/.test(setStatus),
    "dead conditions read as protection that is not there");
  const update = (src.match(/ {6}update: async \(\) => \{[\s\S]*?\n {6}\},/) || [""])[0];
  T("the update handler was located", update.length > 200, `matched ${update.length} chars`);
  T("the update handler is the one that revokes on privilege change",
    /revokeUserSessions/.test(update), "update is the only action that can change role or access");
}

section("6. Changing a credential revokes the sessions it opened");
{
  let tables = adminWorld();
  let res = await admin({ action: "reset_password", id: "u_target", newPassword: NEWPASS });
  T("an admin password reset succeeds", res.status === 200, JSON.stringify(res.body));
  T("an admin password reset evicts the account's sessions", live(tables, "u_target").length === 0,
    "resetting a compromised account's password did not log the intruder out");

  tables = adminWorld();
  res = await admin({ action: "set_password", id: "u_target", newPassword: NEWPASS });
  T("set_password succeeds", res.status === 200, JSON.stringify(res.body));
  T("set_password evicts the account's sessions", live(tables, "u_target").length === 0);

  // set_password used to accept any 8 characters while createUser and
  // reset_password both required mixed case and a digit.
  tables = adminWorld();
  res = await admin({ action: "set_password", id: "u_target", newPassword: "password" });
  T("set_password enforces the same strength rule as every other writer",
    res.status >= 400 && /uppercase|lowercase|number/i.test(res.body?.error || ""),
    `status=${res.status} body=${JSON.stringify(res.body)}`);
}

section("7. Changing your own password keeps you signed in and drops the rest");
{
  // The caller holds tok_t1; tok_t2 is the same account on another device.
  let tables = world({
    users: [mkUser()],
    sessions: [mkSession("s_t1", "u_target", "tok_t1"), mkSession("s_t2", "u_target", "tok_t2")],
  });
  let res = await admin(
    { action: "change_own_password", id: "u_target", currentPassword: PASSWORD, newPassword: NEWPASS },
    { token: "tok_t1" },
  );
  console.log(`    change_own_password => status=${res.status} live=${JSON.stringify(live(tables, "u_target"))}`);
  T("the password change succeeded", res.status === 200, JSON.stringify(res.body));
  T("the session that made the change survives", live(tables, "u_target").includes("s_t1"),
    "logging the user out of the tab they are using would be a bug, not a control");
  T("every other session for that account is revoked", !live(tables, "u_target").includes("s_t2"),
    `live=${JSON.stringify(live(tables, "u_target"))}`);

  // Same timingSafeEqual defect as the login path.
  tables = world({
    users: [mkUser({ password_hash: `$pbkdf2$${"a".repeat(64)}` })],
    sessions: [mkSession("s_t1", "u_target", "tok_t1")],
  });
  res = await admin(
    { action: "change_own_password", id: "u_target", currentPassword: PASSWORD, newPassword: NEWPASS },
    { token: "tok_t1" },
  );
  console.log(`    mismatched stored hash => status=${res.status} body=${JSON.stringify(res.body)}`);
  T("a stored hash of another length is a refusal, not a 500",
    res.status === 403 || res.status === 400,
    `status=${res.status} — timingSafeEqual threw RangeError`);
  T("the refusal names the wrong current password", /current password/i.test(res.body?.error || ""),
    JSON.stringify(res.body));

  tables = world({ users: [mkUser()], sessions: [mkSession("s_t1", "u_target", "tok_t1")] });
  res = await admin(
    { action: "change_own_password", id: "u_target", currentPassword: PASSWORD, newPassword: "alllowercase1" },
    { token: "tok_t1" },
  );
  T("a weak new password is refused",
    res.status >= 400 && /uppercase|lowercase|number/i.test(res.body?.error || ""),
    `status=${res.status} body=${JSON.stringify(res.body)} — only length was checked`);
}

section("8. verify_mfa is gated and throttled");
{
  // u_target is an ordinary user; u_victim has MFA on. Neither is an admin.
  const victim = {
    id: "u_victim", username: "victim", email: "victim@example.com", role: "read_only",
    is_active: true, is_locked: false, property_access: "all", password_hash: HASH, salt: SALT,
    mfa_enabled: true, mfa_secret: MFA_SECRET,
  };
  let tables = world({
    users: [mkUser(), victim],
    sessions: [mkSession("s_t1", "u_target", "tok_t1")],
  });
  let res = await admin({ action: "verify_mfa", id: "u_victim", token: "000000" }, { token: "tok_t1" });
  console.log(`    cross-account verify => status=${res.status} body=${JSON.stringify(res.body)}`);
  T("one user cannot submit codes against another user's account", res.status === 403,
    `status=${res.status} — there was no requireAdmin() and no self-check`);
  T("no audit row was written for a target the caller may not touch",
    tables.AuditLog.__rows().length === 0, actions(tables));

  // Self-verification is the legitimate use (Settings.jsx enrolment).
  tables = world({
    users: [mkUser({ mfa_enabled: true, mfa_secret: MFA_SECRET })],
    sessions: [mkSession("s_t1", "u_target", "tok_t1")],
  });
  res = await admin(
    { action: "verify_mfa", id: "u_target", token: totpCode(MFA_SECRET, nowCounter()) },
    { token: "tok_t1" },
  );
  T("a user can still verify their own code", res.status === 200, JSON.stringify(res.body));

  // Unlimited guessing against six digits is the point of the throttle.
  tables = world({
    users: [mkUser({ mfa_enabled: true, mfa_secret: MFA_SECRET })],
    sessions: [mkSession("s_t1", "u_target", "tok_t1")],
  });
  const statuses = [];
  for (let i = 0; i < 12; i += 1) {
    statuses.push(
      (await admin({ action: "verify_mfa", id: "u_target", token: String(100000 + i) }, { token: "tok_t1" })).status,
    );
  }
  console.log(`    12 wrong codes => ${statuses.join(",")}`);
  T("repeated wrong codes are throttled", statuses.includes(429),
    `statuses=${statuses.join(",")} — every attempt was free`);
}

section("9. Removing or re-pointing a second factor needs the password again");
{
  const target = mkUser({ mfa_enabled: true, mfa_secret: MFA_SECRET });
  let tables = adminWorld({ target });
  let res = await admin({ action: "disable_mfa", id: "u_target" });
  console.log(`    disable, no password => status=${res.status} body=${JSON.stringify(res.body)}`);
  T("disabling MFA on nothing but a session cookie is refused", res.status >= 400,
    `status=${res.status} — a stolen session could strip the second factor`);
  T("MFA is still enabled after the refusal", row(tables, "u_target").mfa_enabled === true);

  tables = adminWorld({ target });
  res = await admin({ action: "disable_mfa", id: "u_target", currentPassword: "not-the-password" });
  T("a wrong password does not disable MFA",
    res.status >= 400 && row(tables, "u_target").mfa_enabled === true,
    `status=${res.status} mfa_enabled=${row(tables, "u_target").mfa_enabled}`);

  tables = adminWorld({ target });
  res = await admin({ action: "disable_mfa", id: "u_target", currentPassword: PASSWORD });
  console.log(`    disable, with password => status=${res.status} live=${JSON.stringify(live(tables, "u_target"))}`);
  T("an admin who re-authenticates can disable MFA", res.status === 200, JSON.stringify(res.body));
  T("MFA is off", row(tables, "u_target").mfa_enabled === false);
  T("disabling MFA evicts the account's sessions", live(tables, "u_target").length === 0,
    "the sessions that existed under the second factor outlived it");

  // Rotating a secret that is already in use is the same weight of change.
  tables = adminWorld({ target });
  res = await admin({ action: "enable_mfa", id: "u_target" });
  T("re-pointing an existing MFA secret is refused without the password", res.status >= 400,
    `status=${res.status} — enable_mfa overwrote mfa_secret unconditionally and returned it`);
  T("the existing secret is unchanged", row(tables, "u_target").mfa_secret === MFA_SECRET);
}

section("10. First-time enrolment keeps the tab you are enrolling from");
{
  const tables = world({
    users: [mkUser()],
    sessions: [mkSession("s_t1", "u_target", "tok_t1"), mkSession("s_t2", "u_target", "tok_t2")],
  });
  const res = await admin({ action: "enable_mfa", id: "u_target" }, { token: "tok_t1" });
  console.log(`    self-enrol => status=${res.status} live=${JSON.stringify(live(tables, "u_target"))}`);
  T("a fresh enrolment needs no step-up", res.status === 200, JSON.stringify(res.body));
  T("a secret and a URI come back",
    typeof res.body?.secret === "string" && /^otpauth:/.test(res.body?.uri || ""),
    JSON.stringify(res.body));
  T("the enrolling session survives", live(tables, "u_target").includes("s_t1"),
    "Settings.jsx has to stay signed in to verify the first code");
  T("the account's other sessions are evicted", !live(tables, "u_target").includes("s_t2"),
    `live=${JSON.stringify(live(tables, "u_target"))}`);
}

section("11. A token-based reset is a real credential change");
{
  const tokenPlain = "reset-token-abcdef";
  const withToken = (over = {}) => mkUser({
    reset_token_hash: th(tokenPlain),
    reset_token_expires_at: new Date(Date.now() + 3600e3).toISOString(),
    ...over,
  });

  let tables = world({
    users: [mkAdmin(), withToken()],
    sessions: [mkSession("s_admin", "u_admin", "tok_admin"), mkSession("s_t1", "u_target", "tok_t1")],
  });
  let res = await doReset({ token: tokenPlain, newPassword: "abc" });
  console.log(`    weak reset => status=${res.status} body=${JSON.stringify(res.body)}`);
  T("a weak password is refused", res.status >= 400, `status=${res.status} — nothing was validated`);
  T("the reset token is not consumed by a refusal",
    row(tables, "u_target").reset_token_hash === th(tokenPlain),
    "a rejected attempt must not force a second email");
  T("the password was not changed", row(tables, "u_target").password_hash === HASH);

  tables = world({
    users: [mkAdmin(), withToken()],
    sessions: [mkSession("s_admin", "u_admin", "tok_admin"), mkSession("s_t1", "u_target", "tok_t1")],
  });
  res = await doReset({ token: tokenPlain, newPassword: NEWPASS });
  console.log(`    good reset => status=${res.status} rows=${actions(tables)}`);
  T("a strong password is accepted", res.status === 200 && res.body?.success === true,
    JSON.stringify(res.body));
  T("the token is consumed", row(tables, "u_target").reset_token_hash === null);
  T("the reset is recorded in the audit trail",
    tables.AuditLog.__rows().some((r) => /password/i.test(r.action)), actions(tables));
  // Both of the next two are vacuously true over an empty table — `every` on no
  // rows is true, and the verifier reports valid with count 0 — so the row count
  // is asserted first. Without this premise the pair passed while the reset was
  // writing nothing at all.
  const auditRows = tables.AuditLog.__rows();
  T("a row was actually written to chain", auditRows.length >= 1, `rows=${auditRows.length}`);
  T("the recorded row is chained",
    auditRows.length >= 1 && auditRows.every((r) => typeof r.hash === "string" && r.hash.length === 64),
    JSON.stringify(auditRows.map((r) => r.hash)));
  const v = await verifyChain(tables);
  T("the chain still verifies with a reset row in it",
    v.valid === true && v.count >= 1, JSON.stringify(v));
  T("every session for that account is revoked", live(tables, "u_target").length === 0,
    "whoever forced the reset would otherwise still be signed in");

  // The new password has to actually work afterwards.
  const after = await signIn({ username: "clerk1", password: NEWPASS });
  T("the new password signs in", after.status === 200 && after.body?.success === true,
    JSON.stringify(after.body));
}

section("12. Reset requests are throttled and do not leak the token");
{
  // host.includes('localhost') is true for a host an attacker controls.
  let tables = world({ users: [mkUser({ email: "clerk@example.com" })] });
  let res = await askReset("clerk@example.com", "localhost.evil.com", "203.0.113.10");
  console.log(`    Host: localhost.evil.com => ${JSON.stringify(res.body)}`);
  T("a hostile Host header does not get the reset token handed to it",
    res.body?.token === undefined,
    `body=${JSON.stringify(res.body)} — the check was host.includes('localhost')`);
  T("the response still claims success", res.body?.success === true, JSON.stringify(res.body));
  T("the token was mailed instead", (tables.__emails?.() || []).length === 1,
    JSON.stringify(tables.__emails?.() || []));

  // A real local dev host keeps the convenience.
  tables = world({ users: [mkUser({ email: "clerk@example.com" })] });
  res = await askReset("clerk@example.com", "localhost:5173", "127.0.0.1");
  T("a genuine localhost host still returns the token for dev", typeof res.body?.token === "string",
    JSON.stringify(res.body));

  // Unthrottled, this endpoint mints a fresh token per call and mails it.
  tables = world({ users: [mkUser({ email: "clerk@example.com" })] });
  const statuses = [];
  for (let i = 0; i < 8; i += 1) {
    statuses.push((await askReset("clerk@example.com", "hotel.example.com", "203.0.113.11")).status);
  }
  console.log(`    8 requests from one IP => ${statuses.join(",")}`);
  T("reset requests from one source are throttled", statuses.includes(429),
    `statuses=${statuses.join(",")} — anyone could flood an inbox and re-mint tokens`);
  T("the mail stopped when the throttle tripped", (tables.__emails?.() || []).length <= 5,
    `emails=${(tables.__emails?.() || []).length}`);
}

section("13. A slid session slides the cookie with it");
{
  // Two days left: custom_auth_me slides expires_at, but the browser cookie was
  // set with Max-Age=7d at login, so without a fresh Set-Cookie the session dies
  // in the browser while the row says it is alive.
  let tables = world({
    users: [mkUser()],
    sessions: [mkSession("s_t1", "u_target", "tok_t1", {
      expires_at: new Date(Date.now() + 2 * 24 * 3600e3).toISOString(),
    })],
  });
  let res = await me("tok_t1");
  const slid = tables.Session.__rows()[0].expires_at;
  console.log(`    slide => status=${res.status} set-cookie=${res.setCookie}`);
  T("the session is accepted", res.status === 200 && res.body?.user?.id === "u_target",
    JSON.stringify(res.body));
  T("the stored expiry slid forward",
    new Date(slid).getTime() - Date.now() > 6 * 24 * 3600e3, `expires_at=${slid}`);
  T("the cookie is re-issued so the browser copy lives as long",
    typeof res.setCookie === "string" && res.setCookie.includes("base44_session=tok_t1"),
    `set-cookie=${JSON.stringify(res.setCookie)}`);
  T("the re-issued cookie keeps its protections",
    /HttpOnly/.test(res.setCookie || "") && /SameSite=Lax/.test(res.setCookie || "") && /Max-Age=/.test(res.setCookie || ""),
    `set-cookie=${JSON.stringify(res.setCookie)}`);

  // A session inside its window must not be touched at all.
  tables = world({ users: [mkUser()], sessions: [mkSession("s_t1", "u_target", "tok_t1")] });
  res = await me("tok_t1");
  T("a session with time left is not re-issued on every poll", res.setCookie === null,
    `set-cookie=${JSON.stringify(res.setCookie)}`);

  // The absolute cap still ends it.
  tables = world({
    users: [mkUser()],
    sessions: [mkSession("s_t1", "u_target", "tok_t1", {
      created_date: new Date(Date.now() - 31 * 24 * 3600e3).toISOString(),
      expires_at: new Date(Date.now() + 3600e3).toISOString(),
    })],
  });
  res = await me("tok_t1");
  T("a session past its 30-day absolute lifetime is revoked",
    res.status === 401 && tables.Session.__rows()[0].is_revoked === true,
    `status=${res.status} revoked=${tables.Session.__rows()[0].is_revoked}`);
}

section("14. The browser's CSRF pair cannot drift apart");
{
  // The SDK spreads the headers object once, at createClient time
  // (node_modules/@base44/sdk/dist/client.js: `const headers = {...optionalHeaders,
  // "X-App-Id": ...}`), so X-CSRF-Token is fixed for the life of the page while
  // rotateCsrfToken() keeps rewriting the csrf_token cookie. Every server
  // function compares the two, so after any rotation — a password change, a
  // guarded delete — every later call answered 403.
  const client = read("src/api/base44Client.js");
  T("the CSRF header token is captured once, deliberately",
    /const CSRF_HEADER_TOKEN\s*=/.test(client),
    "the value the SDK will send has to be nameable to be kept in step");
  T("the cookie is re-pinned to that value before a backend call",
    /pinCsrfCookie\(\)/.test(client) &&
      /pinCsrfCookie\(\);[\s\S]{0,400}realClient\.functions\.invoke/.test(client),
    "otherwise the header and the cookie disagree after any rotation");

  const utils = read("src/lib/securityUtils.js");
  T("the CSRF cookie is written in one place", (utils.match(/__Host-csrf_token=\$\{/g) || []).length <= 1,
    "getCsrfToken and rotateCsrfToken both wrote the cookie by hand");
  T("the CSRF cookie carries Secure over https", /Secure/.test(utils),
    "a plaintext downgrade could otherwise read it");
}

section("15. Login is unchanged where it was already right");
{
  // Regression guard: the launch gate and the generic-refusal contract that
  // scripts/probe-auth-audit.mjs and src/lib/launchPolicy.js depend on.
  const tables = world({ users: [mkUser({ property_access: ["prop_1"] })] });
  const res = await signIn({ username: "clerk1", password: PASSWORD });
  T("a single-property account still cannot sign in", res.status === 403, `status=${res.status}`);
  T("the refusal still carries its machine-readable code",
    res.body?.code === "ALL_PROPERTY_ACCESS_REQUIRED", JSON.stringify(res.body));
  T("the refusal is recorded", /Failed Login/.test(actions(tables)), actions(tables));

  const ok = world({ users: [mkUser()] });
  const good = await signIn({ username: "clerk1", password: PASSWORD });
  T("an all-property account still signs in", good.status === 200 && good.body?.success === true,
    JSON.stringify(good.body));
  T("the session cookie is still HttpOnly and Secure",
    /HttpOnly/.test(good.headers?.get?.("Set-Cookie") || "") &&
      /Secure/.test(good.headers?.get?.("Set-Cookie") || ""),
    String(good.headers?.get?.("Set-Cookie")));
  T("the success is recorded", /Login\[success\]/.test(actions(ok)), actions(ok));
}

section("16. The UI supplies the step-up password the server now demands");
{
  // Static, not rendered: vitest cannot run in this environment, and the failure
  // mode being guarded is a wiring omission, which is visible in source. Without
  // these, the server-side step-up above would be a feature that 403s every time
  // a real operator touches it — protection that looks present and works by
  // breaking the product.
  //
  // Negative assertions run against comment-stripped source, because the fixes
  // deliberately quote the calls they replaced.
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const client = strip(read("src/api/base44Client.js"));
  const settings = strip(read("src/pages/Settings.jsx"));
  const users = strip(read("src/pages/Users.jsx"));
  const dialog = strip(read("src/components/PasswordConfirmDialog.jsx"));

  T("the client wrapper forwards a currentPassword to enable_mfa",
    /enableMfa\s*\(\s*actor\s*,\s*id\s*,\s*currentPassword\s*\)/.test(client) &&
      /action:\s*'enable_mfa',\s*id,\s*currentPassword/.test(client),
    "src/api/base44Client.js");
  T("the client wrapper forwards a currentPassword to disable_mfa",
    /disableMfa\s*\(\s*actor\s*,\s*id\s*,\s*currentPassword\s*\)/.test(client) &&
      /action:\s*'disable_mfa',\s*id,\s*currentPassword/.test(client),
    "src/api/base44Client.js");

  T("a password prompt component exists",
    /type="password"/.test(dialog) && /onConfirm/.test(dialog),
    "src/components/PasswordConfirmDialog.jsx");
  T("the prompt does not keep the password after it closes",
    /setPassword\(''\)/.test(dialog) || /setPassword\(""\)/.test(dialog),
    "src/components/PasswordConfirmDialog.jsx");

  for (const [name, src] of [["Settings.jsx", settings], ["Users.jsx", users]]) {
    T(`${name} renders the password prompt`, /PasswordConfirmDialog/.test(src), name);
    // Every() over an empty match set is true, so the call sites are counted
    // first. Without this premise, DELETING the MFA calls entirely would turn
    // these two assertions green — a guard that passes hardest when the feature
    // is gone.
    const disableCalls = [...src.matchAll(/disableMfa\(([^)]*)\)/g)];
    const enableCalls = [...src.matchAll(/enableMfa\(([^)]*)\)/g)];
    T(`${name} still calls both MFA endpoints`,
      disableCalls.length >= 1 && enableCalls.length >= 1,
      `disableMfa=${disableCalls.length} enableMfa=${enableCalls.length}`);
    // The defect this pins: a bare disableMfa(me, id) call, which the server now
    // refuses with 403 every single time.
    T(`${name} never calls disableMfa without a password`,
      disableCalls.length >= 1 && disableCalls.every((m) => m[1].split(",").length >= 3),
      disableCalls.map((m) => m[0]).join(" | "));
    T(`${name} passes a password to enableMfa`,
      enableCalls.length >= 1 && enableCalls.every((m) => m[1].split(",").length >= 3),
      enableCalls.map((m) => m[0]).join(" | "));
  }

  // disable_mfa revokes EVERY session for the account, the caller's included, so
  // a self-disable that stays on the page leaves a signed-in-looking UI whose
  // next request 401s.
  T("Settings signs the operator out after disabling their own factor",
    /runMfaDisable[\s\S]{0,900}?logout\(/.test(settings), "src/pages/Settings.jsx");

  // enable_mfa returns the enrolment secret exactly once and revokes the target's
  // other sessions. Dropping it locks the user out of an account that now demands
  // a code nobody can produce.
  T("Users.jsx shows the one-time enrolment secret instead of discarding it",
    /setMfaHandoff\(\{[\s\S]{0,200}secret/.test(users) && /mfaHandoff\.secret/.test(users),
    "src/pages/Users.jsx");
}

console.log(`\n${"─".repeat(60)}`);
console.log(`probe-auth-hardening: ${pass} passed, ${fail} failed`);
if (fail) {
  console.log("\nFailures:");
  failures.forEach((f) => console.log(`  · ${f}`));
  process.exit(1);
}
