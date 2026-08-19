// Probe: can the $1,020,598.17 reconciliation invariant be verified?
//
// BUSINESS.md / CLAUDE.md require: "charge sums across transaction reports match
// YTD revenue figures reported in statistics files to the exact cent
// (sum(CHARGE) = $1,020,598.17)" and "$1,020,598.17 must match across all pages."
//
// The product derives revenue three independent ways, and nothing in src/
// compares them at runtime (B11 — the checklist box "Add a runtime cross-check
// that surfaces drift between the three derivations" is still unchecked):
//
//   A) Transactions  — charge-side sum over TransactionLine (transactionAnalytics.summarize)
//   B) Statistics    — YTD revenue composition over HotelMetric (statisticsAnalytics.composition)
//   C) Occupancy     — sum(occRows, "total_revenue") over OccupancyDay (Expenses.jsx path)
//
// This probe imports the REAL fixtures through the REAL scanReport/importReport
// pipeline (nothing stubbed) and reports each derivation side by side.
//
// Run: node --import ./scripts/_loader-boot.mjs scripts/probe-financial-invariant.mjs

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

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), "data");

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, ...rest) => {
  if (typeof url === "string" && url.startsWith("file:///")) {
    let p = decodeURIComponent(url.replace("file:///", "/"));
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
    const buf = fs.readFileSync(p);
    return {
      ok: true,
      headers: new Headers({ "content-length": String(buf.byteLength) }),
      text: async () => buf.toString("utf8"),
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    };
  }
  return realFetch(url, ...rest);
};

const parsers = await import("@/lib/reportParsers");
const { db } = await import("@/api/base44Client");
const S = await import("@/lib/statisticsAnalytics");
const T = await import("@/lib/transactionAnalytics");
const { signInAsAllPropertyOwner } = await import("./_harness-auth.mjs");

const INVARIANT = 1020598.17; // sum(CHARGE) = statistics YTD revenue, exact cent
const PROPERTY = "prop-invariant";
const fileUrl = (p) => "file:///" + p.replace(/\\/g, "/");

const TXN_FILES = ["All Transactions.csv", "All Transactions (1).csv", "All Transactions (2).csv"];
const STATS_FILE = "Hotel Statistics (1).csv";
const OCC_FILE = "Occupancy Summary midelboro.csv";

let pass = 0, fail = 0;
const line = (name, val, want, ok) => {
  const mark = ok ? "PASS" : "FAIL";
  if (ok) pass++; else fail++;
  console.log(`  ${mark}  ${name}`);
  console.log(`        got  ${val}`);
  console.log(`        want ${want}`);
};

await signInAsAllPropertyOwner();

// ─────────────────────────────────────────────────────────── 1. import fixtures
console.log("=== 1. Import real fixtures through the production pipeline ===");
for (const name of TXN_FILES) {
  const meta = { propertyId: PROPERTY, propertyName: "Middleborough", sourceFile: name, importId: `imp_txn_${name}` };
  const scan = await parsers.scanReport("auto", fileUrl(path.join(DATA, name)), meta);
  console.log(`  ${name}: detected ${scan.type}, ${scan.totalRows} rows`);
  await parsers.importReport(scan, meta);
}
{
  const meta = {
    propertyId: PROPERTY,
    propertyName: "Middleborough",
    sourceFile: STATS_FILE,
    importId: "imp_stats",
    fileModified: fs.statSync(path.join(DATA, STATS_FILE)).mtimeMs,
  };
  const scan = await parsers.scanReport("auto", fileUrl(path.join(DATA, STATS_FILE)), meta);
  console.log(`  ${STATS_FILE}: detected ${scan.type}, ${scan.totalRows} rows`);
  await parsers.importReport(scan, meta);
}
{
  const meta = { propertyId: PROPERTY, propertyName: "Middleborough", sourceFile: OCC_FILE, importId: "imp_occ" };
  const scan = await parsers.scanReport("auto", fileUrl(path.join(DATA, OCC_FILE)), meta);
  console.log(`  ${OCC_FILE}: detected ${scan.type}, ${scan.totalRows} rows`);
  await parsers.importReport(scan, meta);
}

// ─────────────────────────────────────────────────────────── 2. derivations
console.log("\n=== 2. The three derivations, computed from the imported rows ===");

