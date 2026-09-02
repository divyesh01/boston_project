// scripts/probe-worker-credential-lifecycle.mjs — the server-side credential
// lifecycle, proven against the PRODUCTION-EXACT authentication schema.
//
// Every check here loads migrations-production/0001_auth_schema.sql byte for byte
// (makeProductionDb), not worker/schema.sql. That distinction is the whole point:
// the H1 defect — INSERT INTO user without password_hash/salt — was invisible to
// every existing suite precisely because the staging schema left those columns
// nullable. A probe that runs against a parity-checked COPY can only prove the
// copy; this one runs against production's own DDL, so a missing NOT NULL column
// fails here exactly the way it fails in Cloudflare.
//
// WHAT IS REAL AND WHAT IS SHIMMED:
//   * Real: worker/index.js's routing, its CSRF gate, authenticateAppSession,
//     resolveScope, worker/users.js authorization, worker/password-credential.js
//     PBKDF2+HMAC derivation, worker/totp.js RFC 6238 codes, and the production
//     DDL's NOT NULL / UNIQUE / CHECK / FOREIGN KEY constraints.
//   * Shimmed: the D1 binding (node:sqlite, one real transaction per batch()).
//     Nothing about credentials or authorization is stubbed.
//
// BLOCKED/UNPROVEN: this does not exercise Cloudflare's live D1 or a deployed
// Worker. scripts/probe-worker-auth-remote.mjs covers the remote path.

import worker from "../worker/index.js";
import {
  createCredentialWithParameters,
  credentialNeedsUpgrade,
  isSupportedCredential,
} from "../worker/password-credential.js";
import { counterForTime, totpAt } from "../worker/totp.js";
import { validatePasswordStrength } from "../worker/password-policy.js";
import {
  assert,
  assertEqual,
  makeEnv,
  makeProductionDb,
  makeRunner,
  seedAuthFixture,
  seedCredential,
  seedUser,
} from "./_worker-testkit.mjs";

const origin = "https://app.test";
const PEPPER_V1 = "probe-pepper-v1-at-least-32-characters-long";
const PEPPER_V2 = "probe-pepper-v2-at-least-32-characters-long";

const OWNER_PASSWORD = "OwnerPass!2026x";
const STAFF_PASSWORD = "StaffPass!2026x";
const NEXT_PASSWORD = "StaffNext!2026y";

const run = makeRunner("probe-worker-credential-lifecycle");

// ---------------------------------------------------------------------------
// Request plumbing
// ---------------------------------------------------------------------------

/** The first cookie value out of a Set-Cookie header, without its attributes. */
function cookieValue(setCookie) {
  return String(setCookie || "").split(";")[0] || "";
}

/**
 * Drive the REAL Worker entry point. `requestedWith` and `originHeader` default
 * to values that satisfy the CSRF gate, so a check that wants to prove the gate
 * still fires overrides them explicitly rather than relying on an omission.
 */
