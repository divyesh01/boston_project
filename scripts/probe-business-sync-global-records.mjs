// scripts/probe-business-sync-global-records.mjs
//
// THE DEFECT THIS PROVES (Observed in production D1 by Agent A):
//   The owner's real hotel dataset contains 16 business records (14 PayrollRun +
//   2 Staff) whose `property_id` is the empty string. worker/business-sync.js
//   `typedRecordKey("")` returns the 4-character key `s:0:`, and
//   activateMigration's orphan loop (the `orphaned property reference:` throw in
//   worker/business-sync.js) rejects any `property_key` absent from `mappings`,
//   which is built ONLY from `entity_name='Property'` rows. So the migration
//   dies with
//   `422 orphaned property reference: s:0:` and the account can never activate.
//
// THE GOVERNING CONTRACT BEING RATIFIED:
//   A business record with no property is ACCOUNT-GLOBAL. It carries
//   `property_key = 's:0:'` and `server_property_id IS NULL`. An unrestricted
//   caller (`scope.all`) may read and write it. A restricted caller can neither
//   read nor write it — SQL NULL never satisfies `server_property_id IN (...)`,
//   so the read side is fail-closed by construction, and the write side must
//   deny with an authorization message that is identical whether or not the
//   record exists (no existence oracle).
//
// WHY THE OBVIOUS PARTIAL FIXES ARE NOT ENOUGH — the DISCRIMINATORS below:
//   * Fixing only activateMigration leaves `mutate` at 422 `property mapping
//     not found`, because mutate's mapping lookup has no row for `s:0:`
//     and `business_property_map.server_property_id` is NOT NULL, so a sentinel
//     mapping row cannot exist. (checks 5, 6)
//   * Fixing only `mutate` leaves the staged-transaction path broken by
//     `business_staging_target.server_property_id NOT NULL` (worker/schema.sql:840).
//     That constraint failure text matches the regex at
//     uploadTransactionChunk's `transaction target changed or was duplicated`
//     remap in worker/business-sync.js and is MISREPORTED as
//     `409 { code: 'sync_conflict' }` — a real data-loss trap, because the
//     client treats a conflict as "someone else won" rather than "the server
//     cannot store this". (check 7)
//   * Returning a NULL server property id without teaching
//     assertPropertyInScope about global rows produces
//     `403 property null is outside caller scope` — a String(null)
//     stringification artifact. Asserting only the STATUS CODE would pass for
//     the wrong reason, so check 9 asserts the exact message
//     `record belongs to another property`.
//   * Treating an empty/absent `property_key` as global would silently re-home
//     every malformed write. `String(body.property_key || "")` coerces a missing
//     key to `""`, and `"" !== "s:0:"`. (check 10)
//
// WHY EACH INDIVIDUAL CLAUSE OF THE FIX IS LOAD-BEARING — checks 11-14:
//   Checks 1-10 prove the CONTRACT. They do not prove that every clause the fix
//   added is doing work: five separate clauses could be deleted while 1-10 stayed
//   green. Each of 11-14 is built to fail if exactly one of those clauses is
//   removed, and each names the removal it catches:
//     * 11 — presentGuard's `requireGlobal` flag on the TRANSACTION path, which
//       has no JavaScript `current` check at all, so that flag is the only thing
//       forbidding staged re-homing.
//     * 12 — the `property_key` half of mutate's re-homing comparison, which
//       only bites when the stored key disagrees while both sides sit on the
//       same server_property_id.
//     * 13 — the staging-sentinel exclusion in BOTH commit-time scope guards
//       (the `:scope` SQL guard and the JavaScript fallback), which only bite
//       when a grant literally names the sentinel id.
//     * 14 — activation's empty/NULL `property_key` boundary, which check 4's
//       genuine non-empty orphan cannot reach.
//
// TEST-ONLY. Agent C (independent-tester) owns this file. It edits nothing under
// worker/ or src/. It drives the REAL handler
// (worker/business-sync.js handleBusinessSyncRequest) over the REAL schema
// (worker/schema.sql) through the node:sqlite D1 shim in ./_worker-testkit.mjs,
// and resolves BOTH caller scopes through the REAL worker/scope.js resolveScope.
//
// Run: node scripts/probe-business-sync-global-records.mjs

import {
  assert,
  assertEqual,
  makeDb,
  makeEnv,
  makeRunner,
  seedUser,
} from "./_worker-testkit.mjs";
import {
  BUSINESS_ENTITIES,
  canonicalJson,
  handleBusinessSyncRequest,
  typedRecordKey,
} from "../worker/business-sync.js";
import { resolveScope } from "../worker/scope.js";

const run = makeRunner("probe-business-sync-global-records");

const ACCOUNT = "A_1";
const PROPERTY_ID = "P_RRI1416";
const PROPERTY_CODE = "RRI1416";
const OWNER_EMAIL = "owner@test.local";
const MANAGER_EMAIL = "manager@test.local";

// The account-global typed key. Derived, never hardcoded outside check 1.
const GLOBAL_KEY = typedRecordKey("");

// The fixture mirrors the production shape: ONE real property, ONE record on it,
// and TWO records whose property_id is the empty string.
const PROPERTY_ROW = { id: 1, code: PROPERTY_CODE, name: "Red Roof Inn 1416", rooms: 120, active: true, created_date: "2026-01-01" };
const EXPENSE_ROW = { id: 1, property_id: 1, expense_name: "Utilities", amount: 1234.56 };
const STAFF_ROW = { id: "STF001", property_id: "", full_name: "Corporate Controller", position: "Controller" };
const PAYROLL_ROW = { id: "PR001", property_id: "", period_end: "2026-01-15", gross_pay: 4500.5 };

const PROPERTY_KEY = typedRecordKey(PROPERTY_ROW.id);
const EXPENSE_KEY = typedRecordKey(EXPENSE_ROW.id);
const STAFF_KEY = typedRecordKey(STAFF_ROW.id);
const PAYROLL_KEY = typedRecordKey(PAYROLL_ROW.id);

const db = makeDb();
db.prepare("INSERT INTO account (id,name,created_date) VALUES (?,?,?)").run(ACCOUNT, "Boston Hotels", "2026-01-01");
// The roster row already exists, exactly as it does in the owner's live D1, so
// activation must REUSE it and must not invent a sentinel property.
db.prepare("INSERT INTO property (id,account_id,code,name,rooms,active,created_date) VALUES (?,?,?,?,?,?,?)")
  .run(PROPERTY_ID, ACCOUNT, PROPERTY_CODE, PROPERTY_ROW.name, PROPERTY_ROW.rooms, 1, PROPERTY_ROW.created_date);
seedUser(db, { id: "owner", email: OWNER_EMAIL, role: "owner", mode: "all" });
// The restricted caller is role `manager` + mode `specific` + manual_entry, NOT
// the testkit's scopeSpecific() helper. That helper hardcodes role "staff",
// which requireMutationRole (worker/business-sync.js) refuses on the ROLE
// gate, so every write assertion would pass without the PROPERTY gate ever
// being reached. This user clears the role gate and is granted ONLY the real
// property, so a denial can only come from property scope.
seedUser(db, { id: "mgr", email: MANAGER_EMAIL, role: "manager", mode: "specific", grants: [PROPERTY_ID] });
db.prepare("UPDATE user SET permissions=? WHERE account_id=? AND id=?")
  .run(JSON.stringify({ manual_entry: true }), ACCOUNT, "mgr");

const env = makeEnv(db, { ENABLE_BUSINESS_SYNC_API: "true" });

// Both scopes come from the REAL resolver, so `all`, `propertyIds`, `role` and
// `permissions` are whatever production would compute for these rows.
const ownerResolved = await resolveScope(env, { subject: "owner", email: OWNER_EMAIL });
const managerResolved = await resolveScope(env, { subject: "mgr", email: MANAGER_EMAIL });
if (!ownerResolved.ok || !managerResolved.ok) {
  throw new Error(`fixture scope resolution failed: ${JSON.stringify({ ownerResolved, managerResolved })}`);
}
const owner = ownerResolved.scope;
const restricted = managerResolved.scope;
if (!owner.all || restricted.all) throw new Error("fixture scopes are not owner-unrestricted / manager-restricted");

// ---------------------------------------------------------------------------
// Helpers — same shapes as scripts/probe-worker-business-sync.mjs
// ---------------------------------------------------------------------------

async function hash(value) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(typeof value === "string" ? value : canonicalJson(value))));
  return Array.from(digest, (part) => part.toString(16).padStart(2, "0")).join("");
}

async function encoded(entity, row) {
  const record_key = typedRecordKey(row.id);
  const property_key = entity === "Property" ? record_key : typedRecordKey(row.property_id);
  return { entity, record_key, property_key, row, row_hash: await hash(canonicalJson(row)) };
}

/** Build a migration payload from `[[ [entity,row], ... ], ...]` chunk groups. */
async function buildPayload(groups) {
  const chunks = [];
  for (const group of groups) {
    const encodedRows = [];
    for (const [entity, row] of group) encodedRows.push(await encoded(entity, row));
    chunks.push(encodedRows);
  }
  const rows = chunks.flat();
  const descriptors = [];
  for (let index = 0; index < chunks.length; index += 1) {
    descriptors.push({ index, count: chunks[index].length, hash: await hash(canonicalJson(chunks[index])) });
  }
  const counts = Object.fromEntries(BUSINESS_ENTITIES.map((entity) => [entity, rows.filter((row) => row.entity === entity).length]));
  const manifest = { schema_version: 1, counts, chunks: descriptors };
  return { chunks, descriptors, manifest, manifest_hash: await hash(canonicalJson(manifest)) };
}

