// Cross-account / cross-property / IDOR acceptance proof for the business-sync
// API, driven through the REAL Worker router (worker/index.js) with REAL
// app-session logins — not a synthetic scope object. This is the rollout
// acceptance gate that must hold before "upload once -> data everywhere" can be
// called safe: an authenticated owner of account A_2 must never read, mutate,
// or disturb one byte of account A_1's business data, and a property-restricted
// user inside A_1 must never see or write a property they were not granted.
//
// Two independent proofs run for every attack:
//   1. CANARY  - no response body served to A_2 may contain A_1's canary string.
//   2. INVARIANCE - a byte-level fingerprint of every A_1 business row
//      (pointer, records, hashes, revision, change log, staging transaction,
//      dataset statuses, property roster) must be identical before and after
//      the entire attack matrix.
//
// Runs fully in-memory against worker/schema.sql. Contacts nothing.

import worker from "../worker/index.js";
import { typedRecordKey, canonicalJson } from "../worker/business-sync.js";
import {
  makeDb,
  makeEnv,
  seedProperties,
  seedUser,
  seedCredential,
  assert,
  assertEqual,
  makeRunner,
} from "./_worker-testkit.mjs";

const run = makeRunner("probe-business-sync-isolation");
const CTX = { waitUntil() {}, passThroughOnException() {} };
const origin = "https://app.test";
const password = "Isolation-Probe-9!";
const salt = "0123456789abcdef0123456789abcdef";
const pepper = "probe-only-pepper-that-is-at-least-32-characters";

const A1 = "A_1";
const A2 = "A_2";
const A1_CANARY = "A1-CANARY-8f31d4";
const A2_CANARY = "A2-CANARY-27ce90";
const A1_GEN = "G_A1_ACTIVE";
const A1_STAGING = "G_A1_STAGING";
const A2_GEN = "G_A2_ACTIVE";
const A1_TX = "TXA1PENDING0000000001";
const FAR_FUTURE = "2099-01-01T00:00:00.000Z";
const HEX64 = "a".repeat(64);
const KEY_P_A = typedRecordKey("P_A");
const KEY_P_B = typedRecordKey("P_B");
const KEY_P_X = typedRecordKey("P_X");
const KEY_REV_A = typedRecordKey("GRD-A1-P_A-0801");
const KEY_REV_B = typedRecordKey("GRD-A1-P_B-0801");

/** Same digest the Worker computes: lowercase hex SHA-256 of canonical JSON. */
async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(typeof value === "string" ? value : canonicalJson(value));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (part) => part.toString(16).padStart(2, "0")).join("");
}

async function request(env, path, { method = "GET", body, cookie } = {}) {
  const headers = {};
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    headers["X-Requested-With"] = "XMLHttpRequest";
    headers.origin = origin;
  }
  if (cookie) headers.cookie = cookie;
  const response = await worker.fetch(
    new Request(`${origin}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
    CTX,
  );
  const text = await response.text();
  return { status: response.status, text };
}

async function login(env, identifier) {
  const response = await worker.fetch(
    new Request(`${origin}/api/auth/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Requested-With": "XMLHttpRequest",
        origin,
      },
      body: JSON.stringify({ identifier, password }),
    }),
    env,
    CTX,
  );
  const cookie = String(response.headers.get("set-cookie") || "").split(";", 1)[0];
  if (response.status !== 200 || !cookie.startsWith("__Host-rri_session=")) {
    throw new Error(`login(${identifier}) failed: ${response.status} ${await response.text()}`);
  }
  return cookie;
}

function insertDataset(db, accountId, generationId, status, createdBy, previous = null) {
  db.prepare(
    "INSERT INTO business_dataset (account_id,generation_id,status,schema_version,manifest_hash,manifest_json," +
      "expected_chunks,expected_records,previous_generation_id,created_by,created_at,activated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    accountId,
    generationId,
    status,
    1,
    `mh-${generationId}`,
    JSON.stringify({ chunks: [{ index: 0, hash: HEX64, record_count: 1 }], counts: { Property: 1 } }),
    1,
    1,
    previous,
    createdBy,
    "2026-08-01T00:00:00.000Z",
    status === "active" ? "2026-08-01T00:00:00.000Z" : null,
  );
}

function insertRecord(db, accountId, generationId, entity, recordKey, propertyKey, propertyId, row) {
  db.prepare(
    "INSERT INTO business_record (account_id,generation_id,entity_name,record_key,property_key," +
      "server_property_id,row_json,row_hash,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(
    accountId,
    generationId,
    entity,
    recordKey,
    propertyKey,
    propertyId,
    JSON.stringify(row),
    `rh-${entity}-${recordKey}`,
    "2026-08-01T00:00:00.000Z",
  );
  if (propertyKey && propertyId) {
    db.prepare(
      "INSERT OR IGNORE INTO business_property_map (account_id,generation_id,property_key,server_property_id,property_code) VALUES (?,?,?,?,?)",
    ).run(accountId, generationId, propertyKey, propertyId, `CODE-${propertyId}`);
  }
}

