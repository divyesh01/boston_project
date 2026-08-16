// Probe for the "import commits rows then reports failure" defect.
//
// Symptom: every CSV-import suite (verify-transactions, verify-statistics,
// verify-source-contributions, verify-coexistence) dies with
//   DexieError [TransactionInactiveError]: Transaction has already completed or failed
// at src/api/base44Client.js:441, immediately after
//   [localAuth] remote fallback for custom_auth_me unavailable: connect ECONNREFUSED
//
// Hypothesis: every entity-proxy method calls `await getUserPropertyAccess()`,
// which calls `await auth.me()` -> `functions.invoke('custom_auth_me')`, a real
// network round trip. `importReport` runs `doImport` inside
// `runInTransaction` -> `localDb.transaction('rw', ...)`. Awaiting a
// non-Dexie async task inside a Dexie transaction zone leaves the zone, so
// Dexie commits the transaction; the next table operation then throws.
//
// This probe isolates the mechanism from the app so the fix can be designed
// against measured behaviour instead of assumptions. It answers three questions:
//
//   Q1 Does awaiting a macrotask (setTimeout / network) inside a Dexie rw zone
//      kill the zone?                                     -> reproduces the bug
//   Q2 Does awaiting an ALREADY-RESOLVED native promise kill the zone?
//      -> decides whether an `async` cache accessor is safe, or whether the
//         accessor must be fully synchronous
//   Q3 Does awaiting a Dexie operation keep the zone alive?  -> control
//
// Run: node --import ./scripts/_loader-boot.mjs scripts/probe-import-txn-zone.mjs

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

const localDb = (await import("@/api/localDb")).default;
// db.entities fails closed for an unauthenticated caller (blocker B3), and Q4
// writes through it. Sign in first, otherwise the write is refused for a reason
// that has nothing to do with the transaction zone this probe is about.
const { signInAsAllPropertyOwner } = await import("./_harness-auth.mjs");
await signInAsAllPropertyOwner();

// Zone survival test: run `body` inside a real Dexie rw transaction, then try a
// table read. If the zone died, Dexie throws TransactionInactiveError.
async function zoneSurvives(body) {
  try {
    await localDb.transaction("rw", localDb.tables, async () => {
      await body();
      // The canary: same shape as base44Client.js:441 (`plan.collection.toArray()`).
      await localDb.Property.toArray();
    });
    return { survived: true, error: null };
  } catch (e) {
    return { survived: false, error: `${e.name}: ${e.message}` };
  }
}

console.log("\n=== Q1. Awaiting a macrotask inside a Dexie rw zone ===");
// 25ms, not 0ms. IndexedDB auto-commits a transaction once its request queue
// drains and control returns to the event loop; with setTimeout(...,0) the
// commit sometimes lands after the canary read, making the check flap. A real
// custom_auth_me round trip is far longer than either, so the longer sleep is
// the faithful reproduction.
const q1 = await zoneSurvives(async () => {
  await new Promise((r) => setTimeout(r, 25));
});
T("macrotask await KILLS the zone (this is the bug)", q1.survived === false, `zone survived unexpectedly`);
if (!q1.survived) console.log(`          observed: ${q1.error}`);
T("failure mode is TransactionInactiveError/PrematureCommit",
  !q1.survived && /TransactionInactive|PrematureCommit/.test(q1.error || ""),
  `got ${q1.error}`);

console.log("\n=== Q2. Awaiting an already-resolved native promise ===");
const q2 = await zoneSurvives(async () => {
  await Promise.resolve("cached-value");
});
T("resolved-promise await keeps the zone alive", q2.survived === true, q2.error || "");

console.log("\n=== Q2b. Awaiting an async fn that returns without awaiting ===");
// This is the exact shape a primed cache accessor would have:
//   async function getUserPropertyAccess() { if (primed) return cache; ... }
async function primedAccessor() { return "all"; }
const q2b = await zoneSurvives(async () => {
  const v = await primedAccessor();
  if (v !== "all") throw new Error("accessor returned wrong value");
});
T("await on a no-await async fn keeps the zone alive", q2b.survived === true, q2b.error || "");

console.log("\n=== Q3. Control: awaiting a Dexie op ===");
const q3 = await zoneSurvives(async () => {
  await localDb.Property.toArray();
});
T("Dexie await keeps the zone alive", q3.survived === true, q3.error || "");

console.log("\n=== Q4. Real path: entity bulkCreate inside runInTransaction ===");
const { db, runInTransaction } = await import("@/api/base44Client");
let q4err = null;
let q4count = 0;
try {
  await runInTransaction([async () => {
    await db.entities.TransactionLine.bulkCreate([
      { property_id: "p1", date: "2026-01-01", amount: 1.23, description: "probe" },
    ]);
  }]);
} catch (e) {
  q4err = `${e.name}: ${e.message}`;
}
// Read OUTSIDE the transaction to see whether rows committed despite the throw.
q4count = await localDb.TransactionLine.count();

if (q4err) console.log(`          import threw: ${q4err}`);
console.log(`          rows actually in TransactionLine afterwards: ${q4count}`);

T("bulkCreate inside runInTransaction does NOT throw", q4err === null, q4err || "");
T("no split-brain: throw implies zero rows committed",
  !(q4err !== null && q4count > 0),
  q4err !== null && q4count > 0
    ? `COMMIT-THEN-FAIL CONFIRMED: ${q4count} row(s) persisted but the caller saw an error`
    : "");

console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
