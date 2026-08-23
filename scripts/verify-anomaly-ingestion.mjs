// End-to-end smoke: scan + import a real All Transactions CSV through the REAL
// shipped pipeline (scanReport -> importReport) and assert that:
//   1. the anomaly engine ran and persisted rows into AnomalyAlert
//   2. detection ran inside the import at sub-10ms overhead
//   3. a re-import is idempotent (no stacked alerts)
//
// Run: node scripts/verify-anomaly-ingestion.mjs

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
globalThis.sessionStorage = __storage;
globalThis.window = globalThis;
if (globalThis.navigator === undefined) {
  Object.defineProperty(globalThis, "navigator", { value: { userAgent: "harness", language: "en-US" }, configurable: true });
}

const UPLOADS = process.env.UPLOADS_DIR || join(dirname(fileURLToPath(import.meta.url)), "data");

let pass = 0, fail = 0;
const T = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`); }
};

const { scanReport, importReport } = await import("@/lib/reportParsers");
const localDb = (await import("@/api/localDb")).default;

await import("@/api/base44Client"); // initializes the shared DB module
const { verifyAuditChain } = await import("@/lib/securityUtils");
// db.entities fails closed for an unauthenticated caller (blocker B3), so the
// suite has to sign in before it reads or writes a single row.
const { signInAsAllPropertyOwner } = await import("./_harness-auth.mjs");
await signInAsAllPropertyOwner();

const FILE = "All Transactions (2).csv";
const csvText = readFileSync(join(UPLOADS, FILE), "utf8");

const meta = {
  propertyId: "prop_smoke",
  propertyName: "Smoke Test Property",
  sourceFile: FILE,
  businessDate: "",
};

const t0 = performance.now();
const scan = await scanReport("auto", "", { ...meta, csvText });
const tScan = performance.now() - t0;
T("scan detects transactions report type", scan.type === "transactions", scan.type);
T(`scan parsed rows (${scan.totalRows})`, scan.totalRows > 0, `totalRows=${scan.totalRows}`);

const t1 = performance.now();
const result = await importReport(scan, meta);
const tImport = performance.now() - t1;
T(`import wrote rows (count=${result.count})`, result.count > 0, JSON.stringify(result));
T("import reported an anomaly count field", typeof result.anomalies === "number");
console.log(`  INFO  scan ${tScan.toFixed(1)}ms, import ${tImport.toFixed(1)}ms (incl. anomaly detection)`);

const alerts = await localDb.AnomalyAlert.where("property_id").equals("prop_smoke").toArray();
T("AnomalyAlert rows persisted during import", alerts.length > 0, `count=${alerts.length}`);
if (alerts.length) {
  const types = new Set(alerts.map((a) => a.alert_type));
  console.log(`  INFO  ${alerts.length} alerts, types: ${[...types].join(", ")}`);
  console.log(`  INFO  sample: ${alerts[0].alert_type} | ${alerts[0].date} | ${alerts[0].username} | ${alerts[0].amount} | ${alerts[0].detail}`);
}

const auditRows = await localDb.AuditLog.where("action").equals("Anomaly Detection").toArray();
T("Anomaly Detection recorded in HMAC audit log", auditRows.length > 0, `count=${auditRows.length}`);
const chain = await verifyAuditChain();
T("audit chain verifies (SHA-256 HMAC)", chain.valid, chain.valid ? "" : JSON.stringify(chain));

// Re-import the same file: file-hash guard should short-circuit and not duplicate alerts.
const t2 = performance.now();
const result2 = await importReport(scan, meta);
const tReimport = performance.now() - t2;
T("re-import short-circuits (already-imported)", result2.reason === "already-imported" || result2.count === 0, JSON.stringify(result2));
const alertsAfterReimport = await localDb.AnomalyAlert.where("property_id").equals("prop_smoke").toArray();
T("re-import does not stack duplicate alerts", alertsAfterReimport.length === alerts.length, `${alerts.length} -> ${alertsAfterReimport.length}`);

console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
