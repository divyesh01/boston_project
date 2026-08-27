/**
 * PROBE: the local Expense schema must index the field the real entity writes.
 *
 * The Base44 entity and Expenses page use `payment_status`. Dexie v14 instead
 * indexed `status`, and the performance benchmark seeded that same imaginary
 * field. The benchmark was green while every real Expense row missed the index.
 *
 * Run:
 *   node --import ./scripts/_loader-boot.mjs scripts/probe-expense-payment-status-index.mjs
 */

await import("fake-indexeddb/auto");
globalThis.crypto ??= (await import("node:crypto")).webcrypto;

const memory = new Map();
const storage = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => memory.set(key, String(value)),
  removeItem: (key) => memory.delete(key),
  clear: () => memory.clear(),
};
globalThis.localStorage = storage;
globalThis.sessionStorage = storage;
globalThis.window = globalThis;
if (globalThis.navigator === undefined) {
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "expense-index-probe", language: "en-US" },
    configurable: true,
  });
}

import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./_repo-root.mjs";

let pass = 0;
let fail = 0;
const failures = [];
function check(label, condition, detail = "") {
  if (condition) {
    pass += 1;
    console.log(`  ok   ${label}${detail ? ` (${detail})` : ""}`);
  } else {
    fail += 1;
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${label}${detail ? ` (${detail})` : ""}`);
  }
}

const entity = JSON.parse(readFileSync(path.join(REPO_ROOT, "base44/entities/Expense.jsonc"), "utf8"));
const expensePage = readFileSync(path.join(REPO_ROOT, "src/pages/Expenses.jsx"), "utf8");
const benchmark = readFileSync(path.join(REPO_ROOT, "scripts/benchmark_performance.mjs"), "utf8");
const localDb = (await import("@/api/localDb")).default;
const { default: Dexie } = await import("dexie");

console.log("\n1. canonical field");
check("Base44 declares payment_status", !!entity.properties?.payment_status);
check("Base44 does not declare status", !entity.properties?.status);
check("the Expenses page writes payment_status", /payment_status:\s*form\.payment_status/.test(expensePage));

console.log("\n2. live Dexie schema");
const indexNames = new Set(localDb.Expense.schema.indexes.map((index) => index.name));
check("Expense has a single payment_status index", indexNames.has("payment_status"), [...indexNames].join(", "));
check("Expense has a property + payment_status index", indexNames.has("[property_id+payment_status]"), [...indexNames].join(", "));
check("the obsolete single status index is gone", !indexNames.has("status"), [...indexNames].join(", "));
check("the obsolete compound status index is gone", !indexNames.has("[property_id+status]"), [...indexNames].join(", "));

console.log("\n3. real rows populate the index");
await localDb.Expense.clear();
await localDb.Expense.bulkAdd([
  { property_id: "alpha", expense_name: "Power", amount: 100, expense_date: "2026-08-01", payment_status: "paid" },
  { property_id: "alpha", expense_name: "Water", amount: 80, expense_date: "2026-08-02", payment_status: "unpaid" },
  { property_id: "bravo", expense_name: "Power", amount: 90, expense_date: "2026-08-01", payment_status: "paid" },
]);

let indexedRows = [];
let indexError = null;
try {
  indexedRows = await localDb.Expense
    .where("[property_id+payment_status]")
    .equals(["alpha", "paid"])
    .toArray();
} catch (error) {
  indexError = error;
}
check("the compound index is queryable", !indexError, indexError?.message || "opened");
check("the compound index returns only alpha's paid row",
  indexedRows.length === 1 && indexedRows[0]?.expense_name === "Power",
  `${indexedRows.length} row(s)`);

console.log("\n4. v23 to v24 migration preserves existing rows");
const migrationDbName = "ExpensePaymentStatusMigrationProbe";
const oldSchema = '++id, property_id, expense_date, category, status, [property_id+expense_date], [property_id+status], import_id, created_date';
const newSchema = '++id, property_id, expense_date, category, payment_status, [property_id+expense_date], [property_id+payment_status], import_id, created_date';
const beforeUpgrade = new Dexie(migrationDbName);
beforeUpgrade.version(23).stores({ Expense: oldSchema });
await beforeUpgrade.open();
const oldId = await beforeUpgrade.table("Expense").add({
  property_id: "alpha",
  expense_name: "Insurance",
  amount: 125,
  expense_date: "2026-08-03",
  payment_status: "scheduled",
});
beforeUpgrade.close();

const afterUpgrade = new Dexie(migrationDbName);
afterUpgrade.version(23).stores({ Expense: oldSchema });
afterUpgrade.version(24).stores({ Expense: newSchema });
await afterUpgrade.open();
const carried = await afterUpgrade.table("Expense").get(oldId);
const carriedByIndex = await afterUpgrade.table("Expense")
  .where("[property_id+payment_status]")
  .equals(["alpha", "scheduled"])
  .toArray();
check("the upgrade keeps the original Expense row", carried?.expense_name === "Insurance");
check("the upgrade keeps its payment_status value", carried?.payment_status === "scheduled");
check("the upgraded index contains the existing row", carriedByIndex.length === 1 && carriedByIndex[0]?.id === oldId);
afterUpgrade.close();
await Dexie.delete(migrationDbName);

console.log("\n5. benchmark uses production-shaped data");
check("benchmark seeds payment_status", /payment_status:\s*i\s*%\s*3/.test(benchmark));
check("benchmark filters payment_status", /payment_status:\s*"paid"/.test(benchmark));
check("benchmark no longer seeds the imaginary status field", !/^\s*status:\s*i\s*%\s*3/m.test(benchmark));
check("benchmark documents the real compound index", !benchmark.includes("[property_id+status]"));

const localAuthSetup = benchmark.indexOf('process.env.VITE_USE_LOCAL_AUTH ??= "true"');
const clientImport = benchmark.indexOf('import("../src/api/base44Client.js")');
check("the documented bare benchmark enables its local test backend",
  localAuthSetup >= 0,
  `local-auth setup found at source offset ${localAuthSetup}`);
check("local auth is enabled before base44Client is imported",
  localAuthSetup >= 0 && clientImport >= 0 && localAuthSetup < clientImport,
  `setup ${localAuthSetup}, import ${clientImport}`);

const absoluteLatencyAssertions = benchmark.match(/\.m(?:in|edian)\.dt\s*[<>]=?\s*\d+(?:\.\d+)?/g) || [];
check("performance gates compare paths from the same run instead of machine milliseconds",
  absoluteLatencyAssertions.length === 0,
  absoluteLatencyAssertions.join(", "));
check("Expense performance requires a meaningful relative speedup",
  /expSpeedup\s*>=\s*2/.test(benchmark));

console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
if (fail) {
  failures.forEach((failure) => console.log(`  - ${failure}`));
  process.exit(1);
}
