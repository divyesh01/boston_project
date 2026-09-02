// scripts/_worker-testkit.mjs — INDEPENDENT adversarial test harness for the
// off-production Cloudflare Worker runtime (worker/*.js). Owned by Agent C
// (independent-tester). This is TEST infrastructure, NOT production code.
//
// Leading `_` keeps this file out of BOTH suite-discovery walks
// (verify-all.mjs `isSuite` and probe-suite-integrity.mjs), so it is a shared
// library for the probe-worker-*.mjs suites and never runs as a suite itself.
//
// WHAT THIS SHIMS, AND WHY IT IS FAITHFUL:
//   * env.DB — a `node:sqlite` DatabaseSync-backed stand-in for the D1 binding.
//     It implements ONLY the four methods worker/db.js uses:
//       prepare(sql).bind(...params).first() / .all() / .run()  and  batch([...]).
//     first() -> row|null (D1 semantics), all() -> { results: [...] } (D1),
//     batch() -> ONE real SQLite transaction (BEGIN/COMMIT/ROLLBACK), which is
//     the atomicity guarantee D1 batch() provides. Loaded over the REAL
//     worker/schema.sql with foreign_keys ON (DatabaseSync default + explicit
//     PRAGMA), so REFERENCES / ON DELETE CASCADE are actually enforced.
//   * Synthetic Cloudflare Access: a real RSA keypair (RSASSA-PKCS1-v1_5 /
//     SHA-256 / 2048) via WebCrypto, its public key exported as a JWK with a
//     `kid`, served as a synthetic JWKS the auth module fetches through the
//     injectable `env.FETCH` + `env.ACCESS_CERTS_URL`. JWTs are signed here with
//     the private key, so worker/auth.js runs REAL signature verification.
//
// BLOCKED/UNPROVEN: this exercises the crypto + claim logic against SYNTHETIC
// keys only. It does NOT verify against Cloudflare's live JWKS or a live Access
// deployment — that remains BLOCKED until Access is enabled on the Worker.

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SCHEMA_PATH = fileURLToPath(new URL("../worker/schema.sql", import.meta.url));
const PRODUCTION_SCHEMA_PATH = fileURLToPath(
  new URL("../migrations-production/0001_auth_schema.sql", import.meta.url),
);

// ---------------------------------------------------------------------------
// D1 binding shim over node:sqlite
// ---------------------------------------------------------------------------

/** node:sqlite accepts null|number|bigint|string|Uint8Array; coerce the rest. */
function normalizeParams(params) {
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === "boolean") return p ? 1 : 0;
    return p;
  });
}

class BoundStatement {
  constructor(db, sql, params, stats) {
    this._db = db;
    this._sql = sql;
    this._params = params;
    this._stats = stats;
  }
  async first() {
    recordQuery(this._stats, this._sql, this._params);
    const row = this._db.prepare(this._sql).get(...normalizeParams(this._params));
    return row === undefined ? null : row;
  }
  async all() {
    recordQuery(this._stats, this._sql, this._params);
    const rows = this._db.prepare(this._sql).all(...normalizeParams(this._params));
    return { results: rows };
  }
  async run() {
    recordQuery(this._stats, this._sql, this._params);
    return this._db.prepare(this._sql).run(...normalizeParams(this._params));
  }
}

/**
 * Count an EXECUTED query against the D1 budget. prepare()/bind() alone are not
 * queries — D1 charges at execution — so this is called from first/all/run and
 * from batch(), once per statement actually executed.
 *
 * `params` is captured as the RAW bound array, BEFORE normalizeParams(), so a
 * test can assert WHICH VALUES a code path actually bound — not merely how many.
 * That is required to prove a negative: that the batched property resolver never
 * BINDS a `property_local_id` the per-row resolution step would refuse. Counting
 * params cannot express that; `paramCount` is kept unchanged for the existing
 * D1-ceiling checks.
 */
function recordQuery(stats, sql, params) {
  if (!stats) return;
  stats.statements += 1;
  stats.maxParams = Math.max(stats.maxParams, params.length);
  stats.calls.push({ sql, paramCount: params.length, params: [...params] });
}

