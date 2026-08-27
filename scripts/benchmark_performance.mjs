// Performance benchmark: indexed Dexie range queries vs the old full-table scan.
//
// Seeds 50,000 occupancy rows (5 properties × 10,000 days) plus 10,000 expense
// rows, then measures the property-scoped read both ways against the REAL
// shipped code:
//   scan    — table.toArray().filter(...)  (the pre-optimization behaviour)
//   indexed — entity proxy → [property_id+date] /
//             [property_id+payment_status] range
//             query planned by base44Client.js
//
// Asserts each indexed path is meaningfully faster than its full scan from the
// SAME process, and that both return identical results. Relative comparisons
// stay honest on fast and slow machines; absolute millisecond ceilings do not.
//
// Run: node scripts/benchmark_performance.mjs

// This is an isolated fake-indexeddb benchmark. Enable the local entity/auth
// path before base44Client is dynamically imported below, so the documented
// bare command never tries to call a real backend or depend on Vite env loading.
process.env.VITE_USE_LOCAL_AUTH ??= "true";

import { register } from "node:module";
register(new URL("./resolve-alias.mjs", import.meta.url));

// Browser-global shims the real modules touch (mirrors scripts/verify-transactions.mjs).
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

const localDb = (await import("../src/api/localDb.js")).default;
const { db } = await import("../src/api/base44Client.js");
// db.entities fails closed for an unauthenticated caller (blocker B3), so the
// benchmark has to sign in or it would be timing queries over zero rows.
const { signInAsAllPropertyOwner } = await import("./_harness-auth.mjs");
await signInAsAllPropertyOwner();

let pass = 0;
let fail = 0;
const T = (name, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`);
  }
};

const pad = (n) => String(n).padStart(2, "0");
const fmtDate = (t) => `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;

async function measureSet(fn, runs) {
  // Warm-up first: the first pass builds Dexie's index cursor / lazy caches.
  await fn();
  const samples = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    const rows = await fn();
    samples.push({ dt: performance.now() - t0, rows });
  }
  samples.sort((a, b) => a.dt - b.dt);
  return {
    // min-of-N: best achievable latency, the standard noise-free microbenchmark
    // metric for an indexed query's intrinsic cost.
    min: samples[0],
    // median-of-N: typical latency under GC/CPU noise.
    median: samples[Math.floor(samples.length / 2)],
  };
}

const ms = (n) => `${n.toFixed(3)} ms`;

// ─────────────────────────────── 0. seed 50,000 occupancy rows ───────────────────────────────
const PROPERTIES = 5;
const DAYS = 10000;
const base = Date.UTC(2000, 0, 1);

console.log(`\n=== Seeding ${PROPERTIES * DAYS} occupancy rows (${PROPERTIES} properties × ${DAYS} days) ===`);
const seedT0 = Date.now();
const occRows = [];
for (let p = 1; p <= PROPERTIES; p++) {
  const pid = `prop_${p}`;
  for (let d = 0; d < DAYS; d++) {
    const date = fmtDate(new Date(base + d * 86400000));
    occRows.push({
      property_id: pid,
      date,
      rooms_sold: (d % 50) + 1,
      total_revenue: ((d % 50) + 1) * 120,
      total_rooms: 100,
      created_date: new Date().toISOString(),
    });
  }
}
await localDb.OccupancyDay.bulkAdd(occRows, { allKeys: true });
const stored = await localDb.OccupancyDay.count();
console.log(`        seeded ${stored} rows in ${Date.now() - seedT0} ms`);
T("schema exposes [property_id+date]", localDb.OccupancyDay.schema.indexes.some((i) => i.name === "[property_id+date]"));
T("schema exposes [date+property_id] (kept)", localDb.OccupancyDay.schema.indexes.some((i) => i.name === "[date+property_id]"));

// ─────────────────────────────── 1. occupancy: property-scoped date range ───────────────────────────────
const pid = "prop_3";
const from = "2026-01-01";
const to = "2026-12-31";

const scanOcc = async () => {
  const all = await localDb.OccupancyDay.toArray();
  return all.filter((r) => r.property_id === pid && r.date >= from && r.date <= to);
};
const indexedOcc = () =>
  db.entities.OccupancyDay.filter({ property_id: pid, date: { $gte: from, $lte: to } }, "date", 1000000);

const occScan = await measureSet(scanOcc, 9);
const occIndexed = await measureSet(indexedOcc, 9);

