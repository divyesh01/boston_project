// scripts/probe-worker-entities-roster-create.mjs — INDEPENDENT adversarial proof
// of the WRITE-CONFIRMATION contract in worker/entities.js `createRows`. Owned by
// Agent C (independent-tester). worker/entities.js had ZERO test coverage before
// this file.
//
// THE GOVERNING CONTRACT UNDER TEST:
//   "A write must be confirmed under the same authority and by the same key the
//    INSERT bound — never through the caller's read-authorization predicate."
//
// THE DEFECT: createRows (worker/entities.js:192-223) INSERTs via
// env.DB.batch(...) at :215, then confirms at :218 with
// findScoped(env, contract, scope, item.id). findScoped (:175-178) builds its
// predicate from scopeConstraint(scope, contract.scopeColumn). For the Property
// contract (:19, the ONLY `roster: true` contract, scopeColumn "id") that
// predicate is `inClause("id", scope.propertyIds)` — and scope.propertyIds is a
// snapshot materialized in worker/scope.js:96 BEFORE the insert. A brand-new id
// can therefore never satisfy it, so :219 raises
// EntityRequestError("created row was not readable", 500) while the row HAS
// landed in D1. scope.js:118-120 does not short-circuit on scope.all, so
// owner/all-mode callers hit it too, and db.js:76-82 returns `1 = 0` for an empty
// set, so an account with zero properties 500s on its very first create.
// Severity is RESPONSE TRUTHFULNESS, not data availability: scope re-resolves per
// request, so the row appears on the next call.
//
// HARNESS RULES OBEYED HERE (both are load-bearing):
//   * NO guard reads batch() result metadata. scripts/_worker-testkit.mjs:115
//     returns node:sqlite's {changes,lastInsertRowid} while real Cloudflare D1
//     returns {success, meta:{changes,…}} — anything asserting on that shape
//     would be green here and undefined in production. Every row effect below is
//     verified by a direct SELECT against the sqlite fixture.
//   * Every guard carries an explicit PRECONDITION assertion, so it cannot pass
//     because a fixture was missing or a request never executed.
//
// Requests go through worker/index.js (real router, real Access JWT validation,
// real resolveScope) so the pre-insert snapshot that CAUSES the defect is
// materialized by production code, not fabricated by the test.
//
// Run: node scripts/probe-worker-entities-roster-create.mjs (non-zero on ANY failure)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import worker from "../worker/index.js";
import { ENTITY_CONTRACT, handleEntityRequest } from "../worker/entities.js";
import {
  makeDb,
  makeEnv,
  makeInstrumentedEnv,
  seedProperties,
  seedUser,
  generateRsaKey,
  makeJwks,
  makeJwksFetch,
  signRs256,
  makeRunner,
  assert,
  assertEqual,
} from "./_worker-testkit.mjs";

const r = makeRunner("probe-worker-entities-roster-create");

// ---------------------------------------------------------------------------
// Synthetic Cloudflare Access wiring (same shape probe-shared-property-contract
// uses): a real RSA keypair, a synthetic JWKS served through env.FETCH, and JWTs
// signed here — so worker/auth.js runs REAL signature verification.
// ---------------------------------------------------------------------------
const AUD = "aud-roster-create";
const TEAM = "team.cloudflareaccess.com";
const ISS = `https://${TEAM}`;
const CERTS_URL = "https://synthetic.jwks/roster-create";
const CTX = { waitUntil() {}, passThroughOnException() {} };
const key = await generateRsaKey("kid-roster-create");
const { fetchImpl } = makeJwksFetch(makeJwks(key.publicJwk));
const ACCESS = {
  ACCESS_AUD: AUD,
  ACCESS_TEAM_DOMAIN: TEAM,
  ACCESS_CERTS_URL: CERTS_URL,
  FETCH: fetchImpl,
};

const OWNER = "owner@hotel.test";
const MGR = "mgr@hotel.test";
const D1_PARAMS_PER_STATEMENT = 100; // D1 hard bound-parameter ceiling per statement

async function tokenFor(email) {
  return signRs256({
    privateKey: key.privateKey,
    kid: "kid-roster-create",
    payload: { aud: AUD, iss: ISS, exp: Math.floor(Date.now() / 1000) + 3600, email, sub: `sub-${email}` },
  });
}

async function api(env, email, path, init = {}) {
  const token = await tokenFor(email);
  const headers = {
    "Cf-Access-Jwt-Assertion": token,
    "X-Requested-With": "XMLHttpRequest",
    "content-type": "application/json",
    ...(init.headers || {}),
  };
  return worker.fetch(new Request(`https://api.test${path}`, { ...init, headers }), env, CTX);
}