class PreparedStatement {
  constructor(db, sql, stats) {
    this._db = db;
    this._sql = sql;
    this._stats = stats;
  }
  bind(...params) {
    return new BoundStatement(this._db, this._sql, params, this._stats);
  }
}

class D1Shim {
  constructor(db, stats = null) {
    this._db = db;
    this._stats = stats;
  }
  prepare(sql) {
    return new PreparedStatement(this._db, sql, this._stats);
  }
  // D1 batch() == one implicit transaction: all statements commit or none do.
  async batch(statements) {
    this._db.exec("BEGIN");
    try {
      const out = [];
      for (const s of statements) {
        recordQuery(this._stats, s._sql, s._params);
        out.push(this._db.prepare(s._sql).run(...normalizeParams(s._params)));
      }
      this._db.exec("COMMIT");
      return out;
    } catch (err) {
      try {
        this._db.exec("ROLLBACK");
      } catch {
        /* ignore rollback failure — surface the original error */
      }
      throw err;
    }
  }
}

/** Build a fresh in-memory DB loaded with the REAL worker schema. */
export function makeDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  db.exec("PRAGMA foreign_keys = ON;"); // re-assert after schema's own PRAGMA
  return db;
}

/**
 * Build a fresh in-memory DB loaded with the EXACT DDL the live production
 * authentication database was built from — migrations-production/0001_auth_schema.sql,
 * byte for byte, with nothing added.
 *
 * worker/schema.sql is now held to that DDL by scripts/verify-schema-parity.mjs,
 * so the two agree; this loader exists so a credential/authorization probe is
 * proven against production's own file and cannot be satisfied by a staging
 * convenience column that production does not have. A probe that must run
 * against the auth surface ONLY should prefer this one.
 */
export function makeProductionDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(readFileSync(PRODUCTION_SCHEMA_PATH, "utf8"));
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}

/** Seed two properties (P_A, P_B) and their property_id_map rows. */
export function seedProperties(db, { accountId = "A_1", accountName = "Boston Hotels" } = {}) {
  db.prepare("INSERT OR IGNORE INTO account (id, name, created_date) VALUES (?,?,?)")
    .run(accountId, accountName, "2026-01-01");
  db.exec(
    `INSERT INTO property (id, account_id, code, name, rooms, active, created_date) VALUES` +
      ` ('P_A','${accountId}','RRI-BOS','Boston Downtown',120,1,'2026-01-01'),` +
      ` ('P_B','${accountId}','RRI-CAM','Cambridge Riverside',88,1,'2026-01-01');`,
  );
  db.exec(
    `INSERT INTO property_id_map (account_id, local_numeric_id, code, server_id) VALUES` +
      ` ('${accountId}',1,'RRI-BOS','P_A'), ('${accountId}',2,'RRI-CAM','P_B');`,
  );
}

/**
 * Seed an account and two properties using ONLY columns the production auth
 * schema declares. seedProperties() cannot be used against makeProductionDb()
 * because it writes property.created_date and property_id_map, neither of which
 * exists in production.
 */
export function seedAuthFixture(db, { accountId = "A_1", accountName = "Boston Hotels" } = {}) {
  db.prepare("INSERT OR IGNORE INTO account (id, name, created_date) VALUES (?,?,?)")
    .run(accountId, accountName, "2026-01-01");
  db.prepare("INSERT INTO property (id, account_id, code, name, rooms, active) VALUES (?,?,?,?,?,?)")
    .run("P_A", accountId, "RRI-BOS", "Boston Downtown", 120, 1);
  db.prepare("INSERT INTO property (id, account_id, code, name, rooms, active) VALUES (?,?,?,?,?,?)")
    .run("P_B", accountId, "RRI-CAM", "Cambridge Riverside", 88, 1);
}

/**
 * A NOT NULL-satisfying credential that can never verify: worker/password-credential.js
 * refuses to parse it, so verifyCredential() returns false for every password.
 */
export const UNUSABLE_CREDENTIAL = "$unusable$no-credential-provisioned";

/**
 * Insert a user row. The scope resolver reads id/email/role/property_access_mode,
 * but the schema now enforces production's NOT NULL set, so this must also supply
 * password_hash, salt, created_date and updated_date.
 *
 * `password_hash` defaults to a deliberately UNUSABLE sentinel: it satisfies
 * NOT NULL, it is not a parseable `$rri-pbkdf2-sha256$...` envelope, and it
 * therefore makes every login attempt for a seeded-but-credential-less user fail
 * closed. Tests that need a real credential mint one with seedCredential(), the
 * same way production creates one.
 */
