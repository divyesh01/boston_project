// Probe for "the audit hash chain breaks itself" (B9).
//
// The audit trail is meant to be tamper-evident: base44/functions/audit_log
// hashes a canonical payload with a server-held secret and links each row to the
// previous one, and base44/functions/audit_verify recomputes the whole chain.
// Three things defeat that today:
//
//   1. base44/functions/custom_user_admin writes audit rows DIRECTLY, with no
//      `hash` and no `previous_hash` (12 call sites: user created, role changed,
//      password reset, MFA toggled, user deleted...). The verifier compares
//      `ctEqual(expectedHash, row.hash || "")`, so the first user-admin action
//      permanently breaks the chain — and a permanently red chain is
//      indistinguishable from a real intrusion.
//   2. base44/functions/audit_clear DELETES every row, gated only by
//      owner/admin — precisely the actors an audit log exists to hold
//      accountable — and then appends its own unhashed summary row.
//   3. Both audit_log and audit_verify fall back to a hard-coded dev secret
//      that is published in this repository when AUDIT_CHAIN_SECRET is unset,
//      so an unconfigured deployment reports a GREEN chain whose hashes anyone
//      holding this source can recompute — and therefore forge.
//
// This probe RUNS the real function entry files against an in-memory backend
// (scripts/stubs/*, resolved by scripts/resolve-base44.mjs), so the results are
// observations about shipped code rather than about a reimplementation.
//
// Run: node scripts/probe-audit-chain.mjs

import { readFileSync } from "node:fs";
import { register } from "node:module";
import crypto from "node:crypto";

register(new URL("./resolve-base44.mjs", import.meta.url));

const sdk = await import("./stubs/base44-sdk.mjs");
const runtime = await import("./stubs/base44-runtime.mjs");

const auditLog = (await import("../base44/functions/audit_log/entry.js")).default;
const auditVerify = (await import("../base44/functions/audit_verify/entry.js")).default;
const auditClear = (await import("../base44/functions/audit_clear/entry.js")).default;
const userAdmin = (await import("../base44/functions/custom_user_admin/entry.js")).default;

