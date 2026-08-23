/**
 * PROBE: "Clear all imported data" must leave no rollback state behind.
 *
 * Playbook item #14.
 *
 * THE DEFECT. Import.jsx#handleClearAll clears a hardcoded list of eleven data
 * tables. Two things an import also creates are not on that list:
 *
 *   localDb.ImportRecordIds   the rollback ledger — one row per import_id+entity
 *                             holding the ARRAY OF RECORD IDS that "Undo import"
 *                             deletes. Left with status:'active'.
 *   rri_import_sessions       the lifecycle list in secureStore that the Import
 *                             page renders as import history, each row with an
 *                             Undo button.
 *
 * The confirm dialog promises to delete "ALL imported report data AND IMPORT
 * HISTORY". It deletes the data and keeps the history, so the page goes on
 * offering Undo for imports whose rows are already gone.
 *
 * WHY THIS IS NOT COSMETIC, in the codebase's own words. rollbackImportSession
 * guards its idempotency with:
 *
 *     "a second rollback of the same import must not re-delete ids that may
 *      since have been reassigned by Dexie's auto-increment to unrelated rows"
 *
 * A clear-all manufactures precisely that state: live ledger rows naming ids that
 * no longer exist. Section 1 therefore MEASURES whether IndexedDB's key generator
 * is reset by clear(), because the severity of the whole item turns on it — if it
 * resets, the ids in the stale ledger are handed straight back out to the next
 * import and Undo deletes THAT import's rows instead, across property boundaries.
 * The measurement is printed either way; the fix does not depend on the answer,
 * because a ledger naming rows that do not exist is wrong regardless.
 *
 * ROOT CAUSE, and why the fix is an extraction. The set of stores an import owns
 * was written down in three places that nothing keeps in sync: reportParsers.js
 * writes the rows, base44Client.js writes the ledger and the lifecycle record, and
 * a literal array inside a React event handler in Import.jsx decides what a
 * clear-all removes. The list in the handler was simply missing two entries, and
 * would have gone on missing every store added later. src/lib/importReset.js now
 * owns that set once, and the handler calls it — so the next store an import
 * writes to is added in the same file that knows how to clear it.
 *
 * WHAT MUST SURVIVE A CLEAR-ALL, asserted in section 5: localDb.IdSequence. That
 * table is the persisted high-water mark that stops staff IDs being reused
 * (playbook item #1). Clearing it would silently reintroduce the exact defect
 * item #1 fixed, which is the kind of regression a "clear everything" change
 * invites. Properties, users, staff, payroll and expenses must survive too — they
 * are not imported data and the dialog says they are kept.
 *
 * Run: node --import ./scripts/_loader-boot.mjs scripts/probe-clear-all-rollback.mjs
 */

await import("fake-indexeddb/auto");
globalThis.crypto ??= (await import("node:crypto")).webcrypto;
if (!globalThis.crypto?.subtle) globalThis.crypto = (await import("node:crypto")).webcrypto;

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
globalThis.screen = { width: 1920, height: 1080 };
if (globalThis.navigator === undefined) {
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "harness", language: "en-US" },
    configurable: true,
  });
}

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const { default: localDb } = await import("@/api/localDb");
const {
  db,
  createImportSession,
  completeImportSession,
  addImportRecordIds,
  rollbackImportSession,
  listImportSessions,
} = await import("@/api/base44Client");
const { signInAsAllPropertyOwner } = await import("./_harness-auth.mjs");
const { reserveEmployeeId, peekIdSequence, employeeIdPrefix } = await import("@/lib/employeeId");

// Loaded defensively: before the fix this module does not exist, and a probe that
// dies at import reports NOTHING — the runner calls that BROKEN, which is worse
// than a clean FAIL because it looks like a suite that verified something.
let importReset = null;
try {
  importReset = await import("@/lib/importReset");
} catch (e) {
  console.log(`  (src/lib/importReset.js did not load: ${e.code || e.message})`);
}