/** POST JSON through the REAL router and return { status, body }. */
async function post(env, email, path, body) {
  const res = await api(env, email, path, { method: "POST", body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

// ---------------------------------------------------------------------------
// Fixtures. Account A_1 owns P_A (RRI-BOS / "Boston Downtown" / 120 rooms) and
// P_B (RRI-CAM), seeded by the shared testkit. `owner-1` is all-mode; `mgr-1` is
// a 'specific' manager granted P_A only, with the permissions mayMutate() needs
// for a NON-roster write, so a 403 from that caller proves a SCOPE denial rather
// than a role denial.
// ---------------------------------------------------------------------------
function baseDb() {
  const db = makeDb();
  seedProperties(db);
  seedUser(db, { id: "owner-1", email: OWNER, role: "owner", mode: "all" });
  seedUser(db, { id: "mgr-1", email: MGR, role: "manager", mode: "specific", grants: ["P_A"] });
  db.prepare("UPDATE user SET permissions = ? WHERE id = ?")
    .run(JSON.stringify({ manual_entry: true }), "mgr-1");
  return db;
}

/** A db + env pair for the plain (uninstrumented) fixture. */
function base(extra = {}) {
  const db = baseDb();
  return { db, env: makeEnv(db, { ...ACCESS, ...extra }) };
}

/** Insert an account row with NO properties (the bootstrap case). */
function emptyAccountDb(accountId, email) {
  const db = makeDb();
  db.prepare("INSERT INTO account (id, name, created_date) VALUES (?,?,?)")
    .run(accountId, `Account ${accountId}`, "2026-01-01");
  seedUser(db, { id: `owner-${accountId}`, email, role: "owner", mode: "all", accountId });
  return db;
}

const INSERT_PROPERTY =
  "INSERT INTO property (id, account_id, code, name, rooms, active, created_date) VALUES (?,?,?,?,?,?,?)";

/** Every property row carrying `code`, across ALL accounts (leak detection). */
const propsByCode = (db, code) =>
  db.prepare("SELECT id, account_id, code, name FROM property WHERE code = ? ORDER BY id").all(code);
const propById = (db, id) => db.prepare("SELECT * FROM property WHERE id = ?").get(id);
const propCount = (db) => db.prepare("SELECT COUNT(*) c FROM property").get().c;
const occCount = (db) => db.prepare("SELECT COUNT(*) c FROM occupancy_day").get().c;

// ===========================================================================
// GUARD 01 + GUARD 02 — the headline defect, and the fact that the 500 LIES.
// One request serves both: guard 01 pins the response, guard 02 pins that the row
// is on disk AND that the response says 201. Asserting the landed row ALONE would
// already be green today (the row lands), which is exactly why guard 02 asserts
// the landed row TOGETHER with the 201: it can only go green when the response
// stops lying about a write that succeeded.
// ===========================================================================
/** @type {{ status: number, body: any, db: any } | null} */
let g1 = null;

await r.check("GUARD 01 RED: owner all-mode POST /api/entities/Property with an unused code => 201 with the requested code and a non-empty id", async () => {
  const { db, env } = base();
  // PRECONDITION (non-vacuity): the code is genuinely unused, the caller's
  // pre-insert snapshot is genuinely NON-empty (so this is not the empty-set
  // `1 = 0` case guard 03 covers), and the caller is genuinely provisioned.
  assertEqual(propsByCode(db, "HOTEL_C").length, 0, "precondition: HOTEL_C is unused");
  assertEqual(propCount(db), 2, "precondition: the account already owns 2 properties (non-empty snapshot)");
  const out = await post(env, OWNER, "/api/entities/Property", { data: { code: "HOTEL_C", name: "Hotel C", rooms: 10 } });
  g1 = { ...out, db };
  assertEqual(out.status, 201, `roster create must be a truthful 201, got ${out.status} ${JSON.stringify(out.body)}`);
  assertEqual(out.body.code, "HOTEL_C", `the response must describe the row that was created, got ${JSON.stringify(out.body)}`);
  assert(typeof out.body.id === "string" && out.body.id.length > 0, `the response must carry the server-issued id, got ${JSON.stringify(out.body)}`);
});

await r.check("GUARD 02 RED: the created roster row IS on disk under the caller's account AND the response said 201 (the 500 is a lie about a write that landed)", async () => {
  // PRECONDITION (non-vacuity): guard 01's request must actually have run.
  assert(g1 !== null, "precondition: guard 01 executed its request");
  const landed = propsByCode(g1.db, "HOTEL_C");
  // DIAGNOSTIC, printed either way: this is the row-landed truth.
  console.log(`        [diagnostic] response status ${g1.status}; rows on disk for HOTEL_C: ${JSON.stringify(landed)}`);
  assertEqual(landed.length, 1, "exactly one HOTEL_C row must exist on disk");
  assertEqual(landed[0].account_id, "A_1", "the landed row belongs to the caller's account");
  assertEqual(landed[0].name, "Hotel C", "the landed row carries the requested name");
  // THE CONJUNCTION is the whole point: row present AND response truthful.
  assertEqual(g1.status, 201, `the row landed, so the response must not be a 500; got ${g1.status} ${JSON.stringify(g1.body)}`);
  assertEqual(landed[0].id, g1.body.id, "the id the response returned must be the id that is on disk (no invented or echoed id)");
});

// ===========================================================================
// GUARD 03 — THE BOOTSTRAP CASE. An account with ZERO properties has an EMPTY
// snapshot, and db.js:76-82 turns that into `1 = 0`, so the read-authorization
// predicate matches nothing at all. A fix that merely appended the new id to the
// snapshot, or that leaned on the snapshot being non-empty, still fails here.
// ===========================================================================
await r.check("GUARD 03 RED: an account with ZERO properties can create its FIRST property (empty snapshot => inClause yields `1 = 0`)", async () => {
  const db = emptyAccountDb("A_EMPTY", "empty@hotel.test");
  const env = makeEnv(db, ACCESS);
  // PRECONDITION (non-vacuity): the account owns nothing, so the snapshot really
  // is empty; and the user IS provisioned, so a 403 here would be a real failure
  // rather than a missing fixture.
  assertEqual(propCount(db), 0, "precondition: the account owns ZERO properties (empty snapshot)");
  assert(db.prepare("SELECT id FROM user WHERE lower(email) = lower(?)").get("empty@hotel.test"), "precondition: the caller is provisioned");
  const out = await post(env, "empty@hotel.test", "/api/entities/Property", { data: { code: "FIRST", name: "First Hotel" } });
  console.log(`        [diagnostic] bootstrap create status ${out.status}; rows on disk: ${JSON.stringify(propsByCode(db, "FIRST"))}`);
  assertEqual(out.status, 201, `the first property of an account must be creatable, got ${out.status} ${JSON.stringify(out.body)}`);
  const landed = propsByCode(db, "FIRST");
  assertEqual(landed.length, 1, "the first property is on disk");
  assertEqual(landed[0].account_id, "A_EMPTY", "under the bootstrapping account");
  assertEqual(landed[0].id, out.body.id, "the response id is the on-disk id");
});

// ===========================================================================
// GUARD 04 — PIN (green today, must STAY green). The NON-ROSTER create path.
// OccupancyDay and TransactionLine both carry property_id (scopeColumn
// "property_id"), so their confirmation predicate already matches an in-scope
// row today. Any fix that narrows the roster confirmation must not disturb this.
//
// FIXTURE NOTE (OBSERVED, adjacent to the defect under test): the
// TransactionLine payload MUST carry `dedupe_key`. worker/schema.sql:256 declares
// `dedupe_key TEXT NOT NULL UNIQUE`, createRows (:211) binds ONLY the columns the
// caller supplied, and the INSERT is `INSERT OR IGNORE` (:212) — which suppresses
// a NOT NULL violation as `changes: 0` with NO error. Omitting dedupe_key
// therefore lands ZERO rows and the confirmation at :218 correctly finds nothing,
// producing the SAME 500 "created row was not readable" as the roster defect from
// a completely different cause (a real lost write, not a false negative). Keeping
// dedupe_key here is what makes this guard exercise the confirmation predicate
// instead of that unrelated silent-suppression path.
// ===========================================================================
await r.check("GUARD 04 PIN: non-roster create into an IN-SCOPE property => 201 and the row reads back through the API and on disk", async () => {
  const { db, env } = base();
  for (const [entity, data, table] of [
    ["OccupancyDay", { property_id: "P_A", date: "2026-03-01", rooms_sold: 10 }, "occupancy_day"],
    ["TransactionLine", { property_id: "P_B", date: "2026-03-01", folio_number: "F-1", amount: 199.99, dedupe_key: "DK-G04" }, "transaction_line"],
  ]) {
    // PRECONDITION (non-vacuity): the target property exists and is in scope.
    assert(propById(db, data.property_id), `precondition: ${data.property_id} exists`);
    const out = await post(env, OWNER, `/api/entities/${entity}`, { data });
    assertEqual(out.status, 201, `${entity} create must succeed, got ${out.status} ${JSON.stringify(out.body)}`);
    assert(typeof out.body.id === "string" && out.body.id.length > 0, `${entity}: response carries the server id`);
    assertEqual(out.body.property_id, data.property_id, `${entity}: response names the requested property`);
    // Direct SQL — never batch() metadata.
    const row = db.prepare(`SELECT id, property_id FROM ${table} WHERE id = ?`).get(out.body.id);
    assert(row, `${entity}: the row is on disk under the returned id`);
    assertEqual(row.property_id, data.property_id, `${entity}: on disk under the requested property`);
    // And it reads back through the API's own GET-by-id (findScoped as a READ).
    const read = await api(env, OWNER, `/api/entities/${entity}/${encodeURIComponent(out.body.id)}`);
    assertEqual(read.status, 200, `${entity}: the created row must read back, got ${read.status}`);
    assertEqual((await read.json()).id, out.body.id, `${entity}: the read-back row is the created row`);
  }
});

// ===========================================================================
// GUARD 05 — PIN. assertPropertyInScope (:204) must keep refusing a non-roster
// write aimed at a property outside the caller's scope, and NOTHING may land.
// The POSITIVE CONTROL is what makes the 403 non-vacuous: the SAME caller must
// succeed against its OWN property, so the denial provably comes from the scope
// check and not from mayMutate() or a broken fixture.
// ===========================================================================
await r.check("GUARD 05 PIN: non-roster create naming a property OUTSIDE the caller's scope => 403 and NOTHING lands (positive control: the same caller succeeds in-scope)", async () => {
  const { db, env } = base();
  // PRECONDITION / POSITIVE CONTROL: mgr-1 is granted P_A only and CAN write there.
  const ok = await post(env, MGR, "/api/entities/OccupancyDay", { data: { property_id: "P_A", date: "2026-03-02", rooms_sold: 11 } });
  assertEqual(ok.status, 201, `positive control: the restricted caller must succeed on its OWN property, got ${ok.status} ${JSON.stringify(ok.body)}`);
  assertEqual(occCount(db), 1, "positive control: exactly one row landed");
  assert(propById(db, "P_B"), "precondition: P_B exists but is NOT granted to mgr-1");

  const denied = await post(env, MGR, "/api/entities/OccupancyDay", { data: { property_id: "P_B", date: "2026-03-03", rooms_sold: 12 } });
  assertEqual(denied.status, 403, `an out-of-scope target must be 403, got ${denied.status} ${JSON.stringify(denied.body)}`);
  assertEqual(denied.body.error, "forbidden", "the denial is the generic forbidden body (no scope disclosure)");
  assertEqual(occCount(db), 1, "NOTHING may land for the out-of-scope row (still just the control row)");
  assertEqual(
    db.prepare("SELECT COUNT(*) c FROM occupancy_day WHERE property_id = 'P_B'").get().c,
    0,
    "specifically: no row landed against P_B",
  );
});

// ===========================================================================
// GUARD 06 — PIN. A missing or empty property_id on a non-roster create is a
// loud 422 at :203, BEFORE any scope check or write.
// ===========================================================================
await r.check("GUARD 06 PIN: non-roster create with missing/empty property_id => 422 'property_id is required', nothing lands", async () => {
  for (const [label, data] of [
    ["absent", { date: "2026-03-04" }],
    ['empty string ""', { property_id: "", date: "2026-03-04" }],
    ["null", { property_id: null, date: "2026-03-04" }],
  ]) {
    const { db, env } = base();
    // PRECONDITION (non-vacuity): the same shape WITH a property_id is accepted,
    // so a 422 here is about the missing key and not about a malformed request.
    const control = await post(env, OWNER, "/api/entities/OccupancyDay", { data: { property_id: "P_A", date: "2026-03-05" } });
    assertEqual(control.status, 201, `${label}: positive control must be 201, got ${control.status} ${JSON.stringify(control.body)}`);
    const out = await post(env, OWNER, "/api/entities/OccupancyDay", { data });
    assertEqual(out.status, 422, `${label}: must be a loud 422, got ${out.status} ${JSON.stringify(out.body)}`);
    assertEqual(out.body.error, "property_id is required", `${label}: the exact contract message`);
    assertEqual(occCount(db), 1, `${label}: only the control row exists — the rejected row landed nothing`);
  }
});

// ===========================================================================
// GUARD 07 — PIN. A roster create requires scope.all. Two callers, because the
// HTTP route and the :199 clause are NOT the same gate:
//   (a) a 'specific' manager is refused at :193 by mayMutate() — with the current
//       role model EVERY role that satisfies mayMutate for a roster contract
//       (owner, admin, gm) is in scope.js UNRESTRICTED_ROLES, so scope.all is
//       always true for them and :199 is unreachable through the router. That is
//       recorded as an OBSERVED fact, not assumed.
//   (b) so :199 itself is pinned by calling the exported handleEntityRequest with
//       a fabricated owner-role scope whose `all` is false. That is the ONLY way
//       to reach the clause, and a fix that keys the account branch off scope.all
//       must not turn this into a write.
// ===========================================================================
await r.check("GUARD 07 PIN: roster create by a restricted caller => 403 and nothing lands, both through the router AND at the :199 scope.all clause itself", async () => {
  const { db, env } = base();
  // (a) via the real router, as a 'specific'-mode manager.
  // PRECONDITION (non-vacuity): this caller is provisioned and CAN write a
  // non-roster row, so the 403 is about the roster contract, not about the user.
  const control = await post(env, MGR, "/api/entities/OccupancyDay", { data: { property_id: "P_A", date: "2026-03-06" } });
  assertEqual(control.status, 201, `precondition: the restricted caller is a working writer elsewhere, got ${control.status}`);
  const routed = await post(env, MGR, "/api/entities/Property", { data: { code: "SNEAK", name: "Sneak" } });
  assertEqual(routed.status, 403, `a restricted caller must not create a property, got ${routed.status} ${JSON.stringify(routed.body)}`);
  assertEqual(propsByCode(db, "SNEAK").length, 0, "nothing landed for SNEAK");
  assertEqual(propCount(db), 2, "the roster is untouched (still the 2 seeded properties)");

  // (b) :199 directly — owner role (so mayMutate passes) with all:false.
  const restrictedOwnerScope = {
    user: { id: "owner-1", account_id: "A_1", email: OWNER, role: "owner", property_access_mode: "specific", permissions: null, is_active: 1, is_locked: 0, must_change_password: 0 },
    accountId: "A_1",
    all: false,
    propertyIds: ["P_A"],
  };
  const req = new Request("https://api.test/api/entities/Property", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ data: { code: "SNEAK2", name: "Sneak2" } }),
  });
  const direct = await handleEntityRequest(req, env, restrictedOwnerScope, ["api", "entities", "Property"]);
  assertEqual(direct.status, 403, "an owner-role caller WITHOUT scope.all must still be refused a roster write (:199)");
  assertEqual((await direct.json()).error, "forbidden", "the :199 denial is the generic forbidden body");
  assertEqual(propsByCode(db, "SNEAK2").length, 0, "nothing landed for SNEAK2");
  assertEqual(propCount(db), 2, "the roster is STILL untouched after the direct call");
});