export function seedUser(db, {
  id,
  email,
  role,
  mode,
  grants = [],
  accountId = "A_1",
  username = email,
  passwordHash = UNUSABLE_CREDENTIAL,
  salt = "",
  createdDate = "2026-01-01T00:00:00.000Z",
}) {
  db.prepare(
    "INSERT INTO user (id, account_id, username, email, role, property_access_mode, password_hash, salt, created_date, updated_date) VALUES (?,?,?,?,?,?,?,?,?,?)",
  ).run(id, accountId, username, email, role, mode, passwordHash, salt, createdDate, createdDate);
  for (const pid of grants) {
    db.prepare(
      "INSERT INTO user_property_access (account_id, user_id, property_id) VALUES (?,?,?)",
    ).run(accountId, id, pid);
  }
}

/**
 * Mint a REAL versioned credential for a seeded user through the production code
 * path (worker/password-credential.js), so a probe never hand-rolls hashing.
 */
export async function seedCredential(db, { userId, password, pepper, salt, accountId = "A_1" }) {
  const { createCredential } = await import("../worker/password-credential.js");
  const credential = await createCredential(
    password,
    pepper,
    salt === undefined ? undefined : new TextEncoder().encode(salt),
  );
  const changed = db
    .prepare("UPDATE user SET password_hash=?, salt=?, updated_date=? WHERE id=? AND account_id=?")
    .run(credential.encoded, credential.salt, new Date().toISOString(), userId, accountId);
  if (Number(changed.changes) !== 1) throw new Error(`seedCredential: user ${userId} not found`);
  return credential;
}

/** Insert a transaction_line row directly (for scope read tests). */
export function seedTxn(db, { id, property_id, date, amount, folio, code, dedupe_key }) {
  db.prepare(
    "INSERT INTO transaction_line (id, property_id, date, amount, folio_number, transaction_code, dedupe_key) " +
      "VALUES (?,?,?,?,?,?,?)",
  ).run(id, property_id, date, amount, folio, code, dedupe_key);
}

/** Make an env whose DB is the shim over `db`, plus optional Access config. */
export function makeEnv(db, extra = {}) {
  // Integration probes exercise the staged shared-data API unless a test
  // explicitly selects the production auth-only posture.
  return { DB: new D1Shim(db), ENABLE_D1_DATA_API: "true", ...extra };
}

/**
 * Like makeEnv, but the D1 shim COUNTS every executed statement and the bound
 * param count per statement, so a test can prove the D1 per-invocation query
 * budget (50 on the free plan) and the 100-bound-param/statement limit. Each
 * recorded call also carries `params` (the RAW bound values), so a test can
 * assert which values were bound, not just how many.
 */
export function makeInstrumentedEnv(db, extra = {}) {
  const stats = { statements: 0, maxParams: 0, calls: [] };
  const env = { DB: new D1Shim(db, stats), ENABLE_D1_DATA_API: "true", ...extra };
  const reset = () => {
    stats.statements = 0;
    stats.maxParams = 0;
    stats.calls.length = 0;
  };
  return { env, stats, reset };
}

/** A resolved Scope literal (matches worker/scope.js Scope typedef). */
export function scopeAll(propertyIds) {
  return { user: { id: "u", account_id: "A_1", email: "u@x", role: "owner", property_access_mode: "all" }, accountId: "A_1", all: true, propertyIds };
}
export function scopeSpecific(propertyIds) {
  return {
    user: { id: "u", account_id: "A_1", email: "u@x", role: "staff", property_access_mode: "specific" },
    accountId: "A_1",
    all: false,
    propertyIds,
  };
}

// ---------------------------------------------------------------------------
// Synthetic Cloudflare Access: RSA keys, JWKS, JWT signing
// ---------------------------------------------------------------------------

const enc = new TextEncoder();

