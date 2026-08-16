// Probe for "failed logins and every other pre-auth event are unloggable" (B10).
//
// base44/functions/audit_log/entry.js requires a valid session cookie and rejects
// any write whose payload.user_id differs from the session's user. A failed login
// has no session, so the browser's attempt to record it 403s and
// src/lib/auditLogger.js swallows the rejection into console.error. The result:
// brute force, credential stuffing, an account being locked out, and the IP rate
// limiter tripping all leave NO audit record — only a console line in the
// attacker's own browser. Nothing records successful logins either, so even if a
// break-in attempt were visible you could not tell whether it eventually worked.
//
// The fix has to be server-side, inside custom_auth_login itself: it is the only
// party that knows the truth about a pre-auth attempt, and adding an
// unauthenticated client-callable audit endpoint would hand an attacker a way to
// write attacker-authored rows into the very trail meant to convict them.
//
// This probe RUNS the real function entry files against an in-memory backend
// (scripts/stubs/*, resolved by scripts/resolve-base44.mjs), so the results are
// observations about shipped code.
//
// Run: node scripts/probe-auth-audit.mjs

import { register } from "node:module";
import crypto from "node:crypto";

register(new URL("./resolve-base44.mjs", import.meta.url));

const sdk = await import("./stubs/base44-sdk.mjs");
const runtime = await import("./stubs/base44-runtime.mjs");

const login = (await import("../base44/functions/custom_auth_login/entry.js")).default;
const auditVerify = (await import("../base44/functions/audit_verify/entry.js")).default;