let pass = 0;
let fail = 0;
const T = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`); }
};

const TOKEN = "probe-session-token";
const CSRF = "probe-csrf-token";
const TOKEN_HASH = crypto.createHash("sha256").update(TOKEN).digest("hex");

/** Fresh backend: one owner (the actor), one ordinary target user, one session. */
function setup({ secret = "probe-chain-secret" } = {}) {
  runtime.__clearSecrets();
  if (secret !== null) runtime.__setSecret("AUDIT_CHAIN_SECRET", secret);
  const tables = sdk.__installBackend({
    users: [
      { id: "u_owner", username: "owner1", email: "owner@example.com", role: "owner", is_active: true, is_locked: false },
      { id: "u_target", username: "clerk1", email: "clerk@example.com", role: "read_only", is_active: true, is_locked: false, mfa_enabled: true, mfa_secret: "JBSWY3DPEHPK3PXP" },
    ],
    sessions: [
      { id: "s_1", token_hash: TOKEN_HASH, user_id: "u_owner", is_revoked: false, expires_at: new Date(Date.now() + 3600e3).toISOString() },
    ],
  });
  return tables;
}

const req = (body = {}) => ({
  headers: new Headers({
    cookie: `base44_session=${TOKEN}; csrf_token=${CSRF}`,
    "x-csrf-token": CSRF,
    "x-forwarded-for": "203.0.113.7",
  }),
  json: async () => body,
});

const call = async (fn, body) => {
  const res = await fn(req(body));
  return { status: res.status, body: await res.json() };
};

const logSelfEvent = (detail) =>
  call(auditLog, {
    user_id: "u_owner", username: "owner1", action: "Login",
    performed_by_id: "u_owner", performed_by: "owner1",
    result: "success", detail, device: "probe",
  });

const chainShape = (rows) =>
  rows.map((r) => `${r.action}[hash=${r.hash ? `${r.hash.slice(0, 8)}…` : "MISSING"} prev=${r.previous_hash ? `${r.previous_hash.slice(0, 8)}…` : "MISSING"}]`).join("\n      ");

// ── 1. Baseline: the client-originated write path chains correctly ──────────
console.log("\n=== 1. audit_log writes a hashed, chained row ===");
let tables = setup();
const first = await logSelfEvent("probe login 1");
T("audit_log accepted the entry", first.status === 200 || first.status === undefined,
  `status=${first.status} body=${JSON.stringify(first.body)}`);
let rows = tables.AuditLog.__rows();
T("the row carries a hash", !!rows[0]?.hash, JSON.stringify(rows[0] || null));
T("the first row links to the zero hash", rows[0]?.previous_hash === "0".repeat(64));
let verified = await call(auditVerify, {});
console.log(`    verify => ${JSON.stringify(verified.body)}`);
T("a chain of one verifies", verified.body.valid === true && verified.body.count === 1);

// ── 2. The break: a privileged server-side action must not orphan the chain ─
// Any mutating action in custom_user_admin would do here — they all go through the
// same writeAudit. `set_status` is used rather than `disable_mfa` because turning
// a second factor off now demands the ACTOR's own password (step-up), and giving
// this fixture a derived credential would only be re-testing what
// scripts/probe-auth-hardening.mjs §9 already covers, in a probe about hashing.
console.log("\n=== 2. custom_user_admin writes an audit row of its own ===");
const admin = await call(userAdmin, { action: "set_status", id: "u_target", status: "disabled" });
T("the admin action succeeded", !!admin.body?.user,
  `status=${admin.status} body=${JSON.stringify(admin.body)}`);
rows = tables.AuditLog.__rows();
console.log(`    rows now:\n      ${chainShape(rows)}`);
T("the admin action was recorded", rows.length === 2, `rows=${rows.length}`);
T("the admin row carries a hash", !!rows[1]?.hash, JSON.stringify(rows[1] || null));
T("the admin row links to the row before it", rows[1]?.previous_hash === rows[0]?.hash,
  `previous_hash=${rows[1]?.previous_hash} expected=${rows[0]?.hash}`);
T("created_date is strictly increasing (no tie for the verifier to mis-order)",
  rows[1]?.created_date > rows[0]?.created_date,
  `${rows[0]?.created_date} -> ${rows[1]?.created_date}`);
verified = await call(auditVerify, {});
console.log(`    verify => ${JSON.stringify(verified.body)}`);
T("the chain still verifies after a user-admin action",
  verified.body.valid === true && verified.body.count === 2,
  JSON.stringify(verified.body));

// ── 3. Tamper evidence must still fire for a real edit ─────────────────────
console.log("\n=== 3. A row edited behind the app's back is still caught ===");
tables.AuditLog.__rows()[0].detail = "probe login 1 (rewritten by a DB admin)";
verified = await call(auditVerify, {});
console.log(`    verify => ${JSON.stringify(verified.body)}`);
T("editing a row is detected", verified.body.valid === false);
T("the reason names the hash", verified.body.reason === "hash_mismatch", JSON.stringify(verified.body));
T("the report points at the edited row", verified.body.index === 0, `index=${verified.body.index}`);

// ── 4. Append-only means append-only ───────────────────────────────────────
console.log("\n=== 4. audit_clear must not be able to erase the trail ===");
tables = setup();
await logSelfEvent("probe login 2");
const before = tables.AuditLog.__rows().length;
const beforeIds = tables.AuditLog.__rows().map((r) => r.id).join(",");
const cleared = await call(auditClear, {});
const afterRows = tables.AuditLog.__rows();
console.log(`    clear => status=${cleared.status} body=${JSON.stringify(cleared.body)}; rows ${before} -> ${afterRows.length}`);
T("an owner cannot clear the audit log", cleared.status >= 400,
  `status=${cleared.status} body=${JSON.stringify(cleared.body)}`);
// Assert the ORIGINAL rows survived, not merely that the count is unchanged: the
// old implementation deleted every row and then appended its own summary row, so
// a bare count check reported "nothing was deleted" while the history was gone.
T("the original rows are still there", afterRows.map((r) => r.id).join(",") === beforeIds,
  `before=[${beforeIds}] after=[${afterRows.map((r) => `${r.id}:${r.action}`).join(",")}]`);
verified = await call(auditVerify, {});
T("the chain is intact after the refused clear", verified.body.valid === true,
  JSON.stringify(verified.body));

// ── 5. A missing chain secret must fail CLOSED ──────────────────────────────
console.log("\n=== 5. AUDIT_CHAIN_SECRET is not configured ===");
tables = setup({ secret: null });
const unconfigured = await logSelfEvent("probe login 3");
console.log(`    audit_log => status=${unconfigured.status} body=${JSON.stringify(unconfigured.body)}`);
T("audit_log refuses to write an untrustworthy row", unconfigured.status >= 400,
  `status=${unconfigured.status}`);
T("no row was written with a guessable hash", tables.AuditLog.__rows().length === 0,
  `rows=${tables.AuditLog.__rows().length}`);
verified = await call(auditVerify, {});
console.log(`    verify (empty, no secret) => status=${verified.status} body=${JSON.stringify(verified.body)}`);
T("verification of an unconfigured deployment is NOT green", verified.body.valid !== true,
  JSON.stringify(verified.body));
T("the report says why", /secret/i.test(JSON.stringify(verified.body)), JSON.stringify(verified.body));

// A deployment that wrote rows under a real secret, then lost it, must also not
// report green — it must report "cannot verify", not "verified".
tables = setup();
await logSelfEvent("probe login 4");
runtime.__setSecret("AUDIT_CHAIN_SECRET", null);
verified = await call(auditVerify, {});
console.log(`    verify (rows, no secret) => status=${verified.status} body=${JSON.stringify(verified.body)}`);
T("a populated chain cannot be verified without the secret", verified.body.valid !== true,
  JSON.stringify(verified.body));

// ── 6. The canonical payload is duplicated — hold the copies in lockstep ────
// The base44 host gives these functions no way to share a module (every import
// is npm:, node:, or base44:runtime), so the signed field list is written out in
// each writer and in the verifier. Comments asking for lockstep are not a
// mechanism; this is. Drift here would make every healthy row look tampered.
console.log("\n=== 6. The signed field list is identical in every copy ===");
const FILES = [
  "../base44/functions/audit_log/entry.js",
  "../base44/functions/custom_user_admin/entry.js",
  "../base44/functions/custom_auth_login/entry.js",
  "../base44/functions/custom_auth_reset_password/entry.js",
  "../base44/functions/audit_verify/entry.js",
];
const MARKER = /AUDIT_CANONICAL_V1 = ([a-z_,]+)/;
const seen = [];
for (const rel of FILES) {
  const src = readFileSync(new URL(rel, import.meta.url), "utf8");
  const marker = src.match(MARKER);
  T(`${rel.split("/").slice(-2)[0]} declares the canonical field list`, !!marker);
  if (!marker) continue;
  const declared = marker[1].split(",");
  // Keys of the JSON.stringify({...}) literal that follows the marker. Search
  // for the closing "});" FROM the literal's own start — the marker sits above
  // it, and scanning from the marker would otherwise be able to match a "});"
  // that closes something else entirely.
  const after = src.slice(src.indexOf(marker[0]));
  const start = after.indexOf("JSON.stringify({");
  const literal = after.slice(start, after.indexOf("});", start) + 3);
  // Accept both `key: value` and the ES6 shorthand `key,` — custom_user_admin
  // signs `action` by shorthand, and a matcher that only understood colons
  // would report drift where there is none. A guard that cries wolf gets muted.
  const actual = [...literal.matchAll(/^\s{2,}([a-z_]+)\s*[:,]/gm)].map((m) => m[1]);
  T(`${rel.split("/").slice(-2)[0]} hashes exactly the fields it declares`,
    actual.join(",") === declared.join(","),
    `declared=${declared.join(",")}\n          hashed  =${actual.join(",")}`);
  seen.push({ rel, declared: declared.join(",") });
}
T("every copy declares the same field list",
  seen.length === FILES.length && new Set(seen.map((s) => s.declared)).size === 1,
  seen.map((s) => `${s.rel}: ${s.declared}`).join("\n          "));

console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