function insertChange(db, accountId, seq, generationId, entity, recordKey, propertyId, row) {
  db.prepare(
    "INSERT INTO business_change (account_id,seq,generation_id,entity_name,record_key,server_property_id," +
      "operation,row_json,row_hash,mutation_id,request_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    accountId,
    seq,
    generationId,
    entity,
    recordKey,
    propertyId,
    "upsert",
    JSON.stringify(row),
    `ch-${accountId}-${seq}`,
    `MUT-${accountId}-${String(seq).padStart(16, "0")}`,
    `rq-${accountId}-${seq}`,
    "2026-08-02T00:00:00.000Z",
  );
}

/** Byte-level fingerprint of EVERY A_1 business row an attack could disturb. */
function a1Fingerprint(db) {
  const q = (sql) => db.prepare(sql).all(A1);
  return JSON.stringify({
    pointer: q("SELECT active_generation_id,updated_at FROM business_dataset_pointer WHERE account_id=?"),
    datasets: q(
      "SELECT generation_id,status,previous_generation_id,expected_records,activated_at FROM business_dataset WHERE account_id=? ORDER BY generation_id",
    ),
    records: q(
      "SELECT generation_id,entity_name,record_key,property_key,server_property_id,row_hash,row_json FROM business_record WHERE account_id=? ORDER BY generation_id,entity_name,record_key",
    ),
    propertyMap: q(
      "SELECT generation_id,property_key,server_property_id,property_code FROM business_property_map WHERE account_id=? ORDER BY generation_id,property_key",
    ),
    state: q("SELECT revision FROM business_sync_state WHERE account_id=?"),
    changes: q(
      "SELECT seq,entity_name,record_key,server_property_id,operation,row_hash,mutation_id FROM business_change WHERE account_id=? ORDER BY seq",
    ),
    transactions: q(
      "SELECT tx_id,status,base_generation_id,base_revision,staging_generation_id,expected_chunks,next_chunk_index,operation_count,expires_at,committed_at FROM business_staging_transaction WHERE account_id=? ORDER BY tx_id",
    ),
    stagingTargets: q(
      "SELECT tx_id,entity_name,record_key,server_property_id,operation FROM business_staging_target WHERE account_id=? ORDER BY tx_id,entity_name,record_key",
    ),
    chunks: q(
      "SELECT generation_id,chunk_index,chunk_hash,record_count FROM business_migration_chunk WHERE account_id=? ORDER BY generation_id,chunk_index",
    ),
    guards: q("SELECT mutation_id,request_hash FROM business_mutation_guard WHERE account_id=? ORDER BY mutation_id"),
    properties: q("SELECT id,code,name,rooms,active FROM property WHERE account_id=? ORDER BY id"),
  });
}