async function call(env, path, { method = "GET", body, cookie, originHeader = origin, requestedWith = "XMLHttpRequest" } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (originHeader) headers.origin = originHeader;
  if (requestedWith) headers["X-Requested-With"] = requestedWith;
  const response = await worker.fetch(
    new Request(`${origin}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
    env,
    { waitUntil() {}, passThroughOnException() {} },
  );
  let payload = null;
  try { payload = await response.json(); } catch { payload = null; }
  return {
    status: response.status,
    body: payload,
    setCookie: response.headers.get("set-cookie"),
    cacheControl: response.headers.get("cache-control"),
  };
}

/** Sign in and return the session cookie, or "" plus the response for a failure. */
async function login(env, identifier, password, extra = {}) {
  const response = await call(env, "/api/auth/login", { method: "POST", body: { identifier, password, ...extra } });
  return { ...response, cookie: cookieValue(response.setCookie) };
}

/** Read a user row straight out of SQLite, bypassing every Worker projection. */
function userRow(db, id) {
  return db.prepare("SELECT * FROM user WHERE id=?").get(id);
}

/**
 * A production-shaped database with an owner who holds a REAL credential, plus
 * the env the Worker sees. `ENABLE_D1_DATA_API` stays "false" because production
 * is auth-only; the user/credential routes must work with business data off.
 */
async function freshWorld({ pepperVersion = 1 } = {}) {
  const db = makeProductionDb();
  seedAuthFixture(db);
  seedUser(db, { id: "U_OWNER", email: "owner@example.test", role: "owner", mode: "all", username: "owner" });
  const env = makeEnv(db, {
    ENABLE_D1_DATA_API: "false",
    PASSWORD_PEPPER_V1: PEPPER_V1,
    ...(pepperVersion === 2 ? { PASSWORD_PEPPER_V2: PEPPER_V2, PASSWORD_PEPPER_CURRENT_VERSION: "2" } : {}),
  });
  await seedCredential(db, { userId: "U_OWNER", password: OWNER_PASSWORD, pepper: pepperVersion === 2 ? PEPPER_V2 : PEPPER_V1 });
  if (pepperVersion === 2) {
    // seedCredential mints at p=1; rewrite the marker so the owner's stored
    // credential honestly declares the pepper it was derived with.
    const row = userRow(db, "U_OWNER");
    db.prepare("UPDATE user SET password_hash=? WHERE id=?").run(String(row.password_hash).replace("$p=1$", "$p=2$"), "U_OWNER");
  }
  const session = await login(env, "owner", OWNER_PASSWORD);
  assertEqual(session.status, 200, "owner fixture could not sign in");
  return { db, env, owner: session.cookie };
}

/** Create a user through POST /api/users the way src/api/base44Client.js does. */
function createUser(env, cookie, data) {
  return call(env, "/api/users", { method: "POST", cookie, body: { data } });
}

const STAFF = {
  username: "frontdesk1",
  email: "frontdesk1@example.test",
  display_name: "Front Desk One",
  role: "front_desk",
  property_access: ["P_A"],
};

// ---------------------------------------------------------------------------
// GATE 1 — CREATE USER
// ---------------------------------------------------------------------------
// H1 verbatim: worker/users.js built a 13-column INSERT with password_hash and
// salt absent, both of which production declares NOT NULL. The batch throws, the
// UserRequestError branch does not catch it, and worker/index.js answers 500 —
// so "create a user" was impossible in production and looked like a server bug.

await run.check("GATE 1 CREATE USER: an admin creates a user with a real credential", async () => {
  const { db, env, owner } = await freshWorld();
  const created = await createUser(env, owner, { ...STAFF, password: STAFF_PASSWORD });
  assertEqual(created.status, 201, `create failed: ${JSON.stringify(created.body)}`);
  const id = created.body?.user?.id;
  assert(typeof id === "string" && id.length > 0, "response carried no user id");
  const row = userRow(db, id);
  assert(row, "no user row was written");
  assert(isSupportedCredential(row.password_hash, env), `stored credential is not verifiable: ${row.password_hash}`);
  assert(String(row.salt || "").length > 0, "salt column was left empty");
  assertEqual(row.account_id, "A_1", "the new user landed outside the creator's account");
  assertEqual(row.must_change_password, 0, "an explicitly supplied password must not force a change");
  assert(row.created_date, "created_date NOT NULL was not satisfied");
  assert(row.updated_date, "updated_date NOT NULL was not satisfied");
});

await run.check("GATE 1 CREATE USER: the plaintext password is never echoed back", async () => {
  const { env, owner } = await freshWorld();
  const created = await createUser(env, owner, { ...STAFF, password: STAFF_PASSWORD });
  assertEqual(created.status, 201, `create failed: ${JSON.stringify(created.body)}`);
  assert(
    !JSON.stringify(created.body).includes(STAFF_PASSWORD),
    "the response body contains the plaintext password",
  );
});

await run.check("GATE 1 CREATE USER: a temporary password is issued when none is supplied", async () => {
  const { db, env, owner } = await freshWorld();
  const created = await createUser(env, owner, STAFF);
  assertEqual(created.status, 201, `create failed: ${JSON.stringify(created.body)}`);
  const temporary = created.body?.temporary_password;
  assert(typeof temporary === "string" && temporary.length >= 12, "no usable temporary password was returned");
  assertEqual(validatePasswordStrength(temporary), "", "the temporary password violates the password policy");
  assertEqual(created.cacheControl, "no-store", "a response carrying a temporary credential may be cached");
  assertEqual(userRow(db, created.body.user.id).must_change_password, 1, "a temporary password must force a change");
  const signIn = await login(env, STAFF.username, temporary);
  assertEqual(signIn.status, 200, `the temporary password does not authenticate: ${JSON.stringify(signIn.body)}`);
});

await run.check("GATE 1 CREATE USER: a weak password is a 400 carrying the policy reason", async () => {
  const { env, owner } = await freshWorld();
  const created = await createUser(env, owner, { ...STAFF, password: "short" });
  assertEqual(created.status, 400, `expected 400, got ${created.status}`);
  assert(/^Password must /.test(String(created.body?.error)), `unhelpful error: ${JSON.stringify(created.body)}`);
});

await run.check("GATE 1 CREATE USER: a duplicate username is a 409, never a 500", async () => {
  const { env, owner } = await freshWorld();
  assertEqual((await createUser(env, owner, { ...STAFF, password: STAFF_PASSWORD })).status, 201);
  // The production uniqueness indexes are GLOBAL — idx_user_username_ci is on
  // lower(username) with no account predicate — so an account-scoped pre-check
  // would leave the INSERT free to raise a constraint error and surface as 500.
  const again = await createUser(env, owner, { ...STAFF, email: "other@example.test", password: STAFF_PASSWORD });
  assertEqual(again.status, 409, `expected 409, got ${again.status}: ${JSON.stringify(again.body)}`);
});

await run.check("GATE 1 CREATE USER: a duplicate email is a 409, never a 500", async () => {
  const { env, owner } = await freshWorld();
  assertEqual((await createUser(env, owner, { ...STAFF, password: STAFF_PASSWORD })).status, 201);
  const again = await createUser(env, owner, { ...STAFF, username: "frontdesk2", password: STAFF_PASSWORD });
  assertEqual(again.status, 409, `expected 409, got ${again.status}: ${JSON.stringify(again.body)}`);
});

await run.check("GATE 1 CREATE USER: a malformed username or email is refused before any write", async () => {
  const { db, env, owner } = await freshWorld();
  const badUsername = await createUser(env, owner, { ...STAFF, username: "no spaces", password: STAFF_PASSWORD });
  assertEqual(badUsername.status, 400, `expected 400 for a bad username, got ${badUsername.status}`);
  const badEmail = await createUser(env, owner, { ...STAFF, email: "not-an-email", password: STAFF_PASSWORD });
  assertEqual(badEmail.status, 400, `expected 400 for a bad email, got ${badEmail.status}`);
  assertEqual(Number(db.prepare("SELECT COUNT(*) c FROM user").get().c), 1, "a refused create still wrote a row");
});

await run.check("GATE 1 CREATE USER: missing credential pepper is a controlled 503 with zero writes", async () => {
  const { db, env, owner } = await freshWorld();
  delete env.PASSWORD_PEPPER_V1;
  const before = Number(db.prepare("SELECT COUNT(*) c FROM user").get().c);
  const created = await createUser(env, owner, { ...STAFF, password: STAFF_PASSWORD });
  assertEqual(created.status, 503, `expected 503, got ${created.status}: ${JSON.stringify(created.body)}`);
  assertEqual(Number(db.prepare("SELECT COUNT(*) c FROM user").get().c), before, "missing pepper still wrote a user row");
});

await run.check("GATE 1 CREATE USER: a non-admin cannot create a user", async () => {
  const { db, env } = await freshWorld();
  seedUser(db, { id: "U_STAFF", email: "staff@example.test", role: "front_desk", mode: "specific", grants: ["P_A"], username: "staffonly" });
  await seedCredential(db, { userId: "U_STAFF", password: STAFF_PASSWORD, pepper: PEPPER_V1 });
  const staff = await login(env, "staffonly", STAFF_PASSWORD);
  assertEqual(staff.status, 200, "staff fixture could not sign in");
  const created = await createUser(env, staff.cookie, { ...STAFF, username: "sneak", email: "sneak@example.test", password: STAFF_PASSWORD });
  assertEqual(created.status, 403, `expected 403, got ${created.status}`);
  assertEqual(Number(db.prepare("SELECT COUNT(*) c FROM user").get().c), 2, "a forbidden create still wrote a row");
});

await run.check("GATE 1 CREATE USER: the CSRF gate still refuses a cross-origin create", async () => {
  const { env, owner } = await freshWorld();
  const created = await call(env, "/api/users", {
    method: "POST",
    cookie: owner,
    body: { data: { ...STAFF, password: STAFF_PASSWORD } },
    originHeader: "https://evil.test",
  });
  assertEqual(created.status, 403, `expected 403, got ${created.status}`);
});

await run.check("GATE 1 ROLE HIERARCHY: a delegated admin cannot mint an owner", async () => {
  const { db, env } = await freshWorld();
  seedUser(db, { id: "U_ADMIN", email: "admin@example.test", role: "admin", mode: "all", username: "admin1" });
  db.prepare("UPDATE user SET permissions=? WHERE id=?").run(JSON.stringify({ manage_users: true }), "U_ADMIN");
  await seedCredential(db, { userId: "U_ADMIN", password: STAFF_PASSWORD, pepper: PEPPER_V1 });
  const admin = await login(env, "admin1", STAFF_PASSWORD);
  const created = await createUser(env, admin.cookie, {
    username: "owner2", email: "owner2@example.test", role: "owner", property_access: "all", password: NEXT_PASSWORD,
  });
  assertEqual(created.status, 403, `delegated admin minted an owner: ${JSON.stringify(created.body)}`);
});

await run.check("GATE 1 ROLE HIERARCHY: a delegated admin cannot promote an existing user to owner", async () => {
  const { db, env, owner } = await freshWorld();
  const staff = await createUser(env, owner, { ...STAFF, password: STAFF_PASSWORD });
  seedUser(db, { id: "U_ADMIN", email: "admin@example.test", role: "admin", mode: "all", username: "admin1" });
  db.prepare("UPDATE user SET permissions=? WHERE id=?").run(JSON.stringify({ manage_users: true }), "U_ADMIN");
  await seedCredential(db, { userId: "U_ADMIN", password: NEXT_PASSWORD, pepper: PEPPER_V1 });
  const admin = await login(env, "admin1", NEXT_PASSWORD);
  const promoted = await call(env, `/api/users/${staff.body.user.id}`, {
    method: "PATCH", cookie: admin.cookie, body: { data: { role: "owner", property_access: "all" } },
  });
  assertEqual(promoted.status, 403, `delegated admin promoted an owner: ${JSON.stringify(promoted.body)}`);
});

await run.check("GATE 1 PATCH VALIDATION: malformed identity is refused and duplicate identity is controlled", async () => {
  const { env, owner } = await freshWorld();
  const first = await createUser(env, owner, { ...STAFF, password: STAFF_PASSWORD });
  const second = await createUser(env, owner, { ...STAFF, username: "frontdesk2", email: "frontdesk2@example.test", password: NEXT_PASSWORD });
  const malformed = await call(env, `/api/users/${first.body.user.id}`, {
    method: "PATCH", cookie: owner, body: { data: { username: "not valid" } },
  });
  assertEqual(malformed.status, 400, `malformed PATCH was accepted: ${JSON.stringify(malformed.body)}`);
  const duplicate = await call(env, `/api/users/${second.body.user.id}`, {
    method: "PATCH", cookie: owner, body: { data: { email: STAFF.email } },
  });
  assertEqual(duplicate.status, 409, `duplicate PATCH was not controlled: ${JSON.stringify(duplicate.body)}`);
});

// ---------------------------------------------------------------------------
// GATES 2-3 — LOGIN NEW USER / WRONG PASSWORD
// ---------------------------------------------------------------------------

/** A world with STAFF already created through the API at STAFF_PASSWORD. */
async function worldWithStaff(options = {}) {
  const world = await freshWorld(options);
  const created = await createUser(world.env, world.owner, { ...STAFF, password: STAFF_PASSWORD });
  assertEqual(created.status, 201, `staff create failed: ${JSON.stringify(created.body)}`);
  return { ...world, staffId: created.body.user.id };
}

await run.check("GATE 2 LOGIN NEW USER: the created user signs in on the credential just minted", async () => {
  const { env } = await worldWithStaff();
  const byUsername = await login(env, STAFF.username, STAFF_PASSWORD);
  assertEqual(byUsername.status, 200, `username sign-in failed: ${JSON.stringify(byUsername.body)}`);
  assert(byUsername.cookie.startsWith("__Host-rri_session="), "no __Host- session cookie was issued");
  assert(/HttpOnly/i.test(byUsername.setCookie) && /Secure/i.test(byUsername.setCookie), "session cookie is not HttpOnly+Secure");
  const byEmail = await login(env, STAFF.email, STAFF_PASSWORD);
  assertEqual(byEmail.status, 200, `email sign-in failed: ${JSON.stringify(byEmail.body)}`);
});

await run.check("GATE 3 WRONG PASSWORD: 401", async () => {
  const { env } = await worldWithStaff();
  const wrong = await login(env, STAFF.username, "WrongPass!2026x");
  assertEqual(wrong.status, 401, `expected 401, got ${wrong.status}`);
  assertEqual(wrong.cookie, "", "a failed sign-in issued a session cookie");
});

// ---------------------------------------------------------------------------
// GATES 4-5 — CHANGE PASSWORD / OLD PASSWORD AFTER CHANGE
// ---------------------------------------------------------------------------

function changeOwn(env, cookie, id, currentPassword, newPassword) {
  return call(env, `/api/users/${encodeURIComponent(id)}/password/change`, {
    method: "POST", cookie, body: { currentPassword, newPassword },
  });
}

await run.check("GATE 4 CHANGE PASSWORD: a user changes their own password and the new one works", async () => {
  const { db, env, staffId } = await worldWithStaff();
  const before = userRow(db, staffId).password_hash;
  const staff = await login(env, STAFF.username, STAFF_PASSWORD);
  const changed = await changeOwn(env, staff.cookie, staffId, STAFF_PASSWORD, NEXT_PASSWORD);
  assertEqual(changed.status, 200, `change failed: ${JSON.stringify(changed.body)}`);
  const after = userRow(db, staffId);
  assert(after.password_hash !== before, "the stored credential did not change");
  assert(isSupportedCredential(after.password_hash, env), "the replacement credential is not verifiable");
  assertEqual(await (await login(env, STAFF.username, NEXT_PASSWORD)).status, 200, "the new password does not authenticate");
});

await run.check("GATE 5 OLD PASSWORD AFTER CHANGE: FAIL", async () => {
  const { env, staffId } = await worldWithStaff();
  const staff = await login(env, STAFF.username, STAFF_PASSWORD);
  assertEqual((await changeOwn(env, staff.cookie, staffId, STAFF_PASSWORD, NEXT_PASSWORD)).status, 200);
  const old = await login(env, STAFF.username, STAFF_PASSWORD);
  assertEqual(old.status, 401, `the retired password still authenticates (status ${old.status})`);
});

await run.check("GATE 4 CHANGE PASSWORD: the wrong current password is refused", async () => {
  const { db, env, staffId } = await worldWithStaff();
  const before = userRow(db, staffId).password_hash;
  const staff = await login(env, STAFF.username, STAFF_PASSWORD);
  const changed = await changeOwn(env, staff.cookie, staffId, "NotMyPass!2026x", NEXT_PASSWORD);
  assert(changed.status === 400 || changed.status === 403, `expected 400/403, got ${changed.status}`);
  assertEqual(userRow(db, staffId).password_hash, before, "a refused change still replaced the credential");
});

await run.check("GATE 4 CHANGE PASSWORD: a weak replacement is refused with the policy reason", async () => {
  const { env, staffId } = await worldWithStaff();
  const staff = await login(env, STAFF.username, STAFF_PASSWORD);
  const changed = await changeOwn(env, staff.cookie, staffId, STAFF_PASSWORD, "alllowercase");
  assertEqual(changed.status, 400, `expected 400, got ${changed.status}`);
  assert(/^Password must /.test(String(changed.body?.error)), `unhelpful error: ${JSON.stringify(changed.body)}`);
});

await run.check("GATE 4 CHANGE PASSWORD: nobody can change ANOTHER user's password this way", async () => {
  const { db, env, staffId, owner } = await worldWithStaff();
  const before = userRow(db, staffId).password_hash;
  // An owner is the most privileged caller there is; change-own-password is still
  // not the route for it, because it would let a stolen admin session rewrite a
  // credential while only ever proving the ADMIN's password.
  const asOwner = await changeOwn(env, owner, staffId, OWNER_PASSWORD, NEXT_PASSWORD);
  assertEqual(asOwner.status, 403, `expected 403, got ${asOwner.status}`);
  assertEqual(userRow(db, staffId).password_hash, before, "another user's credential was replaced");
});

// ---------------------------------------------------------------------------
// GATE 6 — ADMIN RESET PASSWORD  (+ the admin SET variant)
// ---------------------------------------------------------------------------
// An admin cannot produce the target's password and must never need it, so these
// two routes are separated from change-own-password by AUTHORIZATION, not by
// knowledge: reset/set prove the CALLER is an admin, change proves the caller is
// the ACCOUNT HOLDER. Both admin routes revoke every session the target holds,
// because a credential replaced by someone else is exactly the case where an
// already-open session may be the attacker's.

function adminReset(env, cookie, id, body = {}) {
  return call(env, `/api/users/${encodeURIComponent(id)}/password/reset`, { method: "POST", cookie, body });
}

function adminSet(env, cookie, id, newPassword) {
  return call(env, `/api/users/${encodeURIComponent(id)}/password/set`, { method: "POST", cookie, body: { newPassword } });
}

/** How many server-side sessions a user currently holds. */
function sessionCount(db, userId) {
  return Number(db.prepare("SELECT COUNT(*) c FROM app_session WHERE user_id=?").get(userId).c);
}

await run.check("GATE 6 ADMIN RESET PASSWORD: a temporary password is issued and the old one dies", async () => {
  const { db, env, owner, staffId } = await worldWithStaff();
  const staff = await login(env, STAFF.username, STAFF_PASSWORD);
  assertEqual(sessionCount(db, staffId), 1, "the staff sign-in did not create a session row");
  const reset = await adminReset(env, owner, staffId);
  assertEqual(reset.status, 200, `reset failed: ${JSON.stringify(reset.body)}`);
  const temporary = reset.body?.temporary_password;
  assert(typeof temporary === "string" && temporary.length >= 12, "no usable temporary password was returned");
  assertEqual(reset.cacheControl, "no-store", "a reset response carrying a temporary credential may be cached");
  assertEqual(validatePasswordStrength(temporary), "", "the issued password violates the password policy");
  assertEqual(userRow(db, staffId).must_change_password, 1, "a reset must force a password change");
  assertEqual(sessionCount(db, staffId), 0, "the reset left the target's sessions alive");
  assertEqual((await call(env, "/api/users", { cookie: staff.cookie })).status, 401, "the target's old session still authenticates");
  assertEqual((await login(env, STAFF.username, STAFF_PASSWORD)).status, 401, "the pre-reset password still authenticates");
  assertEqual((await login(env, STAFF.username, temporary)).status, 200, "the issued temporary password does not authenticate");
});

await run.check("GATE 6 ADMIN RESET PASSWORD: privileged callers cannot reset themselves without the current password", async () => {
  const { env, owner } = await freshWorld();
  const reset = await adminReset(env, owner, "U_OWNER", { newPassword: NEXT_PASSWORD });
  assertEqual(reset.status, 403, `privileged self-reset was accepted: ${JSON.stringify(reset.body)}`);
});

await run.check("GATE 6 ADMIN RESET PASSWORD: reset clears lockout and pending MFA password proofs", async () => {
  const { db, env, owner, staffId } = await worldWithStaff();
  db.prepare("UPDATE user SET mfa_enabled=1,mfa_secret=?,failed_login_count=5,locked_until=?,is_locked=1 WHERE id=?")
    .run("JBSWY3DPEHPK3PXP", new Date(Date.now() + 900000).toISOString(), staffId);
  // Seed a pending proof exactly as the password-first MFA step would.
  db.prepare("INSERT INTO app_mfa_challenge (id,user_id,token_hash,expires_at) VALUES (?,?,?,?)")
    .run("C_STALE", staffId, "stale-proof", new Date(Date.now() + 300000).toISOString());
  const reset = await adminReset(env, owner, staffId, { newPassword: NEXT_PASSWORD });
  assertEqual(reset.status, 200, `reset failed: ${JSON.stringify(reset.body)}`);
  const row = userRow(db, staffId);
  assertEqual(row.failed_login_count, 0, "reset left the failed-login counter set");
  assertEqual(row.locked_until, null, "reset left locked_until set");
  assertEqual(row.is_locked, 0, "reset left the account locked");
  assertEqual(Number(db.prepare("SELECT COUNT(*) c FROM app_mfa_challenge WHERE user_id=?").get(staffId).c), 0, "reset left a password-proof challenge reusable");
});

await run.check("GATE 6 LOGIN RACE: a password changed after verification cannot receive a stale session", async () => {
  const { db, env } = await worldWithStaff();
  const originalBatch = env.DB.batch.bind(env.DB);
  let injected = false;
  env.DB.batch = async (statements) => {
    if (!injected && statements.some((statement) => /INSERT INTO app_session/.test(statement._sql))) {
      injected = true;
      db.prepare("UPDATE user SET password_hash=?,salt=? WHERE username=?").run("$unusable$concurrent-reset", "", STAFF.username);
    }
    return originalBatch(statements);
  };
  const stale = await login(env, STAFF.username, STAFF_PASSWORD);
  assertEqual(stale.status, 401, `a stale verified password received a session: ${JSON.stringify(stale.body)}`);
  assertEqual(stale.cookie, "", "the stale login received a cookie");
});

await run.check("GATE 6 ADMIN RESET PASSWORD: an explicit newPassword is honoured and never echoed", async () => {
  const { db, env, owner, staffId } = await worldWithStaff();
  const reset = await adminReset(env, owner, staffId, { newPassword: NEXT_PASSWORD });
  assertEqual(reset.status, 200, `reset failed: ${JSON.stringify(reset.body)}`);
  assert(!JSON.stringify(reset.body).includes(NEXT_PASSWORD), "the response body contains the plaintext password");
  assertEqual(userRow(db, staffId).must_change_password, 1, "a reset must force a password change");
  assertEqual((await login(env, STAFF.username, NEXT_PASSWORD)).status, 200, "the supplied password does not authenticate");
});

await run.check("GATE 6 ADMIN SET PASSWORD: no forced change, and every session is still revoked", async () => {
  const { db, env, owner, staffId } = await worldWithStaff();
  await login(env, STAFF.username, STAFF_PASSWORD);
  const set = await adminSet(env, owner, staffId, NEXT_PASSWORD);
  assertEqual(set.status, 200, `set failed: ${JSON.stringify(set.body)}`);
  assertEqual(userRow(db, staffId).must_change_password, 0, "an admin-set password must not force a change");
  assertEqual(sessionCount(db, staffId), 0, "the set left the target's sessions alive");
  assertEqual((await login(env, STAFF.username, NEXT_PASSWORD)).status, 200, "the set password does not authenticate");
});

await run.check("GATE 6 ADMIN RESET PASSWORD: a weak explicit password is refused with the policy reason", async () => {
  const { db, env, owner, staffId } = await worldWithStaff();
  const before = userRow(db, staffId).password_hash;
  const reset = await adminReset(env, owner, staffId, { newPassword: "nope" });
  assertEqual(reset.status, 400, `expected 400, got ${reset.status}`);
  assert(/^Password must /.test(String(reset.body?.error)), `unhelpful error: ${JSON.stringify(reset.body)}`);
  assertEqual(userRow(db, staffId).password_hash, before, "a refused reset still replaced the credential");
});

await run.check("GATE 6 ADMIN RESET PASSWORD: a non-admin cannot reset anyone, including themselves", async () => {
  const { db, env, staffId } = await worldWithStaff();
  const before = userRow(db, staffId).password_hash;
  const staff = await login(env, STAFF.username, STAFF_PASSWORD);
  assertEqual((await adminReset(env, staff.cookie, staffId)).status, 403, "a front_desk user could reset a password");
  assertEqual(userRow(db, staffId).password_hash, before, "a forbidden reset still replaced the credential");
});

await run.check("GATE 6 ADMIN RESET PASSWORD: a target in another account is a 404, not a reset", async () => {
  const { db, env, owner } = await worldWithStaff();
  db.prepare("INSERT INTO account (id,name,created_date) VALUES (?,?,?)").run("A_2", "Other Co", "2026-01-01");
  seedUser(db, { id: "U_OTHER", email: "other@other.test", role: "owner", mode: "all", accountId: "A_2", username: "otherowner" });
  const before = userRow(db, "U_OTHER").password_hash;
  const reset = await adminReset(env, owner, "U_OTHER");
  assertEqual(reset.status, 404, `expected 404, got ${reset.status}: ${JSON.stringify(reset.body)}`);
  assertEqual(userRow(db, "U_OTHER").password_hash, before, "a cross-account reset replaced the credential");
});

// ---------------------------------------------------------------------------
// GATE 7 — MUST_CHANGE_PASSWORD ENFORCED
// ---------------------------------------------------------------------------
// A forced change that only the UI honours is not a control: the flag lives in D1
// and the browser is the one thing that cannot be trusted to read it. So the
// SERVER refuses every /api/* route for a flagged session except the two it needs
// to clear the flag — sign out, and change-own-password.
//
// The check uses a MANAGER rather than the front_desk fixture on purpose: a
// manager may read the roster, so GET /api/users is a genuine 200 before the flag
// is set and a 403 after it. With a front_desk user both answers would be 403 and
// the check would pass without proving anything.

const MANAGER = {
  username: "manager1",
  email: "manager1@example.test",
  display_name: "Manager One",
  role: "manager",
  property_access: ["P_A"],
};

async function worldWithManager() {
  const world = await freshWorld();
  const created = await createUser(world.env, world.owner, { ...MANAGER, password: STAFF_PASSWORD });
  assertEqual(created.status, 201, `manager create failed: ${JSON.stringify(created.body)}`);
  return { ...world, managerId: created.body.user.id };
}

await run.check("GATE 7 MUST_CHANGE_PASSWORD ENFORCED: a flagged session is refused everywhere but the change route", async () => {
  const { db, env, owner, managerId } = await worldWithManager();
  const before = await login(env, MANAGER.username, STAFF_PASSWORD);
  assertEqual((await call(env, "/api/users", { cookie: before.cookie })).status, 200, "a manager cannot read the roster even unflagged");

  const reset = await adminReset(env, owner, managerId);
  assertEqual(reset.status, 200, `reset failed: ${JSON.stringify(reset.body)}`);
  const temporary = reset.body.temporary_password;
  const flagged = await login(env, MANAGER.username, temporary);
  assertEqual(flagged.status, 200, "the temporary password does not authenticate");

  const blocked = await call(env, "/api/users", { cookie: flagged.cookie });
  assertEqual(blocked.status, 403, `a flagged session still read the roster (status ${blocked.status})`);
  assertEqual(blocked.body?.code, "password_change_required", `unactionable refusal: ${JSON.stringify(blocked.body)}`);

  const changed = await changeOwn(env, flagged.cookie, managerId, temporary, NEXT_PASSWORD);
  assertEqual(changed.status, 200, `the flagged session could not change its own password: ${JSON.stringify(changed.body)}`);
  assertEqual(userRow(db, managerId).must_change_password, 0, "the change did not clear must_change_password");
  assertEqual((await call(env, "/api/users", { cookie: flagged.cookie })).status, 200, "the roster is still refused after the change");
});

await run.check("GATE 7 MUST_CHANGE_PASSWORD ENFORCED: a flagged session may still sign out", async () => {
  const { env, owner, managerId } = await worldWithManager();
  const temporary = (await adminReset(env, owner, managerId)).body.temporary_password;
  const flagged = await login(env, MANAGER.username, temporary);
  const out = await call(env, "/api/auth/logout", { method: "POST", cookie: flagged.cookie });
  assertEqual(out.status, 200, `a flagged session could not sign out (status ${out.status})`);
});

await run.check("GATE 7 MUST_CHANGE_PASSWORD ENFORCED: the change route keeps the caller's session and revokes the rest", async () => {
  const { db, env, managerId } = await worldWithManager();
  const first = await login(env, MANAGER.username, STAFF_PASSWORD);
  const second = await login(env, MANAGER.username, STAFF_PASSWORD);
  assertEqual(sessionCount(db, managerId), 2, "two sign-ins did not create two sessions");
  assertEqual((await changeOwn(env, second.cookie, managerId, STAFF_PASSWORD, NEXT_PASSWORD)).status, 200);
  assertEqual(sessionCount(db, managerId), 1, "the other session was not revoked");
  assertEqual((await call(env, "/api/users", { cookie: second.cookie })).status, 200, "the calling session was revoked");
  assertEqual((await call(env, "/api/users", { cookie: first.cookie })).status, 401, "the other session still authenticates");
});

await run.check("GATE 8 OWNER INVARIANT: concurrent demotions cannot remove every active owner", async () => {
  const { db, env, owner } = await freshWorld();
  seedUser(db, { id: "U_OWNER_2", email: "owner2@example.test", role: "owner", mode: "all", username: "owner2" });
  await seedCredential(db, { userId: "U_OWNER_2", password: STAFF_PASSWORD, pepper: PEPPER_V1 });
  const owner2 = await login(env, "owner2", STAFF_PASSWORD);
  const demote = (cookie, id) => call(env, `/api/users/${id}`, {
    method: "PATCH", cookie, body: { data: { role: "manager", property_access: ["P_A"] } },
  });
  const [left, right] = await Promise.all([demote(owner, "U_OWNER_2"), demote(owner2.cookie, "U_OWNER")]);
  assert([left.status, right.status].some((status) => status !== 200), `neither concurrent demotion was blocked: ${left.status}, ${right.status}`);
  assertEqual(Number(db.prepare("SELECT COUNT(*) c FROM user WHERE role='owner' AND is_active<>0").get().c), 1, "concurrent demotions removed every active owner");
});

run.done();
if (process.exitCode) process.exit(1);
console.log("PASSED: Worker credential lifecycle contract completed.");
