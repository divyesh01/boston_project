// Rollback and atomicity guarantees for the import pipeline.
//
// Pins the behaviour that was broken: rollbackImportSession reported
// {success: true} while deleting zero rows, because per-record ids were never
// consulted. These assertions fail loudly if that regresses.
//
// Loader-only on purpose — vite cannot run in the Linux sandbox (node_modules
// holds Windows rollup binaries), so this must not import it.
//
// Usage: node scripts/verify-import-rollback.mjs
import { register } from "node:module";
register(new URL("./resolve-alias.mjs", import.meta.url));

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
// getEncryptionKey() reads sessionStorage. Without it secureStore throws a
// swallowed ReferenceError and the crypto.subtle await never happens — which
// would make the atomicity assertion below pass for the wrong reason.
globalThis.sessionStorage = __storage;
// `window` must BE globalThis: Dexie resolves the IndexedDB API off `window`
// when that global exists, so a stand-in {} hides fake-indexeddb entirely.
globalThis.window = globalThis;
globalThis.screen = { width: 1920, height: 1080 };
if (globalThis.navigator === undefined) {
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "harness", language: "en-US" },
    configurable: true,
  });
}

const { default: localDb } = await import("../src/api/localDb.js");
const {
  db, runInTransaction, createImportSession, completeImportSession,
  addImportRecordIds, rollbackImportSession, listImportSessions,
} = await import("../src/api/base44Client.js");

await localDb.open();

// db.entities fails closed for an unauthenticated caller (blocker B3), so the
// suite has to sign in before it reads or writes a single row.
const { signInAsAllPropertyOwner } = await import("./_harness-auth.mjs");
await signInAsAllPropertyOwner();