// ===========================================================================
// GUARD 08 — PIN. A client may NEVER choose the record's account scope.
//
// RECORDED DISCREPANCY (OBSERVED, reported to Agent A): the assignment expected
// 403 "record scope cannot be changed" from sanitizeData :154-156. The measured
// answer is 400 "field not allowed: account_id" from :153, because `account_id`
// is NOT in ANY contract's `columns` list (see the define() calls at :19-43), so
// the :153 allow-list rejects it first. The `field === "account_id"` clause at
// :154 is therefore DEAD CODE for every contract in the registry today. The
// security invariant the guard exists to protect is unchanged and fully asserted
// (an account_id in the payload is refused and nothing lands); only the line that
// refuses it differs, so the exact status/message are pinned as recorded current
// behaviour rather than silently relaxed.
// ===========================================================================
await r.check("GUARD 08 PIN: an account_id in the payload is REFUSED and nothing lands (roster AND non-roster)", async () => {
  for (const [entity, data, code] of [
    ["Property", { code: "X1", name: "X1", account_id: "A_2" }, "X1"],
    ["OccupancyDay", { property_id: "P_A", date: "2026-03-07", account_id: "A_2" }, null],
  ]) {
    const { db, env } = base();
    // PRECONDITION (non-vacuity): the SAME payload minus account_id is accepted
    // for the non-roster contract, so the refusal is specifically about
    // account_id. (The roster contract cannot have a 201 control today — that is
    // exactly the defect guards 01-03 cover — so its control is the on-disk
    // count instead.)
    const before = propCount(db);
    const out = await post(env, OWNER, `/api/entities/${entity}`, { data });
    console.log(`        [diagnostic] ${entity} account_id payload => ${out.status} ${JSON.stringify(out.body)}`);
    // THE INVARIANT: never accepted, always a client error, nothing written.
    assert(out.status >= 400 && out.status < 500, `${entity}: a client-chosen account_id must be a 4xx refusal, got ${out.status}`);
    assert(out.status !== 201, `${entity}: a client-chosen account_id must NEVER be accepted`);
    assert(/account_id|record scope/.test(String(out.body.error)), `${entity}: the error must name the offending field, got ${JSON.stringify(out.body)}`);
    // RECORDED CURRENT BEHAVIOUR (exact pin; see the discrepancy note above).
    assertEqual(out.status, 400, `${entity}: measured status of the :153 allow-list rejection`);
    assertEqual(out.body.error, "field not allowed: account_id", `${entity}: measured message of the :153 allow-list rejection`);
    assertEqual(propCount(db), before, `${entity}: the roster row count is unchanged`);
    if (code) assertEqual(propsByCode(db, code).length, 0, `${entity}: nothing landed for ${code}`);
    else assertEqual(occCount(db), 0, `${entity}: nothing landed in occupancy_day`);
    assertEqual(
      db.prepare("SELECT COUNT(*) c FROM property WHERE account_id = 'A_2'").get().c,
      0,
      `${entity}: no row may exist under the account the payload tried to name`,
    );
  }
});