function b64urlBytes(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlStr(str) {
  return b64urlBytes(enc.encode(str));
}

/** Generate an RSA-2048 RSASSA-PKCS1-v1_5/SHA-256 keypair; export public JWK+kid. */
export async function generateRsaKey(kid) {
  const kp = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
  jwk.kid = kid;
  jwk.alg = "RS256";
  jwk.use = "sig";
  return { privateKey: kp.privateKey, publicJwk: jwk, kid };
}

/** A JWKS document from one or more exported public JWKs. */
export function makeJwks(...publicJwks) {
  return { keys: publicJwks };
}

/**
 * An injectable fetch that serves `jwks` and counts calls, so a test can prove
 * the exact number of UPSTREAM certs requests a code path makes.
 *
 * `state.keys` is the LIVE key array — push a new JWK onto it to simulate a
 * Cloudflare key rotation. Set `state.fail = true` to simulate an unreachable /
 * erroring certs endpoint (the validator must then fail CLOSED).
 */
export function makeJwksFetch(jwks) {
  const state = { calls: 0, urls: [], fail: false, keys: [...jwks.keys] };
  const fetchImpl = async (url) => {
    state.calls += 1;
    state.urls.push(String(url));
    if (state.fail) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ keys: state.keys }) };
  };
  return { fetchImpl, state };
}

/**
 * Run `fn` with `Date.now()` advanced by `offsetMs`, then restore it. This is
 * how a test steps past worker/auth.js's JWKS_MIN_REFRESH_INTERVAL_MS without a
 * real 5-minute wait: the module reads the global Date.now for both the cache
 * timestamp and the throttle comparison.
 */
export async function withFakeNow(offsetMs, fn) {
  const real = Date.now;
  const base = real();
  Date.now = () => base + offsetMs;
  try {
    return await fn();
  } finally {
    Date.now = real;
  }
}

/**
 * Sign a JWT with the RSA private key. `header`/`payload` overrides let a test
 * craft adversarial tokens (alg none, wrong aud, expired, …).
 */
export async function signRs256({ privateKey, kid, payload, header = {} }) {
  const h = { alg: "RS256", typ: "JWT", kid, ...header };
  const signingInput = `${b64urlStr(JSON.stringify(h))}.${b64urlStr(JSON.stringify(payload))}`;
  const sig = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    privateKey,
    enc.encode(signingInput),
  );
  return `${signingInput}.${b64urlBytes(new Uint8Array(sig))}`;
}

/** Build an unsigned `alg:none` token: header.payload with an empty signature. */
export function makeAlgNoneToken({ kid, payload }) {
  const h = { alg: "none", typ: "JWT", kid };
  return `${b64urlStr(JSON.stringify(h))}.${b64urlStr(JSON.stringify(payload))}.`;
}

/** Build an HS256 token with a genuinely valid HMAC over the body. */
export async function makeHs256Token({ kid, payload, secret }) {
  const h = { alg: "HS256", typ: "JWT", kid };
  const signingInput = `${b64urlStr(JSON.stringify(h))}.${b64urlStr(JSON.stringify(payload))}`;
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(signingInput));
  return `${signingInput}.${b64urlBytes(new Uint8Array(sig))}`;
}

/** Replace the payload segment of a signed token, leaving the old signature. */
export function tamperPayload(token, newPayload) {
  const [h, , s] = token.split(".");
  return `${h}.${b64urlStr(JSON.stringify(newPayload))}.${s}`;
}

/** A Request carrying the Access JWT in the assertion header. */
export function reqWithToken(token, extraHeaders = {}) {
  return new Request("https://api.test/api/properties", {
    headers: { "Cf-Access-Jwt-Assertion": token, ...extraHeaders },
  });
}

// ---------------------------------------------------------------------------
// Tiny assertion runner shared by the probe suites
// ---------------------------------------------------------------------------

export function makeRunner(title) {
  let pass = 0;
  let fail = 0;
  const failures = [];
  return {
    async check(name, fn) {
      try {
        await fn();
        pass += 1;
        console.log(`  PASS  ${name}`);
      } catch (err) {
        fail += 1;
        failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
        console.log(`  FAIL  ${name} -> ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    done() {
      console.log(`\n${title}: ${pass} passed, ${fail} failed`);
      if (fail > 0) {
        console.log("FAILED checks:");
        for (const f of failures) console.log(`  - ${f}`);
        process.exit(1);
      }
    },
  };
}

export function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}
export function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || "not equal"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
