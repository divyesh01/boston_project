// scripts/probe-worker-import.mjs — INDEPENDENT adversarial proof of
// worker/import.js (atomic, resumable, idempotent chunked import) against a REAL
// node:sqlite shim over worker/schema.sql (foreign_keys ON).
//
// Covers Agent D's findings F2 (N+1 property resolution -> ONE batched read,
// MAX_ROWS_PER_CHUNK 45->40, D1 query budget) and F3 (rows_committed must
// advance by rows ACTUALLY inserted, not rows submitted).
//
// Run: node scripts/probe-worker-import.mjs   (exits non-zero on ANY failure)

import { importChunk, parseChunk, transactionDedupeKey, MAX_ROWS_PER_CHUNK } from "../worker/import.js";
import {
  makeDb,
  makeEnv,
  makeInstrumentedEnv,
  seedProperties,
  scopeAll,
  scopeSpecific,
  makeRunner,
  assert,
  assertEqual,
} from "./_worker-testkit.mjs";

const r = makeRunner("probe-worker-import");
const SCOPE = scopeAll(["P_A", "P_B"]);
const D1_QUERIES_PER_INVOCATION = 50; // free-plan ceiling worker/import.js budgets against
const D1_PARAMS_PER_STATEMENT = 100; // bound-parameter ceiling per statement

function freshEnv() {
  const db = makeDb();
  seedProperties(db);
  return { db, env: makeEnv(db) };
}
const txnCount = (db) => db.prepare("SELECT COUNT(*) c FROM transaction_line").get().c;
const amounts = (db) => db.prepare("SELECT amount FROM transaction_line").all().map((x) => x.amount);
const jsSum = (arr) => arr.reduce((a, b) => a + b, 0);
const progress = (db, id) => db.prepare("SELECT * FROM import_progress WHERE import_id = ?").get(id);