// ===========================================================================
// GUARD 09 — RECORDED CURRENT BEHAVIOUR for a DEFERRED defect. NOT a 409 demand.
//
// A roster create whose (account_id, code) already exists, with a fresh
// server-derived id, hits `UNIQUE (account_id, code)` (worker/schema.sql) and
// INSERT OR IGNORE silently skips it. The DESIRED future behaviour is a 409
// naming the conflicting code; that is filed separately and is deliberately NOT
// asserted here, because Agent B's write-confirmation fix does not address it and
// this guard must survive that fix unchanged.
//
// The invariant asserted instead is the one that is stable across both states and
// is the actual data-integrity requirement: A DUPLICATE MUST NOT OVERWRITE,
// MUTATE, OR DUPLICATE THE EXISTING ROW, and it must not be reported as a
// successful create. The observed status is printed as a diagnostic.
// ===========================================================================
await r.check("GUARD 09 RECORDED: a duplicate (account_id, code) roster create does not overwrite, mutate, or duplicate the existing row, and is not reported as a create", async () => {
  const { db, env } = base();
  // PRECONDITION (non-vacuity): the collision target really exists, so the
  // request really is a duplicate.
  const before = propById(db, "P_A");
  assert(before, "precondition: P_A exists");
  assertEqual(before.code, "RRI-BOS", "precondition: P_A holds the code we are about to collide with");
  const out = await post(env, OWNER, "/api/entities/Property", { data: { code: "RRI-BOS", name: "Impostor", rooms: 1 } });
  console.log(`        [diagnostic] duplicate-code create => ${out.status} ${JSON.stringify(out.body)} (desired future behaviour: 409, filed separately)`);
  const after = propById(db, "P_A");
  assertEqual(JSON.stringify(after), JSON.stringify(before), "EVERY field of the pre-existing row must be byte-identical after the duplicate attempt");
  assertEqual(after.name, "Boston Downtown", "specifically: the name was not overwritten by 'Impostor'");
  assertEqual(after.rooms, 120, "specifically: rooms was not overwritten by 1");
  assertEqual(
    db.prepare("SELECT COUNT(*) c FROM property WHERE account_id = 'A_1' AND code = 'RRI-BOS'").get().c,
    1,
    "exactly ONE row may hold (A_1, RRI-BOS) — the duplicate must not create a second",
  );
  assertEqual(propCount(db), 2, "the roster still holds exactly the 2 seeded rows");
  assert(out.status !== 201, `a duplicate must never be answered as a successful create, got ${out.status} ${JSON.stringify(out.body)}`);
});

