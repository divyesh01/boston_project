// Probe: a manual-entry save must commit every row or none of them.
//
// THE DEFECT (launch item #4). ManualEntry.jsx#handleSave wrote the grid with a
// bare per-row loop and had no try/catch anywhere in the handler, so a failure on
// row 7 of 20 committed rows 1-6 to a financial ledger, threw out of an async
// onClick, and left the page's `saving` flag set — a spinning Save button and no
// message, over data that had partly landed. Section [0] reproduces that with the
// original loop so the fix is measured against observed behaviour, not a claim.
//
// WHAT ATOMICITY IS ASSERTED AGAINST. Dexie rolls back the zone when the op
// throws, so the assertion that matters is a COUNT taken after a mid-batch
// failure: exactly the number of rows that were in the table before. Asserting
// only "the call threw" would pass just as well against the broken loop.
//
// Run: node --import ./scripts/_loader-boot.mjs scripts/probe-manual-entry-save.mjs

await import("fake-indexeddb/auto");
globalThis.crypto ??= (await import("node:crypto")).webcrypto;

const __store = new Map();
const __storage = {
  getItem: (k) => (__store.has(k) ? __store.get(k) : null),
  setItem: (k, v) => __store.set(k, String(v)),
  removeItem: (k) => __store.delete(k),
  clear: () => __store.clear(),
};
globalThis.localStorage = __storage;
globalThis.sessionStorage = __storage;
globalThis.window = globalThis;
if (globalThis.navigator === undefined) {
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "harness", language: "en-US" },
    configurable: true,
  });
}

const { db, runInTransaction } = await import("@/api/base44Client");
const { saveManualRows } = await import("@/lib/manualEntrySave");
const { draftKeyFor, readDraft, writeDraft, clearDraft } = await import("@/lib/manualDraft");
const { readFileSync: fsReadFileSync } = await import("node:fs");
const { signInAsAllPropertyOwner } = await import("./_harness-auth.mjs");

const PROPERTY = "prop-manual-save";
const ENTITY = "OccupancyDay";