// Client row for property A (resolves via property_code). Distinct folio/occurrence
// keep dedupe keys distinct unless we deliberately collide them.
function rowA(over = {}) {
  return {
    property_code: "RRI-BOS",
    occurrence: 0,
    date: "2026-02-01",
    time: "10:00:00",
    folio_number: "FOL-100",
    transaction_code: "RENT",
    amount: 199.99,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// CHANGE 10 CONTRACT VOCABULARY (owner decision: `property_local_id` is NOT an
// import resolution key; canonical `property_code` is REQUIRED on every
// property-scoped row; no silent fallback to browser-local numeric ids).
//
// resolveServerPropertyId returns exactly three shapes, and the two rejection
// shapes must stay DISTINGUISHABLE by their error text, not merely by status:
//   missing_code -> 422, `property_code` absent/""/null/not-a-string (a JSON
//                   *number* included). The row never named a canonical property.
//   unresolved   -> 422, `property_code` IS a usable non-empty string but is not
//                   in property_id_map. The row named a property the server does
//                   not know.
// Collapsing those two into one message is the most plausible incomplete fix, so
// every 422 check below pins the exact discriminator text.
// ---------------------------------------------------------------------------

/** The row label worker/import.js prefixes onto every per-row rejection. */
const rowLabel = (importId, cursor, i) => `chunk ${importId}#${cursor} row ${i}`;
/** Discriminator texts. Owner/Agent A settled the missing_code wording verbatim. */
const MISSING_CODE_TEXT =
  "property_code is required (canonical property code; browser-local ids are not accepted)";
const UNRESOLVED_TEXT = "property did not resolve";
const expectMissingCode = (importId, cursor, i) => `${rowLabel(importId, cursor, i)}: ${MISSING_CODE_TEXT}`;
const expectUnresolved = (importId, cursor, i) => `${rowLabel(importId, cursor, i)}: ${UNRESOLVED_TEXT}`;

// --- atomic chunk write; progress advances ---------------------------------
await r.check("chunk writes rows atomically; import_progress advances", async () => {
  const { db, env } = freshEnv();
  const chunk = {
    import_id: "imp-atomic",
    cursor: 0,
    rows: [rowA({ folio_number: "A1" }), rowA({ folio_number: "A2" }), rowA({ folio_number: "A3" })],
  };
  const res = await importChunk(env, scopeAll(["P_A", "P_B"]), chunk, false);
  assertEqual(res.status, 200, "chunk should commit");
  assertEqual(txnCount(db), 3, "3 rows landed");
  const p = progress(db, "imp-atomic");
  assert(p, "progress row exists");
  assertEqual(p.chunk_cursor, 0, "cursor recorded");
  assertEqual(p.rows_committed, 3, "rows_committed = 3");
  assertEqual(p.status, "in_progress", "status in_progress");
});

// --- idempotent re-send: count AND summed amount unchanged -----------------
await r.check("re-sent identical chunk is idempotent (no double count, sum unchanged)", async () => {
  const { db, env } = freshEnv();
  const rows = [rowA({ folio_number: "B1", amount: 100.25 }), rowA({ folio_number: "B2", amount: 250.75 })];
  const chunk = { import_id: "imp-idem", cursor: 0, rows };
  await importChunk(env, scopeAll(["P_A", "P_B"]), chunk, false);
  const countAfterFirst = txnCount(db);
  const sumAfterFirst = jsSum(amounts(db)); // JS sum — NOT a SQL SUM of a REAL column
  // Re-send the byte-identical chunk.
  const res2 = await importChunk(env, scopeAll(["P_A", "P_B"]), { import_id: "imp-idem", cursor: 0, rows }, false);
  assertEqual(res2.status, 200, "re-send accepted");
  assertEqual(txnCount(db), countAfterFirst, "row count unchanged on re-send");
  assertEqual(jsSum(amounts(db)), sumAfterFirst, "summed amount unchanged (no double count)");
  assertEqual(progress(db, "imp-idem").rows_committed, 2, "rows_committed not double-advanced");
});

// --- orphan property rejected LOUDLY; NO partial write ---------------------
await r.check("unresolved property rejected loudly; nothing lands (whole chunk atomic)", async () => {
  const { db, env } = freshEnv();
  // row 0 is valid; row 1 is an orphan. Whole chunk must reject with no writes.
  const chunk = {
    import_id: "imp-orphan",
    cursor: 0,
    rows: [rowA({ folio_number: "OK1" }), rowA({ folio_number: "ORPH", property_code: "RRI-DOES-NOT-EXIST" })],
  };
  const res = await importChunk(env, scopeAll(["P_A", "P_B"]), chunk, false);
  assertEqual(res.status, 422, "orphan must be a loud 4xx");
  assert(/row 1/.test(res.body.error), `error must name the offending row, got: ${res.body.error}`);
  assert(/did not resolve/.test(res.body.error), "error must state the property did not resolve");
  assertEqual(res.body.property_code, "RRI-DOES-NOT-EXIST", "error names the unresolved code");
  assertEqual(txnCount(db), 0, "NO orphan or partial row may land");
  assert(!progress(db, "imp-orphan"), "no progress row for a rejected chunk");
});

// ===========================================================================
// GOVERNING-CONTRACT REGRESSION — a property created via the Property ENTITY
// create path (a row in `property` with a canonical code, and NO
// property_id_map row) MUST be importable. This is the exact case the old
// resolver failed: it sourced resolution from `property_id_map`, which has no
// production writer, so an in-app-created property (row in `property`, none in
// `property_id_map`) 422'd with "property did not resolve" even though the
// server plainly owns the property. The row is seeded ONLY in `property` — NO
// property_id_map row — so this case is honest: it can only pass once the
// resolver reads the `property` table (property.id IS the server id, under
// UNIQUE(account_id, code)). Per-row assertPropertyInScope still applies: the
// server id must be in the caller's scope, and it is.
// ===========================================================================
await r.check("ENTITY-CREATED property (row in `property`, NO property_id_map row) is importable: resolves by code, 200, lands under the server id", async () => {
  const db = makeDb();
  db.prepare("INSERT INTO account (id, name, created_date) VALUES (?,?,?)").run("A_1", "Boston Hotels", "2026-01-01");
  // The Property ENTITY create path: a row in `property` with a canonical code,
  // and DELIBERATELY no property_id_map tuple for it. property.id is the server id.
  db.prepare(
    "INSERT INTO property (id, account_id, code, name, rooms, active, created_date) VALUES (?,?,?,?,?,?,?)",
  ).run("P_ENT", "A_1", "RRI-ENT", "Entity Created Property", 50, 1, "2026-01-01");
  // HONESTY PRECONDITIONS: the property row exists, and the map genuinely does
  // NOT know this code — so a pass can only come from reading the property table.
  assertEqual(
    db.prepare("SELECT id FROM property WHERE account_id = ? AND code = ?").get("A_1", "RRI-ENT").id,
    "P_ENT",
    "precondition: the property row exists with server id P_ENT",
  );
  assert(
    !db.prepare("SELECT 1 FROM property_id_map WHERE code = ?").get("RRI-ENT"),
    "precondition: RRI-ENT has NO property_id_map row (entity-create path only)",
  );
  const env = makeEnv(db);
  const row = rowA({ folio_number: "ENT-1", property_code: "RRI-ENT", amount: 123.45 });
  const res = await importChunk(env, scopeAll(["P_ENT"]), { import_id: "imp-entity", cursor: 0, rows: [row] }, false);
  assertEqual(res.status, 200, `an entity-created property must be importable, got ${JSON.stringify(res.body)}`);
  assertEqual(res.body.rows_inserted, 1, "the row is actually inserted");
  const stored = db.prepare("SELECT property_id FROM transaction_line WHERE folio_number = 'ENT-1'").get();
  assert(stored, "the transaction row landed");
  assertEqual(stored.property_id, "P_ENT", "committed under the SERVER property id taken from the property table");
  assertEqual(txnCount(db), 1, "exactly one row lands");
  assertEqual(progress(db, "imp-entity").rows_committed, 1, "progress counts the entity-property row exactly once");
});

// --- dedupe_key semantics with the SERVER property id ----------------------
await r.check("dedupe_key uses SERVER property id and matches transactionDedupeKey semantics", async () => {
  const { db, env } = freshEnv();
  const row = rowA({ folio_number: "DK", occurrence: 0, amount: 12.34 });
  await importChunk(env, scopeAll(["P_A", "P_B"]), { import_id: "imp-dk", cursor: 0, rows: [row] }, false);
  const stored = db.prepare("SELECT dedupe_key FROM transaction_line WHERE folio_number = 'DK'").get().dedupe_key;
  // worker/import.js exported key (server pid = P_A, NOT the client code)
  const workerKey = transactionDedupeKey({
    serverPropertyId: "P_A",
    date: row.date,
    time: row.time,
    folio_number: row.folio_number,
    transaction_code: row.transaction_code,
    amount: row.amount,
    occurrence: 0,
  });
  assertEqual(stored, workerKey, "stored key == worker transactionDedupeKey(components)");
  assert(!stored.includes("RRI-BOS"), "key must use server id P_A, never the client business code");
  // DELIBERATE DIVERGENCE FROM src/lib/transactionNorm.js (Change 9b).
  // This check used to require the worker key to be BYTE-IDENTICAL to the client's
  // `[...].join("|")` form. That requirement was itself the defect: the `|`-join is
  // forgeable, so mirroring it forced the worker to keep a silent-money-loss bug.
  // The worker key is now length-prefixed and the client's is NOT, so the two
  // formats intentionally differ until the Phase-2 client repoint. Pinned here so
  // the divergence cannot be mistaken for drift:
  assert(
    stored !== ["P_A", row.date, row.time, row.folio_number, row.transaction_code, row.amount, 0].join("|"),
    "the worker key must NOT be the forgeable client `join(\"|\")` form",
  );
  // PHASE-2 OBLIGATION (recorded, NOT satisfied here): when the client is
  // repointed at this Worker, src/lib/transactionNorm.js transactionDedupeKey must
  // adopt this same length-prefixed form, and scripts/probe-dedupe-indexed-lookup.mjs
  // must stop recovering the ISO date via `split("|")[1]` — it must read the row's
  // date field instead, because a length-prefixed key is no longer split-parseable
  // by that probe's assumption.
});

// --- byte-identical rows across a chunk boundary: distinct occurrence -> both persist
await r.check("byte-identical rows across chunk boundary (occ 0 & 1) both persist", async () => {
  const { db, env } = freshEnv();
  const base = { folio_number: "MULTI", amount: 75.0, date: "2026-02-05", time: "23:00:00", transaction_code: "RENT" };
  // occurrence 0 in chunk cursor 0
  await importChunk(env, scopeAll(["P_A", "P_B"]), { import_id: "imp-multi", cursor: 0, rows: [rowA({ ...base, occurrence: 0 })] }, false);
  // occurrence 1 in chunk cursor 1 (straddles the boundary; must NOT be dropped)
  await importChunk(env, scopeAll(["P_A", "P_B"]), { import_id: "imp-multi", cursor: 1, rows: [rowA({ ...base, occurrence: 1 })] }, false);
  assertEqual(txnCount(db), 2, "both legitimate multi-night postings persist as distinct rows");
});

await r.check("a TRUE duplicate (same occurrence) collapses", async () => {
  const { db, env } = freshEnv();
  const dup = rowA({ folio_number: "DUP", amount: 42.0, occurrence: 0 });
  await importChunk(env, scopeAll(["P_A", "P_B"]), { import_id: "imp-dup", cursor: 0, rows: [dup] }, false);
  // same row, same occurrence, later chunk -> must collapse (ON CONFLICT DO NOTHING)
  await importChunk(env, scopeAll(["P_A", "P_B"]), { import_id: "imp-dup", cursor: 1, rows: [dup] }, false);
  assertEqual(txnCount(db), 1, "true duplicate must not double-insert");
});

// --- resume: advance on new cursor; no-op on stale/committed cursor --------
await r.check("resume: new cursor continues; stale committed cursor is a no-op", async () => {
  const { db, env } = freshEnv();
  const first = [rowA({ folio_number: "R1" }), rowA({ folio_number: "R2" }), rowA({ folio_number: "R3" })];
  const second = [rowA({ folio_number: "R4" }), rowA({ folio_number: "R5" })];
  await importChunk(env, scopeAll(["P_A", "P_B"]), { import_id: "imp-res", cursor: 0, rows: first }, false);
  await importChunk(env, scopeAll(["P_A", "P_B"]), { import_id: "imp-res", cursor: 1, rows: second }, false);
  assertEqual(txnCount(db), 5, "cursor 1 continues from cursor 0");
  assertEqual(progress(db, "imp-res").rows_committed, 5, "rows_committed advanced to 5");
  assertEqual(progress(db, "imp-res").chunk_cursor, 1, "cursor advanced to 1");
  // Re-send the STALE cursor 0 chunk: rows collapse, progress does not regress/advance.
  const res = await importChunk(env, scopeAll(["P_A", "P_B"]), { import_id: "imp-res", cursor: 0, rows: first }, false);
  assertEqual(res.status, 200, "stale re-send accepted");
  assertEqual(txnCount(db), 5, "no new rows from a stale cursor");
  assertEqual(progress(db, "imp-res").rows_committed, 5, "rows_committed unchanged on stale cursor");
  assertEqual(progress(db, "imp-res").chunk_cursor, 1, "cursor does not regress below 1");
});

// --- money REAL round-trips exactly; no SQL SUM of a fractional column -----
await r.check("money REAL round-trips: 422.48 read back == 422.48 exactly", async () => {
  const { db, env } = freshEnv();
  await importChunk(env, scopeAll(["P_A", "P_B"]), { import_id: "imp-money", cursor: 0, rows: [rowA({ folio_number: "MON", amount: 422.48 })] }, false);
  const back = db.prepare("SELECT amount FROM transaction_line WHERE folio_number = 'MON'").get().amount;
  assert(back === 422.48, `REAL round-trip must be bit-exact, got ${back}`);
  assert(typeof back === "number", "amount is a JS Number (REAL), never rescaled to cents");
});

// --- import respects scope: out-of-scope property rejected -----------------
await r.check("'specific' user importing an out-of-scope property row => 403, nothing lands", async () => {
  const { db, env } = freshEnv();
  // Caller is scoped to P_A only; row resolves (via RRI-CAM) to P_B.
  const chunk = { import_id: "imp-scope", cursor: 0, rows: [rowA({ folio_number: "X", property_code: "RRI-CAM" })] };
  const res = await importChunk(env, scopeSpecific(["P_A"]), chunk, false);
  assertEqual(res.status, 403, "out-of-scope import must be denied");
  assert(/outside caller scope/.test(res.body.error), `error must state scope violation, got: ${res.body.error}`);
  assertEqual(txnCount(db), 0, "no cross-property row may land");
  assert(!progress(db, "imp-scope"), "no progress for a denied chunk");
});

// --- parseChunk envelope validation (loud rejection of malformed input) ----
await r.check("parseChunk rejects malformed envelopes and oversized chunks", async () => {
  assert(parseChunk(null).ok === false, "null body rejected");
  assert(parseChunk({ cursor: 0, rows: [] }).ok === false, "missing import_id rejected");
  assert(parseChunk({ import_id: "x", cursor: -1, rows: [] }).ok === false, "negative cursor rejected");
  assert(parseChunk({ import_id: "x", cursor: 0, rows: {} }).ok === false, "non-array rows rejected");
  const big = { import_id: "x", cursor: 0, rows: new Array(46).fill(rowA()) };
  assert(parseChunk(big).ok === false, "chunk over MAX_ROWS_PER_CHUNK rejected");
  assert(parseChunk({ import_id: "x", cursor: 0, rows: [] }).ok === true, "well-formed envelope accepted");
});

// --- missing/invalid occurrence rejected (client must assign globally) -----
await r.check("row without a valid occurrence is rejected (no per-chunk re-derivation)", async () => {
  const { db, env } = freshEnv();
  const bad = rowA({ folio_number: "NOOCC" });
  delete bad.occurrence;
  const res = await importChunk(env, scopeAll(["P_A", "P_B"]), { import_id: "imp-occ", cursor: 0, rows: [bad] }, false);
  assertEqual(res.status, 400, "missing occurrence must be a loud 400");
  assertEqual(txnCount(db), 0, "nothing lands");
});

// ===========================================================================
// F2 REGRESSION — D1 PER-INVOCATION QUERY BUDGET.
// The defect Agent D confirmed: resolveServerPropertyId used to issue 1-2 D1
// reads PER ROW before the batch, so a full chunk spent ~91 queries in ONE
// invocation while the file's own comment claimed "46 < 50". The node:sqlite
// shim has no query ceiling, so ONLY an explicit statement counter can catch
// this — hence makeInstrumentedEnv. Asserted invariant: a full
// MAX_ROWS_PER_CHUNK chunk stays under 50 executed statements AND no single
// statement binds more than 100 params, with every valid row still inserted.
// ===========================================================================
await r.check(`full ${MAX_ROWS_PER_CHUNK}-row chunk stays under the D1 query budget (<50) and inserts every row`, async () => {
  const db = makeDb();
  seedProperties(db);
  const { env, stats } = makeInstrumentedEnv(db);
  const rows = Array.from({ length: MAX_ROWS_PER_CHUNK }, (_, i) =>
    rowA({
      folio_number: `BUD-${i}`,
      property_code: i % 2 === 0 ? "RRI-BOS" : "RRI-CAM", // both maps exercised
      amount: 10 + i,
    }),
  );
  assertEqual(rows.length, MAX_ROWS_PER_CHUNK, "chunk is the maximum legal size");
  const res = await importChunk(env, SCOPE, { import_id: "imp-budget", cursor: 0, rows }, false);
  assertEqual(res.status, 200, `max-size chunk must commit, got ${JSON.stringify(res.body)}`);
  assertEqual(txnCount(db), MAX_ROWS_PER_CHUNK, "every valid row must be inserted");
  assert(
    stats.statements < D1_QUERIES_PER_INVOCATION,
    `executed ${stats.statements} statements in ONE invocation; D1 free-plan ceiling is ${D1_QUERIES_PER_INVOCATION} ` +
      `(pre-fix N+1 spent ~91 for a chunk this size)`,
  );
  assert(
    stats.maxParams <= D1_PARAMS_PER_STATEMENT,
    `widest statement bound ${stats.maxParams} params; D1 ceiling is ${D1_PARAMS_PER_STATEMENT}`,
  );
  // No per-row resolution reads may remain: property resolution is ONE batched
  // read, so total statements must be far below "1 per row" + the batch.
  const perRowReads = stats.calls.filter((c) => /FROM property\b/i.test(c.sql)).length;
  assertEqual(perRowReads, 1, `property resolution must be ONE batched read, saw ${perRowReads}`);
});

// --- F2 worst case: MAX_ROWS_PER_CHUNK rows across DISTINCT properties -----
// The batched IN-list is the only place param count scales with row count.
// CHANGE 10: there is now exactly ONE key space. 40 distinct property_codes = 40
// binds worst case, not 80, because property_local_id is never collected and
// never bound. Prove the worst case stays inside the 100-param statement ceiling
// and inside the 50-query invocation budget. The statement-count ceiling is the
// binding limit, and it is unchanged.
await r.check("worst-case chunk (every row a DISTINCT property) stays inside both D1 ceilings", async () => {
  const db = makeDb();
  db.prepare("INSERT INTO account (id, name) VALUES (?,?)").run("A_1", "Boston Hotels");
  const codes = [];
  for (let i = 0; i < MAX_ROWS_PER_CHUNK; i++) {
    const code = `RRI-W${String(i).padStart(2, "0")}`;
    codes.push(code);
    db.prepare("INSERT INTO property (id, account_id, code, name, rooms, active, created_date) VALUES (?,?,?,?,?,?,?)").run(
      `PW_${i}`,
      "A_1",
      code,
      `Worst ${i}`,
      10,
      1,
      "2026-01-01",
    );
    db.prepare("INSERT INTO property_id_map (account_id, local_numeric_id, code, server_id) VALUES (?,?,?,?)").run(
      "A_1",
      100 + i,
      code,
      `PW_${i}`,
    );
  }
  const { env, stats } = makeInstrumentedEnv(db);
  const scope = scopeAll(codes.map((_, i) => `PW_${i}`));
  // Every row carries a DISTINCT property_code, which is the ONLY key space the
  // resolver may bind under Change 10. No property_local_id is sent here: this
  // check measures the real worst case of the new contract. The separate
  // "param budget" check below proves a local id is not bound even when present.
  const rows = codes.map((code, i) =>
    rowA({ folio_number: `W-${i}`, property_code: code, amount: 5 + i }),
  );
  const res = await importChunk(env, scope, { import_id: "imp-worst", cursor: 0, rows }, false);
  assertEqual(res.status, 200, `worst-case chunk must commit, got ${JSON.stringify(res.body)}`);
  assertEqual(txnCount(db), MAX_ROWS_PER_CHUNK, "all distinct-property rows inserted");
  // NON-VACUITY, as an AGGREGATE invariant instead of a per-statement one.
  // Intent: prove this test really reached the hard case, i.e. all 40 distinct
  // codes were actually bound. Asserting that a SINGLE statement binds all 40
  // over-specifies the resolver: a legitimate refactor into two smaller reads is
  // equally correct and strictly safer against the 100-param ceiling, and must
  // not false-fail. So: sum the binds across the property read(s), and
  // separately require EVERY individual statement to stay inside the limit.
  const resolverReads = stats.calls.filter((c) => /FROM property\b/i.test(c.sql));
  assert(resolverReads.length >= 1, "non-vacuity: property resolution must actually have read the property table");
  const resolverParams = resolverReads.reduce((sum, c) => sum + c.paramCount, 0);
  assert(
    resolverParams >= MAX_ROWS_PER_CHUNK,
    `non-vacuity: resolution must bind every distinct property_code — at least ${MAX_ROWS_PER_CHUNK} params ` +
      `in total across ${resolverReads.length} read(s); saw ${resolverParams}, so this test is not exercising ` +
      `the real ceiling case`,
  );
  assert(
    resolverParams <= MAX_ROWS_PER_CHUNK + 1,
    `Resolver binds one account id plus at most ONE param per distinct property_code, so a ${MAX_ROWS_PER_CHUNK}-row chunk of ` +
      `distinct properties must bind at most ${MAX_ROWS_PER_CHUNK + 1} resolver params; saw ${resolverParams}`,
  );
  for (const c of resolverReads) {
    assert(
      c.paramCount <= D1_PARAMS_PER_STATEMENT,
      `a single resolution read bound ${c.paramCount} params; per-statement ceiling is ${D1_PARAMS_PER_STATEMENT}`,
    );
  }
  assert(
    stats.maxParams <= D1_PARAMS_PER_STATEMENT,
    `widest statement bound ${stats.maxParams} params with ${MAX_ROWS_PER_CHUNK} distinct properties; ` +
      `ceiling is ${D1_PARAMS_PER_STATEMENT}`,
  );
  assert(
    stats.statements < D1_QUERIES_PER_INVOCATION,
    `executed ${stats.statements} statements; ceiling is ${D1_QUERIES_PER_INVOCATION}`,
  );
});

// --- CHANGE 10: property_local_id is never BOUND, even when the client sends it
// The check above measures the new worst case with codes only, so it cannot see a
// resolver that still collects a second key space. This one sends BOTH on every
// row: 40 distinct codes AND 40 distinct local ids. The old two-key-space
// resolver bound 80 params via `code IN (…) OR local_numeric_id IN (…)`; under
// Change 10 the local ids must not appear in ANY bound param list, and the
// `local_numeric_id IN (…)` clause must be gone.
await r.check("CHANGE 10 param budget: the resolver binds ONE param per distinct property_code and NEVER binds a property_local_id", async () => {
  const db = makeDb();
  db.prepare("INSERT INTO account (id, name) VALUES (?,?)").run("A_1", "Boston Hotels");
  const codes = [];
  const localIds = new Set();
  for (let i = 0; i < MAX_ROWS_PER_CHUNK; i++) {
    const code = `RRI-B${String(i).padStart(2, "0")}`;
    codes.push(code);
    localIds.add(String(100 + i));
    db.prepare("INSERT INTO property (id, account_id, code, name, rooms, active, created_date) VALUES (?,?,?,?,?,?,?)").run(
      `PB_${i}`, "A_1", code, `Budget ${i}`, 10, 1, "2026-01-01",
    );
    db.prepare("INSERT INTO property_id_map (account_id, local_numeric_id, code, server_id) VALUES (?,?,?,?)").run(
      "A_1", 100 + i, code, `PB_${i}`,
    );
  }
  const { env, stats } = makeInstrumentedEnv(db);
  const scope = scopeAll(codes.map((_, i) => `PB_${i}`));
  // Each row's local id AGREES with its code, so the row is legitimate and must
  // commit: this check is about BINDINGS, not about status.
  const rows = codes.map((code, i) =>
    rowA({ folio_number: `PB-${i}`, property_code: code, property_local_id: 100 + i, amount: 5 + i }),
  );
  const res = await importChunk(env, scope, { import_id: "imp-parambudget", cursor: 0, rows }, false);
  assertEqual(res.status, 200, `every row carries a resolvable code, so the chunk must commit, got ${JSON.stringify(res.body)}`);
  assertEqual(txnCount(db), MAX_ROWS_PER_CHUNK, "every row inserted BY CODE");
  const resolverReads = stats.calls.filter((c) => /FROM property\b/i.test(c.sql));
  assert(resolverReads.length >= 1, "non-vacuity: property resolution must actually have read the property table");
  const resolverParams = resolverReads.reduce((sum, c) => sum + c.paramCount, 0);
  assertEqual(
    resolverParams,
    MAX_ROWS_PER_CHUNK + 1,
    `the resolver must bind one account id plus one param per distinct property_code (${MAX_ROWS_PER_CHUNK + 1}), NOT two key ` +
      `spaces (${2 * MAX_ROWS_PER_CHUNK}); SQL: ${JSON.stringify(resolverReads.map((c) => c.sql))}`,
  );
  for (const c of resolverReads) {
    assert(
      !/local_numeric_id\s*\bIN\b/i.test(c.sql),
      `the resolver must no longer look properties up by local_numeric_id; SQL: ${c.sql}`,
    );
  }
  // THE NEGATIVE, across EVERY executed statement: no value derived from a
  // property_local_id may reach D1 as a bound param.
  for (const c of stats.calls) {
    for (const p of c.params) {
      assert(
        !localIds.has(String(p)),
        `a property_local_id (${String(p)}) was BOUND as a D1 param in: ${c.sql}. Under Change 10 the client's ` +
          `browser-local id is IGNORED — never read for resolution, never bound.`,
      );
    }
  }
});

// ===========================================================================
// F3 REGRESSION — rows_committed must count rows ACTUALLY INSERTED.
// Pre-fix it advanced by chunk.rows.length, so a chunk containing an already-
// committed row inflated the counter past the real row count.
// ===========================================================================
await r.check("rows_committed advances by rows ACTUALLY inserted, not rows submitted", async () => {
  const { db, env } = freshEnv();
  const first = rowA({ folio_number: "F3-1", amount: 100.25 });
  const r1 = await importChunk(env, SCOPE, { import_id: "imp-f3", cursor: 0, rows: [first] }, false);
  assertEqual(r1.status, 200, "first chunk commits");
  assertEqual(r1.body.rows_inserted, 1, "first chunk inserted 1");
  assertEqual(progress(db, "imp-f3").rows_committed, 1, "rows_committed = 1 after first chunk");

  // Chunk 2 mixes a duplicate of the committed row with one genuinely new row.
  const fresh = rowA({ folio_number: "F3-2", amount: 50.5 });
  const r2 = await importChunk(env, SCOPE, { import_id: "imp-f3", cursor: 1, rows: [first, fresh] }, false);
  assertEqual(r2.status, 200, "mixed chunk commits");
  assertEqual(r2.body.rows_inserted, 1, "only the genuinely new row counts as inserted (submitted 2)");
  assertEqual(txnCount(db), 2, "exactly 2 rows in the table (the duplicate collapsed)");
  const p = progress(db, "imp-f3");
  assertEqual(p.rows_committed, 2, "rows_committed = 2, NOT 3 (must not count the submitted duplicate)");
  assertEqual(p.rows_committed, txnCount(db), "rows_committed must equal the real row count");
  assertEqual(p.chunk_cursor, 1, "cursor still advances");
  assertEqual(jsSum(amounts(db)), 150.75, "JS-summed money is correct (no double count)");
});

// ===========================================================================
// DURABLE REGRESSION COVERAGE — D1 BUDGET GATE ON THE PUBLIC ENTRY POINT.
// importChunk is an exported function; callers reach it WITHOUT going through
// parseChunk. The size invariant used to live only in parseChunk, so an
// oversized chunk arriving here would have executed rows+4 statements and bound
// 2*rows params, blowing both D1 per-invocation ceilings.
// ===========================================================================
function freshInstrumented() {
  const db = makeDb();
  seedProperties(db);
  const { env, stats, reset } = makeInstrumentedEnv(db);
  return { db, env, stats, reset };
}
const writeCalls = (stats) => stats.calls.filter((c) => /^\s*INSERT|^\s*UPDATE|^\s*DELETE/i.test(c.sql));

await r.check("oversized chunk reaching importChunk DIRECTLY (bypassing parseChunk) => 400, nothing written", async () => {
  const { db, env, stats } = freshInstrumented();
  const rows = Array.from({ length: 45 }, (_, i) => rowA({ folio_number: `OVER-${i}` }));
  assert(rows.length > MAX_ROWS_PER_CHUNK, "precondition: chunk is genuinely oversized");
  const res = await importChunk(env, SCOPE, { import_id: "imp-oversize", cursor: 0, rows }, false);
  assertEqual(res.status, 400, `oversized chunk must be a loud 400, got ${JSON.stringify(res.body)}`);
  assert(
    new RegExp(`MAX_ROWS_PER_CHUNK \\(${MAX_ROWS_PER_CHUNK}\\)`).test(String(res.body.error)),
    `error must name the limit, got: ${res.body.error}`,
  );
  assert(/received 45 rows/.test(String(res.body.error)), `error must name what arrived, got: ${res.body.error}`);
  assertEqual(txnCount(db), 0, "NOTHING may land from an oversized chunk");
  assert(!progress(db, "imp-oversize"), "no progress row for a rejected oversized chunk");
  assertEqual(stats.statements, 0, "the size gate must reject BEFORE any D1 query is spent");
});

// ===========================================================================
// DURABLE REGRESSION COVERAGE — CURSOR SEQUENCE GATE.
// Pre-fix an out-of-order chunk was WRITTEN but its inserts were never counted
// into rows_committed, so the counter under-reported permanently.
// ===========================================================================
await r.check("brand-new import starting at cursor 3 => 409 expected_cursor 0, nothing written", async () => {
  const { db, env } = freshEnv();
  const res = await importChunk(
    env,
    SCOPE,
    { import_id: "imp-newgap", cursor: 3, rows: [rowA({ folio_number: "NG1" })] },
    false,
  );
  assertEqual(res.status, 409, `a new import must not start mid-stream, got ${JSON.stringify(res.body)}`);
  assertEqual(res.body.expected_cursor, 0, "409 must name expected_cursor 0 so the client can resume correctly");
  assertEqual(res.body.import_id, "imp-newgap", "409 names the import");
  assertEqual(txnCount(db), 0, "nothing may land from an out-of-sequence chunk");
  assert(!progress(db, "imp-newgap"), "no progress row created by a rejected chunk");
});

await r.check("out-of-order cursor 5 after cursor 0 => 409 expected_cursor 1, nothing written; resume is exact", async () => {
  const { db, env } = freshEnv();
  const first = [rowA({ folio_number: "SQ1" }), rowA({ folio_number: "SQ2" })];
  const r0 = await importChunk(env, SCOPE, { import_id: "imp-seq", cursor: 0, rows: first }, false);
  assertEqual(r0.status, 200, "cursor 0 commits");
  const countAfter0 = txnCount(db);
  assertEqual(countAfter0, 2, "two rows after cursor 0");

  const gap = [rowA({ folio_number: "SQ-GAP-1" }), rowA({ folio_number: "SQ-GAP-2" })];
  const r5 = await importChunk(env, SCOPE, { import_id: "imp-seq", cursor: 5, rows: gap }, false);
  assertEqual(r5.status, 409, `a gap must be a loud 409, got ${JSON.stringify(r5.body)}`);
  assertEqual(r5.body.expected_cursor, 1, "409 must name expected_cursor 1 (last committed 0)");
  assertEqual(txnCount(db), countAfter0, "GAP ROWS MUST NOT BE WRITTEN (pre-fix they were, and were never counted)");
  assertEqual(progress(db, "imp-seq").rows_committed, 2, "rows_committed unchanged by the rejected gap");
  assertEqual(progress(db, "imp-seq").chunk_cursor, 0, "cursor must not jump to 5");

  // Resuming at the expected cursor then succeeds, with an EXACT count.
  const r1 = await importChunk(env, SCOPE, { import_id: "imp-seq", cursor: 1, rows: gap }, false);
  assertEqual(r1.status, 200, `resume at the expected cursor must commit, got ${JSON.stringify(r1.body)}`);
  assertEqual(r1.body.rows_inserted, 2, "both resumed rows inserted");
  assertEqual(txnCount(db), 4, "four rows after the resume");
  const p = progress(db, "imp-seq");
  assertEqual(p.chunk_cursor, 1, "cursor advanced to 1");
  assertEqual(p.rows_committed, 4, "rows_committed is EXACT (2 + 2), never under-counted by the earlier gap");
  assertEqual(p.rows_committed, txnCount(db), "rows_committed equals the real row count");
});

await r.check("stale already-committed cursor => 200 normal body, rows_inserted 0, and a TRUE no-op (1 statement)", async () => {
  const { db, env, stats, reset } = freshInstrumented();
  const rows = [rowA({ folio_number: "ST1" }), rowA({ folio_number: "ST2" })];
  const r0 = await importChunk(env, SCOPE, { import_id: "imp-stale", cursor: 0, rows }, false);
  assertEqual(r0.status, 200, "cursor 0 commits");
  const r1 = await importChunk(env, SCOPE, { import_id: "imp-stale", cursor: 1, rows: [rowA({ folio_number: "ST3" })] }, false);
  assertEqual(r1.status, 200, "cursor 1 commits");
  assertEqual(txnCount(db), 3, "three rows committed");

  reset();
  const stale = await importChunk(env, SCOPE, { import_id: "imp-stale", cursor: 0, rows }, false);
  assertEqual(stale.status, 200, "an already-committed cursor is an idempotent 200, not an error");
  // Normal body shape — the client must not have to special-case a retry.
  assertEqual(stale.body.import_id, "imp-stale", "body.import_id");
  assertEqual(stale.body.cursor, 0, "body.cursor echoes what was sent");
  assertEqual(stale.body.next_cursor, 2, "next_cursor points at where to actually resume");
  assertEqual(stale.body.rows_received, 2, "body.rows_received");
  assertEqual(stale.body.rows_inserted, 0, "a stale cursor inserts NOTHING");
  assertEqual(stale.body.status, "in_progress", "body.status");
  // TRUE no-op, proven by statement count: the progress read and nothing else.
  assertEqual(stats.statements, 1, `stale cursor must cost exactly ONE statement (the progress read), saw ${JSON.stringify(stats.calls.map((c) => c.sql))}`);
  assert(/FROM import_progress/i.test(stats.calls[0].sql), `the one statement must be the progress read, got: ${stats.calls[0].sql}`);
  assertEqual(writeCalls(stats).length, 0, "ZERO writes for a stale cursor");
  assertEqual(txnCount(db), 3, "row count unchanged");
  assertEqual(progress(db, "imp-stale").rows_committed, 3, "rows_committed unchanged");
  assertEqual(progress(db, "imp-stale").chunk_cursor, 1, "cursor does not regress");
});

// ===========================================================================
// INTRA-CHUNK DUPLICATE DEDUPE KEY (coverage hole).
// Every other idempotency check collides rows ACROSS chunks. An implementation
// that counted `keys.length - existing.size` instead of DISTINCT keys would
// over-count here while every pre-existing assertion still passed.
// ===========================================================================
await r.check("SAME dedupe key twice in ONE chunk: one row lands and is counted ONCE", async () => {
  const { db, env } = freshEnv();
  const dup = rowA({ folio_number: "INTRA", amount: 33.33, occurrence: 7 });
  const res = await importChunk(
    env,
    SCOPE,
    { import_id: "imp-intra", cursor: 0, rows: [{ ...dup }, { ...dup }] },
    false,
  );
  assertEqual(res.status, 200, `chunk must commit, got ${JSON.stringify(res.body)}`);
  assertEqual(res.body.rows_received, 2, "two rows were submitted");
  assertEqual(res.body.rows_inserted, 1, "an intra-chunk duplicate must be counted ONCE, not twice");
  assertEqual(txnCount(db), 1, "exactly one row lands (UNIQUE dedupe_key + ON CONFLICT DO NOTHING)");
  assertEqual(progress(db, "imp-intra").rows_committed, 1, "rows_committed must be 1, not 2");
  assertEqual(progress(db, "imp-intra").rows_committed, txnCount(db), "rows_committed equals the real row count");
  assertEqual(jsSum(amounts(db)), 33.33, "JS-summed money counts the row once");
});

// ===========================================================================
// EXPLICIT CEILING GUARDS. A bare `< 50` check would let a silent revert to 45
// rows/chunk stay green, and a loosened statement budget would go unnoticed.
// ===========================================================================
await r.check("MAX_ROWS_PER_CHUNK is pinned to 40 and a full chunk costs at most 44 statements", async () => {
  assertEqual(
    MAX_ROWS_PER_CHUNK,
    40,
    "MAX_ROWS_PER_CHUNK must stay 40: deliberate headroom under the 50-query D1 ceiling, because it is " +
      "NOT certain how D1 counts the worker/db.js wrappers and the implicit transaction around batch(). " +
      "45 rows would arithmetically fit (49) with ZERO margin and is a known-bad prior value",
  );
  const { db, env, stats } = freshInstrumented();
  const rows = Array.from({ length: MAX_ROWS_PER_CHUNK }, (_, i) =>
    rowA({ folio_number: `CEIL-${i}`, property_code: i % 2 === 0 ? "RRI-BOS" : "RRI-CAM", amount: 20 + i }),
  );
  const res = await importChunk(env, SCOPE, { import_id: "imp-ceiling", cursor: 0, rows }, false);
  assertEqual(res.status, 200, `full chunk must commit, got ${JSON.stringify(res.body)}`);
  assertEqual(txnCount(db), MAX_ROWS_PER_CHUNK, "every row inserted");
  // Derivation: 1 property resolution read + 1 countNewKeys read + 1 progress
  // read + 40 single-row INSERTs + 1 progress upsert = 44.
  const FULL_CHUNK_STATEMENT_BUDGET = 3 + MAX_ROWS_PER_CHUNK + 1;
  assertEqual(FULL_CHUNK_STATEMENT_BUDGET, 44, "budget derivation must stay 44 while MAX_ROWS_PER_CHUNK is 40");
  assert(
    stats.statements <= FULL_CHUNK_STATEMENT_BUDGET,
    `a full chunk executed ${stats.statements} statements; the exact budget is ${FULL_CHUNK_STATEMENT_BUDGET} ` +
      `(1 resolver + 1 countNewKeys + 1 progress read + ${MAX_ROWS_PER_CHUNK} inserts + 1 progress upsert)`,
  );
  assert(
    stats.statements >= MAX_ROWS_PER_CHUNK + 1,
    `non-vacuity: only ${stats.statements} statements executed, so the full chunk was not actually written`,
  );
});

// ===========================================================================
// CHANGE 10 — `property_code` IS REQUIRED; `property_local_id` IS IGNORED.
//
// OWNER DECISION being encoded: remove `property_local_id` as an import
// resolution key, require canonical `property_code` for every property-scoped
// imported row, and never silently fall back to browser-local numeric ids.
//
// WHY THE FALLBACK WAS WRONG DATA, not merely weaker evidence: `property_id_map`
// has no production writer; Phase 1 population is out-of-band operator SQL that
// inserts ONE TUPLE PER PROPERTY (local_numeric_id, code, server_id) under
// PRIMARY KEY (code) + UNIQUE (local_numeric_id) (worker/schema.sql:118-124).
// A browser-local numeric id is Dexie autoincrement output: it is stable only
// within ONE browser profile. Resolving an import row by it attributes money to
// whichever property happens to hold that number on the SERVER, with no error at
// all. There is no way for the server to detect the misalignment, because a
// local-id-only row carries no second reference to disagree with.
//
// THE TWO REJECTION SHAPES MUST STAY DISTINGUISHABLE. `missing_code` (the row
// never named a canonical property) and `unresolved` (the row named one the
// server does not know) demand different operator action: re-export from the
// canonical browser vs. create/seed the property. An implementation that deletes
// the fallback and lets both fall into `property did not resolve` is the most
// plausible incomplete fix and passes any status-only test, so every check below
// pins the exact discriminator text.
// ===========================================================================

await r.check("local-id-only row (property_local_id, NO property_code) => 422 missing_code, NOTHING lands, and it is NOT reported as unresolved", async () => {
  const { db, env } = freshEnv();
  const numericRow = rowA({ folio_number: "LOC-NUM", amount: 61.5 });
  delete numericRow.property_code;
  numericRow.property_local_id = 1; // MAPPED: local_numeric_id 1 -> P_A, in SCOPE
  assert(numericRow.property_code === undefined, "precondition: the row carries NO property_code");
  assertEqual(
    db.prepare("SELECT server_id FROM property_id_map WHERE local_numeric_id = 1").get().server_id,
    "P_A",
    "precondition: local_numeric_id 1 IS mapped, to P_A, and P_A is in SCOPE — so NOTHING but the contract " +
      "stops this row from landing. That is what makes this the central positive test of Change 10",
  );

  const res = await importChunk(env, SCOPE, { import_id: "imp-local", cursor: 0, rows: [numericRow] }, false);
  assertEqual(res.status, 422, `a local-id-only row must be REFUSED, got ${JSON.stringify(res.body)}`);
  assertEqual(
    String(res.body.error),
    expectMissingCode("imp-local", 0, 0),
    "the rejection must be the missing_code discriminator, verbatim",
  );
  // THE DISCRIMINATOR, stated as a negative too: merely deleting the fallback
  // would answer 422 with `property did not resolve`, which sends the operator
  // hunting a missing property when the real fault is a stale client that never
  // sent a canonical code.
  assert(
    !new RegExp(UNRESOLVED_TEXT).test(String(res.body.error)),
    `a missing property_code must NOT masquerade as an unresolved property, got: ${res.body.error}`,
  );
  // DIAGNOSTICS ONLY: the body shows the operator that a stale client sent a
  // browser-local id, which is the single most useful clue for fixing the export.
  assertEqual(res.body.property_local_id, "1", "body carries the offending local id as DIAGNOSTICS");
  assertEqual(res.body.property_code, null, "body echoes the absent property_code as null");
  assertEqual(txnCount(db), 0, "ZERO rows may land: the local id is not a resolution key");
  assert(!progress(db, "imp-local"), "no import_progress row for a rejected chunk");

  // WIRE-FORMAT VARIANT: JSON stringifies ids, so a stale client may send the
  // local id as a STRING. That must be refused identically — a fix that only
  // dropped the numeric branch of the fallback would let this one through.
  const str = freshEnv();
  const stringRow = rowA({ folio_number: "LOC-STR", amount: 12.5, occurrence: 3 });
  delete stringRow.property_code;
  stringRow.property_local_id = "2"; // string form of local_numeric_id 2 -> P_B
  const res2 = await importChunk(str.env, SCOPE, { import_id: "imp-local-str", cursor: 0, rows: [stringRow] }, false);
  assertEqual(res2.status, 422, `a string-form local id must be REFUSED too, got ${JSON.stringify(res2.body)}`);
  assertEqual(
    String(res2.body.error),
    expectMissingCode("imp-local-str", 0, 0),
    "the string-form local id must produce the SAME missing_code discriminator",
  );
  assertEqual(res2.body.property_local_id, "2", "body carries the string-form local id as DIAGNOSTICS");
  assertEqual(txnCount(str.db), 0, "ZERO rows may land for the string-form local id either");
  assert(!progress(str.db, "imp-local-str"), "no import_progress row for the rejected string-form chunk");

  // LATER-ROW WHOLE-CHUNK ATOMICITY. The offending row is NOT row 0, so a per-row
  // `continue`, or a rejection raised only after the batch is built, would leave
  // the perfectly valid row 0 behind. It must not. This is the shape the deleted
  // contradiction later-row check used to own.
  const late = freshEnv();
  const rows = [
    rowA({ folio_number: "LATER-OK" }), // valid: resolves to P_A by canonical code
    rowA({ folio_number: "LATER-BAD" }), // property_code deleted below
  ];
  delete rows[1].property_code;
  rows[1].property_local_id = 2; // mapped to P_B — still not a resolution key
  const res3 = await importChunk(late.env, SCOPE, { import_id: "imp-local-late", cursor: 0, rows }, false);
  assertEqual(res3.status, 422, `a missing code anywhere in the chunk must reject it, got ${JSON.stringify(res3.body)}`);
  assertEqual(
    String(res3.body.error),
    expectMissingCode("imp-local-late", 0, 1),
    "the rejection must name the LATER offending row (row 1) with the missing_code discriminator",
  );
  assert(!/\brow 0\b/.test(String(res3.body.error)), `error must not blame the innocent row 0, got: ${res3.body.error}`);
  assertEqual(txnCount(late.db), 0, "whole-chunk atomicity: the VALID row 0 must NOT land when a later row has no code");
  assert(
    !late.db.prepare("SELECT id FROM transaction_line WHERE folio_number = 'LATER-OK'").get(),
    "the valid row preceding the offending row is specifically absent",
  );
  assert(!progress(late.db, "imp-local-late"), "no import_progress row for a rejected chunk");
});


// ===========================================================================
// CHANGE 10 — `property_local_id` IS IGNORED, NOT ARBITRATED.
//
// This block previously pinned a `contradiction` contract: a row claiming BOTH a
// property_code and a property_local_id that resolved to DIFFERENT server
// properties was rejected 422 so the operator could see that the client's
// local-id numbering was misaligned. Change 10 removes the premise: the local id
// is no longer a resolution key at ALL, so there is no second resolution to
// disagree with and nothing to arbitrate. Three checks that asserted the
// contradiction 422 (forward, later-row, reverse-direction) were DELETED here —
// they are unfalsifiable once the variant is gone. The later-row whole-chunk
// atomicity claim they carried was NOT dropped: it moved into the missing_code
// check above, which rejects a chunk whose OFFENDING ROW IS ROW 1 and proves the
// valid row 0 does not land.
//
// What survives, and why each one is load-bearing:
//   * the IGNORE-CLAUSE guard: a row with a usable code plus ANY property_local_id
//     (agreeing, disagreeing, garbage) resolves BY CODE, 200, with a success body
//     that gained no warning channel;
//   * the REJECTION COST guard: a chunk with no usable code anywhere must not
//     spend a single D1 query on resolution.
// ===========================================================================

/** Exact key set of the success body; nothing may add to it. */
const SUCCESS_BODY_KEYS = ["cursor", "import_id", "next_cursor", "rows_inserted", "rows_received", "status"];




await r.check("IGNORE CLAUSE: a usable property_code plus ANY property_local_id (agreeing, DISAGREEING, garbage) resolves BY CODE, 200, SILENTLY", async () => {
  const { db, env } = freshEnv();
  // RRI-BOS and local_numeric_id 1 both map to P_A: the local id is irrelevant,
  // not "agreeing". An over-broad "two references present => reject" rule fails here.
  const agree = rowA({ folio_number: "AGREE-A", amount: 44.5, property_code: "RRI-BOS", property_local_id: 1 });
  const res = await importChunk(env, SCOPE, { import_id: "imp-agree", cursor: 0, rows: [agree] }, false);
  assertEqual(res.status, 200, `an ignored local id must not stop the row, got ${JSON.stringify(res.body)}`);
  assertEqual(res.body.rows_inserted, 1, "the row is actually inserted");
  const stored = db
    .prepare("SELECT property_id, dedupe_key FROM transaction_line WHERE folio_number = 'AGREE-A'")
    .get();
  assertEqual(stored.property_id, "P_A", "commits to the property the CODE named");
  // Format-agnostic (Change 9b made the key length-prefixed): the server id's text
  // sits in the FIRST component, before any delimiter.
  assert(
    stored.dedupe_key.indexOf("P_A") >= 0 && stored.dedupe_key.indexOf("P_A") < stored.dedupe_key.indexOf("|"),
    `dedupe key must lead with the code-resolved server id, got ${stored.dedupe_key}`,
  );
  // SILENTLY: no warning channel may appear on the success path. This is the only
  // thing stopping a later "helpful" warn/contradiction field from reappearing
  // once the local id is officially ignored.
  assertEqual(
    JSON.stringify(Object.keys(res.body).sort()),
    JSON.stringify(SUCCESS_BODY_KEYS),
    "the success body shape must be unchanged by the presence of an ignored property_local_id",
  );
  for (const k of Object.keys(res.body)) {
    assert(!/warn|contradict|conflict/i.test(k), `an ignored local id must be silent; saw body key ${k}`);
  }
  assertEqual(progress(db, "imp-agree").rows_committed, 1, "progress counts the row exactly once");

  // THE LOAD-BEARING HALF: local ids that DISAGREE with the code, or are outright
  // junk, are equally irrelevant. Under the old contract the disagreeing case was
  // a 422 contradiction; under Change 10 the code decides and nothing else is
  // consulted, so every one of these must commit BY CODE to P_A.
  /** @type {[string, unknown][]} */
  const IGNORED = [
    ["2 (DISAGREEING: local_numeric_id 2 is P_B while the code is P_A)", 2],
    ['"2" (disagreeing, string wire form)', "2"],
    ["999 (unmapped)", 999],
    ["true (boolean)", true],
    ['"garbage" (non-numeric string)', "garbage"],
    ["{} (object)", {}],
    ["0 (never a real Dexie id)", 0],
  ];
  for (const [label, value] of IGNORED) {
    const f = freshEnv();
    const row = rowA({ folio_number: "IGNORED", amount: 17.25, property_code: "RRI-BOS" });
    row.property_local_id = value;
    const out = await importChunk(f.env, SCOPE, { import_id: "imp-ignored", cursor: 0, rows: [row] }, false);
    assertEqual(out.status, 200, `property_local_id ${label} must be IGNORED, not arbitrated, got ${JSON.stringify(out.body)}`);
    assertEqual(
      f.db.prepare("SELECT property_id FROM transaction_line WHERE folio_number = 'IGNORED'").get().property_id,
      "P_A",
      `${label}: the row must land on the property its CODE names`,
    );
    assertEqual(txnCount(f.db), 1, `${label}: exactly one row lands`);
    assertEqual(
      JSON.stringify(Object.keys(out.body).sort()),
      JSON.stringify(SUCCESS_BODY_KEYS),
      `${label}: the success body must gain no diagnostic channel`,
    );
  }
});

await r.check("REJECTION COST: a chunk with NO usable property_code anywhere costs EXACTLY 1 statement (the cursor read); the resolver never queries", async () => {
  const { db, env, stats } = freshInstrumented();
  // Neither row carries a usable code, so buildPropertyResolver has nothing to
  // look up and must early-return WITHOUT a query. The old resolver still issued
  // its batched read here, because it collected property_local_id as a key space.
  const a = rowA({ folio_number: "COST-1", amount: 21.0 });
  delete a.property_code;
  a.property_local_id = 1; // mapped, and still not a resolution key
  const b = rowA({ folio_number: "COST-2", amount: 22.0, occurrence: 1, property_code: "" });
  b.property_local_id = 2;
  const res = await importChunk(env, SCOPE, { import_id: "imp-cost", cursor: 0, rows: [a, b] }, false);
  assertEqual(res.status, 422, `precondition: the codeless chunk is rejected, got ${JSON.stringify(res.body)}`);
  assertEqual(
    String(res.body.error),
    expectMissingCode("imp-cost", 0, 0),
    "precondition: rejected on row 0 with the missing_code discriminator",
  );
  assertEqual(
    stats.statements,
    1,
    `a chunk with no usable property_code must cost EXACTLY 1 statement (the cursor-gate progress read) — the ` +
      `resolver has nothing to look up and must not query at all; saw ${JSON.stringify(stats.calls.map((c) => c.sql))}`,
  );
  assert(/FROM import_progress/i.test(stats.calls[0].sql), `the one statement must be the cursor gate, got: ${stats.calls[0].sql}`);
  assertEqual(
    stats.calls.filter((c) => /FROM property\b/i.test(c.sql)).length,
    0,
    "ZERO property-table reads: with no usable code, resolution has nothing to resolve",
  );
  assertEqual(
    stats.calls.filter((c) => /FROM transaction_line/i.test(c.sql)).length,
    0,
    "the dedupe-key pre-read must never be reached: the chunk is already doomed",
  );
  assertEqual(writeCalls(stats).length, 0, "ZERO writes for a rejected chunk");
  assertEqual(txnCount(db), 0, "nothing lands");
  assert(!progress(db, "imp-cost"), "no import_progress row for a rejected chunk");
});


// ===========================================================================
// THE `unresolved` DISCRIMINATOR, AND THE STANDING GUARD AGAINST RESTORING THE
// FALLBACK (this block was the Change 7 regression set).
//
// An UNRESOLVABLE property_code together with a RESOLVABLE property_local_id is
// the one row shape on which "resolve by code only" and "fall back to the local
// id" disagree in WHERE THE MONEY LANDS, so it stays as a permanent guard: if
// anyone reintroduces the fallback, this row silently commits to the property its
// local id names while its code named something else.
//
// property_id_map is seeded ONE TUPLE PER PROPERTY, (local_numeric_id, code,
// server_id), under PRIMARY KEY (code) + UNIQUE (local_numeric_id)
// (worker/schema.sql:118-124). So WITHIN a mapped property the code and the local
// id share a server_id, and an UNMAPPED code plus a MAPPED local id therefore
// requires that local id to belong to a DIFFERENT code. Such a row would be
// committed to a property it EXPLICITLY NAMED AS SOMETHING ELSE.
//
// The checks after it pin the OTHER 422 shape, `missing_code`, across every JSON
// value a client serializer emits for "no code": "", null, and a bare number.
// Under the OLD contract those were NEGATIVE CONTROLS that had to keep the
// fallback alive; under Change 10 they are positive tests of the required-code
// clause, which is why their expectations inverted from 200 to 422.
// ===========================================================================

await r.check("UNRESOLVED: a usable property_code that is NOT in property_id_map => 422 'property did not resolve'; a resolvable property_local_id does NOT rescue it, and the body does not echo it", async () => {
  const { db, env } = freshEnv();
  // Preconditions that make this the genuine defect shape rather than a coincidence.
  assert(
    !db.prepare("SELECT 1 FROM property_id_map WHERE code = ?").get("RRI-DOES-NOT-EXIST"),
    "precondition: the property_code is genuinely UNMAPPED",
  );
  assertEqual(
    db.prepare("SELECT server_id FROM property_id_map WHERE local_numeric_id = 1").get().server_id,
    "P_A",
    "precondition: local_numeric_id 1 IS mapped, to P_A, and P_A is in SCOPE — so if the fallback is ever " +
      "restored, this row lands on P_A instead of being refused",
  );
  const misattributed = rowA({
    folio_number: "C7-DEFECT",
    amount: 77.25,
    property_code: "RRI-DOES-NOT-EXIST",
    property_local_id: 1,
  });
  const res = await importChunk(env, SCOPE, { import_id: "imp-c7", cursor: 0, rows: [misattributed] }, false);
  assertEqual(res.status, 422, `an unresolvable code must NOT fall back to the local id, got ${JSON.stringify(res.body)}`);
  assertEqual(
    String(res.body.error),
    expectUnresolved("imp-c7", 0, 0),
    "the rejection must be the UNRESOLVED discriminator, verbatim: the row DID name a canonical property, the " +
      "server just does not know it. That is a different operator action from missing_code",
  );
  assert(
    !new RegExp(MISSING_CODE_TEXT.slice(0, 24)).test(String(res.body.error)),
    `an unresolvable code must NOT be reported as a MISSING code, got: ${res.body.error}`,
  );
  assertEqual(res.body.property_code, "RRI-DOES-NOT-EXIST", "body echoes the unmapped client code");
  // THE ECHO IS REMOVED FROM THIS BODY. `property_local_id` survives ONLY in the
  // missing_code body, where it is the diagnostic that explains the rejection.
  // Here the local id is irrelevant to why the row failed, and echoing it invites
  // an operator to "fix" the import by trusting it.
  assert(
    !("property_local_id" in res.body),
    `the unresolved body must NOT carry a property_local_id key, got keys ${JSON.stringify(Object.keys(res.body).sort())}`,
  );
  for (const k of Object.keys(res.body)) {
    assert(!/local/i.test(k), `the unresolved body must not reference the browser-local id at all; saw key ${k}`);
  }
  // THE LOAD-BEARING ASSERTIONS: it must land NOTHING, not merely answer 422.
  assertEqual(txnCount(db), 0, "NOTHING may land from a row whose named property is unknown to the server");
  assertEqual(
    db.prepare("SELECT COUNT(*) c FROM transaction_line WHERE property_id = 'P_A'").get().c,
    0,
    "specifically: the row must NOT be committed to P_A, the property its local id names but its code denies",
  );
  assert(!progress(db, "imp-c7"), "no import_progress row for a rejected chunk");
});

await r.check('MISSING CODE: property_code "" (empty string) + mapped local id => 422 missing_code, ZERO rows land', async () => {
  const { db, env } = freshEnv();
  // Under the OLD contract "" counted as ABSENT and this row resolved 200 through
  // the local-id fallback. Change 10 makes "" a REFUSAL: a client serializer that
  // emits property_code: "" is exactly the stale exporter the owner decision is
  // aimed at, and its rows must fail loudly instead of being attributed by a
  // browser-local number.
  const row = rowA({ folio_number: "C7-EMPTY", amount: 15.5, property_code: "", property_local_id: 1 });
  const res = await importChunk(env, SCOPE, { import_id: "imp-c7-empty", cursor: 0, rows: [row] }, false);
  assertEqual(res.status, 422, `an empty-string code must be REFUSED, got ${JSON.stringify(res.body)}`);
  assertEqual(
    String(res.body.error),
    expectMissingCode("imp-c7-empty", 0, 0),
    'property_code "" must produce the missing_code discriminator, verbatim',
  );
  assert(
    !new RegExp(UNRESOLVED_TEXT).test(String(res.body.error)),
    `"" is an ABSENT code, not an unknown one; it must not be reported as unresolved, got: ${res.body.error}`,
  );
  assertEqual(res.body.property_code, "", "body echoes the empty code verbatim");
  assertEqual(res.body.property_local_id, "1", "body carries the local id as DIAGNOSTICS ONLY");
  assertEqual(txnCount(db), 0, "ZERO rows may land: the mapped local id must not rescue the row");
  assertEqual(
    db.prepare("SELECT COUNT(*) c FROM transaction_line WHERE property_id = 'P_A'").get().c,
    0,
    "specifically: nothing may land on P_A, the property the ignored local id names",
  );
  assert(!progress(db, "imp-c7-empty"), "no import_progress row for a rejected chunk");
});

await r.check("MISSING CODE: property_code null + mapped local id => 422 missing_code, ZERO rows land", async () => {
  const { db, env } = freshEnv();
  // The other JSON shape a serializer emits for "no code", on the OTHER property,
  // so this is not "P_A happened to fail".
  const row = rowA({ folio_number: "C7-NULL", amount: 28.75, property_code: null, property_local_id: 2 });
  const res = await importChunk(env, SCOPE, { import_id: "imp-c7-null", cursor: 0, rows: [row] }, false);
  assertEqual(res.status, 422, `a null code must be REFUSED, got ${JSON.stringify(res.body)}`);
  assertEqual(
    String(res.body.error),
    expectMissingCode("imp-c7-null", 0, 0),
    "property_code null must produce the missing_code discriminator, verbatim",
  );
  assert(
    !new RegExp(UNRESOLVED_TEXT).test(String(res.body.error)),
    `null is an ABSENT code, not an unknown one, got: ${res.body.error}`,
  );
  assertEqual(res.body.property_code, null, "body echoes the null code as null");
  assertEqual(res.body.property_local_id, "2", "body carries the local id as DIAGNOSTICS ONLY");
  assertEqual(txnCount(db), 0, "ZERO rows may land");
  assertEqual(
    db.prepare("SELECT COUNT(*) c FROM transaction_line WHERE property_id = 'P_B'").get().c,
    0,
    "specifically: nothing may land on P_B, the property the ignored local id names",
  );
  assert(!progress(db, "imp-c7-null"), "no import_progress row for a rejected chunk");
});

// AGENT D'S GAP: a NON-STRING property_code. `typeof code === "string"` already
// treats a JSON *number* as absent, so today such a row takes the fallback (or the
// generic unresolved path). Under Change 10 it must hit the EXPLICIT missing_code
// branch — a bare number is a browser-local id wearing the code field's name, and
// reporting it as "property did not resolve" would tell the operator to create a
// property called 8.
await r.check("MISSING CODE: a NON-STRING property_code (JSON number 8, and other non-string shapes) => 422 missing_code, ZERO rows land", async () => {
  /** @type {[string, unknown, string | null][]} */
  const NON_STRINGS = [
    ["8 (JSON number — the headline case)", 8, "8"],
    ["2 (JSON number that COLLIDES with mapped local_numeric_id 2)", 2, "2"],
    ["true (boolean)", true, "true"],
    ['["RRI-BOS"] (array wrapping a REAL code — String() would flatten it to a valid code)', ["RRI-BOS"], "RRI-BOS"],
    ["{} (object)", {}, "[object Object]"],
  ];
  for (const [label, value, echoed] of NON_STRINGS) {
    const { db, env } = freshEnv();
    const row = rowA({ folio_number: "C7-NONSTR", amount: 44.44 });
    row.property_code = value;
    row.property_local_id = 1; // mapped to P_A: it must NOT rescue the row
    const res = await importChunk(env, SCOPE, { import_id: "imp-c7-nonstr", cursor: 0, rows: [row] }, false);
    assertEqual(res.status, 422, `property_code ${label} must be REFUSED, got ${JSON.stringify(res.body)}`);
    assertEqual(
      String(res.body.error),
      expectMissingCode("imp-c7-nonstr", 0, 0),
      `${label}: a non-string code is an ABSENT canonical code and must produce the missing_code discriminator`,
    );
    assert(
      !new RegExp(UNRESOLVED_TEXT).test(String(res.body.error)),
      `${label}: must NOT be reported as an unknown property, got: ${res.body.error}`,
    );
    assertEqual(res.body.property_code, echoed, `${label}: body echoes what the client actually sent`);
    assertEqual(res.body.property_local_id, "1", `${label}: body carries the local id as DIAGNOSTICS ONLY`);
    assertEqual(txnCount(db), 0, `${label}: ZERO rows may land`);
    assert(!progress(db, "imp-c7-nonstr"), `${label}: no import_progress row for a rejected chunk`);
  }
});

await r.check("IGNORE CLAUSE (mirror case) — DO NOT 'FIX' INTO A REJECTION: mapped property_code + UNMAPPED property_local_id 999 => 200, committed BY CODE to P_A", async () => {
  const { db, env } = freshEnv();
  assert(
    !db.prepare("SELECT 1 FROM property_id_map WHERE local_numeric_id = ?").get(999),
    "precondition: local_numeric_id 999 is genuinely UNMAPPED",
  );
  // Still correct under Change 10, and for a stronger reason than before: the local
  // id is not a resolution key at all, so whether it maps is not the server's
  // business. Rejecting this row would reject CORRECT DATA — the canonical code is
  // present, it resolves, and it is what the row is committed to. A future reader
  // who "restores symmetry" with the unresolved-code case breaks legitimate imports.
  const row = rowA({ folio_number: "C7-MIRROR", amount: 33.0, property_code: "RRI-BOS", property_local_id: 999 });
  const res = await importChunk(env, SCOPE, { import_id: "imp-c7-mirror", cursor: 0, rows: [row] }, false);
  assertEqual(res.status, 200, `a resolvable code with a stale local id must still commit, got ${JSON.stringify(res.body)}`);
  assertEqual(res.body.rows_inserted, 1, "the row is actually inserted, not silently skipped");
  const stored = db
    .prepare("SELECT property_id FROM transaction_line WHERE folio_number = 'C7-MIRROR'")
    .get();
  assertEqual(stored.property_id, "P_A", "committed to the property the CODE named");
  assertEqual(txnCount(db), 1, "exactly one row landed");
});

// ===========================================================================
// DELETED WITH CHANGE 10 — the two `toLocalPropertyId` suites.
//
// This file used to end with two checks that pinned `toLocalPropertyId`, the type
// narrowing that decided which UNTRUSTED `property_local_id` values were allowed
// to resolve a row (`true`, `" 2 "`, `["2"]`, `"0x2"` refused; a positive-integer
// number or an all-digit string accepted), plus a check that
// buildPropertyResolver's filter and resolveServerPropertyId agreed about that
// definition. Change 10 deletes the helper and with it both checks: there is no
// longer any value of `property_local_id` that can resolve, bind, or reject a row,
// so both suites became unfalsifiable — every table row would assert the same
// outcome for the same reason (no usable property_code).
//
// The property they were really protecting — "no browser-local id ever reaches D1
// as a bound param" — is NOT lost. It is now pinned, more directly, by:
//   * the CHANGE 10 param-budget check, which sends 40 distinct local ids and
//     asserts none of them appears in ANY bound param list and that the
//     `local_numeric_id IN (…)` clause is gone; and
//   * the REJECTION COST check, which proves the resolver issues ZERO queries when
//     no row carries a usable code.
// ===========================================================================

// ===========================================================================
// CHANGE 9 + 9b CONTRACT (owner work order; ONE atomic change because both
// rewrite the dedupe-key format and neither is safe to ship alone).
//
// 9  — NORMALIZATION. The client ALREADY parses money: src/lib/csvParser.js
//      parseAmount strips "$", commas and whitespace and handles all three
//      negative conventions, and src/lib/transactionNorm.js mapTransactionRow
//      runs it over amount, quantity AND adults. A legitimate client therefore
//      emits ONLY `null`/absent (an empty cell) or a finite Number. Anything
//      else means the client pipeline was BYPASSED, and re-parsing it here
//      would repair the wrong boundary while inventing money. So:
//         absent | null    -> SQL NULL      (a genuinely empty cell)
//         finite number    -> that number   (bit-exact, never rescaled)
//         EVERYTHING ELSE  -> 422, nothing written
//      The old asNumber() coerced instead: "5,000.00"->NULL (a $5,000 charge
//      silently vanishing), []->0, "  "->0, false->0, true->1, "0x10"->16,
//      "1e3"->1000. Each is a money defect, not a parsing nicety.
//
// 9b — KEY INTEGRITY. The key was `[...].join("|")` over RAW row fields, which
//      is neither injective nor value-agreeing:
//        * FORGEABLE: folio "A|B" + code "C" and folio "A" + code "B|C" build
//          the SAME string, so ON CONFLICT(dedupe_key) DO NOTHING silently
//          DROPS the second real posting.
//        * DISAGREEING: the key hashed `row.amount ?? 0` while the column stored
//          the normalized value, so an absent amount keyed as "0" but stored
//          NULL, then collided with a real $0.00 posting.
//      The key is now built from the SAME normalized values that get written,
//      with every component length-prefixed so no component's CONTENT can move
//      a component BOUNDARY.
// ===========================================================================

/** Pinned discriminator for a refused numeric. Owner/Agent A settled the wording. */
const INVALID_NUMBER_TEXT = (field) => `${field} must be a finite number or absent`;
const NUMERIC_FIELDS_UNDER_TEST = ["amount", "quantity", "adults"];

// --- 9: the ONLY two accepted shapes -------------------------------------
await r.check("CHANGE 9 ACCEPT: absent/null numerics store SQL NULL; finite numbers store bit-exactly", async () => {
  for (const field of NUMERIC_FIELDS_UNDER_TEST) {
    /** @type {[string, unknown, number|null][]} */
    const ACCEPTED = [
      ["null (an empty CSV cell: parseAmount('') returns null)", null, null],
      ["absent (the column is not in the file at all)", undefined, null],
      ["0 (a real $0.00 posting — NOT the same as an empty cell)", 0, 0],
      ["199.99", 199.99, 199.99],
      ["-50.25 (a refund; the client already resolved the sign convention)", -50.25, -50.25],
      ["1020598.17 (the YTD reconciliation total, bit-exact through REAL)", 1020598.17, 1020598.17],
    ];
    for (const [label, sent, expected] of ACCEPTED) {
      const { db, env } = freshEnv();
      const row = rowA({ folio_number: `OK-${field}`, [field]: sent });
      const res = await importChunk(env, SCOPE, { import_id: `imp-ok-${field}`, cursor: 0, rows: [row] }, false);
      assertEqual(res.status, 200, `${field}=${label} must be accepted, got ${JSON.stringify(res.body)}`);
      const stored = db.prepare(`SELECT ${field} AS v FROM transaction_line`).get().v;
      assertEqual(stored, expected, `${field}=${label} must store ${String(expected)}, stored ${String(stored)}`);
      // Bit-exactness, not just ==: a rescale to cents and back would survive ==.
      if (expected !== null) {
        assert(Object.is(stored, expected), `${field}=${label} must round-trip BIT-EXACT, got ${String(stored)}`);
      } else {
        assert(stored === null, `${field}=${label} must be SQL NULL, not 0 (0 is a real posting)`);
      }
    }
  }
});

// --- 9: everything else is a LOUD 422, and NOTHING is written -------------
await r.check("CHANGE 9 REJECT: every non-number numeric is a 422 naming the field; ZERO rows land; the old silent coercions are dead", async () => {
  /** @type {[string, unknown][]} */
  const REJECTED = [
    ['"5,000.00" — comma money. OLD: Number() -> NaN -> NULL, silently VANISHING a $5,000 charge.', "5,000.00"],
    ['"$5.00" — currency symbol. OLD: NULL.', "$5.00"],
    ['"199.99" — a plain numeric STRING. The most likely "helpful" acceptance; the client never sends it.', "199.99"],
    ['"5.50" — trailing-zero string. OLD: stored 5.5 while KEYING "5.50" (money double-counted).', "5.50"],
    ['"" — empty string. OLD: NULL. The client emits null for an empty cell, never "".', ""],
    ['"  " — whitespace. OLD: Number("  ") === 0, inventing a $0.00 posting.', "  "],
    ["[] — empty array. OLD: Number([]) === 0.", []],
    ['["7"] — single-element array. OLD: Number(["7"]) === 7, inventing $7.', ["7"]],
    ["{} — object. OLD: NaN -> NULL.", {}],
    ["true — OLD: Number(true) === 1, inventing $1.00 out of a boolean.", true],
    ["false — OLD: Number(false) === 0.", false],
    ['"0x10" — hex string. OLD: 16.', "0x10"],
    ['"1e3" — exponent string. OLD: 1000.', "1e3"],
    ["NaN — a Number but not finite.", NaN],
    ["Infinity — a Number but not finite.", Infinity],
    ["-Infinity — a Number but not finite.", -Infinity],
  ];
  for (const field of NUMERIC_FIELDS_UNDER_TEST) {
    for (const [label, sent] of REJECTED) {
      const { db, env } = freshEnv();
      const row = rowA({ folio_number: "BAD", [field]: sent });
      const res = await importChunk(env, SCOPE, { import_id: "imp-bad", cursor: 0, rows: [row] }, false);
      assertEqual(res.status, 422, `${field}: ${label} — must be a LOUD 422, got ${JSON.stringify(res.body)}`);
      assert(/row 0/.test(String(res.body.error)), `${field}: ${label} — the error must name the row`);
      assert(
        String(res.body.error).includes(INVALID_NUMBER_TEXT(field)),
        `${field}: ${label} — error must name the field and the rule; got: ${String(res.body.error)}`,
      );
      assertEqual(res.body.field, field, `${field}: ${label} — the body must carry the offending field`);
      assertEqual(txnCount(db), 0, `${field}: ${label} — NO row may land (whole chunk is atomic)`);
      assert(!progress(db, "imp-bad"), `${field}: ${label} — no progress row for a rejected chunk`);
    }
  }
});

await r.check("CHANGE 9: one bad numeric in a LATER row rejects the WHOLE chunk (row 0 must not land either)", async () => {
  const { db, env } = freshEnv();
  const chunk = {
    import_id: "imp-mixed",
    cursor: 0,
    rows: [rowA({ folio_number: "GOOD", amount: 10.5 }), rowA({ folio_number: "BADAMT", amount: "5,000.00" })],
  };
  const res = await importChunk(env, SCOPE, chunk, false);
  assertEqual(res.status, 422, `got ${JSON.stringify(res.body)}`);
  assert(/row 1/.test(String(res.body.error)), "the error must name row 1, the offender");
  assertEqual(txnCount(db), 0, "row 0 was valid but the chunk is ATOMIC — nothing lands");
  assert(!progress(db, "imp-mixed"), "no progress row");
});

// --- 9b: a `|` inside a component cannot move a component BOUNDARY --------
await r.check("CHANGE 9b: a `|` inside a text component CANNOT forge a dedupe collision (both real postings persist)", async () => {
  /** @type {[string, Record<string, unknown>, Record<string, unknown>][]} */
  const FORGERY_PAIRS = [
    [
      'folio "A|B" + code "C"  vs  folio "A" + code "B|C"',
      { folio_number: "A|B", transaction_code: "C" },
      { folio_number: "A", transaction_code: "B|C" },
    ],
    [
      // The component COUNT is held fixed and only the boundary moves — the naive
      // "add a `|` and see" attempt fails because it changes the count instead.
      'date "2026-03-01|09:00" + time "X"  vs  date "2026-03-01" + time "09:00|X"',
      { date: "2026-03-01|09:00", time: "X" },
      { date: "2026-03-01", time: "09:00|X" },
    ],
    [
      'folio "" + code "Z"  vs  folio "|Z" shifted through an empty component',
      { folio_number: "", transaction_code: "Z" },
      { folio_number: "|Z", transaction_code: "" },
    ],
  ];
  for (const [label, leftOver, rightOver] of FORGERY_PAIRS) {
    const { db, env } = freshEnv();
    const left = rowA({ amount: 5, ...leftOver });
    const right = rowA({ amount: 5, ...rightOver });
    const res = await importChunk(env, SCOPE, { import_id: "imp-forge", cursor: 0, rows: [left, right] }, false);
    assertEqual(res.status, 200, `${label} — both rows are legitimate; got ${JSON.stringify(res.body)}`);
    assertEqual(res.body.rows_inserted, 2, `${label} — BOTH postings must insert; a collision silently DROPS one`);
    assertEqual(txnCount(db), 2, `${label} — two distinct rows on disk`);
    const keys = db.prepare("SELECT dedupe_key FROM transaction_line").all().map((x) => x.dedupe_key);
    assertEqual(new Set(keys).size, 2, `${label} — the two keys must be DISTINCT, saw ${JSON.stringify(keys)}`);
    assertEqual(progress(db, "imp-forge").rows_committed, 2, `${label} — progress counts both`);
  }
});

// --- 9b: the key must agree with the value that is actually STORED ---------
await r.check("CHANGE 9b: an EMPTY amount and a real $0.00 posting do not share a dedupe key", async () => {
  /** @type {[string, unknown][]} */
  const EMPTIES = [["null", null], ["absent", undefined]];
  for (const [label, empty] of EMPTIES) {
    const { db, env } = freshEnv();
    // OLD: `row.amount ?? 0` keyed BOTH as "…|0|0" while storing NULL vs 0, so the
    // $0.00 posting collided with the empty cell and was silently dropped.
    const rows = [rowA({ folio_number: "Z", amount: empty }), rowA({ folio_number: "Z", amount: 0 })];
    const res = await importChunk(env, SCOPE, { import_id: "imp-zero", cursor: 0, rows }, false);
    assertEqual(res.status, 200, `amount ${label} vs 0 — got ${JSON.stringify(res.body)}`);
    assertEqual(res.body.rows_inserted, 2, `amount ${label} vs 0 — both rows must insert`);
    const stored = db.prepare("SELECT amount, dedupe_key FROM transaction_line").all();
    assertEqual(stored.length, 2, `amount ${label} vs 0 — two rows on disk`);
    assertEqual(new Set(stored.map((x) => x.dedupe_key)).size, 2, `amount ${label} vs 0 — keys must DIFFER`);
    assert(stored.some((x) => x.amount === null), `amount ${label} must store SQL NULL`);
    assert(stored.some((x) => x.amount === 0), "the $0.00 posting must store 0");
  }
});

await r.check("CHANGE 9b: the stored dedupe_key is derived from the STORED values, not the raw wire row", async () => {
  const { db, env } = freshEnv();
  // A wire row whose text fields are NOT strings: they are stored via String(),
  // so a key built from the RAW row could disagree with the row it identifies.
  const row = rowA({ folio_number: 5, transaction_code: 7, amount: 3.5, date: "2026-04-01", time: "08:00", occurrence: 2 });
  const res = await importChunk(env, SCOPE, { import_id: "imp-agree", cursor: 0, rows: [row] }, false);
  assertEqual(res.status, 200, `got ${JSON.stringify(res.body)}`);
  const s = db
    .prepare("SELECT date, time, folio_number, transaction_code, amount, dedupe_key FROM transaction_line")
    .get();
  assertEqual(s.folio_number, "5", "a numeric folio is stored as TEXT '5'");
  assertEqual(s.transaction_code, "7", "a numeric transaction_code is stored as TEXT '7'");
  // Recomputed from what is ON DISK — the key must be a function of the stored row.
  const expected = transactionDedupeKey({
    serverPropertyId: "P_A",
    date: s.date,
    time: s.time,
    folio_number: s.folio_number,
    transaction_code: s.transaction_code,
    amount: s.amount,
    occurrence: 2,
  });
  assertEqual(s.dedupe_key, expected, "stored key must equal the key recomputed from the STORED values");
});

// --- 9b NON-VACUITY: the new key must still catch a genuine duplicate ------
await r.check("CHANGE 9b NON-VACUITY: a genuine byte-identical duplicate still collapses to ONE row", async () => {
  const { db, env } = freshEnv();
  const row = rowA({ folio_number: "DUP", amount: 88.88, occurrence: 0 });
  // Same occurrence => genuinely the same posting. A key made unique per call
  // (a UUID, a timestamp) would pass every forgery check above and fail HERE.
  const res = await importChunk(env, SCOPE, { import_id: "imp-dup", cursor: 0, rows: [row, { ...row }] }, false);
  assertEqual(res.status, 200, `got ${JSON.stringify(res.body)}`);
  assertEqual(res.body.rows_inserted, 1, "the duplicate must collapse: exactly ONE insert");
  assertEqual(txnCount(db), 1, "one row on disk");
  assertEqual(progress(db, "imp-dup").rows_committed, 1, "rows_committed counts the real insert only");
  // And re-sending the same chunk stays idempotent under the NEW key format.
  const again = await importChunk(env, SCOPE, { import_id: "imp-dup", cursor: 0, rows: [row] }, false);
  assertEqual(again.status, 200, "re-send accepted");
  assertEqual(txnCount(db), 1, "still one row after re-send");
});

// --- 9b: systematic injectivity over EVERY boundary placement --------------
await r.check("CHANGE 9b INJECTIVITY: 4 rows that are indistinguishable under `join(\"|\")` all persist with distinct keys", async () => {
  const { db, env } = freshEnv();
  // The four text components join to "a|b|c|d|e" under the OLD format no matter
  // which three of the four internal delimiters are the real boundaries, so all
  // four rows collided and three real postings were silently dropped.
  /** @type {[string, string, string, string][]} */
  const SPLITS = [
    ["a", "b", "c", "d|e"],
    ["a", "b", "c|d", "e"],
    ["a", "b|c", "d", "e"],
    ["a|b", "c", "d", "e"],
  ];
  const rows = SPLITS.map(([date, time, folio_number, transaction_code]) =>
    rowA({ date, time, folio_number, transaction_code, amount: 1.25 }),
  );
  const res = await importChunk(env, SCOPE, { import_id: "imp-inj", cursor: 0, rows }, false);
  assertEqual(res.status, 200, `all four are distinct postings; got ${JSON.stringify(res.body)}`);
  assertEqual(res.body.rows_inserted, 4, "all FOUR must insert (the old key collapsed them to 1)");
  const keys = db.prepare("SELECT dedupe_key FROM transaction_line").all().map((x) => x.dedupe_key);
  assertEqual(keys.length, 4, "four rows on disk");
  assertEqual(new Set(keys).size, 4, `all four keys must be DISTINCT, saw ${JSON.stringify(keys)}`);
});

await r.check("CHANGE 9b: the exported key is deterministic, property-id-leading, and refuses an unvalidated component set", async () => {
  const base = {
    serverPropertyId: "P_A",
    date: "2026-05-01",
    time: "12:00",
    folio_number: "F1",
    transaction_code: "RENT",
    amount: 9.99,
    occurrence: 0,
  };
  assertEqual(transactionDedupeKey(base), transactionDedupeKey({ ...base }), "same components => same key (pure)");
  const key = transactionDedupeKey(base);
  // Format-agnostic statement of "the property id leads": its text sits before the
  // first delimiter. This is why key forgery is NOT a property-isolation escape —
  // the leading component is the server id, which only the server chooses.
  assert(key.indexOf("P_A") >= 0 && key.indexOf("P_A") < key.indexOf("|"), `pid must lead the key, got ${key}`);
  assert(
    transactionDedupeKey({ ...base, serverPropertyId: "P_B" }) !== key,
    "a different server property id must give a different key",
  );
  // A key built from an unvalidated component set is a silent money defect; the
  // function must CRASH instead of inventing one. This also kills the old
  // positional call shape, which would have keyed `String(undefined)`.
  for (const [label, bad] of [
    ["missing serverPropertyId", { ...base, serverPropertyId: undefined }],
    ["empty serverPropertyId", { ...base, serverPropertyId: "" }],
    ["non-finite occurrence", { ...base, occurrence: NaN }],
    ["missing occurrence", { ...base, occurrence: undefined }],
    ["a non-normalized amount (a string)", { ...base, amount: "9.99" }],
  ]) {
    let threw = false;
    try {
      // @ts-expect-error deliberately violating the component contract at runtime
      transactionDedupeKey(bad);
    } catch {
      threw = true;
    }
    assert(threw, `transactionDedupeKey must THROW on ${label}, not return a key`);
  }
  let threwPositional = false;
  try {
    // @ts-expect-error the OLD positional signature must not silently work
    transactionDedupeKey("P_A", { date: "2026-05-01" }, 0);
  } catch {
    threwPositional = true;
  }
  assert(threwPositional, "the OLD positional signature must throw, not build a wrong key");
});

r.done();
if (process.exitCode) process.exit(1);
console.log("PASSED: Worker import contract completed.");