let pass = 0;
let fail = 0;
const failures = [];

function ok(label, cond, detail) {
  if (cond) pass += 1;
  else {
    fail += 1;
    failures.push(detail ? `${label} — ${detail}` : label);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
const eq = (label, actual, expected) =>
  ok(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

// Returns the fix's entry point, or records a failure and returns null.
function clearFn() {
  if (importReset && typeof importReset.clearAllImportedData === "function") return importReset.clearAllImportedData;
  ok("src/lib/importReset.js exports clearAllImportedData", false, "module missing or does not export it");
  return null;
}

async function reset() {
  await localDb.open();
  await Promise.all(localDb.tables.map((t) => t.clear()));
  localStorage.clear();
  sessionStorage.clear();
  await signInAsAllPropertyOwner();
}

// One import of `n` occupancy days for `propertyId`, ledger and lifecycle record
// written exactly the way reportParsers.js writes them.
async function doImport(propertyId, dates) {
  const session = await createImportSession({
    sourceFile: `${propertyId}.csv`,
    propertyId,
    propertyName: propertyId,
    reportType: "occupancy",
  });
  const created = await db.entities.OccupancyDay.bulkCreate(
    dates.map((date) => ({ date, room_revenue: 100, rooms_sold: 1, property_id: propertyId, import_id: session.importId }))
  );
  await addImportRecordIds(session.importId, "OccupancyDay", created.map((r) => r.id), propertyId);
  await completeImportSession(session.importId, { OccupancyDay: created.length });
  return { importId: session.importId, ids: created.map((r) => r.id) };
}

console.log("--- PROBE: CLEAR-ALL LEAVES NO ROLLBACK STATE (item #14) ---");

// ── 1. Does clear() reset the auto-increment? Measured, not assumed ──────────
console.log("\n[1] the key generator's behaviour across clear()");
let KEYGEN_RESETS = null;
{
  await reset();
  const a = await doImport("P1", ["2026-01-01", "2026-01-02"]);
  ok("an import writes rows with generated ids", a.ids.length === 2 && Number.isFinite(a.ids[0]), `ids ${JSON.stringify(a.ids)}`);

  await localDb.OccupancyDay.clear();
  const b = await doImport("P1", ["2026-02-01"]);
  KEYGEN_RESETS = b.ids[0] <= a.ids[a.ids.length - 1];
  console.log(`        pre-clear ids ${JSON.stringify(a.ids)}; post-clear id ${JSON.stringify(b.ids)}`);
  console.log(
    KEYGEN_RESETS
      ? "        MEASURED: clear() RESETS the key generator — a stale ledger names rows that now belong to a later import."
      : "        MEASURED: clear() does NOT reset the key generator — stale ledger ids do not collide, but the ledger is still garbage."
  );
  ok("the measurement produced a definite answer", typeof KEYGEN_RESETS === "boolean");
}

// ── 2. Reproduce: the old handler's table list leaves the ledger behind ──────
//
// The handler itself is a React callback and cannot be called here, so this
// section replays its exact behaviour: clear the eleven tables it names, then
// look at what is left. IMPORT_TABLES is copied from Import.jsx as it stood.
console.log("\n[2] clearing only the data tables leaves live rollback state");
{
  await reset();
  const a = await doImport("P1", ["2026-01-01", "2026-01-02", "2026-01-03"]);

  const OLD_HANDLER_TABLES = [
    "OccupancyDay", "SourceDay", "GrossRevenueDay", "PaymentDay", "ClerkShiftRecord",
    "HotelMetric", "TransactionLine", "AdjustmentRefund", "AnomalyAlert", "UploadedReport",
    "TimecardPunch", "DailyFinancialAggregate",
  ];
  for (const t of OLD_HANDLER_TABLES) await localDb[t].clear();

  eq("the data rows are gone", await localDb.OccupancyDay.count(), 0);
  const ledger = await localDb.ImportRecordIds.where("import_id").equals(a.importId).toArray();
  eq("but the rollback ledger row survives", ledger.length, 1);
  eq("and it is still marked active", ledger[0].status, "active");
  eq("naming ids that no longer exist", ledger[0].record_ids.length, 3);
  const history = await listImportSessions();
  ok("and the import history still lists the import, with its Undo",
    history.some((s) => s.importId === a.importId), `history: ${JSON.stringify(history.map((s) => s.importId))}`);

  // The consequence. A later import reuses the cleared table; undoing the OLD
  // import now operates on ids it does not own.
  const b = await doImport("P2", ["2026-03-01", "2026-03-02", "2026-03-03"]);
  const before = await localDb.OccupancyDay.count();
  eq("a later import has landed", before, 3);
  const r = await rollbackImportSession(a.importId);
  const after = await localDb.OccupancyDay.count();
  const collided = before - after;
  console.log(`        undoing the cleared import reported success=${r.success} deleted=${r.deletedCount}; P2 rows lost: ${collided}`);
  if (KEYGEN_RESETS) {
    ok("THE DEFECT: undoing a cleared import destroys a later import's rows",
      collided > 0, `expected the stale ledger to collide with ${JSON.stringify(b.ids)}, lost ${collided}`);
  } else {
    // No collision, but the call still claims to have deleted rows it did not.
    ok("THE DEFECT: undoing a cleared import reports deletions that did not happen",
      r.success === true && r.deletedCount > 0 && collided === 0,
      `success=${r.success} deletedCount=${r.deletedCount} actually removed=${collided}`);
  }
}

// ── 3. The fix: one function clears data, ledger and history together ───────
console.log("\n[3] clearAllImportedData leaves nothing behind");
{
  await reset();
  const a = await doImport("P1", ["2026-01-01", "2026-01-02"]);
  await db.entities.DailyFinancialAggregate.create({ date: "2026-01-01", property_id: "P1", total_revenue_cents: 10000 });

  const clearAllImportedData = clearFn();
  if (!clearAllImportedData) { console.log("        skipping the rest of [3] — nothing to call"); }
  const summary = clearAllImportedData ? await clearAllImportedData() : null;

  eq("data rows are gone", await localDb.OccupancyDay.count(), 0);
  eq("the materialized aggregate is gone", await localDb.DailyFinancialAggregate.count(), 0);
  eq("the rollback ledger is gone", await localDb.ImportRecordIds.count(), 0);
  eq("the import history is gone", (await listImportSessions()).length, 0);
  ok("the call reports what it removed", summary && typeof summary.deletedRows === "number", `got ${JSON.stringify(summary)}`);

  // The honest answer to an undo that can no longer be performed.
  const r = await rollbackImportSession(a.importId);
  eq("undoing a cleared import no longer claims success", r.success, false);
  ok("and says why", typeof r.error === "string" && r.error.length > 0, `got ${JSON.stringify(r)}`);
}

// ── 4. A clear-all cannot reach a later import's rows ───────────────────────
console.log("\n[4] no stale ledger survives to collide with the next import");
{
  await reset();
  const a = await doImport("P1", ["2026-01-01", "2026-01-02", "2026-01-03"]);
  const clearAllImportedData = clearFn();
  if (clearAllImportedData) await clearAllImportedData();

  const b = await doImport("P2", ["2026-03-01", "2026-03-02", "2026-03-03"]);
  const before = await localDb.OccupancyDay.count();
  eq("the new import landed", before, 3);
  await rollbackImportSession(a.importId);
  eq("undoing the cleared import removes nothing", await localDb.OccupancyDay.count(), before);

  // And the new import's own undo still works — the fix must not break rollback.
  const r = await rollbackImportSession(b.importId);
  eq("the new import can still be undone", r.success, true);
  eq("it removes exactly its own rows", r.deletedCount, 3);
  eq("leaving the table empty", await localDb.OccupancyDay.count(), 0);
}

// ── 5. What must SURVIVE a clear-all ────────────────────────────────────────
//
// IdSequence is the persisted high-water mark from playbook item #1. Clearing it
// restarts staff numbering and reissues IDs that already exist in payroll
// history. The dialog also promises properties and settings are kept.
console.log("\n[5] non-imported data and the id high-water mark survive");
{
  await reset();
  await doImport("P1", ["2026-01-01"]);
  // Advance the real allocator rather than writing its row by hand, so this
  // asserts the invariant item #1 exists for and not a schema detail.
  const firstId = await reserveEmployeeId("Alex Person", []);
  await db.entities.Property.create({ property_id: "P1", name: "Test Property" });
  await db.entities.Staff.create({ property_id: "P1", full_name: "A Person", employee_id: "PER057" });
  await db.entities.Expense.create({ property_id: "P1", expense_name: "Utilities", amount: 120, expense_date: "2026-01-01" });
  await db.entities.PayrollRun.create({ property_id: "P1", employee_name: "A Person", total_pay: 900, payroll_status: "approved" });

  const clearAllImportedData = clearFn();
  if (clearAllImportedData) await clearAllImportedData();

  // The worst case for item #1: ask for another ID with an EMPTY staff list, so
  // the live floor offers no protection and only the persisted counter can stop a
  // reissue. If a clear-all wiped IdSequence this returns firstId again.
  const secondId = await reserveEmployeeId("Alex Person", []);
  ok("the staff-ID high-water mark survives a clear-all (item #1 stays fixed)",
    secondId !== firstId, `reissued ${secondId} after ${firstId}`);
  // Derived, not hardcoded: my first draft peeked "PER" and read 0, because
  // employeeIdPrefix strips non-letters and takes the FIRST three of the whole
  // string — "Alex Person" is "ALE". The counter was correct; the probe was
  // reading an empty row, which is exactly the false green a hand-written fixture
  // invites.
  const prefix = employeeIdPrefix("Alex Person");
  eq("the prefix comes from the start of the whole name", prefix, "ALE");
  const seq = await peekIdSequence(prefix);
  ok("the persisted counter still records both reservations", Number(seq) >= 2, `peek(${prefix}): ${JSON.stringify(seq)}`);
  eq("properties survive", await localDb.Property.count(), 1);
  eq("staff survive", await localDb.Staff.count(), 1);
  eq("expenses survive", await localDb.Expense.count(), 1);
  eq("payroll survives", await localDb.PayrollRun.count(), 1);
  eq("the signed-in user survives", (await localDb.User.count()) > 0, true);
}

// ── 6. The set of import-owned stores is written down once ──────────────────
//
// Structural, because the defect was a list in the wrong place rather than a
// wrong computation. Comment-stripped, so a file that documents this defect does
// not fail the probe that fixed it (repo convention). The [^:] guard keeps
// "https://" out of the line-comment rule.
console.log("\n[6] one module owns the list; the page no longer keeps its own");
{
  const strip = (s) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const RESET_PATH = path.join(REPO, "src/lib/importReset.js");
  const reset_ = fs.existsSync(RESET_PATH) ? strip(fs.readFileSync(RESET_PATH, "utf8")) : "";
  ok("src/lib/importReset.js exists", reset_ !== "", "the module the page must delegate to is absent");
  const page = strip(fs.readFileSync(path.join(REPO, "src/pages/Import.jsx"), "utf8"));

  ok("importReset exports the store list", /export const IMPORT_DATA_TABLES/.test(reset_));
  ok("importReset exports the clear function", /export async function clearAllImportedData/.test(reset_));
  ok("the ledger is cleared there", /ImportRecordIds/.test(reset_));
  ok("the lifecycle history is cleared there", /clearImportSessions/.test(reset_));
  ok("the page delegates to it", /clearAllImportedData\(/.test(page));
  ok("the page no longer carries its own table literal",
    !/const IMPORT_TABLES\s*=\s*\[/.test(page),
    "IMPORT_TABLES in Import.jsx is the list that went stale");
  ok("IdSequence is never named as a store to clear",
    !/IdSequence/.test(reset_),
    "clearing IdSequence restarts staff numbering and reissues IDs payroll history already uses");
}

// ── 7. The list cannot go stale again — every import-owned store is classified ─
//
// THE ENHANCEMENT, and the actual point of this item. Sections 3-5 prove today's
// list is right; they would go on passing if someone added a twelfth store an
// import writes to and forgot to clear it, which is precisely the failure that
// produced this defect. So the rule is stated mechanically instead.
//
// A store an import owns declares an `import_id` index. That is read from Dexie's
// live schema rather than by grepping localDb.js, so it reflects the database the
// app actually opens, including every version upgrade. Each such store must be
// EITHER in IMPORT_DATA_TABLES or in a written-down exclusion with a reason. A new
// table with import_id therefore fails this probe until somebody decides which it
// is — which is the decision that was skipped last time.
console.log("\n[7] every store carrying import_id is deliberately classified");
{
  // Not imported data, despite the index. Verified by grepping every create /
  // bulkCreate call site: these three are written only by src/pages/Payroll.jsx and
  // src/pages/Expenses.jsx, never by the import pipeline, so their rows are
  // hand-entered. Clearing them would destroy the staff directory and posted
  // payroll history — unrecoverable, and the opposite of what the dialog promises.
  const NOT_IMPORTED_DATA = new Set(["Staff", "Expense", "PayrollRun"]);

  const importOwned = localDb.tables
    .filter((t) => t.schema.indexes.some((i) => i.name === "import_id") || t.schema.primKey.name === "import_id")
    .map((t) => t.name);

  ok("the schema read found the import-owned stores", importOwned.length >= 8, `found ${JSON.stringify(importOwned)}`);

  const dataSet = new Set(importReset ? importReset.IMPORT_DATA_TABLES : []);
  const unclassified = importOwned.filter(
    (name) => !dataSet.has(name) && !NOT_IMPORTED_DATA.has(name) && name !== importReset?.IMPORT_LEDGER_TABLE
  );
  ok("no store carrying import_id is unclassified", unclassified.length === 0,
    `${JSON.stringify(unclassified)} declare import_id but are neither cleared nor excluded with a reason`);

  // And the list still covers the writer's own map, which is where the day tables
  // are named. Derived rather than copied, so this asserts the derivation held.
  const { ENTITY } = await import("@/lib/reportParsers");
  const missing = Object.values(ENTITY).filter((t) => !dataSet.has(t));
  ok("every report type reportParsers writes is cleared", missing.length === 0,
    `reportParsers writes ${JSON.stringify(missing)} which clear-all would leave behind`);
  ok("the map is not empty (the derivation is not vacuous)", Object.values(ENTITY).length >= 7,
    `ENTITY has ${Object.values(ENTITY).length} entries`);

  // The exclusions must be real tables, or a rename would silently turn a
  // deliberate exclusion into a store nobody clears and nobody notices.
  const phantom = [...NOT_IMPORTED_DATA].filter((n) => typeof localDb[n]?.toArray !== "function");
  ok("every excluded name is still a declared store", phantom.length === 0, `phantom exclusions: ${JSON.stringify(phantom)}`);

  console.log(`        import-owned stores: ${importOwned.length}; cleared: ${dataSet.size}; excluded with a reason: ${NOT_IMPORTED_DATA.size}`);
}

console.log(`\n${"─".repeat(70)}`);
if (failures.length) {
  console.log("Failures:");
  failures.forEach((f) => console.log(`  • ${f}`));
}
console.log(`PASS ${pass}   FAIL ${fail}`);
console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