let pass = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { failures.push({ name, detail }); console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`); }
}

// The migration must actually have produced the ledger table, or every
// rollback path throws on `undefined.where`.
check(
  "v11 migration created the ImportRecordIds ledger table",
  typeof localDb.ImportRecordIds?.where === "function",
  `localDb.verno=${localDb.verno}, ImportRecordIds=${typeof localDb.ImportRecordIds}`
);
check(
  "ImportSession was dropped, so the old ambiguous name cannot be read by mistake",
  localDb.tables.every((t) => t.name !== "ImportSession"),
  `tables: ${localDb.tables.map((t) => t.name).join(", ")}`
);

// ── Helper: run one complete import of N occupancy rows ──
async function importRows(rows, propertyId = "P1") {
  const session = await createImportSession({
    sourceFile: "harness.csv", propertyId, propertyName: "Harness", reportType: "occupancy",
  });
  const created = await db.entities.OccupancyDay.bulkCreate(
    rows.map((r) => ({ ...r, property_id: propertyId, import_id: session.importId }))
  );
  await addImportRecordIds(session.importId, "OccupancyDay", created.map((r) => r.id), propertyId);
  await completeImportSession(session.importId, { OccupancyDay: created.length });
  return session.importId;
}

// ── 1. Rollback deletes the rows the import created ──
await localDb.OccupancyDay.clear();
const impA = await importRows([
  { date: "2026-02-01", rooms_sold: 20 },
  { date: "2026-02-02", rooms_sold: 21 },
]);
const beforeA = await localDb.OccupancyDay.count();
const rbA = await rollbackImportSession(impA);
const afterA = await localDb.OccupancyDay.count();
check(
  "rollback deletes the rows its import created",
  rbA.success && beforeA === 2 && afterA === 0,
  `success=${rbA.success} deletedCount=${rbA.deletedCount} rows ${beforeA} -> ${afterA} err=${rbA.error || "none"}`
);

// ── 2. Rollback touches ONLY that import's rows ──
// The regression risk in any "delete what the import wrote" scheme is deleting
// by date range or property and taking pre-existing rows with it.
await localDb.OccupancyDay.clear();
const keep = await importRows([{ date: "2026-03-01", rooms_sold: 1 }, { date: "2026-03-02", rooms_sold: 2 }]);
const drop = await importRows([{ date: "2026-03-03", rooms_sold: 3 }]);
await rollbackImportSession(drop);
const remaining = await localDb.OccupancyDay.toArray();
check(
  "rollback leaves other imports' rows untouched",
  remaining.length === 2 && remaining.every((r) => r.import_id === keep),
  `expected 2 rows from ${keep}, got ${remaining.length}: ${remaining.map((r) => `${r.date}/${r.import_id}`).join(", ")}`
);

// ── 3. Rollback is idempotent ──
// Dexie reuses auto-increment ids after deletion, so replaying a stale id list
// can delete unrelated rows that happen to occupy those ids now.
const second = await rollbackImportSession(drop);
const afterSecond = await localDb.OccupancyDay.count();
check(
  "second rollback of the same import is a no-op, not a re-delete",
  second.deletedCount === 0 && afterSecond === 2,
  `deletedCount=${second.deletedCount} rows now ${afterSecond} (expected 0 and 2)`
);

// ── 4. An import with no ledger reports failure instead of faking success ──
const orphan = await createImportSession({
  sourceFile: "no-ledger.csv", propertyId: "P1", propertyName: "Harness", reportType: "occupancy",
});
await completeImportSession(orphan.importId, { OccupancyDay: 5 });
const rbOrphan = await rollbackImportSession(orphan.importId);
check(
  "rollback without a ledger reports failure rather than success",
  rbOrphan.success === false && /ledger|not found/i.test(rbOrphan.error || ""),
  `got success=${rbOrphan.success} error=${JSON.stringify(rbOrphan.error)}`
);

// ── 5. Lifecycle status reflects the rollback ──
const sessions = await listImportSessions();
const rolled = sessions.find((s) => s.importId === drop);
check(
  "lifecycle session is marked rolled_back",
  rolled?.status === "rolled_back",
  `status=${rolled?.status}`
);

// ── 6. A mid-import failure leaves nothing behind ──
await localDb.OccupancyDay.clear();
let threw = null;
try {
  await runInTransaction([async () => {
    await db.entities.OccupancyDay.bulkCreate([
      { date: "2026-04-01", property_id: "P1", rooms_sold: 10 },
      { date: "2026-04-02", property_id: "P1", rooms_sold: 11 },
    ]);
    await db.entities.OccupancyDay.bulkCreate([{ date: "2026-04-03", property_id: "P1", rooms_sold: 12 }]);
    throw new Error("simulated mid-import failure");
  }]);
} catch (e) { threw = e; }
const survivors = await localDb.OccupancyDay.count();
check(
  "a thrown error mid-import commits no partial rows",
  threw !== null && survivors === 0,
  `threw=${threw?.message || "NOTHING"} survivors=${survivors} of 3`
);

// ── 7. End-to-end: the id importReport returns is the id rollback accepts ──
// The checks above hand-build a session, so they would all still pass while the
// UI's undo button was broken. This exercises the real chain instead:
//   importReport() -> result.importId -> UploadedReport.import_id -> rollback
// The bug this pins: importReport used to return the caller's meta.importId
// while the ledger was keyed by the session's own id, so every undo looked up
// an import with no ledger and reported "cannot be undone".
await localDb.OccupancyDay.clear();
let e2eSkip = null;
let parsers = null;
try {
  parsers = await import("../src/lib/reportParsers.js");
} catch (e) {
  e2eSkip = e.message;
}

if (e2eSkip) {
  check("end-to-end importReport -> rollback", false, `could not load reportParsers.js: ${e2eSkip}`);
} else {
  // A caller-supplied importId that differs from the session's. If it ever wins,
  // the returned id and the ledger key diverge and undo breaks.
  const callerId = "imp_caller_supplied_wrong";
  const e2e = await parsers.importReport(
    { type: "occupancy", rowsToImport: [{ date: "2026-05-01", rooms_sold: 30 }, { date: "2026-05-02", rooms_sold: 31 }] },
    { sourceFile: "e2e.csv", propertyId: "P9", propertyName: "E2E", importId: callerId }
  );

  check(
    "importReport returns an importId, and not the caller's",
    Boolean(e2e.importId) && e2e.importId !== callerId,
    `returned ${JSON.stringify(e2e.importId)} (caller passed ${callerId})`
  );

  const tagged = await localDb.OccupancyDay.toArray();
  check(
    "rows are tagged with the same id that was returned",
    tagged.length === 2 && tagged.every((r) => r.import_id === e2e.importId),
    `returned ${e2e.importId}, rows tagged ${[...new Set(tagged.map((r) => r.import_id))].join(", ")}`
  );

  // Exactly what UndoImportButton does with UploadedReport.import_id.
  const rbE2E = await rollbackImportSession(e2e.importId);
  const leftE2E = await localDb.OccupancyDay.count();
  check(
    "rolling back the returned id removes the imported rows",
    rbE2E.success && rbE2E.deletedCount === 2 && leftE2E === 0,
    `success=${rbE2E.success} deletedCount=${rbE2E.deletedCount} remaining=${leftE2E} err=${rbE2E.error || "none"}`
  );
}

console.log(`\n${pass}/${pass + failures.length} passed`);
console.log(`\n${failures.length === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f.name}\n    ${f.detail}`);
}
process.exit(failures.length ? 1 : 0);
