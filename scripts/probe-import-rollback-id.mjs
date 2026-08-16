// Probe for the "mid-import rollback is a guaranteed silent no-op" defect (B7).
//
// The rollback ledger (ImportRecordIds) is keyed by the id that
// createImportSession mints (`imp_<ts>_<rand>`). Import.jsx minted its OWN
// crypto.randomUUID() per queue row and rolled back with that, so every
// automatic cleanup looked up an import with no ledger and did nothing. Worse,
// rollbackImportSession *returns* {success:false} instead of throwing, and the
// return value was discarded — so the failure was invisible even in the console.
//
// Checks the contract the fix establishes:
//   1. rolling back a caller-minted UUID is refused (the old bug's mechanism)
//   2. importReport attaches the REAL session id to the error it throws
//   3. that id is not the caller's meta.importId
//   4. a failed import is marked 'failed', not left 'in_progress' forever
//   5. rolling back a failed session reports truthfully instead of crying
//      "needs manual cleanup" when the transaction already rolled everything back
//   6. a genuinely unknown id is still refused
//
// Run: node --import ./scripts/_loader-boot.mjs scripts/probe-import-rollback-id.mjs

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

let pass = 0;
let fail = 0;
const T = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`); }
};

const DATA = join(dirname(fileURLToPath(import.meta.url)), "data");
const localDb = (await import("@/api/localDb")).default;
const {
  createImportSession, failImportSession, rollbackImportSession, listImportSessions,
} = await import("@/api/base44Client");
const { scanReport, importReport } = await import("@/lib/reportParsers");
// db.entities fails closed for an unauthenticated caller (blocker B3). Without a
// session the import below aborts at the FIRST bulkCreate with "Access denied"
// instead of reaching the injected ledger fault, so §3 would be asserting against
// the wrong failure and the rollback path under test would never run.
const { signInAsAllPropertyOwner } = await import("./_harness-auth.mjs");
await signInAsAllPropertyOwner();

console.log("\n=== 1. A caller-minted UUID can never address the ledger ===");
const callerUuid = crypto.randomUUID();
const rbUuid = await rollbackImportSession(callerUuid);
T("rollback of an unknown caller UUID is refused",
  rbUuid.success === false && /not found/i.test(rbUuid.error || ""),
  `got ${JSON.stringify(rbUuid)}`);
T("the session id format is not a UUID (so the two can never coincide)",
  (await createImportSession({ sourceFile: "fmt-check.csv" })).importId.startsWith("imp_"));

console.log("\n=== 2. importReport attaches the real session id when it fails ===");
// Force a failure INSIDE the import transaction by making the ledger write throw.
// addImportRecordIds re-throws, so the import aborts mid-flight — the exact
// scenario the automatic cleanup path exists for.
const fixture = "Occupancy Summary midelboro.csv";
const csvText = readFileSync(join(DATA, fixture), "utf8");
const scan = await scanReport("occupancy", `file:///${fixture}`, {
  propertyId: "P1", propertyName: "Probe Property", sourceFile: fixture, csvText,
});
T("fixture scanned to at least one row", (scan.totalRows ?? 0) > 0, `totalRows=${scan.totalRows}`);

const realLedgerAdd = localDb.ImportRecordIds.add.bind(localDb.ImportRecordIds);
localDb.ImportRecordIds.add = async () => { throw new Error("simulated ledger write failure"); };

const myImportId = crypto.randomUUID();
let caught = null;
try {
  await importReport(scan, {
    propertyId: "P1", propertyName: "Probe Property",
    importId: myImportId, sourceFile: fixture, csvText,
  });
} catch (e) {
  caught = e;
} finally {
  localDb.ImportRecordIds.add = realLedgerAdd;
}

T("the import threw", caught !== null);
T("the error carries an importId", typeof caught?.importId === "string" && caught.importId.length > 0,
  `importId=${JSON.stringify(caught?.importId)}`);
T("that id is the SESSION id, not the caller's", caught?.importId !== myImportId,
  `caller=${myImportId} error=${caught?.importId}`);
T("the session id has the imp_ ledger format", /^imp_\d+_/.test(caught?.importId || ""),
  `got ${caught?.importId}`);
T("importId is non-enumerable (never leaks into a serialised error)",
  caught !== null && !Object.keys(caught).includes("importId"),
  `keys=${JSON.stringify(Object.keys(caught || {}))}`);

console.log("\n=== 3. The failed session is marked, not left in_progress ===");
const sessions = await listImportSessions();
const failed = sessions.find((s) => s.importId === caught?.importId);
T("session exists", !!failed);
T("session status is 'failed'", failed?.status === "failed", `status=${failed?.status}`);
T("session records the failure reason", /ledger write failure/.test(failed?.error || ""),
  `error=${JSON.stringify(failed?.error)}`);

console.log("\n=== 4. Rolling back the failed session tells the truth ===");
const committed = await localDb.OccupancyDay.count();
T("the failed import committed no rows", committed === 0, `OccupancyDay count=${committed}`);
const rbFailed = await rollbackImportSession(caught?.importId);
T("rollback of a failed session succeeds instead of demanding manual cleanup",
  rbFailed.success === true, `got ${JSON.stringify(rbFailed)}`);
T("it reports zero deletions", rbFailed.deletedCount === 0, `deletedCount=${rbFailed.deletedCount}`);
T("it is flagged as an atomic rollback", rbFailed.atomicRollback === true,
  `got ${JSON.stringify(rbFailed)}`);

console.log("\n=== 5. An in_progress session with no ledger is still refused ===");
const orphan = await createImportSession({ sourceFile: "orphan.csv" });
const rbOrphan = await rollbackImportSession(orphan.importId);
T("in_progress + no ledger still reports failure",
  rbOrphan.success === false && /ledger/i.test(rbOrphan.error || ""),
  `got ${JSON.stringify(rbOrphan)}`);

console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