// ===========================================================================
// GUARD 10 — RED / NO CROSS-ACCOUNT CONFIRMATION LEAK. Two accounts hold the
// SAME business code (legal: `UNIQUE (account_id, code)` is per-account). A_2
// creates that code. The write must be confirmed against A_2's own row and
// nothing else — this is the guard that kills a "confirm by code" or
// "confirm by code + name" variant, which would find A_1's row and answer 201
// describing another tenant's property.
// ===========================================================================
await r.check("GUARD 10 RED: account A_2 creating a code A_1 already uses => 201 describing A_2's OWN new row; A_1's row is untouched", async () => {
  const db = baseDb();
  db.prepare("INSERT INTO account (id, name) VALUES (?,?)").run("A_2", "Second Hotel Group");
  db.prepare(INSERT_PROPERTY).run("P_SHARED_A1", "A_1", "HOTEL_SHARED", "A1 Shared", 7, 1, "2026-01-01");
  db.prepare(INSERT_PROPERTY).run("P_A2_OWN", "A_2", "A2-OWN", "A2 Own", 5, 1, "2026-01-01");
  seedUser(db, { id: "owner-2", email: "owner2@hotel.test", role: "owner", mode: "all", accountId: "A_2" });
  const env = makeEnv(db, ACCESS);
  // PRECONDITION (non-vacuity): A_1 genuinely holds HOTEL_SHARED, A_2 genuinely
  // does not, and A_2's snapshot is non-empty (so this is not the guard-03 case).
  const a1Before = propById(db, "P_SHARED_A1");
  assert(a1Before, "precondition: A_1 owns a HOTEL_SHARED row");
  assertEqual(propsByCode(db, "HOTEL_SHARED").length, 1, "precondition: exactly one HOTEL_SHARED row exists, and it is A_1's");
  assertEqual(db.prepare("SELECT COUNT(*) c FROM property WHERE account_id='A_2'").get().c, 1, "precondition: A_2's snapshot is non-empty");

  const out = await post(env, "owner2@hotel.test", "/api/entities/Property", { data: { code: "HOTEL_SHARED", name: "A2 Shared" } });
  console.log(`        [diagnostic] cross-account create => ${out.status} ${JSON.stringify(out.body)}`);
  assertEqual(out.status, 201, `A_2 must be able to create its own HOTEL_SHARED, got ${out.status} ${JSON.stringify(out.body)}`);
  assert(out.body.id !== "P_SHARED_A1", "the response must NOT be A_1's row id (a confirmation leak across accounts)");
  const returned = propById(db, out.body.id);
  assert(returned, "the returned id must exist on disk");
  assertEqual(returned.account_id, "A_2", "the returned row belongs to A_2");
  assertEqual(returned.name, "A2 Shared", "the returned row is the one A_2 asked for");
  assertEqual(JSON.stringify(propById(db, "P_SHARED_A1")), JSON.stringify(a1Before), "A_1's row must be byte-identical afterwards");
  assertEqual(propsByCode(db, "HOTEL_SHARED").length, 2, "both accounts now hold their own HOTEL_SHARED row");
});