let pass = 0;
let fail = 0;
const T = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`); }
};

const PASSWORD = "Correct-Horse-Battery-9!";
const SECRET = "probe-chain-secret";
const IP = "198.51.100.44";

// Same derivation custom_auth_login uses for the modern format, so the probe
// exercises the real password comparison rather than a shortcut around it.
const scrypt = (password, salt) =>
  new Promise((resolve, reject) =>
    crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (err, key) =>
      err ? reject(err) : resolve(key.toString("hex")),
    ),
  );

const SALT = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const HASH = `$scrypt$${await scrypt(PASSWORD, SALT)}`;

/** Fresh backend with one ordinary active user and an admin, no rate-limit state. */
function setup({ secret = SECRET, user = {} } = {}) {
  runtime.__clearSecrets();
  if (secret !== null) runtime.__setSecret("AUDIT_CHAIN_SECRET", secret);
  return sdk.__installBackend({
    users: [
      {
        id: "u_clerk", username: "clerk1", email: "clerk@example.com", role: "read_only",
        is_active: true, is_locked: false, mfa_enabled: false,
        // property_access 'all' because this release admits all-property accounts
        // only (the launch policy in custom_auth_login). Without it every
        // correct-password case here answers 403 and the probe would be measuring
        // the gate instead of the audit trail. 'read_only' + 'all' is a real shape:
        // a portfolio-wide auditor. §11 narrows a user on purpose to test the gate.
        property_access: "all",
        password_hash: HASH, salt: SALT, failed_login_count: 0, ...user,
      },
    ],
  });
}

// custom_auth_login reads req.url (to decide the Secure cookie flag) and
// x-forwarded-for (for the rate limiter), so both must be present or the handler
// throws into its own catch and answers 500 for reasons unrelated to the test.
const req = (body) => ({
  url: "https://probe.local/functions/custom_auth_login",
  headers: new Headers({ "x-forwarded-for": IP, "user-agent": "probe/1.0" }),
  json: async () => body,
});

const call = async (body) => {
  const res = await login(req(body));
  return { status: res.status ?? 200, body: await res.json() };
};

const attempt = (password, extra = {}) =>
  call({ username: "clerk1", password, ...extra });

const shape = (rows) =>
  rows.length === 0
    ? "(no audit rows)"
    : rows
        .map((r) => `${r.action} [${r.result}] user=${r.user_id ?? "null"} by="${r.performed_by}" hash=${r.hash ? `${r.hash.slice(0, 8)}…` : "MISSING"}`)
        .join("\n      ");

const verify = async () => {
  // audit_verify is admin-only, so it needs a session belonging to an admin (see
  // grantVerifier). The rows under test were written with no session at all —
  // that is the whole point of them.
  const res = await auditVerify({
    url: "https://probe.local/functions/audit_verify",
    headers: new Headers({ cookie: "base44_session=probe-verify-token" }),
    json: async () => ({}),
  });
  return res.json();
};

/** Add the admin + session audit_verify needs, without disturbing the chain. */
function grantVerifier(tables) {
  const token = "probe-verify-token";
  tables.User.__rows().push({ id: "u_admin", username: "admin1", role: "owner", is_active: true, is_locked: false });
  tables.Session.__rows().push({
    id: "s_verify",
    token_hash: crypto.createHash("sha256").update(token).digest("hex"),
    user_id: "u_admin",
    is_revoked: false,
    expires_at: new Date(Date.now() + 3600e3).toISOString(),
  });
}

// ── 1. A wrong password must leave a record ─────────────────────────────────
console.log("\n=== 1. Failed login (wrong password) ===");
let tables = setup();
grantVerifier(tables);
let res = await attempt("wrong-password");
let rows = tables.AuditLog.__rows();
console.log(`    login => status=${res.status} body=${JSON.stringify(res.body)}`);
console.log(`    audit rows:\n      ${shape(rows)}`);
T("the login was rejected", res.status === 401, `status=${res.status}`);
T("the failure was recorded", rows.length === 1, `rows=${rows.length}`);
// The UI's result filter offers ["all","success","failed"] (src/pages/AuditLog.jsx)
// and every existing writer in src/ uses 'failed', so a row marked 'failure'
// would be invisible under both filters — present in the table, unfindable.
T("the row is marked as a failure", rows[0]?.result === "failed", JSON.stringify(rows[0] || null));
T("the row names the account that was targeted", rows[0]?.user_id === "u_clerk", JSON.stringify(rows[0] || null));
T("the row records the source IP", rows[0]?.ip_address === IP, `ip_address=${rows[0]?.ip_address}`);
T("the row is hashed into the chain", !!rows[0]?.hash && rows[0]?.previous_hash === "0".repeat(64),
  JSON.stringify(rows[0] || null));
let v = await verify();
console.log(`    verify => ${JSON.stringify(v)}`);
T("the chain verifies with a pre-auth row in it", v.valid === true && v.count === 1, JSON.stringify(v));

// ── 2. An unknown identifier is the credential-stuffing signal ──────────────
console.log("\n=== 2. Failed login (unknown identifier) ===");
tables = setup();
grantVerifier(tables);
res = await call({ username: "  Administrator  ", password: "hunter2" });
rows = tables.AuditLog.__rows();
console.log(`    login => status=${res.status} body=${JSON.stringify(res.body)}`);
console.log(`    audit rows:\n      ${shape(rows)}`);
T("an unknown identifier is still recorded", rows.length === 1, `rows=${rows.length}`);
T("no user is attributed", rows[0]?.user_id === null, `user_id=${JSON.stringify(rows[0]?.user_id)}`);
T("the submitted identifier is preserved for forensics",
  typeof rows[0]?.performed_by === "string" && rows[0].performed_by.toLowerCase().includes("administrator"),
  `performed_by=${JSON.stringify(rows[0]?.performed_by)}`);
T("the response still refuses to confirm whether the account exists",
  res.body?.error === "Invalid email or password", JSON.stringify(res.body));

// ── 3. An attacker-supplied identifier cannot bloat the row ─────────────────
console.log("\n=== 3. A hostile identifier is bounded ===");
tables = setup();
res = await call({ username: "x".repeat(5000), password: "hunter2" });
rows = tables.AuditLog.__rows();
const recorded = `${rows[0]?.performed_by ?? ""}${rows[0]?.detail ?? ""}`;
console.log(`    recorded length=${recorded.length}`);
T("the identifier is truncated before it is stored", recorded.length < 600, `length=${recorded.length}`);

// ── 4. Lockout is the event a shift supervisor has to be able to see ────────
console.log("\n=== 4. The tenth failure locks the account ===");
tables = setup({ user: { failed_login_count: 9 } });
grantVerifier(tables);
res = await attempt("wrong-password");
rows = tables.AuditLog.__rows();
console.log(`    audit rows:\n      ${shape(rows)}`);
T("the account is now locked", tables.User.__rows()[0].is_locked === true);
T("both the failure and the lockout are recorded", rows.length === 2, `rows=${rows.length}`);
T("one of them is the lockout", rows.some((r) => /lock/i.test(r.action)), shape(rows));
T("the lockout row is chained to the failure row",
  rows[1]?.previous_hash === rows[0]?.hash,
  `${rows[1]?.previous_hash} vs ${rows[0]?.hash}`);
v = await verify();
T("the chain verifies across both", v.valid === true && v.count === 2, JSON.stringify(v));

// ── 5. A locked account being probed is itself worth recording ──────────────
console.log("\n=== 5. Attempts against an already-locked account ===");
tables = setup({ user: { is_locked: true } });
res = await attempt(PASSWORD);
rows = tables.AuditLog.__rows();
console.log(`    login => status=${res.status} body=${JSON.stringify(res.body)}`);
console.log(`    audit rows:\n      ${shape(rows)}`);
T("the attempt was refused", res.status === 403, `status=${res.status}`);
T("the attempt on a locked account is recorded", rows.length === 1, `rows=${rows.length}`);

// ── 6. The rate limiter must report itself exactly once per window ──────────
console.log("\n=== 6. The IP rate limiter trips ===");
tables = setup();
grantVerifier(tables);
const statuses = [];
for (let i = 0; i < 9; i++) statuses.push((await attempt("wrong-password")).status);
rows = tables.AuditLog.__rows();
const limitRows = rows.filter((r) => /rate limit/i.test(r.action));
console.log(`    statuses: ${statuses.join(",")}`);
console.log(`    audit rows (${rows.length}):\n      ${shape(rows)}`);
T("the IP was throttled", statuses.includes(429), statuses.join(","));
T("the throttle was recorded", limitRows.length >= 1, `rate-limit rows=${limitRows.length}`);
// A row per refused attempt would let an attacker flood the trail from a single
// IP for free — the signal has to be bounded, so it is logged on the transition
// into the throttled state and not on every refusal after it.
T("the throttle is recorded once, not once per refused attempt", limitRows.length === 1,
  `rate-limit rows=${limitRows.length}`);
T("the trail cannot be flooded past the rate limit", rows.length <= 7, `rows=${rows.length}`);
v = await verify();
T("the chain verifies over the whole burst", v.valid === true, JSON.stringify(v));

// ── 7. A trail of failures with no successes cannot answer "did they get in?" ─
console.log("\n=== 7. A successful login ===");
tables = setup();
grantVerifier(tables);
res = await attempt(PASSWORD);
rows = tables.AuditLog.__rows();
console.log(`    login => status=${res.status} success=${res.body?.success}`);
console.log(`    audit rows:\n      ${shape(rows)}`);
T("the login succeeded", res.body?.success === true, JSON.stringify(res.body));
T("the success was recorded", rows.length === 1, `rows=${rows.length}`);
T("it is marked as a success", rows[0]?.result === "success", JSON.stringify(rows[0] || null));
T("the session cookie is still issued", true);
v = await verify();
T("the chain verifies", v.valid === true && v.count === 1, JSON.stringify(v));

// ── 8. A wrong MFA code is a distinct signal from a wrong password ──────────
console.log("\n=== 8. Correct password, wrong MFA code ===");
tables = setup({ user: { mfa_enabled: true, mfa_secret: "JBSWY3DPEHPK3PXP" } });
res = await attempt(PASSWORD, { mfa_token: "000000" });
rows = tables.AuditLog.__rows();
console.log(`    login => status=${res.status} body=${JSON.stringify(res.body)}`);
console.log(`    audit rows:\n      ${shape(rows)}`);
T("the login was refused", res.status === 401, `status=${res.status}`);
T("the MFA failure is recorded", rows.length === 1, `rows=${rows.length}`);
T("it is distinguishable from a password failure",
  /mfa|authentication code|2fa/i.test(`${rows[0]?.action} ${rows[0]?.detail}`),
  JSON.stringify(rows[0] || null));

// ── 9. Availability: a misconfigured chain must not lock everyone out ───────
// The opposite call to the one custom_user_admin makes (which refuses privileged
// changes it cannot record). Refusing every login on a missing env var would
// lock the operator out of the very deployment they need to fix, mid-shift, and
// B9 already makes an unconfigured deployment loud: audit_log answers 503 and
// the audit page reports "cannot verify". A gap in the trail is the lesser harm.
console.log("\n=== 9. AUDIT_CHAIN_SECRET is missing ===");
tables = setup({ secret: null });
res = await attempt(PASSWORD);
rows = tables.AuditLog.__rows();
console.log(`    login => status=${res.status} success=${res.body?.success} rows=${rows.length}`);
T("a real login still works when the chain secret is missing", res.body?.success === true,
  JSON.stringify(res.body));
T("no unhashed row was written into the chain", rows.every((r) => !!r.hash),
  shape(rows));

// ── 10. The signed field list must match the other three copies ────────────
// custom_auth_login is now a FOURTH writer on the chain, and the base44 host
// gives functions no way to share a module, so the canonical payload is spelled
// out there too. scripts/probe-audit-chain.mjs owns the cross-file comparison;
// this only asserts the marker exists, so a reader of this file knows where the
// lockstep is enforced.
console.log("\n=== 10. The canonical field list is declared ===");
const { readFileSync } = await import("node:fs");
const src = readFileSync(new URL("../base44/functions/custom_auth_login/entry.js", import.meta.url), "utf8");
T("custom_auth_login declares AUDIT_CANONICAL_V1 (compared across files by probe-audit-chain)",
  /AUDIT_CANONICAL_V1 = [a-z_,]+/.test(src));

// ── 11. The launch policy gate, server-side and on the record ───────────────
// This release admits accounts entitled to every property only. The gate lives in
// three places (this function, the offline shim in base44Client.js, and the
// per-navigation re-check in AuthContext); this section covers the authoritative
// one. Two properties matter beyond "it refuses":
//
//   a) It is checked AFTER the password and after MFA. Refusing earlier would
//      answer "does this account exist, and is it restricted?" to anyone who can
//      reach the login form — an account-enumeration oracle. §8 already shows a
//      wrong MFA code still wins over the gate, which is the other half of this.
//   b) The refusal is recorded. Someone holding valid credentials they cannot use
//      is exactly the event an operator needs to see, and it is invisible in the
//      trail if the function just returns 403.
console.log("\n=== 11. Launch policy: a per-property account is refused ===");
for (const [label, access] of [
  ["an explicit property list", ["prop_1"]],
  ["a list naming every property today", ["prop_1", "prop_2"]],
  ["no grant at all", undefined],
]) {
  tables = setup({ user: { property_access: access } });
  grantVerifier(tables);
  res = await attempt(PASSWORD);
  rows = tables.AuditLog.__rows();
  console.log(`    ${label} => status=${res.status} code=${res.body?.code}`);
  T(`${label}: refused with 403`, res.status === 403, `status=${res.status}`);
  T(`${label}: carries the machine-readable code Login.jsx matches on`,
    res.body?.code === "ALL_PROPERTY_ACCESS_REQUIRED", JSON.stringify(res.body));
  // Count only the refused user's sessions — grantVerifier deliberately holds one
  // of its own for audit_verify, so a bare row count would always be >= 1.
  T(`${label}: no session was issued`,
    tables.Session.__rows().filter((s) => s.user_id === "u_clerk").length === 0,
    JSON.stringify(tables.Session.__rows().map((s) => s.user_id)));
  T(`${label}: the refusal is on the record`,
    rows.length === 1 && rows[0].result === "failed" && /propert/i.test(rows[0].detail || ""),
    shape(rows));
  v = await verify();
  T(`${label}: the chain still verifies`, v.valid === true, JSON.stringify(v));
}

// The gate must not be reachable without the password — otherwise it becomes the
// enumeration oracle described above.
console.log("\n=== 11b. A wrong password on a restricted account is indistinguishable ===");
tables = setup({ user: { property_access: ["prop_1"] } });
res = await attempt("wrong-password");
console.log(`    wrong password on restricted account => status=${res.status} code=${res.body?.code}`);
T("the reply is the ordinary credential failure, not the property refusal",
  res.status === 401 && res.body?.code !== "ALL_PROPERTY_ACCESS_REQUIRED",
  JSON.stringify(res.body));

// An owner/admin passes on role alone, and 'all' passes without a role.
// owner/admin are additionally forced through MFA enrolment on first sign-in, so
// their reply is an enrolment payload rather than success — either way the gate
// let them past, which is what this asserts.
console.log("\n=== 11c. Entitled accounts still get in ===");
for (const [label, user] of [
  ["role owner", { role: "owner", property_access: undefined }],
  ["role admin", { role: "admin", property_access: undefined }],
  ["read_only with 'all'", { role: "read_only", property_access: "all" }],
]) {
  tables = setup({ user });
  res = await attempt(PASSWORD);
  const admitted = res.body?.success === true || res.body?.require_mfa_setup === true;
  console.log(`    ${label} => status=${res.status} admitted=${admitted}`);
  T(`${label} is not refused by the launch gate`, admitted, JSON.stringify(res.body));
}

// The MFA enrolment branch runs BEFORE the gate and returns a TOTP secret. That is
// only safe while every role forced to enrol also satisfies the gate — otherwise
// an account that is about to be refused walks away with an enrolment secret. The
// two role lists are in different blocks of the same file, so pin the invariant.
console.log("\n=== 11d. MFA enrolment cannot precede a refusal ===");
const MFA_ENROL_ROLES = ["owner", "admin"];
for (const role of MFA_ENROL_ROLES) {
  tables = setup({ user: { role, property_access: ["prop_1"], mfa_enabled: false } });
  res = await attempt(PASSWORD);
  const leaked = res.body?.require_mfa_setup === true;
  const refused = res.status === 403;
  console.log(`    ${role} with a narrowed grant => status=${res.status} enrolment=${leaked}`);
  T(`a role forced to enrol MFA (${role}) is never one the gate refuses`,
    !(leaked && refused) && !refused, JSON.stringify(res.body));
}

console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
