// Probe for "importReport does not validate propertyId at the persist boundary".
//
// Root cause (src/lib/reportParsers.js): importReport() defaulted
// `propertyId = ""` and addMeta stamped `property_id: meta.propertyId || ""`.
// Downstream, skipExisting() and the TransactionLine dedupe degrade an empty
// propertyId to `filter({})` — a scan/write across EVERY property. So a caller
// that reaches the persist boundary without a property (a non-UI caller, a
// future bug, a bypassed dropdown) writes rows with property_id "" and dedupes
// against the whole portfolio, breaking the "Property A cannot see Property B"
// data-integrity invariant.
//
// The fix is a fail-closed guard at the very top of importReport: a missing,
// empty, whitespace, or non-string propertyId is refused with a coded error
// before any session or row is created. This probe asserts the NEGATIVE cases
// (the security directive's requirement). The positive path — a real propertyId
// still imports — is covered by verify-transactions/verify-statistics, which all
// pass a real propertyId and must stay green.
//
// Run: node --import ./scripts/_loader-boot.mjs scripts/probe-import-property-guard.mjs

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

const { importReport } = await import("@/lib/reportParsers");
const localDb = (await import("@/api/localDb")).default;

// A minimal scan the guard must reject BEFORE it inspects. If the guard is
// absent, execution falls through to session creation and the empty-propertyId
// write path.
const scan = {
  type: "occupancy",
  validation: { ok: true, errors: [] },
  rowsToImport: [{ date: "2026-01-05", rooms_sold: 10, total_rooms: 40, room_revenue: 1000 }],
  sections: [],
};

const threw = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

for (const t of localDb.tables) await t.clear();

// ── 1. Every non-property value is refused with the coded error ──────────────
for (const [label, meta] of [
  ["missing propertyId", { propertyName: "X", sourceFile: "a.csv" }],
  ["empty string", { propertyId: "", propertyName: "X", sourceFile: "a.csv" }],
  ["whitespace only", { propertyId: "   ", propertyName: "X", sourceFile: "a.csv" }],
  ["null", { propertyId: null, propertyName: "X", sourceFile: "a.csv" }],
  ["non-string (number)", { propertyId: 123, propertyName: "X", sourceFile: "a.csv" }],
]) {
  const err = await threw(() => importReport(scan, meta));
  T(`${label} is refused`, err !== null, "importReport resolved instead of throwing");
  T(`${label} throws IMPORT_PROPERTY_REQUIRED`,
    err !== null && err.code === "IMPORT_PROPERTY_REQUIRED",
    err ? `code=${err.code} msg=${err.message}` : "no error");
}

// ── 2. The refusal happens BEFORE any row or session is written ──────────────
const rowsAfter = await localDb.OccupancyDay.count();
const sessionsAfter = await localDb.UploadedReport.count();
T("no OccupancyDay rows were created by the refused imports", rowsAfter === 0, `rows=${rowsAfter}`);
T("no import session/report was left behind", sessionsAfter === 0, `sessions=${sessionsAfter}`);

console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