// ===========================================================================
// GUARD 11 — WRITE-KEY IDENTITY, INSTRUMENTED. This is the guard that states the
// governing contract as SQL: the statement that confirms the roster write must
// bind exactly the write key (id, account_id) — the SAME account_id value the
// INSERT bound — and must NOT be the caller's read-authorization predicate
// (`id IN (…snapshot…)`).
//
// EXPECTED-COLOUR DISCREPANCY (reported to Agent A): the assignment lists guard
// 11 among the pins that are "green today". It cannot be. Today the confirmation
// IS findScoped, whose SQL is measured below as
//   SELECT … FROM property WHERE id = ? AND id IN (?, ?) LIMIT 1
// with 3 bound params. A guard that requires the write key can only go green
// AFTER the endorsed fix, so it is RED now, exactly like guards 01/02/03/10/14/15.
// ===========================================================================
await r.check("GUARD 11 RED: the roster write-confirmation statement binds EXACTLY (id, accountId) and is NOT the read-authorization predicate", async () => {
  const db = baseDb();
  const { env, stats, reset } = makeInstrumentedEnv(db, ACCESS);
  reset();
  const out = await post(env, OWNER, "/api/entities/Property", { data: { code: "HOTEL_I", name: "Hotel I" } });
  // PRECONDITIONS (non-vacuity): the INSERT really executed, and at least one
  // statement ran after it — so there IS a confirmation to inspect.
  const insertIdx = stats.calls.findIndex((c) => /INSERT\s+OR\s+IGNORE\s+INTO\s+property\b/i.test(c.sql));
  assert(insertIdx >= 0, `precondition: the roster INSERT must have executed; saw ${JSON.stringify(stats.calls.map((c) => c.sql))}`);
  const insertCall = stats.calls[insertIdx];
  const afterInsert = stats.calls.slice(insertIdx + 1);
  assert(afterInsert.length >= 1, "precondition: a confirmation statement must run AFTER the insert");
  const landed = propsByCode(db, "HOTEL_I");
  assertEqual(landed.length, 1, "precondition: the row genuinely landed, so there is a real write to confirm");

  const confirms = afterInsert.filter((c) => /^\s*SELECT\b[\s\S]*\bFROM\s+property\b/i.test(c.sql));
  assertEqual(confirms.length, 1, `exactly ONE post-insert read of the property table should confirm the write; saw ${JSON.stringify(confirms.map((c) => c.sql))}`);
  const confirm = confirms[0];
  console.log(`        [diagnostic] confirmation SQL: ${confirm.sql}`);
  console.log(`        [diagnostic] confirmation params (${confirm.paramCount}): ${JSON.stringify(confirm.params)} | create status ${out.status}`);
  // THE WRITE KEY, exactly: 2 params, (id, account_id).
  assertEqual(confirm.paramCount, 2, `the confirmation must bind EXACTLY 2 params (id, accountId); it bound ${confirm.paramCount}: ${confirm.sql}`);
  assert(/account_id/.test(confirm.sql), `the confirmation must key on account_id (the write's authority), got: ${confirm.sql}`);
  assert(!/\bid\s+IN\s*\(/i.test(confirm.sql), `the confirmation must NOT reuse the caller's read-authorization predicate \`id IN (…)\`, got: ${confirm.sql}`);
  assertEqual(String(confirm.params[0]), landed[0].id, "the first bound param is the id the INSERT wrote");
  // "THE SAME VALUE THE INSERT BOUND" — read straight off the INSERT's own params.
  const insertColumns = String(insertCall.sql).replace(/^[\s\S]*?\(/, "").split(")")[0].split(",").map((s) => s.trim());
  const accountIdx = insertColumns.indexOf("account_id");
  assert(accountIdx >= 0, `precondition: the INSERT must bind account_id; columns were ${JSON.stringify(insertColumns)}`);
  assertEqual(
    String(confirm.params[1]),
    String(insertCall.params[accountIdx]),
    "the confirmation must bind the SAME account_id value the INSERT bound",
  );
});

// ===========================================================================
// GUARD 12 — NON-ROSTER TABLES MUST NEVER ACQUIRE account_id SQL. This is the
// guard aimed at the FORBIDDEN implementation: keying the account branch off
// anything other than `contract.roster` + `scope.all`.
//
// It has three parts, and the report states honestly what each one can and cannot
// prove:
//   12a BEHAVIOURAL (green today, must stay green). Every statement this probe
//       executes against a NON-ROSTER contract table must key on property_id and
//       must never mention account_id. This kills the most plausible incomplete
//       fix — branching on `scope.all` alone — because an owner all-mode caller
//       writing an OccupancyDay would then emit `account_id = ?` against
//       occupancy_day, a table with NO account_id column.
//   12b REGISTRY TRIPWIRE. `Property` is currently the ONLY contract with
//       scopeColumn "id", and it is also the only `roster: true` one, so
//       `contract.roster` and `scopeColumn === "id"` coincide for every existing
//       contract and NO behavioural test can separate them today. If a second
//       scopeColumn "id" contract ever appears, this assertion fails loudly and
//       tells the next agent to add the behavioural test that then becomes
//       possible. It is a test-only tripwire on a registry invariant.
//   12c LEXICAL NEGATIVE, and it is explicitly NOT behavioural proof. Because of
//       12b the `scopeColumn === "id"` variant is behaviourally indistinguishable
//       today, so the only available guard is that worker/entities.js must not
//       contain such a comparison at all. Stated as a pure negative, so it is
//       green both before and after the endorsed fix, and red for the variant.
// ===========================================================================
const ENTITIES_SRC = readFileSync(fileURLToPath(new URL("../worker/entities.js", import.meta.url)), "utf8");
const NON_ROSTER_TABLES = Object.values(ENTITY_CONTRACT).filter((c) => !c.roster).map((c) => c.table);

await r.check("GUARD 12 PIN: non-roster tables never acquire account_id SQL; and the scopeColumn-keyed variant is excluded", async () => {
  const db = baseDb();
  const { env, stats, reset } = makeInstrumentedEnv(db, ACCESS);
  reset();
  // Exercise BOTH scope shapes, because a fix keyed on scope.all would only
  // misfire for the all-mode caller.
  const a = await post(env, OWNER, "/api/entities/OccupancyDay", { data: { property_id: "P_A", date: "2026-03-08", rooms_sold: 5 } });
  const b = await post(env, MGR, "/api/entities/TransactionLine", { data: { property_id: "P_A", date: "2026-03-08", folio_number: "F-12", amount: 12.5, dedupe_key: "DK-G12" } });
  assertEqual(a.status, 201, `precondition: the all-mode non-roster create must succeed, got ${a.status} ${JSON.stringify(a.body)}`);
  assertEqual(b.status, 201, `precondition: the specific-mode non-roster create must succeed, got ${b.status} ${JSON.stringify(b.body)}`);

  // 12a — collect every statement whose TARGET TABLE is a non-roster contract table.
  assert(NON_ROSTER_TABLES.length >= 2, "precondition: the registry defines non-roster contracts");
  const targeted = stats.calls.filter((c) =>
    NON_ROSTER_TABLES.some((t) => new RegExp(`\\b(?:FROM|INTO|UPDATE)\\s+${t}\\b`, "i").test(c.sql)),
  );
  assert(targeted.length >= 4, `precondition (non-vacuity): both non-roster creates must have executed an INSERT and a confirmation, saw ${targeted.length} statement(s): ${JSON.stringify(targeted.map((c) => c.sql.slice(0, 60)))}`);
  assert(
    targeted.some((c) => /^\s*INSERT/i.test(c.sql)) && targeted.some((c) => /^\s*SELECT/i.test(c.sql)),
    "precondition (non-vacuity): the collected statements include both the write and its confirmation",
  );
  for (const c of targeted) {
    assert(/\bproperty_id\b/.test(c.sql), `a non-roster statement must key on property_id, got: ${c.sql.slice(0, 160)}`);
    assert(
      !/\baccount_id\b/.test(c.sql),
      `a non-roster table has NO account_id column — this statement would fail in D1: ${c.sql.slice(0, 200)}`,
    );
  }

  // 12b — registry tripwire.
  const idScoped = Object.entries(ENTITY_CONTRACT).filter(([, c]) => c.scopeColumn === "id");
  assertEqual(
    JSON.stringify(idScoped.map(([name]) => name)),
    JSON.stringify(["Property"]),
    "TRIPWIRE: Property is the only scopeColumn 'id' contract. If this fails, a second one appeared and the " +
      "`contract.roster` vs `scopeColumn === \"id\"` distinction became BEHAVIOURALLY testable — add that test",
  );
  assert(idScoped.every(([, c]) => c.roster === true), "TRIPWIRE: every scopeColumn 'id' contract must also be roster:true");

  // 12c — lexical negative (documented above as NOT behavioural proof).
  assert(/async function createRows/.test(ENTITIES_SRC) && /INSERT OR IGNORE/.test(ENTITIES_SRC), "precondition: worker/entities.js was really read");
  for (const pattern of [
    /\bscopeColumn\s*[!=]==\s*["']id["']/,
    /["']id["']\s*[!=]==\s*[\w.]*scopeColumn\b/,
    /\bcolumn\s*[!=]==\s*["']id["']/,
    /["']id["']\s*[!=]==\s*\bcolumn\b/,
  ]) {
    assert(
      !pattern.test(ENTITIES_SRC),
      `write confirmation must branch on contract.roster + scope.all, never on a scope-column comparison to "id" ` +
        `(${pattern}) — that variant emits account_id against any future scopeColumn 'id' table that has no such column`,
    );
  }
});

// ===========================================================================
// GUARD 13 — RECORDED CURRENT BEHAVIOUR: THE PARTIAL-COMMIT GAP (deferred, filed
// separately, expected to PERSIST after the endorsed fix).
//
// bulk-create prepares every row, commits them in ONE env.DB.batch() (:215), and
// only THEN confirms them one by one (:217-221). A mid-list row that INSERT OR
// IGNORE skips therefore throws AFTER the other rows are already committed. The
// caller sees an error while two rows are permanently on disk. The endorsed
// write-confirmation fix does not change that ordering, so the assertions here
// are limited to what is stable: the committed rows and the non-success response.
// ===========================================================================
await r.check("GUARD 13 RECORDED: bulk create [NEW_A, duplicate, NEW_B] commits the two new rows and still answers with an error (partial-commit gap)", async () => {
  const { db, env } = base();
  // PRECONDITION (non-vacuity): the middle row is genuinely a duplicate and the
  // two flanking codes are genuinely unused.
  assertEqual(propsByCode(db, "RRI-BOS").length, 1, "precondition: RRI-BOS already exists (the duplicate)");
  assertEqual(propsByCode(db, "NEW_A").length + propsByCode(db, "NEW_B").length, 0, "precondition: NEW_A/NEW_B are unused");
  const out = await post(env, OWNER, "/api/entities/Property/bulk-create", {
    rows: [{ code: "NEW_A", name: "New A" }, { code: "RRI-BOS", name: "Dup" }, { code: "NEW_B", name: "New B" }],
  });
  const committed = db.prepare("SELECT code FROM property WHERE code IN ('NEW_A','NEW_B') ORDER BY code").all().map((x) => x.code);
  console.log(`        [diagnostic] bulk create => ${out.status} ${JSON.stringify(out.body)}; committed new rows: ${JSON.stringify(committed)} (partial-commit gap, filed separately)`);
  assertEqual(JSON.stringify(committed), JSON.stringify(["NEW_A", "NEW_B"]), "both non-duplicate rows are committed by the batch");
  assertEqual(propCount(db), 4, "the roster holds 2 seeded + 2 new rows");
  assertEqual(propsByCode(db, "RRI-BOS").length, 1, "the duplicate did not create a second RRI-BOS row");
  assertEqual(propById(db, "P_A").name, "Boston Downtown", "the duplicate did not overwrite the existing row");
  assert(out.status !== 201, `the partial commit must not be reported as a clean 201, got ${out.status} ${JSON.stringify(out.body)}`);
});

// ===========================================================================
// GUARD 14 — RED / SERVER-DERIVED ID. Today `:206` reads `raw.id ||`, so a
// client-supplied id that already exists is INSERT-OR-IGNOREd away and then
// CONFIRMED (because that id IS in the caller's snapshot). The caller receives a
// 201 describing a DIFFERENT, pre-existing row and the row it asked for was never
// written. Measured today: 201 with {"id":"P_A","code":"RRI-BOS","name":"Boston
// Downtown"} for a request asking for code HOTEL_C.
// ===========================================================================
await r.check("GUARD 14 RED: a client-supplied id is IGNORED — the response describes the requested row, and the requested row exists", async () => {
  const { db, env } = base();
  // PRECONDITION (non-vacuity): P_A exists with a DIFFERENT code, so a 201
  // echoing it would be provably the wrong row.
  const before = propById(db, "P_A");
  assert(before, "precondition: the client-supplied id P_A already exists");
  assertEqual(before.code, "RRI-BOS", "precondition: the pre-existing row holds a DIFFERENT code than the request");
  assertEqual(propsByCode(db, "HOTEL_C").length, 0, "precondition: the requested code is unused");

  const out = await post(env, OWNER, "/api/entities/Property", { data: { id: "P_A", code: "HOTEL_C", name: "Requested C" } });
  console.log(`        [diagnostic] client-supplied id => ${out.status} ${JSON.stringify(out.body)}; HOTEL_C rows: ${JSON.stringify(propsByCode(db, "HOTEL_C"))}`);
  assertEqual(out.body.code, "HOTEL_C", `the response must describe the REQUESTED row, not a pre-existing one; got ${JSON.stringify(out.body)}`);
  assert(out.body.id !== "P_A", "a client-supplied id must be ignored, so the response id must not be the client's");
  const landed = propsByCode(db, "HOTEL_C");
  assertEqual(landed.length, 1, "the requested row must actually exist on disk");
  assertEqual(landed[0].name, "Requested C", "with the requested name");
  assertEqual(landed[0].id, out.body.id, "and under the id the response returned");
  assertEqual(JSON.stringify(propById(db, "P_A")), JSON.stringify(before), "the pre-existing row must be byte-identical afterwards");
});

// ===========================================================================
// GUARD 15 — RED / D1 PARAM CEILING. Confirming through the read-authorization
// predicate makes the confirmation's bound-param count scale with the SIZE OF THE
// ACCOUNT: `WHERE id = ? AND id IN (?, ?, … ×N)`. D1's hard limit is 100 bound
// params per statement, so past ~99 properties the statement is not merely
// untruthful — it is REJECTED BY D1. node:sqlite has no such ceiling, so only an
// explicit param-count assertion can catch this. The endorsed fix binds 2 params
// regardless of account size.
// ===========================================================================
await r.check(`GUARD 15 RED: with 122 properties, no statement in the roster create path binds more than ${D1_PARAMS_PER_STATEMENT} params`, async () => {
  const PROPERTIES = 122;
  const db = emptyAccountDb("A_BIG", "big@hotel.test");
  for (let i = 0; i < PROPERTIES; i++) {
    db.prepare(INSERT_PROPERTY).run(`PB_${i}`, "A_BIG", `BIG-${String(i).padStart(3, "0")}`, `Big ${i}`, 10, 1, "2026-01-01");
  }
  // PRECONDITION (non-vacuity): the account really is large enough that a
  // snapshot-keyed confirmation MUST exceed the ceiling.
  assertEqual(propCount(db), PROPERTIES, `precondition: the account owns ${PROPERTIES} properties`);
  assert(PROPERTIES + 1 > D1_PARAMS_PER_STATEMENT, "precondition: a snapshot-keyed confirmation would exceed the D1 ceiling");
  const { env, stats, reset } = makeInstrumentedEnv(db, ACCESS);
  reset();
  const out = await post(env, "big@hotel.test", "/api/entities/Property", { data: { code: "BIG-NEW", name: "Big New" } });
  // PRECONDITION (non-vacuity): the create path really executed its write and a
  // confirmation after it — otherwise a low param count would prove nothing.
  const insertIdx = stats.calls.findIndex((c) => /INSERT\s+OR\s+IGNORE\s+INTO\s+property\b/i.test(c.sql));
  assert(insertIdx >= 0, "precondition: the roster INSERT executed");
  assert(stats.calls.length > insertIdx + 1, "precondition: a confirmation statement ran after the INSERT");
  assertEqual(propsByCode(db, "BIG-NEW").length, 1, "precondition: the row genuinely landed, so the confirmation had something to find");
  const widest = stats.calls.reduce((a, c) => (c.paramCount > a.paramCount ? c : a), stats.calls[0]);
  console.log(`        [diagnostic] status ${out.status}; widest statement bound ${widest.paramCount} params: ${widest.sql.slice(0, 120)}`);
  assert(
    stats.maxParams <= D1_PARAMS_PER_STATEMENT,
    `the widest statement bound ${stats.maxParams} params against an account of ${PROPERTIES} properties; D1's hard ` +
      `ceiling is ${D1_PARAMS_PER_STATEMENT} per statement, so this request would be REJECTED by real D1. SQL: ${widest.sql}`,
  );
});

r.done();
if (process.exitCode) process.exit(1);
console.log("PASSED: Worker entity roster-create write-confirmation contract completed.");