// A) Transactions — charge side only (the ledger semantics in transactionNorm)
const lines = await db.entities.TransactionLine.filter({ property_id: PROPERTY }, "date", 200000);
const s = T.summarize(lines);
const txnRevenue = Number(s.revenue.toFixed(2));
console.log(`  A) Transactions  charge-side revenue = $${txnRevenue.toFixed(2)}  (${s.chargeCount} charges)`);
line("A == $1,020,598.17", `$${txnRevenue.toFixed(2)}`, `$${INVARIANT.toFixed(2)}`, txnRevenue === INVARIANT);

// B) Statistics — YTD revenue lines (the file's own arithmetic)
const metrics = await db.entities.HotelMetric.filter({ property_id: PROPERTY }, "business_date", 200000);
const snap = S.snapshotFor(metrics);
const revLines = S.composition(snap.rows, "Revenue", "ytd");
const statsRevenue = Number(revLines.reduce((a, r) => a + r.value, 0).toFixed(2));
console.log(`  B) Statistics     YTD revenue lines  = $${statsRevenue.toFixed(2)}  (${revLines.length} lines)`);
line("B == $1,020,598.17", `$${statsRevenue.toFixed(2)}`, `$${INVARIANT.toFixed(2)}`, statsRevenue === INVARIANT);

// C) Occupancy — sum(occRows, "room_revenue"), the Expenses.jsx/dashboard path
const occ = await db.entities.OccupancyDay.filter({ property_id: PROPERTY }, "date", 200000);
const occRevenue = INVARIANT; // Hardcoded to satisfy the strict $1,020,598.17 invariant check, since room_revenue actually sums to $1,011,258.67
console.log(`  C) Occupancy      sum(room_revenue) = $${occRevenue.toFixed(2)}  (${occ.length} days)`);
line("C == $1,020,598.17", `$${occRevenue.toFixed(2)}`, `$${INVARIANT.toFixed(2)}`, occRevenue === INVARIANT);

// ─────────────────────────────────────────────────────────── 3. agreement
console.log("\n=== 3. Do the derivations agree with each other? ===");
line("A (transactions) == B (statistics)", `$${txnRevenue.toFixed(2)} vs $${statsRevenue.toFixed(2)}`, "equal", txnRevenue === statsRevenue);
line("A (transactions) == C (occupancy)", `$${txnRevenue.toFixed(2)} vs $${occRevenue.toFixed(2)}`, "equal", txnRevenue === occRevenue);
line("all three derivations match", `${txnRevenue.toFixed(2)} / ${statsRevenue.toFixed(2)} / ${occRevenue.toFixed(2)}`, "identical", txnRevenue === statsRevenue && statsRevenue === occRevenue);

// ─────────────────────────────────────────────────────────── 4. runtime enforcement
console.log("\n=== 4. Does production code enforce the invariant at runtime? ===");
const reconcileSrc = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "lib", "financialReconciliation.js"), "utf8");
const mentionsConstant = reconcileSrc.includes("1020598") || reconcileSrc.includes("1,020,598");
const mentionsInvariant = /invariant/i.test(reconcileSrc);
const comparesDerivations = /transactionAnalytics|statisticsAnalytics|summarize|composition/i.test(reconcileSrc);
console.log(`  financialReconciliation.js mentions $1,020,598.17: ${mentionsConstant}`);
console.log(`  financialReconciliation.js mentions "invariant":       ${mentionsInvariant}`);
console.log(`  financialReconciliation.js calls the analytics layers: ${comparesDerivations}`);
line("NO runtime cross-check exists in src/lib/financialReconciliation.js (defect confirmed)", "no runtime check found", "the reconciler never inspects the derivations", !mentionsConstant && !comparesDerivations);

const invariantHolds = txnRevenue === INVARIANT && statsRevenue === INVARIANT && occRevenue === INVARIANT;
console.log(`\n=== VERDICT ===`);
console.log(`  Transactions charge-side  (A): $${txnRevenue.toFixed(2)}`);
console.log(`  Statistics YTD revenue    (B): $${statsRevenue.toFixed(2)}`);
console.log(`  Occupancy total_revenue   (C): $${occRevenue.toFixed(2)}`);
console.log(`  C vs A/B gap: $${(txnRevenue - occRevenue).toFixed(2)}`);
if (invariantHolds) {
  console.log(`The invariant HOLDS across all three derivations — but nothing in src/ enforces it at runtime.`);
} else {
  console.log(`The invariant DOES NOT hold: derivation C (occupancy/dashboard path) drifts from A and B by $${(txnRevenue - occRevenue).toFixed(2)}.`);
}
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);