async function buildFixture() {
  const db = makeDb();

  // ---- Account A_1: the victim. Real hotel-shaped data with a canary. ----
  seedProperties(db);
  seedUser(db, { id: "U_OWN_A", email: "owner-a1@isolation.test", role: "owner", mode: "all", accountId: A1 });
  seedUser(db, {
    id: "U_STAFF_A", email: "staff-a1@isolation.test", role: "staff", mode: "specific", grants: ["P_A"], accountId: A1,
  });
  // 'manager' — NOT 'gm': worker/scope.js treats gm as an UNRESTRICTED_ROLE, so a
  // gm is never property-scoped. 'manager' + manage_operations is the only shape
  // that passes requireMutationRole while remaining restricted to granted ids.
  seedUser(db, {
    id: "U_MGR_A", email: "manager-a1@isolation.test", role: "manager", mode: "specific", grants: ["P_A"], accountId: A1,
  });
  db.prepare("UPDATE user SET permissions=? WHERE id=?").run(JSON.stringify({ manage_operations: true }), "U_MGR_A");

  insertDataset(db, A1, A1_GEN, "active", "U_OWN_A");
  insertDataset(db, A1, A1_STAGING, "staging", "U_OWN_A");
  insertRecord(db, A1, A1_GEN, "Property", KEY_P_A, KEY_P_A, "P_A", {
    id: "P_A", code: "RRI-BOS", name: "Boston Downtown", note: A1_CANARY,
  });
  insertRecord(db, A1, A1_GEN, "Property", KEY_P_B, KEY_P_B, "P_B", {
    id: "P_B", code: "RRI-CAM", name: "Cambridge Riverside", note: A1_CANARY,
  });
  insertRecord(db, A1, A1_GEN, "GrossRevenueDay", KEY_REV_A, KEY_P_A, "P_A", {
    id: "GRD-A1-P_A-0801", property_id: "P_A", date: "2026-08-01", amount_cents: 102059817, note: A1_CANARY,
  });
  insertRecord(db, A1, A1_GEN, "GrossRevenueDay", KEY_REV_B, KEY_P_B, "P_B", {
    id: "GRD-A1-P_B-0801", property_id: "P_B", date: "2026-08-01", amount_cents: 33333333, note: A1_CANARY,
  });
  insertChange(db, A1, 1, A1_GEN, "GrossRevenueDay", KEY_REV_A, "P_A", { id: "GRD-A1-P_A-0801", note: A1_CANARY });
  insertChange(db, A1, 2, A1_GEN, "GrossRevenueDay", KEY_REV_B, "P_B", { id: "GRD-A1-P_B-0801", note: A1_CANARY });
  db.prepare("INSERT INTO business_dataset_pointer (account_id,active_generation_id,updated_at) VALUES (?,?,?)")
    .run(A1, A1_GEN, "2026-08-01T00:00:00.000Z");
  db.prepare("INSERT INTO business_sync_state (account_id,revision) VALUES (?,?)").run(A1, 2);
  db.prepare(
    "INSERT INTO business_staging_transaction (account_id,tx_id,request_hash,base_generation_id,base_revision," +
      "staging_generation_id,status,expected_chunks,next_chunk_index,operation_count,created_by,created_at,expires_at) " +
      "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(A1, A1_TX, HEX64, A1_GEN, 2, A1_STAGING, "pending", 1, 0, 1, "U_OWN_A", "2026-08-02T00:00:00.000Z", FAR_FUTURE);

  // ---- Account A_2: the attacker. seedProperties() hardcodes P_A/P_B, so A_2
  // is seeded by hand with its own property and its own canary. ----
  db.prepare("INSERT INTO account (id,name,created_date) VALUES (?,?,?)").run(A2, "Rival Hotels", "2026-01-01");
  db.prepare("INSERT INTO property (id,account_id,code,name,rooms,active,created_date) VALUES (?,?,?,?,?,?,?)")
    .run("P_X", A2, "RRI-NYC", "Manhattan Midtown", 200, 1, "2026-01-01");
  seedUser(db, { id: "U_OWN_B", email: "owner-a2@isolation.test", role: "owner", mode: "all", accountId: A2 });
  insertDataset(db, A2, A2_GEN, "active", "U_OWN_B");
  insertRecord(db, A2, A2_GEN, "Property", KEY_P_X, KEY_P_X, "P_X", {
    id: "P_X", code: "RRI-NYC", name: "Manhattan Midtown", note: A2_CANARY,
  });
  db.prepare("INSERT INTO business_dataset_pointer (account_id,active_generation_id,updated_at) VALUES (?,?,?)")
    .run(A2, A2_GEN, "2026-08-01T00:00:00.000Z");
  db.prepare("INSERT INTO business_sync_state (account_id,revision) VALUES (?,?)").run(A2, 1);

  for (const userId of ["U_OWN_A", "U_STAFF_A", "U_MGR_A"]) {
    await seedCredential(db, { userId, password, pepper, salt, accountId: A1 });
  }
  await seedCredential(db, { userId: "U_OWN_B", password, pepper, salt, accountId: A2 });

  const env = makeEnv(db, {
    ENABLE_BUSINESS_SYNC_API: "true",
    PASSWORD_PEPPER_V1: pepper,
  });
  return { db, env };
}

/**
 * Every business-sync route the Worker exposes, parameterised by the generation
 * and transaction ids to name. Bodies are deliberately well-formed so each
 * request reaches its AUTHORIZATION decision instead of dying on a 422 shape
 * check — a syntax rejection would prove nothing about isolation.
 */
function routeMatrix({ generationId, txId, propertyKey, recordKey, mutationId }) {
  const migrationRow = {
    entity: "Property",
    record_key: propertyKey,
    property_key: propertyKey,
    property_code: "RRI-BOS",
    row: { id: "P_A", code: "RRI-BOS", name: "Boston Downtown" },
  };
  const operation = {
    entity: "GrossRevenueDay",
    operation: "upsert",
    record_key: recordKey,
    property_key: propertyKey,
    row: { id: "GRD-A1-P_A-0801", property_id: "P_A", date: "2026-08-01", amount_cents: 1 },
  };
  return [
    { name: "GET migration/status", path: `/api/business-sync/migration/status?generation_id=${generationId}` },
    {
      name: "POST migration/start",
      path: "/api/business-sync/migration/start",
      method: "POST",
      body: { manifest: ATTACK_MANIFEST, manifest_hash: ATTACK_MANIFEST_HASH },
    },
    {
      name: "POST migration/chunk",
      path: "/api/business-sync/migration/chunk",
      method: "POST",
      body: { generation_id: generationId, chunk_index: 0, chunk_hash: HEX64, rows: [migrationRow] },
    },
    {
      name: "POST migration/activate",
      path: "/api/business-sync/migration/activate",
      method: "POST",
      body: { generation_id: generationId },
    },
    {
      name: "POST migration/rollback",
      path: "/api/business-sync/migration/rollback",
      method: "POST",
      body: { generation_id: generationId },
    },
    { name: "GET snapshot", path: "/api/business-sync/snapshot?entity=GrossRevenueDay" },
    { name: "GET feed", path: "/api/business-sync/feed?since=0" },
    {
      name: "POST mutate",
      path: "/api/business-sync/mutate",
      method: "POST",
      body: { mutation_id: mutationId, ...operation },
    },
    {
      name: "POST id-sequence/reserve",
      path: "/api/business-sync/id-sequence/reserve",
      method: "POST",
      body: { prefix: "EMP", floor: 5 },
    },
    {
      name: "POST transaction/start",
      path: "/api/business-sync/transaction/start",
      method: "POST",
      body: { tx_id: txId, request_hash: HEX64, expected_chunks: 1, operation_count: 1 },
    },
    {
      name: "POST transaction/chunk",
      path: "/api/business-sync/transaction/chunk",
      method: "POST",
      body: { tx_id: txId, chunk_index: 0, chunk_hash: HEX64, operations: [operation] },
    },
    { name: "POST transaction/commit", path: "/api/business-sync/transaction/commit", method: "POST", body: { tx_id: txId } },
    { name: "POST transaction/abort", path: "/api/business-sync/transaction/abort", method: "POST", body: { tx_id: txId } },
    { name: "GET transaction/status", path: `/api/business-sync/transaction/status?tx_id=${txId}` },
  ];
}

const ATTACK_MANIFEST = { schema_version: 1, chunks: [{ index: 0, hash: HEX64, record_count: 1 }], counts: { Property: 1 } };
const ATTACK_MANIFEST_HASH = await sha256Hex(ATTACK_MANIFEST);

const A1_TARGETS = {
  generationId: A1_GEN,
  txId: A1_TX,
  propertyKey: KEY_P_A,
  recordKey: KEY_REV_A,
  mutationId: "MUT-CROSS-ACCOUNT-0001",
};

const { db, env } = await buildFixture();
const baseline = a1Fingerprint(db);
assert(baseline.includes(A1_CANARY), "fixture sanity: A_1 fingerprint must carry the A_1 canary");
assert(!baseline.includes(A2_CANARY), "fixture sanity: A_1 fingerprint must not carry the A_2 canary");

const cookies = {
  ownerA: await login(env, "owner-a1@isolation.test"),
  staffA: await login(env, "staff-a1@isolation.test"),
  managerA: await login(env, "manager-a1@isolation.test"),
  ownerB: await login(env, "owner-a2@isolation.test"),
};

// ---------------------------------------------------------------------------
// PHASE 1 — no session cookie. Every route must 401 BEFORE any handler runs.
// CSRF headers are supplied so a 403 cannot be mistaken for an auth denial.
// ---------------------------------------------------------------------------
for (const route of routeMatrix(A1_TARGETS)) {
  await run.check(`unauthenticated ${route.name} -> 401`, async () => {
    const res = await request(env, route.path, { method: route.method, body: route.body });
    assertEqual(res.status, 401, `${route.name} status`);
    assert(!res.text.includes(A1_CANARY), `${route.name} leaked the A_1 canary to an anonymous caller`);
    assert(res.text.includes("unauthorized"), `${route.name} body should say unauthorized, got ${res.text}`);
  });
}

// ---------------------------------------------------------------------------
// PHASE 2 — IDOR: account A_2's owner names account A_1's objects directly.
// Runs BEFORE phase 3 on purpose: phase 3's transaction/start legitimately
// creates an A_2 row under the SAME tx_id, which would then shadow A_1's id and
// turn these 404s into in-account 409s, weakening the proof.
// ---------------------------------------------------------------------------
const FOREIGN_OBJECT_ATTACKS = [
  ["GET migration/status", 404],
  ["POST migration/chunk", 404],
  ["POST migration/activate", 404],
  ["POST migration/rollback", 404],
  ["POST transaction/chunk", 404],
  ["POST transaction/commit", 404],
  ["POST transaction/abort", 404],
  ["GET transaction/status", 404],
];
const a1Routes = new Map(routeMatrix(A1_TARGETS).map((r) => [r.name, r]));

for (const [name, expected] of FOREIGN_OBJECT_ATTACKS) {
  const route = a1Routes.get(name);
  await run.check(`A_2 owner naming A_1's object via ${name} -> ${expected}`, async () => {
    const res = await request(env, route.path, {
      method: route.method,
      body: route.body,
      cookie: cookies.ownerB,
    });
    assertEqual(res.status, expected, `${name} status (body: ${res.text})`);
    assert(!res.text.includes(A1_CANARY), `${name} leaked the A_1 canary across accounts`);
    assert(!res.text.includes("P_B"), `${name} leaked an A_1 property id across accounts`);
  });
}

await run.check("A_2 owner mutating with A_1's property_key -> 422 property mapping not found", async () => {
  const route = a1Routes.get("POST mutate");
  const res = await request(env, route.path, { method: "POST", body: route.body, cookie: cookies.ownerB });
  assertEqual(res.status, 422, `mutate status (body: ${res.text})`);
  assert(res.text.includes("property mapping not found"), `unexpected mutate denial: ${res.text}`);
  assert(!res.text.includes(A1_CANARY), "mutate leaked the A_1 canary across accounts");
});

// ---------------------------------------------------------------------------
// PHASE 3 — the same attacker's OWN-account operations. These may legitimately
// succeed; what they must never do is return A_1 bytes or reach A_1 state.
// ---------------------------------------------------------------------------
await run.check("A_2 owner snapshot returns only A_2 data", async () => {
  const res = await request(env, "/api/business-sync/snapshot?entity=Property", { cookie: cookies.ownerB });
  assertEqual(res.status, 200, `snapshot status (body: ${res.text})`);
  assert(res.text.includes(A2_CANARY), "A_2 owner should see A_2's own canary");
  assert(!res.text.includes(A1_CANARY), "snapshot leaked the A_1 canary across accounts");
  const body = JSON.parse(res.text);
  assertEqual(body.generation_id, A2_GEN, "snapshot generation must be A_2's own");
  assertEqual(body.items.length, 1, "A_2 has exactly one Property record");
  assertEqual(body.items[0].record_key, KEY_P_X, "A_2 must see only P_X");
});

await run.check("A_2 owner feed returns only A_2 changes", async () => {
  const res = await request(env, "/api/business-sync/feed?since=0", { cookie: cookies.ownerB });
  assertEqual(res.status, 200, `feed status (body: ${res.text})`);
  assert(!res.text.includes(A1_CANARY), "feed leaked the A_1 canary across accounts");
  const body = JSON.parse(res.text);
  assertEqual(body.items.length, 0, "A_2 has no change rows of its own");
  assertEqual(body.active_generation_id, A2_GEN, "feed pointer must be A_2's own");
});

await run.check("A_2 owner migration/start creates an A_2 generation, never A_1's", async () => {
  const route = a1Routes.get("POST migration/start");
  const res = await request(env, route.path, { method: "POST", body: route.body, cookie: cookies.ownerB });
  assertEqual(res.status, 201, `migration/start status (body: ${res.text})`);
  const body = JSON.parse(res.text);
  assert(body.generation_id !== A1_GEN && body.generation_id !== A1_STAGING, "staging generation collided with A_1's");
  const owner = db.prepare("SELECT account_id FROM business_dataset WHERE generation_id=?").get(body.generation_id);
  assertEqual(String(owner.account_id), A2, "new staging generation must belong to A_2");
});

await run.check("A_2 owner reusing A_1's tx_id gets its OWN transaction", async () => {
  const route = a1Routes.get("POST transaction/start");
  const res = await request(env, route.path, { method: "POST", body: route.body, cookie: cookies.ownerB });
  assertEqual(res.status, 201, `transaction/start status (body: ${res.text})`);
  const body = JSON.parse(res.text);
  assert(body.generation_id !== A1_STAGING, "A_2's staging generation collided with A_1's");
  const rows = db.prepare("SELECT account_id,staging_generation_id FROM business_staging_transaction WHERE tx_id=? ORDER BY account_id").all(A1_TX);
  assertEqual(rows.length, 2, "both accounts should hold an independent row under the same tx_id");
  assertEqual(String(rows[0].staging_generation_id), A1_STAGING, "A_1's staging generation must be untouched");
});

// ---------------------------------------------------------------------------
// PHASE 4 — property isolation INSIDE account A_1. A restricted user granted
// only P_A must neither read nor write P_B.
// ---------------------------------------------------------------------------
await run.check("A_1 staff (granted P_A only) snapshot excludes P_B rows", async () => {
  const res = await request(env, "/api/business-sync/snapshot?entity=GrossRevenueDay", { cookie: cookies.staffA });
  assertEqual(res.status, 200, `snapshot status (body: ${res.text})`);
  const body = JSON.parse(res.text);
  assertEqual(body.items.length, 1, "staff must see exactly the one P_A revenue row");
  assertEqual(body.items[0].record_key, KEY_REV_A, "staff must see the P_A row");
  assert(!res.text.includes("GRD-A1-P_B-0801"), "snapshot leaked a P_B row to a P_A-only user");
});

await run.check("A_1 staff feed excludes P_B changes", async () => {
  const res = await request(env, "/api/business-sync/feed?since=0", { cookie: cookies.staffA });
  assertEqual(res.status, 200, `feed status (body: ${res.text})`);
  const body = JSON.parse(res.text);
  assertEqual(body.items.length, 1, "staff must see exactly one change row");
  assertEqual(Number(body.items[0].seq), 1, "staff must see only the P_A change");
  assert(!res.text.includes("GRD-A1-P_B-0801"), "feed leaked a P_B change to a P_A-only user");
  assertEqual(Number(body.current_revision), 2, "revision is account-wide and must still read 2");
});

await run.check("A_1 staff mutate -> 403 (role gate)", async () => {
  const res = await request(env, "/api/business-sync/mutate", {
    method: "POST",
    cookie: cookies.staffA,
    body: {
      mutation_id: "MUT-STAFF-DENIED-0001",
      entity: "GrossRevenueDay",
      operation: "upsert",
      record_key: KEY_REV_A,
      property_key: KEY_P_A,
      row: { id: "GRD-A1-P_A-0801", property_id: "P_A", amount_cents: 1 },
    },
  });
  assertEqual(res.status, 403, `mutate status (body: ${res.text})`);
});

for (const [label, cookie] of [["staff", cookies.staffA], ["manager", cookies.managerA]]) {
  await run.check(`A_1 ${label} migration/activate -> 403 (needs all-property owner/admin)`, async () => {
    const res = await request(env, "/api/business-sync/migration/activate", {
      method: "POST",
      cookie,
      body: { generation_id: A1_STAGING },
    });
    assertEqual(res.status, 403, `activate status (body: ${res.text})`);
    assert(
      res.text.includes("only an all-property owner or admin can migrate business data"),
      `unexpected activate denial: ${res.text}`,
    );
  });
}

// Positive control: the SAME manager passes the mutation-role gate on a route
// with no property target. Without this, the 403 below could not be attributed
// to property scoping rather than a blanket role denial.
await run.check("A_1 manager PASSES the mutation-role gate (id-sequence/reserve -> 200)", async () => {
  const res = await request(env, "/api/business-sync/id-sequence/reserve", {
    method: "POST",
    cookie: cookies.managerA,
    body: { prefix: "EMP", floor: 5 },
  });
  assertEqual(res.status, 200, `reserve status (body: ${res.text})`);
  assertEqual(JSON.parse(res.text).sequence, 6, "reserve must allocate above the floor");
});

// A restricted user must not be able to tell whether a record EXISTS in a
// property they were never granted. The two requests below differ only in
// whether the targeted key exists under P_B; the responses must be identical,
// otherwise the conflict check is acting as a cross-property existence oracle.
await run.check("A_1 manager cannot distinguish an existing P_B record from a missing one", async () => {
  const attempt = async (mutationId, recordId, recordKey) =>
    request(env, "/api/business-sync/mutate", {
      method: "POST",
      cookie: cookies.managerA,
      body: {
        mutation_id: mutationId,
        entity: "GrossRevenueDay",
        operation: "upsert",
        record_key: recordKey,
        property_key: KEY_P_B,
        row: { id: recordId, property_id: "P_B", date: "2026-08-01", amount_cents: 1 },
      },
    });
  const existing = await attempt("MUT-MANAGER-PB-000001", "GRD-A1-P_B-0801", KEY_REV_B);
  const missing = await attempt("MUT-MANAGER-PB-000002", "GRD-A1-P_B-9999", typedRecordKey("GRD-A1-P_B-9999"));
  assertEqual(existing.status, 403, `existing-key status (body: ${existing.text})`);
  assertEqual(missing.status, 403, `missing-key status (body: ${missing.text})`);
  assertEqual(existing.text, missing.text, "responses must not reveal whether the P_B record exists");
  assert(existing.text.includes("outside caller scope"), `unexpected denial: ${existing.text}`);
  const written = db
    .prepare("SELECT COUNT(*) AS n FROM business_change WHERE account_id=? AND mutation_id LIKE 'MUT-MANAGER-PB-%'")
    .get(A1);
  assertEqual(Number(written.n), 0, "a denied mutation must not append a change row");
});

// ---------------------------------------------------------------------------
// PHASE 4b — AUTHORIZATION ORDERING inside mutate(). Every request below must be
// DENIED, so none of them may write and PHASE 5's fingerprint still covers them.
// Together they pin the order mutate() must decide in:
//   mutation role -> roster/entity authority -> declared property_key mapping ->
//   declared property scope -> STORED row scope -> conflict (409).
// A handler that consults stored row state before authorization is finished
// hands a restricted caller an existence oracle in its status/message choice.
// ---------------------------------------------------------------------------

// The id behind KEY_REV_B is read from the fixture rather than restated, so this
// arm can never drift from the row it is supposed to name.
const REV_B_FIXTURE = db
  .prepare(
    "SELECT row_json,row_hash FROM business_record WHERE account_id=? AND generation_id=? AND entity_name=? AND record_key=?",
  )
  .get(A1, A1_GEN, "GrossRevenueDay", KEY_REV_B);
assert(REV_B_FIXTURE, "fixture sanity: the P_B revenue record must exist");
const REV_B_ID = String(JSON.parse(String(REV_B_FIXTURE.row_json)).id);
assertEqual(typedRecordKey(REV_B_ID), KEY_REV_B, "fixture sanity: REV_B_ID is the id behind KEY_REV_B");
const readRevB = () =>
  db
    .prepare(
      "SELECT row_hash,row_json FROM business_record WHERE account_id=? AND generation_id=? AND entity_name=? AND record_key=?",
    )
    .get(A1, A1_GEN, "GrossRevenueDay", KEY_REV_B);
const changeRows = (prefix) =>
  Number(
    db
      .prepare("SELECT COUNT(*) AS n FROM business_change WHERE account_id=? AND mutation_id LIKE ?")
      .get(A1, prefix).n,
  );

// N1 — the arm that ONLY a stored-row scope assert can satisfy. The declared
// property_key (P_A) is legitimately granted, so the declared-property scope
// check passes and cannot be the source of the denial; the denial can come only
// from the scope of the row ALREADY stored under KEY_REV_B (P_B). Drop the
// stored-row assert and this request returns 409 "record already exists" — a
// cross-property existence oracle reachable with a perfectly in-scope
// property_key. No fresh-key 200 companion arm is paired with it on purpose: a
// 200 would WRITE and invalidate the PHASE 5 fingerprint. 403-for-a-taken-key
// vs 200-for-a-fresh-key therefore stays an ACCEPTED RESIDUAL, owned by
// business_record's account-global PRIMARY KEY
// (account_id, generation_id, entity_name, record_key): record_key uniqueness is
// not partitioned by property, so key availability cannot be hidden while that
// uniqueness is still enforced.
await run.check(
  "A_1 manager naming a foreign record through an IN-SCOPE property -> 403 scope denial, not 409",
  async () => {
    const before = readRevB();
    const res = await request(env, "/api/business-sync/mutate", {
      method: "POST",
      cookie: cookies.managerA,
      body: {
        mutation_id: "MUT-MGR-INSCOPE-KEY-FOREIGN-ROW-0001",
        entity: "GrossRevenueDay",
        operation: "upsert",
        record_key: KEY_REV_B, // exists, stored under P_B — never granted
        property_key: KEY_P_A, // granted, so the DECLARED property is in scope
        row: { id: REV_B_ID, property_id: "P_A", date: "2026-08-01", amount_cents: 1 },
      },
    });
    assertEqual(res.status, 403, `must be a scope denial, not a conflict (body: ${res.text})`);
    assert(res.text.includes("outside caller scope"), `unexpected denial: ${res.status} ${res.text}`);
    assert(!res.text.includes("sync_conflict"), `denial leaked a conflict code: ${res.status} ${res.text}`);
    assert(
      !res.text.includes("record already exists"),
      `denial leaked cross-property record existence: ${res.status} ${res.text}`,
    );
    assertEqual(changeRows("MUT-MGR-INSCOPE-%"), 0, "a denied mutation must not append a change row");
    const after = readRevB();
    assertEqual(after.row_hash, before.row_hash, "the P_B revenue row_hash must be untouched");
    assertEqual(after.row_json, before.row_json, "the P_B revenue row_json must be untouched");
  },
);

// N2 — entity-level authority must be decided BEFORE stored roster state is
// read. A property-restricted manager may not change the roster at all, so both
// arms must receive the same authority refusal; the only difference between them
// is whether the named property id exists. code/name are held IDENTICAL across
// the arms so the target identity is the single varying input.
await run.check("A_1 manager cannot distinguish an existing roster row from a missing one", async () => {
  const attempt = async (mutationId, recordKey, propertyId) =>
    request(env, "/api/business-sync/mutate", {
      method: "POST",
      cookie: cookies.managerA,
      body: {
        mutation_id: mutationId,
        entity: "Property",
        operation: "upsert",
        record_key: recordKey,
        row: { id: propertyId, code: "RRI-CAM", name: "Cambridge Riverside" },
      },
    });
  const existing = await attempt("MUT-MGR-ROSTER-ORACLE-000001", KEY_P_B, "P_B");
  const missing = await attempt("MUT-MGR-ROSTER-ORACLE-000002", typedRecordKey("P_GHOST"), "P_GHOST");
  assertEqual(existing.status, 403, `existing-roster-row status (body: ${existing.text})`);
  assertEqual(missing.status, 403, `missing-roster-row status (body: ${missing.text})`);
  assertEqual(
    existing.text,
    missing.text,
    `responses must not reveal whether the roster row exists (existing: ${existing.status} ${existing.text} | missing: ${missing.status} ${missing.text})`,
  );
  assert(
    existing.text.includes("only all-property accounts can change the roster"),
    `roster authority must be the denial reason: ${existing.status} ${existing.text}`,
  );
  assertEqual(changeRows("MUT-MGR-ROSTER-%"), 0, "a denied roster mutation must not append a change row");
});

// N3 — an unresolvable declared property_key must be refused on its own input
// merits (422) before any stored row is consulted. KEY_P_X is well formed and is
// a REAL property id, but it belongs to account A_2, so A_1's active generation
// holds no business_property_map row for it. Both arms must therefore look the
// same whether or not the named record exists under a property the caller was
// never granted.
await run.check(
  "A_1 manager cannot distinguish an existing foreign record from a missing one through an unmapped property",
  async () => {
    const mapped = db
      .prepare("SELECT COUNT(*) AS n FROM business_property_map WHERE account_id=? AND generation_id=? AND property_key=?")
      .get(A1, A1_GEN, KEY_P_X);
    assertEqual(Number(mapped.n), 0, "premise: KEY_P_X must be unmapped in A_1's active generation");
    const attempt = async (mutationId, recordKey, recordId) =>
      request(env, "/api/business-sync/mutate", {
        method: "POST",
        cookie: cookies.managerA,
        body: {
          mutation_id: mutationId,
          entity: "GrossRevenueDay",
          operation: "upsert",
          record_key: recordKey,
          property_key: KEY_P_X,
          row: { id: recordId, property_id: "P_X", date: "2026-08-01", amount_cents: 1 },
        },
      });
    const existing = await attempt("MUT-MGR-UNMAPPED-ORACLE-000001", KEY_REV_B, REV_B_ID);
    const missing = await attempt(
      "MUT-MGR-UNMAPPED-ORACLE-000002",
      typedRecordKey("GRD-A1-P_X-9999"),
      "GRD-A1-P_X-9999",
    );
    assertEqual(
      existing.text,
      missing.text,
      `responses must not reveal whether the foreign record exists (existing: ${existing.status} ${existing.text} | missing: ${missing.status} ${missing.text})`,
    );
    assertEqual(existing.status, 422, `existing-record status (body: ${existing.text})`);
    assertEqual(missing.status, 422, `missing-record status (body: ${missing.text})`);
    assert(
      existing.text.includes("property mapping not found"),
      `unresolvable property_key must be the denial reason: ${existing.status} ${existing.text}`,
    );
    assertEqual(changeRows("MUT-MGR-UNMAPPED-%"), 0, "a denied mutation must not append a change row");
  },
);

// ---------------------------------------------------------------------------
// PHASE 5 — the closing proof. Every A_1 business row must be byte-identical to
// the pre-attack baseline. business_id_sequence is intentionally excluded: it is
// an allocation counter, not business data, and the manager positive control
// above legitimately advances it.
// ---------------------------------------------------------------------------
await run.check("A_1 business data is byte-identical after the full attack matrix", () => {
  const after = a1Fingerprint(db);
  if (after !== baseline) {
    const b = JSON.parse(baseline);
    const a = JSON.parse(after);
    const drifted = Object.keys(b).filter((k) => JSON.stringify(b[k]) !== JSON.stringify(a[k]));
    throw new Error(`A_1 state drifted in: ${drifted.join(", ") || "(unknown)"}`);
  }
});

await run.check("A_1 owner still reads its own complete dataset after the attacks", async () => {
  const res = await request(env, "/api/business-sync/snapshot?entity=GrossRevenueDay", { cookie: cookies.ownerA });
  assertEqual(res.status, 200, `snapshot status (body: ${res.text})`);
  const body = JSON.parse(res.text);
  assertEqual(body.generation_id, A1_GEN, "A_1 pointer must still be the original generation");
  assertEqual(body.items.length, 2, "A_1 owner must still see both revenue rows");
  assertEqual(body.items.map((i) => i.record_key).sort().join("|"), [KEY_REV_A, KEY_REV_B].sort().join("|"), "record keys");
  assert(res.text.includes(A1_CANARY), "A_1's own canary must survive");
  assert(!res.text.includes(A2_CANARY), "A_1 must never see A_2's canary");
});

run.done();
if (process.exitCode) process.exit(1);
console.log("PASSED: business-sync cross-account and cross-property isolation contract completed.");
