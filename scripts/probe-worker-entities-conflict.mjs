// scripts/probe-worker-entities-conflict.mjs — failing-first proof of the
// CONSTRAINT-REPORTING contract in worker/entities.js `createRows`.
//
// THE GOVERNING CONTRACT:
//   The database is the authority on whether a write happened. A create path may
//   suppress EXACTLY ONE conflict — a re-submission of the same server-derived
//   id, which is genuinely idempotent. Every other constraint violation must
//   reach the caller as a truthful status with NOTHING committed.
//
// THE DEFECT (recorded as deferred by GUARD 09 / GUARD 13 of
// probe-worker-entities-roster-create.mjs, filed separately, fixed here):
// `createRows` inserts with `INSERT OR IGNORE`, which suppresses EVERY
// constraint violation as `changes: 0` with no error, and then tries to
// re-derive the outcome from a post-hoc confirmation read. Suppression destroys
// the only authoritative signal, so three distinct outcomes collapse into one
// indistinguishable "row not readable":
//   * an idempotent re-submission of the same id      (must be 201),
//   * a DIFFERENT row colliding on a business key     (must be 409),
//   * a malformed row that no column would accept     (must be 422).
// All three are reported as `500 {"error":"created row was not readable"}` — a
// server-error class for a deterministic client fault, with a message that
// misdescribes the cause (the row was never written, not unreadable). And
// because the confirmation loop runs AFTER env.DB.batch() commits, the surviving
// rows of a bulk create are already durable when the error is raised.
//
// Run: node scripts/probe-worker-entities-conflict.mjs (non-zero on ANY failure)

import worker from "../worker/index.js";
import { ENTITY_CONTRACT } from "../worker/entities.js";
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

const r = makeRunner("probe-worker-entities-conflict");

const AUD = "aud-entity-conflict";
const TEAM = "team.cloudflareaccess.com";
const ISS = `https://${TEAM}`;
const CERTS_URL = "https://synthetic.jwks/entity-conflict";
const CTX = { waitUntil() {}, passThroughOnException() {} };
const D1_PARAMS_PER_STATEMENT = 100;
const D1_QUERIES_PER_INVOCATION = 50;

const key = await generateRsaKey("kid-entity-conflict");
const { fetchImpl } = makeJwksFetch(makeJwks(key.publicJwk));
const ACCESS = {
  ACCESS_AUD: AUD,
  ACCESS_TEAM_DOMAIN: TEAM,
  ACCESS_CERTS_URL: CERTS_URL,
  FETCH: fetchImpl,
};

const OWNER = "owner@hotel.test";

async function tokenFor(email) {
  return signRs256({
    privateKey: key.privateKey,
    kid: "kid-entity-conflict",
    payload: { aud: AUD, iss: ISS, exp: Math.floor(Date.now() / 1000) + 3600, email, sub: `sub-${email}` },
  });
}

/** Drive the REAL router (real Access verification, real resolveScope). */
async function api(env, email, path, init = {}) {
  const token = await tokenFor(email);
  return worker.fetch(new Request(`https://api.test${path}`, {
    ...init,
    headers: {
      "Cf-Access-Jwt-Assertion": token,
      "X-Requested-With": "XMLHttpRequest",
      "content-type": "application/json",
      ...(init.headers || {}),
    },
  }), env, CTX);
}