async function call(path, { method = "GET", body, scope = owner } = {}) {
  const url = new URL(`https://api.test/api/business-sync/${path}`);
  const request = new Request(url, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  return handleBusinessSyncRequest(request, env, scope, url, url.pathname.split("/").filter(Boolean));
}

async function start(payload) {
  const response = await call("migration/start", { method: "POST", body: { manifest: payload.manifest, manifest_hash: payload.manifest_hash } });
  return { response, body: await response.json() };
}

async function upload(generationId, payload, index) {
  const response = await call("migration/chunk", { method: "POST", body: { generation_id: generationId, chunk_index: index, chunk_hash: payload.descriptors[index].hash, rows: payload.chunks[index] } });
  return { response, body: await response.json() };
}

async function transactionChunkHash(operations) {
  return hash(canonicalJson(operations.map((operation) => ({
    entity: operation.entity,
    operation: operation.operation,
    record_key: operation.record_key,
    property_key: operation.property_key,
    row: operation.row || null,
    base_row_hash: operation.base_row_hash ?? null,
  }))));
}

/** The live active generation, re-read every time so no check holds a stale id. */
function activeGeneration() {
  return db.prepare("SELECT active_generation_id FROM business_dataset_pointer WHERE account_id=?").get(ACCOUNT)?.active_generation_id ?? null;
}

function storedRecord(entity, recordKey, generationId = activeGeneration()) {
  return db.prepare("SELECT property_key,server_property_id,row_hash FROM business_record WHERE account_id=? AND generation_id=? AND entity_name=? AND record_key=?")
    .get(ACCOUNT, generationId, entity, recordKey) ?? null;
}

function countRows(sql, ...params) {
  return Number(db.prepare(sql).get(...params).n);
}

/** A generation's lifecycle status, so a check can prove a refused staging generation stayed staging. */
function datasetStatus(generationId) {
  return db.prepare("SELECT status FROM business_dataset WHERE account_id=? AND generation_id=?").get(ACCOUNT, generationId)?.status ?? null;
}

/**
 * call() plus its JSON body, with one difference that matters: a handler that
 * THROWS instead of answering is reported as status 500 rather than aborting the
 * check with a bare SQLite message. A commit that escapes as an unhandled
 * CHECK-constraint failure is a real observable outcome, and it must stay
 * distinguishable from the 403 the contract requires.
 */
async function settle(path, options) {
  try {
    const response = await call(path, options);
    return { status: response.status, body: await response.json() };
  } catch (error) {
    return { status: 500, body: { error: `handler threw instead of answering: ${error instanceof Error ? error.message : String(error)}` } };
  }
}

const mainPayload = await buildPayload([
  [["Property", PROPERTY_ROW], ["Expense", EXPENSE_ROW]],
  [["Staff", STAFF_ROW], ["PayrollRun", PAYROLL_ROW]],
]);
let mainGeneration = null;
let mainActivated = false;

// ---------------------------------------------------------------------------
// 1 — NON-DISCRIMINATING SANITY CHECK.
// Pins the key algebra the whole contract rests on. `n:0` is a REAL property
// whose id is the integer 0; it is NOT global and must never be conflated with
// the empty-string key. This passes today and must keep passing.
// ---------------------------------------------------------------------------
await run.check("the empty property id types to s:0: and is distinct from property id 0 and \"0\"", () => {
  assertEqual(typedRecordKey(""), "s:0:", "empty-string property id");
  assertEqual(typedRecordKey(0), "n:0", "numeric property id 0");
  assertEqual(typedRecordKey("0"), "s:1:0", "string property id \"0\"");
  assert(typedRecordKey("") !== typedRecordKey(0), "global key collided with real property id 0");
  assert(typedRecordKey("") !== typedRecordKey("0"), "global key collided with real property id \"0\"");
});

// ---------------------------------------------------------------------------
// 2 — DISCRIMINATOR (the original defect, end to end).
// Every earlier guard passes; activateMigration's `orphaned property reference:`
// orphan check
// is the FIRST reachable error. start=201 and both chunk uploads=200 are asserted
// BEFORE activate, so a failure here can only be the activation itself.
// ---------------------------------------------------------------------------
await run.check("a migration carrying account-global records activates", async () => {
  const started = await start(mainPayload);
  assertEqual(started.response.status, 201, `migration/start (body ${JSON.stringify(started.body)})`);
  mainGeneration = started.body.generation_id;
  for (let index = 0; index < mainPayload.chunks.length; index += 1) {
    const uploaded = await upload(mainGeneration, mainPayload, index);
    assertEqual(uploaded.response.status, 200, `migration/chunk ${index} (body ${JSON.stringify(uploaded.body)})`);
  }
  assertEqual(countRows("SELECT COUNT(*) AS n FROM business_record WHERE account_id=? AND generation_id=?", ACCOUNT, mainGeneration), 4, "staged record count");
  // The upload path already accepts a global row: it lands with property_key
  // 's:0:' and a NULL server_property_id. Asserting it here localises the defect
  // to activation alone, so the failure below cannot be blamed on ingestion.
  for (const [entity, key] of [["Staff", STAFF_KEY], ["PayrollRun", PAYROLL_KEY]]) {
    const staged = storedRecord(entity, key, mainGeneration);
    assert(staged, `${entity} ${key} was not staged`);
    assertEqual(staged.property_key, GLOBAL_KEY, `staged ${entity} property_key`);
    assertEqual(staged.server_property_id, null, `staged ${entity} server_property_id`);
  }
  const activate = await call("migration/activate", { method: "POST", body: { generation_id: mainGeneration } });
  const body = await activate.json();
  assertEqual(activate.status, 200, `migration/activate must accept a record with no property (body ${JSON.stringify(body)})`);
  assertEqual(body.status, "active", "activation status");
  assertEqual(body.properties, 1, "exactly one property was mapped");
  mainActivated = true;
  assertEqual(activeGeneration(), mainGeneration, "the activated generation must become the pointer");
});

// ---------------------------------------------------------------------------
// 3 — DISCRIMINATOR on the STORED SHAPE. A fix that satisfied activation by
// inventing a sentinel property row, or by re-homing the global rows onto the
// real property, would pass check 2 and fail here.
// ---------------------------------------------------------------------------
await run.check("an activated global record keeps property_key s:0: with a NULL server_property_id and no sentinel property", () => {
  assert(mainGeneration, "check 2 never reached migration/start");
  assert(mainActivated, "check 2's activation was refused, so no post-activation shape exists to inspect");
  for (const [entity, key] of [["Staff", STAFF_KEY], ["PayrollRun", PAYROLL_KEY]]) {
    const stored = storedRecord(entity, key, mainGeneration);
    assert(stored, `${entity} ${key} is absent from generation ${mainGeneration}`);
    assertEqual(stored.property_key, GLOBAL_KEY, `${entity} property_key`);
    assertEqual(stored.server_property_id, null, `${entity} server_property_id must be SQL NULL`);
  }
  const expense = storedRecord("Expense", EXPENSE_KEY, mainGeneration);
  assert(expense, "the property-scoped Expense is absent");
  assertEqual(expense.server_property_id, PROPERTY_ID, "the property-scoped Expense must resolve to the real property");
  assertEqual(countRows("SELECT COUNT(*) AS n FROM business_property_map WHERE account_id=? AND generation_id=?", ACCOUNT, mainGeneration), 1, "business_property_map must hold exactly one row (no sentinel mapping)");
  assertEqual(countRows("SELECT COUNT(*) AS n FROM property WHERE account_id=?", ACCOUNT), 1, "the property roster must hold exactly one row (no sentinel property)");
});

// ---------------------------------------------------------------------------
// 4 — NON-DISCRIMINATING SAFETY CHECK (a negative that must NOT regress).
// Accepting `s:0:` must not accept a genuine dangling reference. This dataset's
// only non-roster row points at property 99, which no Property row declares, so
// `n:99` is the single possible orphan message. Passes today.
// ---------------------------------------------------------------------------
await run.check("a genuine orphaned property reference is still rejected", async () => {
  const payload = await buildPayload([[["Property", PROPERTY_ROW], ["Expense", { id: 2, property_id: 99, expense_name: "Dangling", amount: 1 }]]]);
  const started = await start(payload);
  assertEqual(started.response.status, 201, `orphan migration/start (body ${JSON.stringify(started.body)})`);
  const uploaded = await upload(started.body.generation_id, payload, 0);
  assertEqual(uploaded.response.status, 200, `orphan migration/chunk (body ${JSON.stringify(uploaded.body)})`);
  const activate = await call("migration/activate", { method: "POST", body: { generation_id: started.body.generation_id } });
  const body = await activate.json();
  assertEqual(activate.status, 422, `a dangling reference must still be refused (body ${JSON.stringify(body)})`);
  assertEqual(body.error, "orphaned property reference: n:99", "the orphan message must name the dangling key");
});

// ---------------------------------------------------------------------------
// FIXTURE, NOT AN ASSERTION ABOUT THE FIX.
//
// Checks 5-10 are about the MUTATION and TRANSACTION paths, which are separate
// code from activation. They must be provable NOW, against a state where an
// active generation already holds a global record — otherwise every one of them
// would fail with the uninformative `no active business dataset` and the probe
// would not distinguish an activation-only fix from a complete one.
//
// When activation works (check 2 green) this step does nothing but re-assert the
// contract state. While activation is broken it reconstructs the same state the
// minimum possible way: a roster-only migration is activated by the REAL
// production code path, and only the two global business_record rows are
// inserted directly, in exactly the shape production D1 already holds
// (property_key='s:0:', server_property_id NULL). No sentinel property row and
// no sentinel business_property_map row is created, because the contract forbids
// both and because business_property_map.server_property_id is NOT NULL.
// ---------------------------------------------------------------------------
await run.check("fixture: an active generation holds one property-scoped and two account-global records", async () => {
  if (!mainActivated) {
    const roster = await buildPayload([[["Property", PROPERTY_ROW], ["Expense", EXPENSE_ROW]]]);
    const started = await start(roster);
    assertEqual(started.response.status, 201, `fixture migration/start (body ${JSON.stringify(started.body)})`);
    const uploaded = await upload(started.body.generation_id, roster, 0);
    assertEqual(uploaded.response.status, 200, `fixture migration/chunk (body ${JSON.stringify(uploaded.body)})`);
    const activate = await call("migration/activate", { method: "POST", body: { generation_id: started.body.generation_id } });
    assertEqual(activate.status, 200, `fixture migration/activate (body ${JSON.stringify(await activate.json())})`);
    const now = new Date().toISOString();
    for (const [entity, row] of [["Staff", STAFF_ROW], ["PayrollRun", PAYROLL_ROW]]) {
      const rowJson = canonicalJson(row);
      db.prepare("INSERT INTO business_record (account_id,generation_id,entity_name,record_key,property_key,server_property_id,row_json,row_hash,updated_at) VALUES (?,?,?,?,?,NULL,?,?,?)")
        .run(ACCOUNT, started.body.generation_id, entity, typedRecordKey(row.id), GLOBAL_KEY, rowJson, await hash(rowJson), now);
    }
  }
  const generation = activeGeneration();
  assert(generation, "no active generation could be established");
  assertEqual(storedRecord("Expense", EXPENSE_KEY).server_property_id, PROPERTY_ID, "the property-scoped record must carry the real property id");
  for (const [entity, key] of [["Staff", STAFF_KEY], ["PayrollRun", PAYROLL_KEY]]) {
    const stored = storedRecord(entity, key);
    assert(stored, `${entity} ${key} is not in the active generation`);
    assertEqual(stored.property_key, GLOBAL_KEY, `${entity} property_key`);
    assertEqual(stored.server_property_id, null, `${entity} server_property_id`);
  }
  assertEqual(countRows("SELECT COUNT(*) AS n FROM business_property_map WHERE account_id=? AND generation_id=?", ACCOUNT, generation), 1, "the active generation must map exactly one property");
  assertEqual(countRows("SELECT COUNT(*) AS n FROM property WHERE account_id=?", ACCOUNT), 1, "the roster must still hold exactly one property");
});

// ---------------------------------------------------------------------------
// 5 — DISCRIMINATOR. An activation-only fix fails here with
// `422 property mapping not found` (mutate's business_property_map lookup in
// worker/business-sync.js): there is
// no business_property_map row for `s:0:` and, because that table's
// server_property_id is NOT NULL, there never can be one.
// ---------------------------------------------------------------------------
await run.check("an unrestricted caller can upsert an account-global record", async () => {
  const before = storedRecord("Staff", STAFF_KEY);
  assert(before, "the global Staff record is missing before the upsert");
  const row = { ...STAFF_ROW, position: "Corporate Controller II" };
  const response = await call("mutate", { method: "POST", body: {
    mutation_id: "mutation_global_upsert_0001",
    entity: "Staff",
    operation: "upsert",
    record_key: STAFF_KEY,
    property_key: GLOBAL_KEY,
    row,
    base_row_hash: before.row_hash,
  } });
  const body = await response.json();
  assertEqual(response.status, 200, `a global upsert must be accepted (body ${JSON.stringify(body)})`);
  assert(body.row_hash && body.row_hash !== before.row_hash, `row_hash must change: before ${before.row_hash}, after ${body.row_hash}`);
  const after = storedRecord("Staff", STAFF_KEY);
  assertEqual(after.row_hash, body.row_hash, "the stored row_hash must match the response");
  assertEqual(after.property_key, GLOBAL_KEY, "the upsert must not re-home the record");
  assertEqual(after.server_property_id, null, "the upsert must keep server_property_id NULL");
});

// ---------------------------------------------------------------------------
// 6 — DISCRIMINATOR. Same mapping gate on the delete branch.
// ---------------------------------------------------------------------------
await run.check("an unrestricted caller can delete an account-global record", async () => {
  const before = storedRecord("PayrollRun", PAYROLL_KEY);
  assert(before, "the global PayrollRun record is missing before the delete");
  const response = await call("mutate", { method: "POST", body: {
    mutation_id: "mutation_global_delete_0001",
    entity: "PayrollRun",
    operation: "delete",
    record_key: PAYROLL_KEY,
    property_key: GLOBAL_KEY,
    base_row_hash: before.row_hash,
  } });
  const body = await response.json();
  assertEqual(response.status, 200, `a global delete must be accepted (body ${JSON.stringify(body)})`);
  assertEqual(storedRecord("PayrollRun", PAYROLL_KEY), null, "the global record must be gone");
});

// ---------------------------------------------------------------------------
// 7 — DISCRIMINATOR, and the one that catches the SCHEMA blocker.
// `business_staging_target.server_property_id` is NOT NULL (worker/schema.sql:840).
// A fix that only teaches the resolver to return NULL will hit that constraint
// inside the D1 batch; the failure text matches the regex at
// uploadTransactionChunk's `transaction target changed or was duplicated` remap
// and is returned as
// `409 { code: 'sync_conflict' }`, which tells the client "someone else won"
// when the truth is "the server cannot store this". The chunk therefore asserts
// BOTH that it is not that misreported conflict AND that it is 200.
// base_row_hash is the real current hash, so the ONLY reason to refuse is the
// property gate — never a stale-revision guard.
// ---------------------------------------------------------------------------
await run.check("a staged transaction can carry an account-global operation and commit", async () => {
  const before = storedRecord("Staff", STAFF_KEY);
  assert(before, "the global Staff record is missing before the transaction");
  const txId = "transaction_global_upsert_0001";
  const operation = {
    entity: "Staff",
    operation: "upsert",
    record_key: STAFF_KEY,
    property_key: GLOBAL_KEY,
    row: { ...STAFF_ROW, position: "Corporate Controller III" },
    base_row_hash: before.row_hash,
  };
  const started = await call("transaction/start", { method: "POST", body: { tx_id: txId, request_hash: await hash(canonicalJson([operation])), expected_chunks: 1, operation_count: 1 } });
  const startedBody = await started.json();
  assertEqual(started.status, 201, `transaction/start (body ${JSON.stringify(startedBody)})`);
  const chunk = await call("transaction/chunk", { method: "POST", body: { tx_id: txId, chunk_index: 0, chunk_hash: await transactionChunkHash([operation]), operations: [operation] } });
  const chunkBody = await chunk.json();
  assert(!(chunk.status === 409 && chunkBody.code === "sync_conflict"),
    `a global staged op must never be misreported as a sync conflict (status ${chunk.status}, body ${JSON.stringify(chunkBody)})`);
  assertEqual(chunk.status, 200, `a staged global upsert must be accepted (body ${JSON.stringify(chunkBody)})`);
  const committed = await call("transaction/commit", { method: "POST", body: { tx_id: txId } });
  const committedBody = await committed.json();
  assertEqual(committed.status, 200, `transaction/commit (body ${JSON.stringify(committedBody)})`);
  assertEqual(activeGeneration(), startedBody.generation_id, "the committed staging generation must become active");
  const after = storedRecord("Staff", STAFF_KEY);
  assert(after, "the global record vanished from the committed generation");
  assertEqual(after.property_key, GLOBAL_KEY, "the commit must not re-home the record");
  assertEqual(after.server_property_id, null, "the commit must keep server_property_id NULL");
  assert(after.row_hash !== before.row_hash, "the committed row_hash must change");
});

// ---------------------------------------------------------------------------
// 8a/8b — NON-DISCRIMINATING SANITY CHECKS on the read side. SQL NULL never
// satisfies `server_property_id IN (...)`, so the restricted read is fail-closed
// by construction and passes today. 8b proves the restriction is specifically
// about the global row and not a globally broken scoped query.
// ---------------------------------------------------------------------------
await run.check("a restricted caller cannot read an account-global record but still reads its own property", async () => {
  const restrictedStaff = await (await call("snapshot?entity=Staff&limit=50", { scope: restricted })).json();
  assertEqual(restrictedStaff.items.length, 0, `a restricted caller must see no global Staff (items ${JSON.stringify(restrictedStaff.items)})`);
  const ownerStaff = await (await call("snapshot?entity=Staff&limit=50")).json();
  assertEqual(ownerStaff.items.length, 1, `an unrestricted caller must see the global Staff (items ${JSON.stringify(ownerStaff.items)})`);
  const restrictedExpense = await (await call("snapshot?entity=Expense&limit=50", { scope: restricted })).json();
  assertEqual(restrictedExpense.items.length, 1, `a restricted caller must still read its own property's Expense (items ${JSON.stringify(restrictedExpense.items)})`);
  assertEqual(restrictedExpense.items[0].record_key, EXPENSE_KEY, "the visible Expense must be the property-scoped one");
  assertEqual(typedRecordKey(restrictedExpense.items[0].row.property_id), PROPERTY_KEY, "the visible Expense must belong to the granted property");
});

// ---------------------------------------------------------------------------
// 8c/8d — DISCRIMINATOR on the write side AND on the absence of an existence
// oracle. Both requests are byte-identical in shape (a create: no
// base_row_hash); only the existence of the target differs. In an authorized
// world their answers would diverge maximally (409 `record already exists`
// versus 200 created), so identical 403s prove authorization is decided BEFORE
// existence. Neither answer may be `property mapping not found`, which leaks
// that the server has no idea what `s:0:` is.
// ---------------------------------------------------------------------------
await run.check("a restricted caller is denied on an account-global record with no existence oracle", async () => {
  const before = storedRecord("Staff", STAFF_KEY);
  assert(before, "the global Staff record is missing before the denial checks");
  const absentKey = typedRecordKey("STF999");
  const attempt = async (mutationId, id) => {
    const response = await call("mutate", { method: "POST", scope: restricted, body: {
      mutation_id: mutationId,
      entity: "Staff",
      operation: "upsert",
      record_key: typedRecordKey(id),
      property_key: GLOBAL_KEY,
      row: { ...STAFF_ROW, id, position: "Escalated" },
    } });
    return { status: response.status, body: await response.json() };
  };
  const onExisting = await attempt("mutation_restricted_exists01", STAFF_ROW.id);
  const onAbsent = await attempt("mutation_restricted_absent01", "STF999");
  assertEqual(onExisting.status, 403, `a restricted write to an existing global record must be 403 (body ${JSON.stringify(onExisting.body)})`);
  assertEqual(onAbsent.status, 403, `a restricted write to an absent global record must be 403 (body ${JSON.stringify(onAbsent.body)})`);
  assert(!/property mapping not found/.test(String(onExisting.body.error)), `the denial must be an authorization message, not a mapping leak: ${JSON.stringify(onExisting.body)}`);
  assert(/scope|forbidden|authoriz|permitted|denied/i.test(String(onExisting.body.error)), `the denial must read as an authorization refusal: ${JSON.stringify(onExisting.body)}`);
  assertEqual(onAbsent.body.error, onExisting.body.error, "the existing-record and absent-record denials must be indistinguishable");
  assertEqual(storedRecord("Staff", STAFF_KEY).row_hash, before.row_hash, "the denied write must not have changed the record");
  assertEqual(storedRecord("Staff", absentKey), null, "the denied write must not have created a record");
});

// ---------------------------------------------------------------------------
// 8e — DISCRIMINATOR. The staged path must deny the same thing the direct path
// denies, for the same reason. base_row_hash is the real current hash so a
// stale-revision guard can never be the reason. "Denied" is asserted
// behaviourally: refused, nothing staged, the chunk cursor did not advance, and
// the staging copy untouched. The exact 4xx code is deliberately NOT pinned —
// 403-vs-422 is not a security difference and the lead ratified only "denied".
// Two message facts ARE pinned, for the same reason as 8c/8d: the refusal must
// not be `property mapping not found` (the server admitting it does not model
// global records, and an information asymmetry against 8c/8d), and it must not
// be reported as a write conflict, because nothing here conflicts — the caller
// is simply not allowed. A 200 would be a property-isolation breach.
// ---------------------------------------------------------------------------
await run.check("a restricted caller cannot stage an account-global operation in a transaction", async () => {
  const before = storedRecord("Staff", STAFF_KEY);
  assert(before, "the global Staff record is missing before the staged denial check");
  const txId = "transaction_restricted_global01";
  const operation = {
    entity: "Staff",
    operation: "upsert",
    record_key: STAFF_KEY,
    property_key: GLOBAL_KEY,
    row: { ...STAFF_ROW, position: "Smuggled" },
    base_row_hash: before.row_hash,
  };
  const started = await call("transaction/start", { method: "POST", scope: restricted, body: { tx_id: txId, request_hash: await hash(canonicalJson([operation])), expected_chunks: 1, operation_count: 1 } });
  const startedBody = await started.json();
  assertEqual(started.status, 201, `a restricted caller may open a transaction (body ${JSON.stringify(startedBody)})`);
  const chunk = await call("transaction/chunk", { method: "POST", scope: restricted, body: { tx_id: txId, chunk_index: 0, chunk_hash: await transactionChunkHash([operation]), operations: [operation] } });
  const chunkBody = await chunk.json();
  assert(chunk.status >= 400, `a restricted caller must not stage a global operation (status ${chunk.status}, body ${JSON.stringify(chunkBody)})`);
  assert(!/property mapping not found/i.test(String(chunkBody.error || "")), `the staged refusal must be an authorization refusal, not a mapping diagnostic (body ${JSON.stringify(chunkBody)})`);
  assert(chunkBody.code !== "sync_conflict", `an unauthorized staged operation must not be reported as a write conflict (body ${JSON.stringify(chunkBody)})`);
  assertEqual(countRows("SELECT COUNT(*) AS n FROM business_staging_target WHERE account_id=? AND tx_id=?", ACCOUNT, txId), 0, "no global target may be staged");
  assertEqual(countRows("SELECT next_chunk_index AS n FROM business_staging_transaction WHERE account_id=? AND tx_id=?", ACCOUNT, txId), 0, "the chunk cursor must not advance on a denied chunk");
  assertEqual(storedRecord("Staff", STAFF_KEY, startedBody.generation_id).row_hash, before.row_hash, "the staging copy of the global record must be untouched");
  assertEqual((await call("transaction/abort", { method: "POST", scope: restricted, body: { tx_id: txId } })).status, 200, "the denied transaction must be abortable");
});

// ---------------------------------------------------------------------------
// 9 — DISCRIMINATOR, and the MESSAGE is the discriminator, not the status.
// Both directions 403 today, but with `property null is outside caller scope` /
// `property P_RRI1416 is outside caller scope` — String(null) stringification
// artifacts thrown by assertPropertyInScope (worker/scope.js:130-134) before the
// re-homing check in mutate (the `current.property_key` comparison that throws
// `record belongs to another property` in worker/business-sync.js) is ever
// reached. An
// assertion on the status code alone would pass for the wrong reason and would
// keep passing over a fix that never taught the scope check about global rows.
// ---------------------------------------------------------------------------
await run.check("neither direction of re-homing is allowed, and both say record belongs to another property", async () => {
  const expenseBefore = storedRecord("Expense", EXPENSE_KEY);
  const staffBefore = storedRecord("Staff", STAFF_KEY);
  assert(expenseBefore && staffBefore, "the re-homing fixtures are missing");
  const toGlobal = await call("mutate", { method: "POST", body: {
    mutation_id: "mutation_rehome_toglobal001",
    entity: "Expense",
    operation: "upsert",
    record_key: EXPENSE_KEY,
    property_key: GLOBAL_KEY,
    row: { ...EXPENSE_ROW, property_id: "" },
    base_row_hash: expenseBefore.row_hash,
  } });
  const toGlobalBody = await toGlobal.json();
  assertEqual(toGlobal.status, 403, `moving a property record to global must be refused (body ${JSON.stringify(toGlobalBody)})`);
  assertEqual(toGlobalBody.error, "record belongs to another property", `property -> global must not report a stringified null property (body ${JSON.stringify(toGlobalBody)})`);
  const toProperty = await call("mutate", { method: "POST", body: {
    mutation_id: "mutation_rehome_toproperty1",
    entity: "Staff",
    operation: "upsert",
    record_key: STAFF_KEY,
    property_key: PROPERTY_KEY,
    row: { ...STAFF_ROW, property_id: PROPERTY_ROW.id },
    base_row_hash: staffBefore.row_hash,
  } });
  const toPropertyBody = await toProperty.json();
  assertEqual(toProperty.status, 403, `moving a global record onto a property must be refused (body ${JSON.stringify(toPropertyBody)})`);
  assertEqual(toPropertyBody.error, "record belongs to another property", `global -> property must not report a stringified null property (body ${JSON.stringify(toPropertyBody)})`);
  assertEqual(storedRecord("Expense", EXPENSE_KEY).server_property_id, PROPERTY_ID, "the property record must stay on its property");
  assertEqual(storedRecord("Expense", EXPENSE_KEY).property_key, PROPERTY_KEY, "the property record's property_key must be unchanged");
  assertEqual(storedRecord("Staff", STAFF_KEY).server_property_id, null, "the global record must stay global");
  assertEqual(storedRecord("Staff", STAFF_KEY).property_key, GLOBAL_KEY, "the global record's property_key must be unchanged");
});

// ---------------------------------------------------------------------------
// 10 — NON-DISCRIMINATING SAFETY CHECK. `String(body.property_key || "")`
// coerces an absent key to `""`, and `"" !== "s:0:"`, so a missing key must NOT
// become global. Passes today; it exists to fail loudly if the fix keys global
// handling off falsiness instead of off the exact `s:0:` key.
// ---------------------------------------------------------------------------
await run.check("an omitted property_key is not treated as account-global", async () => {
  const absentKey = typedRecordKey("STF888");
  const response = await call("mutate", { method: "POST", body: {
    mutation_id: "mutation_missing_propkey001",
    entity: "Staff",
    operation: "upsert",
    record_key: absentKey,
    row: { id: "STF888", property_id: "", full_name: "No Property Key", position: "Unassigned" },
  } });
  const body = await response.json();
  assert(response.status !== 200, `an omitted property_key must never be accepted (body ${JSON.stringify(body)})`);
  assertEqual(response.status, 422, `an omitted property_key must be rejected 422 (body ${JSON.stringify(body)})`);
  assertEqual(storedRecord("Staff", absentKey), null, "no record may be created without a property_key");
});

// ---------------------------------------------------------------------------
// 11 — DISCRIMINATOR, and the highest-severity one. KILLS THE MUTATION that
// replaces the trailing `op.isGlobal` with `false` at the `presentGuard(...)`
// call inside uploadTransactionChunk.
//
// The transaction path has NO JavaScript `current` check — nothing like mutate's
// stored-row comparison. `requireGlobal` is therefore the ONLY thing forbidding
// staged re-homing: with requireGlobal=false and a NULL serverPropertyId the
// guard's `(? IS NULL OR server_property_id=?)` escape fires, the check degrades
// to row-hash-only, and `ON CONFLICT DO UPDATE SET
// server_property_id=excluded.server_property_id` silently re-homes a
// property-owned row to global inside the batch.
//
// The fixture needs nothing seeded: the active generation already holds the
// property-owned Expense, and base_row_hash is its REAL stored hash, so no
// staleness guard can be the reason for a refusal. The re-homing would land in
// the STAGING copy, so that is where the row is inspected — asserting only the
// active generation would pass under the mutation, because the guard rolls the
// whole batch back and abort deletes the staging rows. Status is asserted as
// not-200 rather than pinned, because that rollback surfaces through the regex
// in uploadTransactionChunk as 409 { code: 'sync_conflict' }.
// ---------------------------------------------------------------------------
await run.check("a staged global upsert cannot re-home a property-owned record", async () => {
  const before = storedRecord("Expense", EXPENSE_KEY);
  assert(before, "the property-scoped Expense is missing before the staged re-homing check");
  assertEqual(before.server_property_id, PROPERTY_ID, "the Expense must start out owned by the real property");
  const txId = "transaction_stage_rehome0001";
  const operation = {
    entity: "Expense",
    operation: "upsert",
    record_key: EXPENSE_KEY,                   // collides with the property-owned record
    property_key: GLOBAL_KEY,                  // but claims to be account-global
    row: { ...EXPENSE_ROW, property_id: "" },  // typedRecordKey("") === GLOBAL_KEY
    base_row_hash: before.row_hash,            // the REAL stored hash
  };
  const started = await call("transaction/start", { method: "POST", body: { tx_id: txId, request_hash: await hash(canonicalJson([operation])), expected_chunks: 1, operation_count: 1 } });
  const startedBody = await started.json();
  assertEqual(started.status, 201, `transaction/start (body ${JSON.stringify(startedBody)})`);
  const stagingGeneration = startedBody.generation_id;
  const chunk = await settle("transaction/chunk", { method: "POST", body: { tx_id: txId, chunk_index: 0, chunk_hash: await transactionChunkHash([operation]), operations: [operation] } });
  assert(chunk.status !== 200, `a staged global upsert onto a property-owned record must be refused (status ${chunk.status}, body ${JSON.stringify(chunk.body)})`);
  const staged = storedRecord("Expense", EXPENSE_KEY, stagingGeneration);
  assert(staged, `the staging copy of the Expense vanished from ${stagingGeneration}`);
  assertEqual(staged.server_property_id, PROPERTY_ID, "the staged Expense must keep its original non-NULL server_property_id");
  assertEqual(staged.property_key, PROPERTY_KEY, "the staged Expense must keep its original property_key");
  assertEqual(staged.row_hash, before.row_hash, "the staged Expense row must be byte-unchanged");
  assertEqual(countRows("SELECT COUNT(*) AS n FROM business_staging_target WHERE account_id=? AND tx_id=?", ACCOUNT, txId), 0, "no target may survive the rolled-back batch");
  const active = storedRecord("Expense", EXPENSE_KEY);
  assertEqual(active.server_property_id, PROPERTY_ID, "the active generation's Expense must be untouched");
  assertEqual(active.property_key, PROPERTY_KEY, "the active generation's Expense property_key must be untouched");
  assertEqual((await call("transaction/abort", { method: "POST", body: { tx_id: txId } })).status, 200, "the refused transaction must be abortable");
});

// ---------------------------------------------------------------------------
// 12 — DISCRIMINATOR. KILLS THE MUTATION that drops
// `|| String(current.property_key) !== propertyKey` from mutate's re-homing
// comparison. Check 9 survives that removal because in BOTH of its directions
// the server_property_ids also differ, so the id half alone catches them. The
// key half only bites when the stored row's property_key disagrees with the
// request while both sides sit on the SAME server_property_id.
//
// THE FIXTURE IS DIRECT SQL, DELIBERATELY, AND THE OBVIOUS FIXTURE DOES NOT
// EXIST: two business_property_map rows with different property_keys and the
// same server_property_id CANNOT be built, because worker/schema.sql declares
// UNIQUE (account_id, generation_id, server_property_id) on that table — the map
// is one-to-one per generation, and the second insert is refused with
// `UNIQUE constraint failed: business_property_map...` (Observed). What the key
// half actually defends is a business_record whose property_key has drifted from
// the map while its server_property_id still agrees: a stale local property
// reference. No production write path produces that drift, so the row is seeded
// directly in exactly the shape D1 would hold it. The assertion is about
// mutate's decision, not about how the row got there.
//
// The refusal is pinned to the exact message so it cannot be satisfied by an
// assertPropertyInScope artifact: the caller is unrestricted and the stored id is
// in scope, so `record belongs to another property` can only come from the
// re-homing comparison itself.
// ---------------------------------------------------------------------------
await run.check("a record whose property_key disagrees with the request cannot be re-keyed onto the same property", async () => {
  const generation = activeGeneration();
  const staleKey = typedRecordKey(2);
  assert(staleKey !== PROPERTY_KEY, "the stale key must differ from the mapped key");
  assertEqual(countRows("SELECT COUNT(*) AS n FROM business_property_map WHERE account_id=? AND generation_id=? AND property_key=?", ACCOUNT, generation, staleKey), 0, "the stale property_key must be unmapped");
  assertEqual(db.prepare("SELECT server_property_id FROM business_property_map WHERE account_id=? AND generation_id=? AND property_key=?").get(ACCOUNT, generation, PROPERTY_KEY)?.server_property_id, PROPERTY_ID, "the request's property_key must map to the property the stored row already sits on");
  const stored = { id: "STF777", property_id: PROPERTY_ROW.id, full_name: "Stale Reference", position: "Auditor" };
  const storedKey = typedRecordKey(stored.id);
  const rowJson = canonicalJson(stored);
  const rowHash = await hash(rowJson);
  db.prepare("INSERT INTO business_record (account_id,generation_id,entity_name,record_key,property_key,server_property_id,row_json,row_hash,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(ACCOUNT, generation, "Staff", storedKey, staleKey, PROPERTY_ID, rowJson, rowHash, new Date().toISOString());
  const response = await settle("mutate", { method: "POST", body: {
    mutation_id: "mutation_rekey_samepropid1",
    entity: "Staff",
    operation: "upsert",
    record_key: storedKey,
    property_key: PROPERTY_KEY,   // resolves to the SAME server_property_id the row already carries
    row: { ...stored, position: "Re-keyed" },
    base_row_hash: rowHash,       // the REAL stored hash, so no staleness guard can be the reason
  } });
  assertEqual(response.status, 403, `re-keying a record onto a different property_key must be refused (body ${JSON.stringify(response.body)})`);
  assertEqual(response.body.error, "record belongs to another property", `the refusal must come from the re-homing comparison (body ${JSON.stringify(response.body)})`);
  const after = storedRecord("Staff", storedKey, generation);
  assert(after, "the seeded record vanished");
  assertEqual(after.property_key, staleKey, "the stored property_key must be unchanged");
  assertEqual(after.server_property_id, PROPERTY_ID, "the stored server_property_id must be unchanged");
  assertEqual(after.row_hash, rowHash, "the refused write must not have changed the row");
});

// ---------------------------------------------------------------------------
// 13 — DISCRIMINATOR on the COMMIT-TIME revocation race. KILLS TWO MUTATIONS:
// relaxing the `:scope` SQL guard's `t.server_property_id <> ?` sentinel
// exclusion to `? IS NOT NULL`, and deleting the same exclusion
// (`String(row.server_property_id) === GLOBAL_STAGING_TARGET_ID ||`) from
// commitTransaction's JavaScript `targets.some(...)` fallback.
//
// Both clauses only bite when a user_property_access row literally NAMES the
// staging sentinel, and that grant FK-resolves to property(account_id,id)
// (worker/schema.sql), so it requires a property row whose id IS the sentinel to
// exist first — refused with `FOREIGN KEY constraint failed` otherwise
// (Observed). That hostile-but-constructible DB state is built here; it is what
// makes the exclusion load-bearing instead of decorative. The seeded grant is
// then asserted against the id the handler ACTUALLY stages, so renaming the
// sentinel makes this check fail loudly instead of passing vacuously.
//
// The caller stages while unrestricted and is downgraded to
// property_access_mode='specific' before commit, so its in-memory scope still
// says `all` and ONLY the database guards can refuse. The CONTROL commit at the
// end — the same downgraded caller, its granted REAL property — must SUCCEED:
// without it, any blanket authorization failure would satisfy the 403 above for
// the wrong reason.
// ---------------------------------------------------------------------------
await run.check("a caller downgraded mid-transaction cannot commit a global target even when granted the sentinel id", async () => {
  const SENTINEL_ID = "__account_global__";
  const RACER_EMAIL = "racer@test.local";
  db.prepare("INSERT INTO property (id,account_id,code,name,rooms,active,created_date) VALUES (?,?,?,?,?,?,?)")
    .run(SENTINEL_ID, ACCOUNT, "__ACCOUNT_GLOBAL__", "Hostile Sentinel Roster Row", null, 1, "2026-01-01");
  seedUser(db, { id: "racer", email: RACER_EMAIL, role: "manager", mode: "all", grants: [PROPERTY_ID, SENTINEL_ID] });
  db.prepare("UPDATE user SET permissions=? WHERE account_id=? AND id=?").run(JSON.stringify({ manual_entry: true }), ACCOUNT, "racer");
  const racerResolved = await resolveScope(env, { subject: "racer", email: RACER_EMAIL });
  assert(racerResolved.ok && racerResolved.scope.all, `the racer must resolve UNRESTRICTED before the downgrade (${JSON.stringify(racerResolved)})`);
  const racer = racerResolved.scope;

  const staffBefore = storedRecord("Staff", STAFF_KEY);
  const expenseBefore = storedRecord("Expense", EXPENSE_KEY);
  assert(staffBefore && expenseBefore, "the revocation-race fixtures are missing");
  const baseGeneration = activeGeneration();
  const globalTx = "transaction_revoked_global01";
  const controlTx = "transaction_revoked_control1";
  const globalOp = { entity: "Staff", operation: "upsert", record_key: STAFF_KEY, property_key: GLOBAL_KEY, row: { ...STAFF_ROW, position: "Committed After Revocation" }, base_row_hash: staffBefore.row_hash };
  const controlOp = { entity: "Expense", operation: "upsert", record_key: EXPENSE_KEY, property_key: PROPERTY_KEY, row: { ...EXPENSE_ROW, amount: 2222.22 }, base_row_hash: expenseBefore.row_hash };

  // Both transactions are staged from the SAME baseline, BEFORE the downgrade,
  // so neither can be refused later by the compare-and-swap guard.
  const stage = async (txId, operation) => {
    const started = await call("transaction/start", { method: "POST", scope: racer, body: { tx_id: txId, request_hash: await hash(canonicalJson([operation])), expected_chunks: 1, operation_count: 1 } });
    const startedBody = await started.json();
    assertEqual(started.status, 201, `${txId} transaction/start (body ${JSON.stringify(startedBody)})`);
    const chunk = await settle("transaction/chunk", { method: "POST", scope: racer, body: { tx_id: txId, chunk_index: 0, chunk_hash: await transactionChunkHash([operation]), operations: [operation] } });
    assertEqual(chunk.status, 200, `${txId} transaction/chunk must be accepted while the caller is still unrestricted (body ${JSON.stringify(chunk.body)})`);
    return startedBody.generation_id;
  };
  const globalStaging = await stage(globalTx, globalOp);
  const controlStaging = await stage(controlTx, controlOp);
  assertEqual(
    db.prepare("SELECT server_property_id FROM business_staging_target WHERE account_id=? AND tx_id=?").get(ACCOUNT, globalTx)?.server_property_id,
    SENTINEL_ID,
    "the staged global target must carry the exact id this fixture granted, or the grant proves nothing",
  );

  db.prepare("UPDATE user SET property_access_mode='specific' WHERE account_id=? AND id=?").run(ACCOUNT, "racer");
  const revoked = await settle("transaction/commit", { method: "POST", scope: racer, body: { tx_id: globalTx } });
  assertEqual(revoked.status, 403, `a downgraded caller must not commit a global target (body ${JSON.stringify(revoked.body)})`);
  assertEqual(revoked.body.code, "auth_scope_revoked", `the refusal must be classified as a revoked scope (body ${JSON.stringify(revoked.body)})`);
  assertEqual(activeGeneration(), baseGeneration, "the dataset pointer must not move");
  assertEqual(datasetStatus(globalStaging), "staging", "the refused staging generation must not become active");
  assertEqual(storedRecord("Staff", STAFF_KEY, baseGeneration).row_hash, staffBefore.row_hash, "the global record must be unchanged in the active generation");

  const control = await settle("transaction/commit", { method: "POST", scope: racer, body: { tx_id: controlTx } });
  assertEqual(control.status, 200, `the SAME downgraded caller must still commit its GRANTED property, or the 403 above proves nothing (body ${JSON.stringify(control.body)})`);
  assertEqual(activeGeneration(), controlStaging, "the granted-property commit must publish its generation");
});

// ---------------------------------------------------------------------------
// 14 — DISCRIMINATOR on the EMPTY/NULL property_key boundary. KILLS THE MUTATION
// that widens activation's skip from `if (isGlobalPropertyKey(key)) continue;` to
// `if (key === "" || isGlobalPropertyKey(key)) continue;`. Check 4 uses a GENUINE
// non-empty unmapped key (n:99), so it cannot reach this boundary at all.
//
// The ratified contract: typedRecordKey("") is "s:0:", NEVER "", so an empty
// property_key is an OMITTED FIELD, not a global record, and a SQL NULL
// property_key is invalid data. Both must be refused as orphans. One `key === ""`
// clause swallows BOTH, because activation normalises a NULL property_key to ""
// before testing it — which is exactly why both values are exercised here.
//
// THE KEY VALUE IS SEEDED BY DIRECT SQL, DELIBERATELY: the upload path cannot
// express either one. uploadChunk derives property_key through typedRecordKey,
// which returns only `n:<int>` or `s:<len>:<str>` and throws for anything else,
// and then refuses any mismatch against the client's declared key. Everything
// else runs through the REAL surface (start -> chunk -> activate), and the staged
// row's property_key is OVERWRITTEN IN PLACE rather than a row being added, so
// every manifest, chunk-hash and per-entity count reconciliation upstream still
// passes and the orphan check is provably the first reachable refusal.
// ---------------------------------------------------------------------------
await run.check("an empty or NULL staged property_key is an orphan, not an account-global record", async () => {
  const pointerBefore = activeGeneration();
  const attempt = async (label, expense, keyValue) => {
    const payload = await buildPayload([[["Property", PROPERTY_ROW], ["Expense", expense]]]);
    const started = await start(payload);
    assertEqual(started.response.status, 201, `${label}: migration/start (body ${JSON.stringify(started.body)})`);
    const generationId = started.body.generation_id;
    const uploaded = await upload(generationId, payload, 0);
    assertEqual(uploaded.response.status, 200, `${label}: migration/chunk (body ${JSON.stringify(uploaded.body)})`);
    const rewritten = db.prepare("UPDATE business_record SET property_key=? WHERE account_id=? AND generation_id=? AND entity_name='Expense'")
      .run(keyValue, ACCOUNT, generationId);
    assertEqual(Number(rewritten.changes), 1, `${label}: the fixture must rewrite exactly one staged property_key`);
    const activate = await settle("migration/activate", { method: "POST", body: { generation_id: generationId } });
    assertEqual(activate.status, 422, `${label} must be refused as an orphaned reference (body ${JSON.stringify(activate.body)})`);
    assert(/^orphaned property reference:/.test(String(activate.body.error)), `${label}: the refusal must name the orphan (body ${JSON.stringify(activate.body)})`);
    assertEqual(datasetStatus(generationId), "staging", `${label}: the generation must not become active`);
    assertEqual(activeGeneration(), pointerBefore, `${label}: the dataset pointer must not move`);
  };
  await attempt("an empty-string property_key", { id: 8801, property_id: PROPERTY_ROW.id, expense_name: "Empty Key", amount: 11.11 }, "");
  await attempt("a SQL NULL property_key", { id: 8802, property_id: PROPERTY_ROW.id, expense_name: "Null Key", amount: 22.22 }, null);
});

// ===========================================================================
// ADDITIVE BLOCK — checks 15-20 prove a SECOND defect in the SAME contract:
// the account-global sentinel is IN-BAND. GLOBAL_KEY is typedRecordKey(""), so a
// *Property* row whose own `id` is the empty string encodes to
// `record_key === "s:0:"` — the sentinel itself — and three admission sites take
// it for a real property:
//   * uploadChunk (15) stages it. It only compares the client's declared keys
//     against the ones it derives, and for a Property row it derives
//     `property_key` FROM `record_key`, so both sides agree on "s:0:".
//   * activateMigration (16, 17) then mints/reuses a roster property for it,
//     writes a business_property_map row keyed "s:0:", and runs
//     `UPDATE business_record SET server_property_id=? WHERE property_key=?`
//     with "s:0:" — RE-HOMING every genuinely account-global record in the
//     generation onto that property. The orphan loop cannot notice, because it
//     SKIPS "s:0:" as global before it ever consults `mappings`.
//   * mutate's Property branch (19) poisons the same map row directly, and the
//     Property DELETE branch (20) then deletes every record on the mapped
//     property plus the roster row itself.
// Check 18 states the consequence in the only terms that matter: what the REAL
// snapshot route hands a caller granted ONLY the real property.
//
// Both admission paths require scope.all, so this is NOT restricted-caller
// escalation. It is an unrestricted caller — or a client bug that drops an id —
// silently DOWNGRADING scope.all-only records into grantee-readable ones.
//
// Every check below reaches its assertion through the production surface
// (migration/start -> migration/chunk -> migration/activate, mutate, snapshot),
// and none depends on a helper, export or constant that does not exist today:
// the sentinel is the derived GLOBAL_KEY, re-pinned to the literal "s:0:" inside
// check 15 so this block is self-contained.
// ===========================================================================

// A Property row whose id is the EMPTY STRING. Same shape as the real roster row
// and the same `code`, so activation RESOLVES IT ONTO THE REAL PROPERTY the
// fixture manager is already granted — the shortest path from "one hotel lost its
// id in a client round-trip" to "every account-global record is now readable by a
// single-property manager". A and B differ only in `name` so their manifests
// differ and migration/start cannot dedupe the second onto the first.
const POISON_PROPERTY_A = { id: "", code: PROPERTY_CODE, name: "Poisoned Roster Row A", rooms: 120, active: true, created_date: "2026-01-01" };
const POISON_PROPERTY_B = { id: "", code: PROPERTY_CODE, name: "Poisoned Roster Row B", rooms: 120, active: true, created_date: "2026-01-01" };
// Genuinely account-global companions: property_id "" makes property_key "s:0:"
// WITHOUT the record itself being a Property. These must keep working.
const GLOBAL_STAFF_POISON = { id: "STF901", property_id: "", full_name: "Global Payroll Clerk", position: "Clerk" };
const GLOBAL_STAFF_CONTROL = { id: "STF902", property_id: "", full_name: "Global Benefits Clerk", position: "Clerk" };

let poisonGeneration = null;

// ---------------------------------------------------------------------------
// 15 — DISCRIMINATOR on the FIRST admission site. The chunk is built through the
// REAL manifest/hash path (buildPayload -> start -> upload), so every checksum,
// per-chunk hash and declared-key comparison upstream reconciles and the typed
// key check is provably the first thing that can refuse it. Pre-fix it is
// accepted 200 and the sentinel lands in business_record.
//
// The CONTROL in the same check is what stops an over-broad fix: the same chunk
// shape with a REAL Property row and a genuinely account-global Staff row must
// still upload, with the Staff row keeping property_key "s:0:" and a NULL
// server_property_id. A guard that refused every row whose property_key is the
// sentinel would kill the ratified account-global contract (checks 2, 5, 7) and
// is caught here directly.
// ---------------------------------------------------------------------------
await run.check("uploadChunk refuses a Property row whose id is the empty string, and still accepts account-global records", async () => {
  assertEqual(GLOBAL_KEY, "s:0:", "the sentinel this check attacks");
  const payload = await buildPayload([[["Property", POISON_PROPERTY_A], ["Staff", GLOBAL_STAFF_POISON]]]);
  const started = await start(payload);
  assertEqual(started.response.status, 201, `poisoned migration/start (body ${JSON.stringify(started.body)})`);
  const generationId = started.body.generation_id;
  const uploaded = await upload(generationId, payload, 0);
  const stagedProperty = storedRecord("Property", GLOBAL_KEY, generationId);
  assert(uploaded.response.status !== 200,
    `a Property row keyed by the account-global sentinel must never be staged (status ${uploaded.response.status}, staged ${JSON.stringify(stagedProperty)}, body ${JSON.stringify(uploaded.body)})`);
  assertEqual(uploaded.response.status, 422, `the refusal must be a 422 typed-key rejection (body ${JSON.stringify(uploaded.body)})`);
  assertEqual(countRows("SELECT COUNT(*) AS n FROM business_record WHERE account_id=? AND generation_id=?", ACCOUNT, generationId), 0,
    "the refused chunk must stage NOTHING, not merely drop the offending row");
  assertEqual(countRows("SELECT COUNT(*) AS n FROM business_migration_chunk WHERE account_id=? AND generation_id=?", ACCOUNT, generationId), 0,
    "the refused chunk must not be receipted");

  const control = await buildPayload([[["Property", PROPERTY_ROW], ["Staff", GLOBAL_STAFF_CONTROL]]]);
  const controlStarted = await start(control);
  assertEqual(controlStarted.response.status, 201, `control migration/start (body ${JSON.stringify(controlStarted.body)})`);
  const controlGeneration = controlStarted.body.generation_id;
  const controlUpload = await upload(controlGeneration, control, 0);
  assertEqual(controlUpload.response.status, 200,
    `a real Property row alongside an account-global Staff row must still upload, or the refusal above proves only that ingestion is broken (body ${JSON.stringify(controlUpload.body)})`);
  const controlStaff = storedRecord("Staff", typedRecordKey(GLOBAL_STAFF_CONTROL.id), controlGeneration);
  assert(controlStaff, "the account-global Staff row was not staged by the control upload");
  assertEqual(controlStaff.property_key, GLOBAL_KEY, "the control Staff row must still be staged as account-global");
  assertEqual(controlStaff.server_property_id, null, "the control Staff row must still be staged with a NULL server_property_id");
  assert(storedRecord("Property", PROPERTY_KEY, controlGeneration), "the real Property row was not staged by the control upload");
});

// ---------------------------------------------------------------------------
// 16 — DISCRIMINATOR on the SECOND admission site, and the ONLY defence for a
// generation that is ALREADY STAGED on the server. Check 15's gate cannot help
// here: the rows are in D1 before the fix ships.
//
// THE FIXTURE STAGES THE SAME BYTES BY EITHER ROUTE, DELIBERATELY. It first
// offers the poisoned chunk to the REAL upload path; if that path now refuses it
// (check 15's gate), it inserts exactly the rows uploadChunk would have written —
// same record_key, same property_key, same row_json, same row_hash, NULL
// server_property_id — plus the chunk receipt carrying the manifest's own hash
// and count. Activation's four reconciliations (chunk count, per-chunk hash,
// total records, per-entity counts) therefore all pass, so the sentinel check is
// provably the first reachable refusal, and the check proves gate (3) whether or
// not gate (1) exists.
//
// The message text is deliberately NOT pinned: a 422 that names the sentinel and
// a 422 that reuses the orphan wording are both correct refusals, and pinning the
// string would test the implementer's prose instead of the contract. What IS
// pinned is that it is not a 200, not a `sync_conflict` (which would tell the
// client "someone else won" about data the server simply must not accept), that
// the generation stays staging, and that the pointer does not move.
// ---------------------------------------------------------------------------
await run.check("activateMigration refuses a generation whose roster contains a Property keyed s:0:", async () => {
  const pointerBefore = activeGeneration();
  const payload = await buildPayload([[["Property", POISON_PROPERTY_B], ["Staff", STAFF_ROW]]]);
  const started = await start(payload);
  assertEqual(started.response.status, 201, `already-staged migration/start (body ${JSON.stringify(started.body)})`);
  poisonGeneration = started.body.generation_id;
  const uploaded = await upload(poisonGeneration, payload, 0);
  if (uploaded.response.status !== 200) {
    const now = new Date().toISOString();
    for (const item of payload.chunks[0]) {
      db.prepare("INSERT INTO business_record (account_id,generation_id,entity_name,record_key,property_key,server_property_id,row_json,row_hash,updated_at) VALUES (?,?,?,?,?,NULL,?,?,?)")
        .run(ACCOUNT, poisonGeneration, item.entity, item.record_key, item.property_key, canonicalJson(item.row), item.row_hash, now);
    }
    db.prepare("INSERT INTO business_migration_chunk (account_id,generation_id,chunk_index,chunk_hash,record_count,received_at) VALUES (?,?,?,?,?,?)")
      .run(ACCOUNT, poisonGeneration, 0, payload.descriptors[0].hash, payload.chunks[0].length, now);
  }
  const stagedProperty = storedRecord("Property", GLOBAL_KEY, poisonGeneration);
  assert(stagedProperty, `the fixture failed to stage a Property row keyed ${GLOBAL_KEY} in ${poisonGeneration}`);
  const stagedStaff = storedRecord("Staff", STAFF_KEY, poisonGeneration);
  assert(stagedStaff, "the fixture failed to stage the account-global Staff row");
  assertEqual(stagedStaff.property_key, GLOBAL_KEY, "the staged Staff row must be account-global before activation");
  assertEqual(stagedStaff.server_property_id, null, "the staged Staff row must have a NULL server_property_id before activation");

  const activate = await settle("migration/activate", { method: "POST", body: { generation_id: poisonGeneration } });
  const rehomed = storedRecord("Staff", STAFF_KEY, poisonGeneration);
  const sentinelMappings = countRows("SELECT COUNT(*) AS n FROM business_property_map WHERE account_id=? AND generation_id=? AND property_key=?", ACCOUNT, poisonGeneration, GLOBAL_KEY);
  assert(activate.status !== 200,
    `activation must refuse a roster carrying the account-global sentinel (status ${activate.status}, sentinel mappings ${sentinelMappings}, account-global Staff now ${JSON.stringify(rehomed)}, body ${JSON.stringify(activate.body)})`);
  assertEqual(activate.status, 422, `the refusal must be a 422 (body ${JSON.stringify(activate.body)})`);
  assert(activate.body.code !== "sync_conflict", `a server that must not accept this data must not report a write conflict (body ${JSON.stringify(activate.body)})`);
  assertEqual(datasetStatus(poisonGeneration), "staging", "the refused generation must not become active");
  assertEqual(activeGeneration(), pointerBefore, "the dataset pointer must not move");
});

// ---------------------------------------------------------------------------
// 17 — THE LOAD-BEARING HALF OF 16. A refusal that still ran the mapping loop
// first, or a "fix" that dropped the sentinel row and carried on, would satisfy
// 16's status assertion and fail here. These are the three destructive effects
// the mapping loop has, in the order it performs them:
//   * a business_property_map row keyed by the sentinel (the in-band collision
//     made durable — and business_property_map.server_property_id is NOT NULL,
//     so such a row can only ever point at a REAL property);
//   * `UPDATE business_record SET server_property_id=? WHERE property_key='s:0:'`
//     re-homing every account-global record in the generation;
//   * `INSERT INTO property ... ON CONFLICT(account_id,code) DO UPDATE SET
//     name=excluded.name,...` rewriting the REAL roster row from the poisoned
//     row's fields, because the poisoned row carries the real property's code.
// ---------------------------------------------------------------------------
await run.check("the refused activation minted no sentinel mapping and re-homed no account-global record", () => {
  assert(poisonGeneration, "check 16 never staged a poisoned generation");
  assertEqual(countRows("SELECT COUNT(*) AS n FROM business_property_map WHERE account_id=? AND generation_id=? AND property_key=?", ACCOUNT, poisonGeneration, GLOBAL_KEY), 0,
    "no business_property_map row may be keyed by the account-global sentinel");
  const staff = storedRecord("Staff", STAFF_KEY, poisonGeneration);
  assert(staff, "the staged account-global Staff row vanished");
  assertEqual(staff.server_property_id, null, "the staged account-global Staff row must still have a NULL server_property_id");
  assertEqual(staff.property_key, GLOBAL_KEY, "the staged account-global Staff row must still be keyed account-global");
  const sentinelRecord = storedRecord("Property", GLOBAL_KEY, poisonGeneration);
  assert(sentinelRecord, "the staged sentinel Property row vanished, so this check can no longer prove anything");
  assertEqual(sentinelRecord.server_property_id, null, "the sentinel Property row must not have been resolved to a real property id");
  const roster = db.prepare("SELECT name,code FROM property WHERE account_id=? AND id=?").get(ACCOUNT, PROPERTY_ID) ?? null;
  assert(roster, "the real roster property vanished");
  assertEqual(roster.name, PROPERTY_ROW.name, "the poisoned roster row must not have rewritten the real property's name");
  assertEqual(roster.code, PROPERTY_CODE, "the poisoned roster row must not have rewritten the real property's code");
  const activeStaff = storedRecord("Staff", STAFF_KEY);
  assert(activeStaff, "the ACTIVE generation's account-global Staff row vanished");
  assertEqual(activeStaff.server_property_id, null, "the ACTIVE generation's account-global Staff row must still be unrestricted-only");
});

// ---------------------------------------------------------------------------
// 18 — THE CONSEQUENCE, stated as the REAL snapshot route states it. Asserting on
// business_record directly would prove storage; this proves DISCLOSURE. Pre-fix,
// activation re-homes the account-global Staff row onto the very property the
// fixture manager was granted and publishes that generation, so the manager's own
// snapshot returns it — an unrestricted-only record handed to a grantee.
//
// Membership, not counts: the active generation also holds STF777 (seeded by
// check 12 on the real property), which the manager is legitimately entitled to
// see, and the owner sees both. Only STAFF_KEY is the account-global row.
//
// The owner assertion is the anti-vacuity control: without it, "the manager sees
// nothing" would also be satisfied by the row having been destroyed. The Expense
// assertion is the second control: the manager's own property data must still be
// readable, so a blanket read failure cannot masquerade as isolation.
// ---------------------------------------------------------------------------
await run.check("a caller granted only the real property still cannot read the account-global Staff row", async () => {
  const restrictedStaff = await (await call("snapshot?entity=Staff&limit=50", { scope: restricted })).json();
  const restrictedKeys = (restrictedStaff.items || []).map((item) => item.record_key);
  assert(!restrictedKeys.includes(STAFF_KEY),
    `a caller granted only ${PROPERTY_ID} must never be handed the account-global record ${STAFF_KEY} (keys ${JSON.stringify(restrictedKeys)})`);
  const ownerStaff = await (await call("snapshot?entity=Staff&limit=50")).json();
  const ownerKeys = (ownerStaff.items || []).map((item) => item.record_key);
  assert(ownerKeys.includes(STAFF_KEY),
    `an unrestricted caller must still read ${STAFF_KEY}, or the restriction above proves only that the record is gone (keys ${JSON.stringify(ownerKeys)})`);
  const restrictedExpense = await (await call("snapshot?entity=Expense&limit=50", { scope: restricted })).json();
  assertEqual((restrictedExpense.items || []).length, 1,
    `the restricted caller must still read its own property's Expense (items ${JSON.stringify(restrictedExpense.items)})`);
  assertEqual(restrictedExpense.items[0].record_key, EXPENSE_KEY, "the visible Expense must be the property-scoped one");
});

// ---------------------------------------------------------------------------
// 19 — DISCRIMINATOR on the THIRD admission site. mutate's Property branch
// validates only `typedRecordKey(row.id) !== recordKey`, which a row with
// `id: ""` satisfies, and then writes the same poisoned business_property_map row
// activation would have written — no migration required, one request.
//
// The `code` is deliberately one no roster row and no mapping owns
// (SENTINEL_MUTATE_CODE), so nothing upstream of the missing gate can refuse it:
// with a colliding code the branch would answer `409 property code is already
// mapped` and the check would pass for a reason that has nothing to do with the
// sentinel. base_row_hash is supplied only when a sentinel Property record is
// actually stored, so the request reaches the gate as a create or an update
// depending on the state the earlier checks left behind — never as a 409.
//
// The CONTROL kills the cheap fix: a legitimate Property upsert must still be
// accepted and must still map its own key, so "reject Property upserts" cannot
// pass this check.
// ---------------------------------------------------------------------------
const SENTINEL_MUTATE_CODE = "SENTINEL9";
await run.check("mutate refuses a Property upsert keyed s:0: and still accepts a real Property", async () => {
  const generation = activeGeneration();
  assert(generation, "no active generation to mutate");
  const stored = storedRecord("Property", GLOBAL_KEY, generation);
  const body = {
    mutation_id: "mutation_property_sentinel1",
    entity: "Property",
    operation: "upsert",
    record_key: GLOBAL_KEY,
    property_key: GLOBAL_KEY,
    row: { id: "", code: SENTINEL_MUTATE_CODE, name: "Sentinel Roster Upsert", rooms: 10, active: true, created_date: "2026-01-01" },
  };
  if (stored) body.base_row_hash = stored.row_hash;
  const response = await settle("mutate", { method: "POST", body });
  const sentinelMappings = countRows("SELECT COUNT(*) AS n FROM business_property_map WHERE account_id=? AND generation_id=? AND property_key=?", ACCOUNT, generation, GLOBAL_KEY);
  assert(response.status !== 200,
    `a Property upsert keyed by the account-global sentinel must never be accepted (sentinel mappings ${sentinelMappings}, body ${JSON.stringify(response.body)})`);
  assertEqual(response.status, 422, `the refusal must be a 422 (body ${JSON.stringify(response.body)})`);
  assertEqual(sentinelMappings, 0, "no business_property_map row may be keyed by the account-global sentinel");
  assertEqual(countRows("SELECT COUNT(*) AS n FROM property WHERE account_id=? AND lower(code)=lower(?)", ACCOUNT, SENTINEL_MUTATE_CODE), 0,
    "no roster property may be minted for the account-global sentinel");
  assertEqual(JSON.stringify(storedRecord("Property", GLOBAL_KEY, generation)), JSON.stringify(stored),
    "the refused upsert must leave the stored Property state exactly as it was");

  const controlRow = { id: 2, code: "CONTROL1", name: "Control Property", rooms: 50, active: true, created_date: "2026-01-01" };
  const controlKey = typedRecordKey(controlRow.id);
  const control = await settle("mutate", { method: "POST", body: {
    mutation_id: "mutation_property_control001",
    entity: "Property",
    operation: "upsert",
    record_key: controlKey,
    property_key: controlKey,
    row: controlRow,
  } });
  assertEqual(control.status, 200,
    `a legitimate Property upsert must still be accepted, or the refusal above proves only that the roster is broken (body ${JSON.stringify(control.body)})`);
  assertEqual(countRows("SELECT COUNT(*) AS n FROM business_property_map WHERE account_id=? AND generation_id=? AND property_key=?", ACCOUNT, generation, controlKey), 1,
    "the legitimate Property upsert must map its own key");
});

// ---------------------------------------------------------------------------
// 20 — THE WORST BRANCH, and the reason gate (2) must sit above the operation
// split rather than inside the upsert arm. Once ANY sentinel-keyed mapping row
// exists, a Property DELETE keyed "s:0:" resolves it to a REAL property and runs
//   DELETE FROM business_record ... WHERE server_property_id=<that property>
//   DELETE FROM property        ... WHERE id=<that property>
// which also cascades user_property_access (worker/schema.sql FK ON DELETE
// CASCADE) — the account loses a hotel, its business rows and its grants because
// one client row lost its id.
//
// THE STATUS CODE IS DELIBERATELY NOT PINNED. Whether this branch answers 422
// (gate above the dispatch), 409 (the revision guard fires first because no
// sentinel Property record exists once gates 1-3 hold) or 404 (no mapping) is a
// placement detail, not a contract: all three are refusals that destroy nothing.
// Pinning one would test where the implementer put the gate. What is pinned is
// that it is never accepted and that nothing is destroyed.
// ---------------------------------------------------------------------------
await run.check("mutate refuses a Property delete keyed s:0: and destroys neither the roster nor its records", async () => {
  const generation = activeGeneration();
  assertEqual(countRows("SELECT COUNT(*) AS n FROM property WHERE account_id=? AND id=?", ACCOUNT, PROPERTY_ID), 1,
    "fixture: the real roster property must exist before the delete attempt");
  const grantsBefore = countRows("SELECT COUNT(*) AS n FROM user_property_access WHERE account_id=? AND property_id=?", ACCOUNT, PROPERTY_ID);
  assert(grantsBefore >= 1, "fixture: the restricted caller's grant on the real property must exist before the delete attempt");
  const stored = storedRecord("Property", GLOBAL_KEY, generation);
  const response = await settle("mutate", { method: "POST", body: {
    mutation_id: "mutation_property_sentineldel",
    entity: "Property",
    operation: "delete",
    record_key: GLOBAL_KEY,
    property_key: GLOBAL_KEY,
    base_row_hash: stored ? stored.row_hash : await hash("no sentinel property record is stored"),
  } });
  const rosterAfter = countRows("SELECT COUNT(*) AS n FROM property WHERE account_id=? AND id=?", ACCOUNT, PROPERTY_ID);
  const grantsAfter = countRows("SELECT COUNT(*) AS n FROM user_property_access WHERE account_id=? AND property_id=?", ACCOUNT, PROPERTY_ID);
  assert(response.status !== 200,
    `a Property delete keyed by the account-global sentinel must never be accepted (roster rows for ${PROPERTY_ID} left ${rosterAfter}, grants left ${grantsAfter}, body ${JSON.stringify(response.body)})`);
  assert(response.status >= 400, `the delete must be refused, not silently ignored (status ${response.status}, body ${JSON.stringify(response.body)})`);
  assertEqual(rosterAfter, 1, "the real roster property must survive a sentinel-keyed delete");
  assertEqual(grantsAfter, grantsBefore, "the grants on the real roster property must survive a sentinel-keyed delete");
  assert(storedRecord("Staff", STAFF_KEY, generation), "the account-global Staff row must survive a sentinel-keyed delete");
  assert(storedRecord("Expense", EXPENSE_KEY, generation), "the property-scoped Expense must survive a sentinel-keyed delete");
});

run.done();
if (process.exitCode) process.exit(1);
console.log("PASSED: an account-global business record activates, is readable and writable by an unrestricted caller, is invisible and unwritable to a restricted caller, and can never be re-homed.");