let pass = 0;
let fail = 0;
const ok = (cond, label, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
};
const eq = (actual, expected, label) =>
  ok(actual === expected, label, `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);

await signInAsAllPropertyOwner();

const dedupeKey = (rec) => `${rec.property_id}|${rec.date}`;
const meta = {
  property_id: PROPERTY,
  property_name: "Middleborough",
  source_file: "Manual Entry",
  report_type: "manual_entry",
};
// `n` rows for consecutive days, each a plausible occupancy row.
const batch = (n, startDay = 1, extra = {}) =>
  Array.from({ length: n }, (_, i) => ({
    row: {},
    record: {
      ...meta,
      date: `2026-04-${String(startDay + i).padStart(2, "0")}`,
      rooms_sold: 10 + i,
      room_revenue: 1000 + i,
      ...extra,
    },
  }));

const countRows = async () =>
  (await db.entities[ENTITY].filter({ property_id: PROPERTY }, "date", 200000)).length;
const allRows = async () =>
  await db.entities[ENTITY].filter({ property_id: PROPERTY }, "date", 200000);

// Make the Nth create throw, exactly as a constraint violation or a quota error
// would, then restore the real method.
const realCreate = db.entities[ENTITY].create.bind(db.entities[ENTITY]);
const failOnCreate = (nth) => {
  let calls = 0;
  db.entities[ENTITY].create = async (rec) => {
    calls += 1;
    if (calls === nth) throw new Error(`simulated write failure on row ${nth}`);
    return realCreate(rec);
  };
  return () => { db.entities[ENTITY].create = realCreate; };
};

// ── 0. THE DEFECT: the original loop, on the same failing batch ─────────────
console.log("\n[0] BEFORE — the original per-row loop partially commits");
{
  const restore = failOnCreate(4);
  const before = await countRows();
  let threw = null;
  try {
    // Verbatim shape of the pre-fix handleSave loop (no transaction, no catch).
    for (const { row, record } of batch(6, 1)) {
      if (row._id) await db.entities[ENTITY].update(row._id, record);
      else await db.entities[ENTITY].create(record);
    }
  } catch (e) { threw = e; }
  restore();
  const after = await countRows();
  ok(threw !== null, "the legacy loop throws on the failing row", threw?.message);
  ok(after - before === 3, "and leaves 3 of 6 rows COMMITTED — the defect",
    `${before} -> ${after} rows`);
  // Clean up the orphans so the sections below start from a known table.
  for (const r of await allRows()) await db.entities[ENTITY].delete(r.id);
  eq(await countRows(), 0, "table reset before testing the fix");
}

// ── 1. AFTER: a mid-batch failure commits nothing ───────────────────────────
console.log("\n[1] NEGATIVE — saveManualRows rolls the whole batch back");
{
  const before = await countRows();
  const restore = failOnCreate(4);
  let threw = null;
  try {
    await saveManualRows({ entityName: ENTITY, prepared: batch(6, 1), existingKeys: new Set(), dedupeKey });
  } catch (e) { threw = e; }
  restore();
  const after = await countRows();
  ok(threw !== null, "the failure is reported to the caller, not swallowed", threw?.message);
  eq(after, before, "ZERO rows committed after a failure on row 4 of 6");
  ok(/simulated write failure/.test(threw?.message || ""),
    "the original error message survives for the UI to show", threw?.message);
}

// ── 2. Failure on the LAST row rolls back the ones before it ────────────────
// The interesting case for a transaction: five successful writes precede it.
console.log("\n[2] NEGATIVE — failure on the final row still rolls back");
{
  const before = await countRows();
  const restore = failOnCreate(6);
  let threw = null;
  try {
    await saveManualRows({ entityName: ENTITY, prepared: batch(6, 10), existingKeys: new Set(), dedupeKey });
  } catch (e) { threw = e; }
  restore();
  eq(await countRows(), before, "the five rows written before the failure are gone");
  ok(threw !== null, "and the caller still sees the error");
}

// ── 3. POSITIVE: a clean batch commits every row, once ──────────────────────
console.log("\n[3] POSITIVE — a clean batch commits in full");
{
  const res = await saveManualRows({
    entityName: ENTITY, prepared: batch(6, 1), existingKeys: new Set(), dedupeKey,
  });
  eq(res.saved, 6, "reports 6 saved");
  eq(res.skipped, 0, "reports 0 skipped");
  eq(await countRows(), 6, "and 6 rows are actually in the table");
  const dates = (await allRows()).map((r) => r.date).sort();
  eq(new Set(dates).size, 6, "six distinct dates — no row written twice");
  const first = (await allRows()).find((r) => r.date === "2026-04-01");
  eq(first?.property_id, PROPERTY, "the property tag survived the write");
  eq(first?.rooms_sold, 10, "and the values are the ones passed in");
}

// ── 4. Dedupe: against the database, and within the batch ──────────────────
console.log("\n[4] duplicates are skipped, not written");
{
  const existingKeys = new Set((await allRows()).map(dedupeKey));
  const res = await saveManualRows({
    entityName: ENTITY, prepared: batch(6, 1), existingKeys, dedupeKey,
  });
  eq(res.saved, 0, "re-saving the same six rows writes nothing");
  eq(res.skipped, 6, "and reports all six as duplicates");
  eq(await countRows(), 6, "the table is unchanged");

  // Two grid rows for the SAME date in one batch: the second is a duplicate of
  // the first even though the database has never seen either.
  const twice = [...batch(1, 20), ...batch(1, 20)];
  const res2 = await saveManualRows({ entityName: ENTITY, prepared: twice, existingKeys: new Set(), dedupeKey });
  eq(res2.saved, 1, "two identical rows in one batch save once");
  eq(res2.skipped, 1, "the second is counted as a duplicate");
  eq(await countRows(), 7, "one new row reached the table");
}

// ── 5. The caller's key set is never polluted by a rolled-back save ─────────
// If the failed batch had marked its keys as present, the retry would skip
// exactly the rows that were never written — a silent, permanent data loss.
console.log("\n[5] a failed save leaves the caller's dedupe set untouched");
{
  const callerKeys = new Set((await allRows()).map(dedupeKey));
  const sizeBefore = callerKeys.size;
  const restore = failOnCreate(2);
  await saveManualRows({ entityName: ENTITY, prepared: batch(3, 25), existingKeys: callerKeys, dedupeKey })
    .catch(() => {});
  restore();
  eq(callerKeys.size, sizeBefore, "the set the page holds is the same size");
  ok(!callerKeys.has(`${PROPERTY}|2026-04-25`), "and does not claim the rolled-back row exists");
  // Proof it matters: the retry now writes all three.
  const retry = await saveManualRows({ entityName: ENTITY, prepared: batch(3, 25), existingKeys: callerKeys, dedupeKey });
  eq(retry.saved, 3, "the retry after a rollback saves all three rows");
}

// ── 6. Edits update in place instead of inserting ───────────────────────────
console.log("\n[6] a row carrying _id updates and never duplicates");
{
  const target = (await allRows()).find((r) => r.date === "2026-04-01");
  const before = await countRows();
  const res = await saveManualRows({
    entityName: ENTITY,
    prepared: [{ row: { _id: target.id }, record: { ...meta, date: "2026-04-01", rooms_sold: 99, room_revenue: 4242 } }],
    // The key IS present — an edit must not be mistaken for a duplicate.
    existingKeys: new Set((await allRows()).map(dedupeKey)),
    dedupeKey,
  });
  eq(res.saved, 1, "the edit is reported as saved");
  eq(res.skipped, 0, "and not as a duplicate");
  eq(await countRows(), before, "no new row was inserted");
  const after = (await allRows()).find((r) => r.id === target.id);
  eq(after?.rooms_sold, 99, "the stored value was updated in place");
}

// ── 7. Empty and malformed input ────────────────────────────────────────────
console.log("\n[7] empty batch and bad arguments");
{
  const res = await saveManualRows({ entityName: ENTITY, prepared: [], existingKeys: new Set(), dedupeKey });
  eq(res.saved, 0, "an empty batch saves 0");
  eq(res.skipped, 0, "and skips 0");
  const rows = await countRows();
  const allDupes = await saveManualRows({
    entityName: ENTITY, prepared: batch(2, 1), existingKeys: new Set((await allRows()).map(dedupeKey)), dedupeKey,
  });
  eq(allDupes.saved, 0, "a batch that is entirely duplicates is not a failure");
  eq(await countRows(), rows, "and writes nothing");

  for (const [label, args] of [
    ["no entityName", { prepared: batch(1, 1), dedupeKey }],
    ["no dedupeKey", { entityName: ENTITY, prepared: batch(1, 1) }],
  ]) {
    let e = null;
    await saveManualRows(/** @type {any} */ (args)).catch((err) => { e = err; });
    ok(e !== null, `${label} throws instead of silently saving nothing`, e?.message);
  }

  // A typo'd entity name cannot be rejected up front: db.entities is a Proxy that
  // returns a no-op entity for ANY name, so there is nothing to test for. What is
  // asserted instead is the outcome that matters — it fails loudly and commits
  // nothing, because the write is inside the transaction.
  const rowsBefore = await countRows();
  let unknownErr = null;
  await saveManualRows({ entityName: "NotATable", prepared: batch(1, 1), existingKeys: new Set(), dedupeKey })
    .catch((err) => { unknownErr = err; });
  ok(unknownErr !== null, "an unknown entity name fails loudly", unknownErr?.message);
  eq(await countRows(), rowsBefore, "and commits nothing on the real table");
}

// ── 8. The transaction primitive is the one the importer uses ───────────────
// Guards against a future "simplification" that drops back to a bare loop: if
// runInTransaction stops rolling back, section [1] fails, and if this module
// stops using it, this check fails.
console.log("\n[8] runInTransaction itself rolls back a partial write");
{
  const before = await countRows();
  let threw = null;
  try {
    await runInTransaction([async () => {
      await db.entities[ENTITY].create({ ...meta, date: "2026-05-01", rooms_sold: 1 });
      throw new Error("abort");
    }]);
  } catch (e) { threw = e; }
  ok(threw !== null, "the transaction reports the abort");
  eq(await countRows(), before, "and the row created before the throw is gone");
}

// ── 9. The draft is the only copy of the typed rows, so losing it must be loud ──
// The page held five raw localStorage calls (a read OUTSIDE its own try, two
// unguarded removes, a silent discard of a corrupt draft, and an auto-save whose
// only failure path was console.warn). On a browser that refuses storage — private
// browsing, blocked site data, or simply quota — the read threw out of a useEffect
// and took the page down, and the auto-save failed while the page went on showing
// its amber "● Unsaved draft" dot. src/lib/manualDraft.js owns every access now,
// which is what makes these assertions possible at all: an effect cannot be probed
// headlessly, a module can.
console.log("\n[9] the manual-entry draft store reports every storage failure");
{
  const KEY = draftKeyFor("prop-manual-save", "occupancy");
  const ROWS = [{ date: "2026-06-01", rooms_sold: 12 }, { date: "2026-06-02", rooms_sold: 9 }];

  // Failure messages go to the console AND come back as `problem` for the page to
  // render. Both are asserted: the console line is the record, the return value is
  // what stops the page claiming success.
  const capture = (fn) => {
    const real = console.error;
    const lines = [];
    console.error = (...a) => lines.push(a.map(String).join(" "));
    try { return { value: fn(), lines }; } finally { console.error = real; }
  };
  // Storage that refuses one named operation, as a blocked or full browser does.
  const refuse = (op) => ({
    ...__storage,
    [op]: () => { const e = new Error("The operation is insecure."); e.name = "SecurityError"; throw e; },
  });
  const withStorage = (s, fn) => {
    globalThis.localStorage = s;
    try { return fn(); } finally { globalThis.localStorage = __storage; }
  };

  eq(KEY, "manual_draft_prop-manual-save_occupancy", "the key shape is unchanged");
  ok(KEY.startsWith("manual_draft_"), "and keeps the prefix dbArchive backs up");

  __storage.clear();
  const w = writeDraft(KEY, ROWS);
  ok(w.ok === true, "a draft writes", w.problem);
  eq(w.problem, "", "with nothing to report");
  const r = readDraft(KEY);
  eq(JSON.stringify(r.rows), JSON.stringify(ROWS), "and reads back row for row");
  ok(r.discard === false && r.problem === "", "with nothing to discard or report");
  ok(clearDraft(KEY).ok === true, "and clears");
  const gone = readDraft(KEY);
  ok(gone.rows === null && gone.discard === false && gone.problem === "",
    "an absent draft is not a failure and is not reported");

  // Unusable stored values: all four were deleted in silence before.
  for (const [label, raw, mustReport] of [
    ["an empty list", "[]", false],
    ["truncated JSON", '[{"date":"2026-06-01"', true],
    ["an object instead of a list", '{"date":"2026-06-01"}', true],
    ["the text null", "null", true],
    ["a list of numbers", "[1,2,3]", true],
  ]) {
    __storage.setItem(KEY, raw);
    const { value, lines } = capture(() => readDraft(KEY));
    ok(value.rows === null, `${label}: nothing is offered to recover`);
    ok(value.discard === true, `${label}: the caller is told to clear the key`);
    if (mustReport) {
      ok(value.problem.length > 0, `${label}: the loss is reported`, value.problem);
      ok(value.problem.includes(KEY), `${label}: the message names the key`);
      ok(lines.some((l) => l.includes(KEY)), `${label}: and it reaches the console`);
    } else {
      // A cleared draft costs the operator nothing, so it is removed quietly.
      eq(value.problem, "", `${label}: is cleaned up without a message`);
      eq(lines.length, 0, `${label}: and logs nothing`);
    }
  }
  __storage.clear();

  // THE PAGE-BLANKING CASE. `localStorage.getItem` throws in a context where
  // storage is blocked, and the old call sat outside its try.
  {
    const { value, lines } = capture(() => withStorage(refuse("getItem"), () => readDraft(KEY)));
    ok(value.rows === null, "a refused read returns instead of throwing");
    ok(value.discard === false,
      "and does NOT ask for the key to be cleared — nothing is known about the stored value");
    ok(value.problem.includes(KEY), "the message names the key", value.problem);
    ok(/private browsing|blocked/i.test(value.problem), "and says why storage might refuse");
    ok(lines.length === 1, "reported once to the console", String(lines.length));
  }

  // A refused write is what the amber "unsaved draft" dot used to lie about.
  {
    const { value, lines } = capture(() => withStorage(refuse("setItem"), () => writeDraft(KEY, ROWS)));
    ok(value.ok === false, "a refused write reports failure rather than returning void");
    ok(value.problem.includes(KEY), "the message names the key", value.problem);
    ok(/NOT being kept/.test(value.problem), "and states that the rows are not being kept");
    ok(/lost if this tab closes/.test(value.problem), "and what that costs");
    ok(lines.some((l) => l.includes("SecurityError")), "the cause is on the console");
    ok(__storage.getItem(KEY) === null, "and nothing was stored");
  }

  // Rows that cannot be serialised are a code defect, not a full disk, and must not
  // send the owner off to clear their browser.
  {
    const cyclic = [{ date: "2026-06-01" }];
    cyclic[0].self = cyclic;
    const { value } = capture(() => writeDraft(KEY, cyclic));
    ok(value.ok === false, "unserialisable rows report failure");
    ok(/defect in the calling code/.test(value.problem), "and are not blamed on storage", value.problem);
    ok(__storage.getItem(KEY) === null, "and nothing was stored");
  }

  // A refused remove used to throw out of an onClick — after a save had already
  // committed, and before setSaving(false).
  {
    const { value, lines } = capture(() => withStorage(refuse("removeItem"), () => clearDraft(KEY)));
    ok(value.ok === false, "a refused remove reports failure instead of throwing");
    ok(value.problem.includes(KEY), "the message names the key", value.problem);
    ok(/reappear|recovery/i.test(value.problem), "and says the draft will come back");
    ok(lines.length === 1, "reported once to the console", String(lines.length));
  }

  // Static: the page must not hold a second copy of any of this. These are the
  // assertions that fail if a future edit puts a raw localStorage call back into
  // the component, which is the shape the defect had.
  const readFile = (rel) => fsReadFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
  const page = readFile("src/pages/ManualEntry.jsx");
  ok(!/localStorage|sessionStorage/.test(page.replace(/^\s*\/\/.*$/gm, "")),
    "ManualEntry.jsx touches web storage nowhere outside the draft module");
  ok(/from ["']@\/lib\/manualDraft["']/.test(page), "and imports the draft module");
  for (const fn of ["draftKeyFor", "readDraft", "writeDraft", "clearDraft"]) {
    ok(new RegExp(`\\b${fn}\\(`).test(page), `and calls ${fn}()`);
  }
  ok(!/manual_draft_/.test(page), "the key template lives in exactly one place, not in the page");
  ok(/manual_draft_/.test(readFile("src/lib/manualDraft.js")), "and that place is manualDraft.js");
  ok(/LOCAL_SLOT_PREFIXES[\s\S]{0,120}manual_draft_/.test(readFile("src/lib/dbArchive.js")),
    "dbArchive still backs the prefix up, so a draft survives an export");
}

console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