console.log(`\n=== OccupancyDay: property ${pid}, ${from}..${to} (50,000 rows in table) ===`);
console.log(`  full-table scan : median ${ms(occScan.median.dt)} / min ${ms(occScan.min.dt)}  (50,000 rows cloned)`);
console.log(`  indexed range   : median ${ms(occIndexed.median.dt)} / min ${ms(occIndexed.min.dt)}  ([property_id+date])`);
console.log(`  speedup (median) : ${(occScan.median.dt / Math.max(occIndexed.median.dt, 1e-9)).toFixed(1)}x`);

const sumSold = (rows) => rows.reduce((a, r) => a + r.rooms_sold, 0);
T("indexed returns the identical row count", occIndexed.median.rows.length === occScan.median.rows.length,
  `${occIndexed.median.rows.length} vs ${occScan.median.rows.length}`);
T("indexed returns identical data (rooms_sold checksum)", sumSold(occIndexed.median.rows) === sumSold(occScan.median.rows),
  `${sumSold(occIndexed.median.rows)} vs ${sumSold(occScan.median.rows)}`);
// Absolute wall-clock floors punish faster machines and pass slower ones. Compare
// both paths inside this same process instead: the index must remove enough work
// to stay at least one order of magnitude faster than cloning all 50,000 rows.
const occSpeedup = occScan.median.dt / occIndexed.median.dt;
T(`indexed median at least 10x faster (${occSpeedup.toFixed(1)}x)`, occSpeedup >= 10,
  `${ms(occIndexed.median.dt)} indexed vs ${ms(occScan.median.dt)} scan`);

// ─────────────────────────── 2. expense: property + payment status ──────────────────────────
const EXP_COUNT = 10000;
const expRows = [];
for (let p = 1; p <= 5; p++) {
  for (let i = 0; i < EXP_COUNT / 5; i++) {
    expRows.push({
      property_id: `prop_${p}`,
      expense_name: `Utility bill ${i}`,
      expense_date: fmtDate(new Date(base + i * 86400000)),
      category: "utilities",
      frequency: "one_time",
      payment_status: i % 3 === 0 ? "paid" : i % 3 === 1 ? "unpaid" : "scheduled",
      amount: (1000 + i) / 100,
      taxable: true,
      created_date: new Date().toISOString(),
    });
  }
}
await localDb.Expense.bulkAdd(expRows, { allKeys: true });

const scanExp = async () => {
  const all = await localDb.Expense.toArray();
  return all.filter((r) => r.property_id === "prop_2" && r.payment_status === "paid");
};
const indexedExp = () =>
  db.entities.Expense.filter({ property_id: "prop_2", payment_status: "paid" }, "-expense_date", 1000000);

const expScan = await measureSet(scanExp, 9);
const expIndexed = await measureSet(indexedExp, 9);

console.log(`\n=== Expense: property prop_2, payment status "paid" (10,000 rows in table) ===`);
console.log(`  full-table scan : median ${ms(expScan.median.dt)} / min ${ms(expScan.min.dt)}  (10,000 rows cloned)`);
console.log(`  indexed range   : median ${ms(expIndexed.median.dt)} / min ${ms(expIndexed.min.dt)}  ([property_id+payment_status])`);
const expSpeedup = expScan.median.dt / expIndexed.median.dt;
console.log(`  speedup (median) : ${expSpeedup.toFixed(1)}x`);

const sumAmounts = (rows) => rows.reduce((cents, row) => cents + Math.round(Number(row.amount) * 100), 0);
T("expense: identical row count", expIndexed.median.rows.length === expScan.median.rows.length,
  `${expIndexed.median.rows.length} vs ${expScan.median.rows.length}`);
T("expense: identical data (amount checksum)", sumAmounts(expIndexed.median.rows) === sumAmounts(expScan.median.rows),
  `${sumAmounts(expIndexed.median.rows)} vs ${sumAmounts(expScan.median.rows)}`);
// Expense returns a third of one property's rows, so its selectivity is lower
// than the date window above. Requiring 2x proves the index removes meaningful
// work without pretending every machine, Node build and disk has one latency.
T(`expense: indexed median at least 2x faster (${expSpeedup.toFixed(1)}x)`, expSpeedup >= 2,
  `${ms(expIndexed.median.dt)} indexed vs ${ms(expScan.median.dt)} scan`);

// ─────────────────────────────── 3. property isolation still applies ───────────────────────────────
const otherProp = await db.entities.OccupancyDay.filter({ property_id: "prop_9", date: { $gte: from, $lte: to } }, "date", 1000000);
T("unrelated property returns zero rows", otherProp.length === 0, `${otherProp.length} rows`);

console.log(`\n${"=".repeat(62)}\n  ${pass} passed, ${fail} failed\n${"=".repeat(62)}`);
process.exit(fail ? 1 : 0);