async function post(env, email, path, body) {
  const res = await api(env, email, path, { method: "POST", body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

function baseDb() {
  const db = makeDb();
  seedProperties(db);
  seedUser(db, { id: "owner-1", email: OWNER, role: "owner", mode: "all" });
  return db;
}

function base() {
  const db = baseDb();
  return { db, env: makeEnv(db, ACCESS) };
}

/** Every effect is verified by a direct SELECT — never batch() metadata. */
const propsByCode = (db, code) =>
  db.prepare("SELECT id, account_id, code, name FROM property WHERE code = ? ORDER BY id").all(code);
const propById = (db, id) =>
  db.prepare("SELECT id, account_id, code, name, rooms FROM property WHERE id = ?").get(id);
const propCount = (db) => db.prepare("SELECT COUNT(*) c FROM property").get().c;
const txnCount = (db) => db.prepare("SELECT COUNT(*) c FROM transaction_line").get().c;
const occCount = (db) => db.prepare("SELECT COUNT(*) c FROM occupancy_day").get().c;

/** The message the defect produced for all three causes; must not survive. */
const MISLEADING = "created row was not readable";

// ===========================================================================
// CONFLICT 01 — RED. A duplicate business key is a CLIENT conflict (409) that
// NAMES the colliding code, not a server error. The pre-existing row must be
// byte-identical afterwards, and the misleading message must be gone.
// ===========================================================================
await r.check("CONFLICT 01 RED: duplicate (account_id, code) roster create => 409 naming the code, existing row untouched", async () => {
  const { db, env } = base();
  // PRECONDITION (non-vacuity): the collision target really exists.
  const before = propById(db, "P_A");
  assert(before, "precondition: P_A exists");
  assertEqual(before.code, "RRI-BOS", "precondition: P_A holds the code we collide with");

  const out = await post(env, OWNER, "/api/entities/Property", { data: { code: "RRI-BOS", name: "Impostor", rooms: 1 } });
  assertEqual(out.status, 409, `a duplicate business key must be 409, got ${out.status} ${JSON.stringify(out.body)}`);
  assert(
    JSON.stringify(out.body).includes("RRI-BOS"),
    `the 409 must NAME the conflicting code so the UI can report it; got ${JSON.stringify(out.body)}`,
  );
  assert(
    !JSON.stringify(out.body).includes(MISLEADING),
    `the response must not claim the row was unreadable — it was never written; got ${JSON.stringify(out.body)}`,
  );
  assertEqual(JSON.stringify(propById(db, "P_A")), JSON.stringify(before), "the pre-existing row is byte-identical");
  assertEqual(propCount(db), 2, "no extra row landed");
});

// ===========================================================================
// CONFLICT 02 — RED. THE PARTIAL-COMMIT GAP. The rejection must be atomic for
// the WHOLE request: a conflicting row in the middle of a bulk create may not
// leave its neighbours durably committed.
// ===========================================================================
await r.check("CONFLICT 02 RED: bulk create [NEW_A, duplicate, NEW_B] => 409 and NOTHING lands", async () => {
  const { db, env } = base();
  // PRECONDITION (non-vacuity): the middle row is genuinely a duplicate and the
  // flanking codes are genuinely unused, so a clean run WOULD have landed them.
  assertEqual(propsByCode(db, "RRI-BOS").length, 1, "precondition: RRI-BOS exists (the duplicate)");
  assertEqual(propsByCode(db, "NEW_A").length + propsByCode(db, "NEW_B").length, 0, "precondition: NEW_A/NEW_B unused");

  const out = await post(env, OWNER, "/api/entities/Property/bulk-create", {
    rows: [{ code: "NEW_A", name: "New A" }, { code: "RRI-BOS", name: "Dup" }, { code: "NEW_B", name: "New B" }],
  });
  assertEqual(out.status, 409, `the conflicting bulk create must be 409, got ${out.status} ${JSON.stringify(out.body)}`);
  assertEqual(propsByCode(db, "NEW_A").length, 0, "NEW_A must NOT be committed — the request was rejected");
  assertEqual(propsByCode(db, "NEW_B").length, 0, "NEW_B must NOT be committed — the request was rejected");
  assertEqual(propCount(db), 2, "the roster still holds exactly the 2 seeded rows");
  assertEqual(propById(db, "P_A").name, "Boston Downtown", "the duplicate did not overwrite the existing row");
});

// ===========================================================================
// CONFLICT 03 — RED. Two rows of ONE request claiming the same code. The
// collision is inside the request, so no pre-existing row can reveal it; only a
// non-suppressing insert or an intra-request check can. Nothing may land.
// ===========================================================================
await r.check("CONFLICT 03 RED: bulk create with the SAME new code twice => 409 naming it, nothing lands", async () => {
  const { db, env } = base();
  // PRECONDITION (non-vacuity): the code is unused, so neither row is a
  // duplicate of anything already on disk — the conflict is purely intra-request.
  assertEqual(propsByCode(db, "TWIN").length, 0, "precondition: TWIN is unused");

  const out = await post(env, OWNER, "/api/entities/Property/bulk-create", {
    rows: [{ code: "TWIN", name: "First" }, { code: "TWIN", name: "Second" }],
  });
  assertEqual(out.status, 409, `two rows claiming one code must be 409, got ${out.status} ${JSON.stringify(out.body)}`);
  assert(JSON.stringify(out.body).includes("TWIN"), `the 409 must name TWIN; got ${JSON.stringify(out.body)}`);
  assertEqual(propsByCode(db, "TWIN").length, 0, "NEITHER row may land — not even the first");
  assertEqual(propCount(db), 2, "the roster is unchanged");
});

// ===========================================================================
// CONFLICT 04 — RED. The NON-ROSTER path has the same defect through a
// different constraint: `transaction_line.dedupe_key TEXT NOT NULL UNIQUE`.
// This is the money table, so a suppressed duplicate is silent money loss.
// ===========================================================================
await r.check("CONFLICT 04 RED: non-roster create whose dedupe_key already exists => 409, nothing lands, existing row untouched", async () => {
  const { db, env } = base();
  const first = await post(env, OWNER, "/api/entities/TransactionLine", {
    data: { property_id: "P_A", date: "2026-03-01", folio_number: "F-1", amount: 199.99, dedupe_key: "DK-DUP" },
  });
  // PRECONDITION / POSITIVE CONTROL: the first identical-key write succeeds, so
  // the 409 below provably comes from the UNIQUE key and not from a broken payload.
  assertEqual(first.status, 201, `positive control: the first row must be created, got ${first.status} ${JSON.stringify(first.body)}`);
  assertEqual(txnCount(db), 1, "precondition: exactly one row on disk");

  const out = await post(env, OWNER, "/api/entities/TransactionLine", {
    data: { property_id: "P_B", date: "2026-03-02", folio_number: "F-2", amount: 42.5, dedupe_key: "DK-DUP" },
  });
  assertEqual(out.status, 409, `a duplicate dedupe_key must be 409, got ${out.status} ${JSON.stringify(out.body)}`);
  assert(
    !JSON.stringify(out.body).includes(MISLEADING),
    `the response must not misdescribe a rejected write as unreadable; got ${JSON.stringify(out.body)}`,
  );
  assertEqual(txnCount(db), 1, "the second row must NOT land");
  const kept = db.prepare("SELECT property_id, amount FROM transaction_line WHERE dedupe_key = ?").get("DK-DUP");
  assertEqual(kept.property_id, "P_A", "the FIRST row still owns the key");
  assertEqual(kept.amount, 199.99, "and its amount was not overwritten");
});

// ===========================================================================
// CONFLICT 05 — RED. A row no column would accept is a 422 (unprocessable
// payload), NOT a 409 (a conflict with an existing row) and NOT a 500. Property
// declares `name TEXT NOT NULL`; `INSERT OR IGNORE` swallowed that as a lost
// write. This is the guard that keeps the two failure CLASSES distinct.
// ===========================================================================
await r.check("CONFLICT 05 RED: create omitting a NOT NULL column => 422 (not 409, not 500) and nothing lands", async () => {
  const { db, env } = base();
  // PRECONDITION (non-vacuity): the SAME payload plus `name` succeeds, so the
  // rejection is provably caused by the missing NOT NULL column alone.
  const control = await post(env, OWNER, "/api/entities/Property", { data: { code: "NN-OK", name: "Named" } });
  assertEqual(control.status, 201, `positive control: the same payload WITH name must succeed, got ${control.status}`);
  assertEqual(propsByCode(db, "NN-OK").length, 1, "positive control: it landed");

  const out = await post(env, OWNER, "/api/entities/Property", { data: { code: "NN-BAD" } });
  assertEqual(out.status, 422, `a NOT NULL violation must be 422, got ${out.status} ${JSON.stringify(out.body)}`);
  assert(
    !JSON.stringify(out.body).includes(MISLEADING),
    `a rejected write must not be reported as an unreadable one; got ${JSON.stringify(out.body)}`,
  );
  assertEqual(propsByCode(db, "NN-BAD").length, 0, "nothing landed for the malformed row");
  assertEqual(propCount(db), 3, "the roster holds 2 seeded + the 1 control row");
});

// ===========================================================================
// CONFLICT 06 — PIN / THE CONTROL THAT MUST NOT BREAK. Suppression of the
// SAME-id conflict is the one legitimate case: `stableId` is deterministic when
// the payload carries `import_id`, so a retried import row must stay idempotent
// (201, exactly one row) and must NOT become a 409. A fix that simply drops
// `OR IGNORE` fails HERE.
// ===========================================================================
await r.check("CONFLICT 06 PIN: re-submitting an identical import row stays idempotent => 201 twice, ONE row on disk", async () => {
  const { db, env } = base();
  const data = { property_id: "P_A", import_id: "IMP-1", date: "2026-03-05", rooms_sold: 10 };
  const first = await post(env, OWNER, "/api/entities/OccupancyDay", { data });
  assertEqual(first.status, 201, `first submission must succeed, got ${first.status} ${JSON.stringify(first.body)}`);
  assertEqual(occCount(db), 1, "precondition: exactly one row after the first submission");
  // PRECONDITION (non-vacuity): the id really is content-derived, not random —
  // otherwise the second call could not collide on it and this would prove nothing.
  assert(String(first.body.id).startsWith("imp_"), `precondition: the id is content-derived, got ${first.body.id}`);

  const second = await post(env, OWNER, "/api/entities/OccupancyDay", { data });
  assertEqual(second.status, 201, `a re-submitted identical import row must stay idempotent, got ${second.status} ${JSON.stringify(second.body)}`);
  assertEqual(second.body.id, first.body.id, "and answer with the same server id");
  assertEqual(occCount(db), 1, "still exactly ONE row on disk");
});

// ===========================================================================
// CONFLICT 07 — PIN / ISOLATION. `UNIQUE (account_id, code)` is PER ACCOUNT, so
// account A_2 must still be able to create a code A_1 already uses. This kills
// any conflict check that forgets the account filter and would otherwise both
// false-reject a tenant and disclose another tenant's roster.
// ===========================================================================
await r.check("CONFLICT 07 PIN: account A_2 creating a code A_1 already uses => 201; A_1's row untouched", async () => {
  const db = baseDb();
  db.prepare("INSERT INTO account (id, name, created_date) VALUES (?,?,?)").run("A_2", "Second Group", "2026-01-01");
  db.prepare("INSERT INTO property (id,account_id,code,name,rooms,active,created_date) VALUES (?,?,?,?,?,?,?)")
    .run("P_A2", "A_2", "A2-OWN", "A2 Own", 5, 1, "2026-01-01");
  seedUser(db, { id: "owner-2", email: "owner2@hotel.test", role: "owner", mode: "all", accountId: "A_2" });
  const env = makeEnv(db, ACCESS);
  // PRECONDITION (non-vacuity): A_1 holds the code and A_2 does not.
  assertEqual(propsByCode(db, "RRI-BOS").length, 1, "precondition: only A_1 holds RRI-BOS");

  const out = await post(env, "owner2@hotel.test", "/api/entities/Property", { data: { code: "RRI-BOS", name: "A2 Boston" } });
  assertEqual(out.status, 201, `a per-account code is legal for another account, got ${out.status} ${JSON.stringify(out.body)}`);
  const rows = propsByCode(db, "RRI-BOS");
  assertEqual(rows.length, 2, "both accounts now hold the code");
  assertEqual(propById(db, "P_A").name, "Boston Downtown", "A_1's row is untouched");
  assertEqual(rows.filter((x) => x.account_id === "A_2")[0].name, "A2 Boston", "A_2 got its OWN row");
});

// ===========================================================================
// CONFLICT 08 — PIN / NO FALSE REJECTION. A clean multi-row create of distinct
// unused codes must still commit every row. This is the control that a conflict
// check cannot pass by rejecting everything.
// ===========================================================================
await r.check("CONFLICT 08 PIN: bulk create of 3 distinct unused codes => 201 and all 3 land", async () => {
  const { db, env } = base();
  const codes = ["OK_1", "OK_2", "OK_3"];
  // PRECONDITION (non-vacuity): none of them exist yet.
  for (const c of codes) assertEqual(propsByCode(db, c).length, 0, `precondition: ${c} unused`);

  const out = await post(env, OWNER, "/api/entities/Property/bulk-create", {
    rows: codes.map((code) => ({ code, name: `Hotel ${code}` })),
  });
  assertEqual(out.status, 201, `a clean bulk create must succeed, got ${out.status} ${JSON.stringify(out.body)}`);
  assertEqual(out.body.items.length, 3, "the response describes all three created rows");
  for (const c of codes) assertEqual(propsByCode(db, c).length, 1, `${c} landed exactly once`);
  assertEqual(propCount(db), 5, "2 seeded + 3 new");
});

// ===========================================================================
// CONFLICT 09 — RED / NO WRITE AT ALL. "Nothing landed" can also be achieved by
// writing and rolling back. The stronger requirement: a request rejected for a
// duplicate must not even ATTEMPT an INSERT, so the rejection costs no write and
// cannot depend on transaction semantics the shim models differently from D1.
// ===========================================================================
await r.check("CONFLICT 09 RED: a duplicate-code request issues ZERO INSERT statements", async () => {
  const db = baseDb();
  const { env, stats, reset } = makeInstrumentedEnv(db, ACCESS);
  reset();
  const out = await post(env, OWNER, "/api/entities/Property", { data: { code: "RRI-BOS", name: "Impostor" } });
  assertEqual(out.status, 409, `precondition: the request must be rejected as a conflict, got ${out.status} ${JSON.stringify(out.body)}`);
  // PRECONDITION (non-vacuity): statements WERE recorded, so a zero INSERT count
  // is a real observation and not an instrumentation failure.
  assert(stats.calls.length > 0, "precondition: the instrumented env recorded statements");
  const inserts = stats.calls.filter((c) => /^\s*INSERT\b/i.test(c.sql));
  assertEqual(inserts.length, 0, `no INSERT may be attempted; saw ${JSON.stringify(inserts.map((c) => c.sql))}`);
});

// ===========================================================================
// CONFLICT 10 — BUDGET. The conflict pre-check must cost AT MOST ONE extra
// statement, and its widest statement must stay inside D1's 100-parameter
// ceiling with a full MAX_BULK_ROWS request.
//
// NOTE, surfaced not fixed: a 40-row bulk create already issues one statement per
// row for the INSERT plus one per row for the confirmation, which is above the
// 50-queries-per-invocation FREE-plan ceiling before this change. That is a
// separate pre-existing defect; this guard pins that the conflict check does not
// make it worse and prints the real count.
// ===========================================================================
await r.check("CONFLICT 10 BUDGET: a 40-row roster bulk create adds <= 1 statement for the conflict check and binds <= 100 params per statement", async () => {
  const db = baseDb();
  const { env, stats, reset } = makeInstrumentedEnv(db, ACCESS);
  const rows = Array.from({ length: 40 }, (_, i) => ({ code: `BULK_${i}`, name: `Hotel ${i}` }));
  reset();
  const out = await post(env, OWNER, "/api/entities/Property/bulk-create", { rows });
  assertEqual(out.status, 201, `precondition: the clean 40-row create must succeed, got ${out.status} ${JSON.stringify(out.body)}`);
  assertEqual(propCount(db), 42, "precondition: 2 seeded + 40 new rows really landed");
  const widest = stats.calls.reduce((a, c) => (c.paramCount > a.paramCount ? c : a), stats.calls[0]);
  console.log(`        [diagnostic] 40-row bulk create: ${stats.calls.length} statements (D1 free-plan ceiling ${D1_QUERIES_PER_INVOCATION}, pre-existing overrun surfaced not fixed); widest binds ${widest.paramCount} params: ${widest.sql.slice(0, 110)}`);
  assert(
    stats.maxParams <= D1_PARAMS_PER_STATEMENT,
    `the widest statement bound ${stats.maxParams} params; D1 rejects above ${D1_PARAMS_PER_STATEMENT}. SQL: ${widest.sql}`,
  );
  const preChecks = stats.calls.filter((c) => /^\s*SELECT\b[\s\S]*\bFROM\s+property\b[\s\S]*\bcode\s+IN\b/i.test(c.sql));
  assertEqual(preChecks.length, 1, "the conflict pre-check must be exactly ONE batched read");
  assertEqual(preChecks[0].paramCount, rows.length + 1, "the pre-check binds the account plus one param per code");
  // The whole invocation, enumerated so ANY newly added query breaks this guard:
  //   1 user read (auth) + 1 scope snapshot + 1 conflict pre-check
  //   + N INSERTs + N confirmation reads.
  assertEqual(
    stats.calls.length,
    2 * rows.length + 3,
    `unexpected statement count; composition changed: ${JSON.stringify(stats.calls.map((c) => c.sql.slice(0, 34)))}`,
  );
});

// ===========================================================================
// CONFLICT 11 — RED / THE DATABASE STAYS THE AUTHORITY. A pre-flight read cannot
// be the only defence: between the read and the write another request may take
// the code (TOCTOU). The emitted INSERT must therefore still be non-suppressing,
// and any suppression it does carry must be pinned to the id conflict target —
// the one genuinely idempotent case (CONFLICT 06). A bare `INSERT OR IGNORE`
// would silently absorb a UNIQUE(account_id, code) loss the pre-flight missed.
// ===========================================================================
await r.check("CONFLICT 11 RED: the roster INSERT is not blanket-suppressing and scopes any DO NOTHING to the id", async () => {
  const db = baseDb();
  const { env, stats, reset } = makeInstrumentedEnv(db, ACCESS);
  reset();
  const out = await post(env, OWNER, "/api/entities/Property", { data: { code: "AUTH-1", name: "Authority" } });
  assertEqual(out.status, 201, `precondition: the clean create must succeed, got ${out.status} ${JSON.stringify(out.body)}`);
  const insert = stats.calls.find((c) => /^\s*INSERT\b[\s\S]*\bINTO\s+property\b/i.test(c.sql));
  // PRECONDITION (non-vacuity): an INSERT really executed, so the assertions
  // below inspect the statement the worker actually sent.
  assert(insert, `precondition: the roster INSERT must have executed; saw ${JSON.stringify(stats.calls.map((c) => c.sql.slice(0, 40)))}`);
  assert(
    !/\bINSERT\s+OR\s+IGNORE\b/i.test(insert.sql),
    `a blanket OR IGNORE suppresses UNIQUE(account_id, code) too; got: ${insert.sql}`,
  );
  if (/\bON\s+CONFLICT\b/i.test(insert.sql)) {
    assert(
      /\bON\s+CONFLICT\s*\(\s*id\s*\)\s*DO\s+NOTHING\b/i.test(insert.sql),
      `suppression must be pinned to the id conflict target; got: ${insert.sql}`,
    );
  }
});

// ===========================================================================
// CONFLICT 12 — TRIPWIRE. The pre-check treats an existing row whose id EQUALS the
// computed id as the same record re-submitted, not a conflict. That branch is
// currently UNREACHABLE for the roster: `stableId` is content-derived only when the
// payload carries `import_id`, and the Property contract has no such column, so a
// roster id is always a fresh UUID. The branch is kept because it is what keeps the
// idempotent path correct if that ever changes — and this tripwire fires when it
// does, because the branch would then become behaviourally testable.
// ===========================================================================
await r.check("CONFLICT 12 TRIPWIRE: no roster contract carries import_id, so a roster id is never content-derived", async () => {
  const roster = Object.entries(ENTITY_CONTRACT).filter(([, c]) => c.roster);
  // PRECONDITION (non-vacuity): the registry really was read and roster contracts exist.
  assert(roster.length > 0, "precondition: at least one roster contract exists");
  for (const [name, contract] of roster) {
    assert(
      !contract.columns.includes("import_id"),
      `TRIPWIRE: ${name} gained import_id, so stableId() now returns a content-derived id for a roster row. ` +
        "The conflict pre-check's id-equality branch just became reachable — add a behavioural test for a " +
        "re-submitted identical roster import row (it must stay 201, not become 409)",
    );
    assert(
      contract.businessKey && contract.columns.includes(contract.businessKey),
      `${name}: a roster contract must declare a businessKey that is one of its own columns`,
    );
  }
});

// ===========================================================================
// CONFLICT 13-16 — the DRIVER-SHAPE boundary. `createRows` classifies a write
// failure by searching the driver's message. A driver is not obliged to put the
// SQLite text on the OUTERMOST error: D1 has shipped batch rejections whose own
// `.message` is only a generic `D1_ERROR:` wrapper with the real constraint text on
// `.cause`. If classification reads `.message` alone, that shape re-creates the very
// defect this file exists to kill — a deterministic constraint violation reported as
// an opaque 500.
//
// These guards drive the REAL router and REAL createRows; only env.DB.batch is
// replaced, so the pre-check, the auth read and the scope snapshot all still run.
// The payload uses a FRESH code, so the pre-check passes and classification is the
// only thing under test.
//
// BLOCKED/UNPROVEN: which shape live D1 actually throws is NOT verified here — that
// needs a deployed Worker. These prove the classifier is correct for BOTH shapes, so
// the answer no longer depends on which one it is.
// ===========================================================================

/** An env whose batch() rejects with `error`; every other DB call is untouched. */
function envWithFailingBatch(db, error) {
  const inner = makeEnv(db, ACCESS);
  const DB = {
    prepare: (sql) => inner.DB.prepare(sql),
    batch: async () => { throw error; },
  };
  return { ...inner, DB };
}

const FRESH = { code: "RRI-NEW", name: "Fresh Property", rooms: 10 };

await r.check("CONFLICT 13 RED: a UNIQUE violation carried on error.cause is still 409, not an opaque 500", async () => {
  const { db } = base();
  const wrapped = new Error("D1_ERROR: batch failed", {
    cause: new Error("UNIQUE constraint failed: property.account_id, property.code"),
  });
  // PRECONDITION (non-vacuity): the wrapper's OWN message carries no constraint text,
  // so a `.message`-only classifier cannot pass this guard by accident.
  assert(!/constraint failed/i.test(wrapped.message), "precondition: the outer message is constraint-free");
  const out = await post(envWithFailingBatch(db, wrapped), OWNER, "/api/entities/Property", { data: FRESH });
  assertEqual(out.status, 409, `a nested UNIQUE violation must be 409, got ${out.status} ${JSON.stringify(out.body)}`);
  assert(
    !JSON.stringify(out.body).includes(MISLEADING),
    `the response must not claim the row was unreadable; got ${JSON.stringify(out.body)}`,
  );
  assertEqual(propCount(db), 2, "the failed batch committed nothing");
});

await r.check("CONFLICT 14 RED: a NOT NULL violation nested two levels deep is still 422", async () => {
  const { db } = base();
  const wrapped = new Error("D1_ERROR: batch failed", {
    cause: new Error("statement 1 failed", {
      cause: new Error("NOT NULL constraint failed: property.name"),
    }),
  });
  const out = await post(envWithFailingBatch(db, wrapped), OWNER, "/api/entities/Property", { data: FRESH });
  assertEqual(out.status, 422, `a nested NOT NULL violation must be 422, got ${out.status} ${JSON.stringify(out.body)}`);
});

await r.check("CONFLICT 15 PIN: a NON-constraint failure is never re-classified", async () => {
  const { db } = base();
  // A chain with NO constraint text anywhere. Nothing here may become a 409/422.
  const out = await post(
    envWithFailingBatch(db, new Error("D1_ERROR: Network connection lost", { cause: new Error("socket hang up") })),
    OWNER, "/api/entities/Property", { data: FRESH },
  );
  assertEqual(out.status, 500, `a transport failure must stay a 500, got ${out.status} ${JSON.stringify(out.body)}`);
  // The router's catch-all answers a fixed body: no driver text, no SQL, no schema.
  assertEqual(JSON.stringify(out.body), JSON.stringify({ error: "internal server error" }), "no driver detail may reach the client");
  assertEqual(propCount(db), 2, "the failed batch committed nothing");
});

// ===========================================================================
// CONFLICT 16 — the DEPTH BOUND. `cause` is a plain property, so a driver (or a
// wrapper that re-attaches an error it already wrapped) can hand back a CYCLIC
// chain. The walk is depth-bounded for that reason.
//
// WALL CLOCK IS THE ASSERTION, and it is deliberate. An unbounded walk over a cycle
// does NOT produce a distinguishable body: it accumulates until the array hits its
// maximum length, throws RangeError, and the router's catch-all answers the SAME
// `500 {"error":"internal server error"}` a correct classification returns. Measured
// on this harness: 8034 ms to that RangeError versus single-digit ms when bounded.
// So the only observable that separates the two implementations is how long the
// caller waits, and a status-only guard here would be vacuous.
// ===========================================================================
const CYCLIC_WALK_BUDGET_MS = 2000;

await r.check("CONFLICT 16 RED: a CYCLIC cause chain is answered promptly, not walked until the isolate dies", async () => {
  const { db } = base();
  const outer = new Error("D1_ERROR: Network connection lost");
  const innerErr = new Error("socket hang up");
  outer.cause = innerErr;
  innerErr.cause = outer;
  // PRECONDITION (non-vacuity): the chain really is a cycle, so an unbounded walk
  // cannot terminate on its own.
  assert(outer.cause.cause === outer, "precondition: the cause chain is cyclic");

  const started = Date.now();
  const out = await post(envWithFailingBatch(db, outer), OWNER, "/api/entities/Property", { data: FRESH });
  const elapsed = Date.now() - started;

  assertEqual(out.status, 500, `a transport failure must stay a 500, got ${out.status} ${JSON.stringify(out.body)}`);
  assertEqual(JSON.stringify(out.body), JSON.stringify({ error: "internal server error" }), "no driver detail may reach the client");
  assert(
    elapsed < CYCLIC_WALK_BUDGET_MS,
    `classification must not follow the cycle: answered in ${elapsed} ms, budget ${CYCLIC_WALK_BUDGET_MS} ms ` +
      "(an unbounded walk reaches RangeError in ~8 s and yields an identical body)",
  );
  assertEqual(propCount(db), 2, "the failed batch committed nothing");
});

r.done();
if (process.exitCode) process.exit(1);
console.log("PASSED: Worker entity constraint contract completed.");
