// Probe (audit finding 3.5): the TransactionLine import dedupe read materialized
// the WHOLE property ledger to build a Set of dedupe_keys — a 100k-row read to
// answer "have I already seen these ≤17k incoming rows". This gate pins the
// refactor to a date-bounded indexed lookup (existingTxnDedupeKeys), proving it
// is:
//   1. BYTE-IDENTICAL in selection to the old full-table scan (same rows import),
//   2. INDEXED and bounded to the incoming date window, not the whole history,
//   3. property-isolated (property B never suppresses property A's import),
//   4. reconcile-to-the-cent on the imported subset,
//   5. and FALLS BACK to the full read — still catching every duplicate — when an
//      incoming row lacks a clean ISO date (so the key's date is not comparable).
//
// It is lossless because transactionDedupeKey's second component IS the ISO date:
// a stored row can only collide with an incoming row of the same date, so the
// incoming [minDate,maxDate] window cannot clip a real duplicate.
//
// Run: node --import ./scripts/_loader-boot.mjs scripts/probe-dedupe-indexed-lookup.mjs

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

let pass = 0, fail = 0;
const failures = [];
const ok = (label, cond, detail = "") => {
  if (cond) { pass += 1; console.log(`  ok   ${label}${detail ? `  (${detail})` : ""}`); }
  else { fail += 1; failures.push(`${label}${detail ? ` — ${detail}` : ""}`); console.log(`  FAIL ${label}${detail ? `  (${detail})` : ""}`); }
};

const localDb = (await import("@/api/localDb")).default;
const { db, invalidatePropertyAccess } = await import("@/api/base44Client");
const { secureStore } = await import("@/lib/securityUtils");
const { existingTxnDedupeKeys } = await import("@/lib/reportParsers");
const { assignDedupeKeys } = await import("@/lib/transactionNorm");
const { toCents, sumCents } = await import("@/lib/decimal");

// PLACEHOLDER_INSTRUMENT
// ── Instrument: count table scans vs indexed reads and rows materialized ──────
const TableProto = Object.getPrototypeOf(localDb.TransactionLine);
const CollProto = Object.getPrototypeOf(localDb.TransactionLine.where("date").equals("x"));
const origTableToArray = TableProto.toArray;
const origCollToArray = CollProto.toArray;
const origWhere = TableProto.where;
let M = null;
TableProto.toArray = function (...a) {
  if (M) { M.scans += 1; M.depth += 1; }
  try { return origTableToArray.apply(this, a); }
  finally { if (M) M.depth -= 1; }
};
CollProto.toArray = function (...a) {
  const m = M;
  if (m && m.depth === 0) m.indexed += 1;
  return origCollToArray.apply(this, a).then((r) => {
    if (m) m.rows += Array.isArray(r) ? r.length : (r == null ? 0 : 1);
    return r;
  });
};
TableProto.where = function (idx) {
  if (M && typeof idx === "string") M.wheres.push(idx);
  return origWhere.apply(this, arguments);
};
async function measure(fn) {
  const prev = M;
  M = { scans: 0, indexed: 0, rows: 0, depth: 0, wheres: [] };
  try { const value = await fn(); return { ...M, value }; }
  finally { M = prev; }
}

const A = "prop_a";
const B = "prop_b";
const LOCAL_SESSION_KEY = "rr_local_session";
const DAYS = 200;            // property history depth
const WINDOW_FROM = "2026-06-01";
const WINDOW_TO = "2026-06-05"; // the 5-day re-export window
const day = (i) => {
  const d = new Date(Date.UTC(2026, 0, 1) + i * 86400000);
  return d.toISOString().slice(0, 10);
};

// A stored/incoming transaction row, pre-dedupe-key.
const txn = (pid, date, folio, code, amount) => ({
  property_id: pid, date, time: "09:00", folio_number: folio,
  transaction_code: code, amount, source: "WALK IN",
});

// PLACEHOLDER_SEED
// ── Seed: 200 days of A-history + a colliding B row, then sign in as owner ────
async function seed() {
  for (const t of localDb.tables) await t.clear();
  await localDb.Property.bulkAdd([
    { id: A, code: "AAA", name: "Alpha Inn", rooms: 40, active: true },
    { id: B, code: "BBB", name: "Bravo Lodge", rooms: 60, active: true },
  ]);
  await localDb.User.bulkAdd([{
    id: "u_owner", username: "owner1", email: "owner@probe.local", role: "owner",
    property_access: "all", full_name: "owner1", is_active: true, is_locked: false,
    mfa_enabled: false, failed_login_count: 0, created_date: new Date().toISOString(),
  }]);

  // Property A: one txn per day for 200 days, folio F<i>, $100.00 each.
  const aRows = [];
  for (let i = 0; i < DAYS; i += 1) aRows.push(txn(A, day(i), `F${i}`, "SALE", 100));
  // Property B: a row whose date/folio/code/amount MATCH an A row inside the
  // window — same natural fields, different property. Its key must differ (it
  // carries B's property_id) so it can never suppress A's import.
  const bRows = [txn(B, WINDOW_FROM, "F151", "SALE", 100)]; // day(151) === 2026-06-01
  await localDb.TransactionLine.bulkAdd(assignDedupeKeys(aRows));
  await localDb.TransactionLine.bulkAdd(assignDedupeKeys(bRows));

  await secureStore(LOCAL_SESSION_KEY,
    JSON.stringify({ userId: "u_owner", expiresAt: new Date(Date.now() + 3600e3).toISOString() }));
  invalidatePropertyAccess();
  const me = await db.auth.me();
  ok("seeded and signed in as an all-property owner", !!me && me.id === "u_owner",
    `${DAYS} days of A history + 1 colliding B row`);
}
await seed();

// The window spans day(151)=2026-06-01 .. day(155)=2026-06-05. Confirm the
// mapping the fixtures rely on so a calendar mistake fails loudly here.
ok("window maps to days 151..155", day(151) === WINDOW_FROM && day(155) === WINDOW_TO,
  `${day(151)}..${day(155)}`);

// The incoming re-export for property A: 3 EXACT duplicates already stored
// (days 151,152,153) + 2 genuinely NEW rows (day 153 with a different folio, and
// a brand-new day 156 outside the seeded-collision but inside a widened window).
const incomingA = assignDedupeKeys([
  txn(A, day(151), "F151", "SALE", 100),   // exact dup
  txn(A, day(152), "F152", "SALE", 100),   // exact dup
  txn(A, day(153), "F153", "SALE", 100),   // exact dup
  txn(A, day(153), "F999", "SALE", 250.55), // NEW: same day, new folio/amount
  txn(A, day(156), "F156", "SALE", 88.10),  // NEW: day just past the stored window
]);

// PLACEHOLDER_SECTIONS
const keysOf = (rows) => rows.map((r) => r.dedupe_key).sort();

console.log("\n1. selection is byte-identical to the old full-table scan");
{
  const old = await db.entities.TransactionLine.filter({ property_id: A }, "date");
  const oldSeen = new Set(old.map((r) => r.dedupe_key));
  const newSeen = await existingTxnDedupeKeys(db.entities.TransactionLine, A, incomingA);
  const newRowsOld = incomingA.filter((r) => !oldSeen.has(r.dedupe_key));
  const newRowsNew = incomingA.filter((r) => !newSeen.has(r.dedupe_key));
  ok("every incoming key gets the same seen/not-seen verdict",
    incomingA.every((r) => oldSeen.has(r.dedupe_key) === newSeen.has(r.dedupe_key)));
  ok("the imported set is identical between old scan and new bounded read",
    JSON.stringify(keysOf(newRowsOld)) === JSON.stringify(keysOf(newRowsNew)),
    `${newRowsNew.length} rows`);
}

console.log("\n2. exactly the two genuinely-new rows import; the three dups are excluded");
{
  const seen = await existingTxnDedupeKeys(db.entities.TransactionLine, A, incomingA);
  const newRows = incomingA.filter((r) => !seen.has(r.dedupe_key));
  ok("two new rows import", newRows.length === 2, `${newRows.length}`);
  ok("the new rows are F999@day153 and F156@day156",
    newRows.some((r) => r.folio_number === "F999") && newRows.some((r) => r.folio_number === "F156"),
    keysOf(newRows).join(" , "));
  ok("no exact-duplicate folio survives", !newRows.some((r) => ["F151", "F152", "F153"].includes(r.folio_number) && r.amount === 100));
}

console.log("\n3. the read is indexed on [property_id+date] and bounded to the window");
{
  const m = await measure(() => existingTxnDedupeKeys(db.entities.TransactionLine, A, incomingA));
  ok("no full table scan", m.scans === 0, `scans ${m.scans}`);
  ok("drives the compound [property_id+date] index",
    m.wheres.includes("[property_id+date]"), m.wheres.join(","));
  ok("materializes only the 6 in-window A rows (days 151-156), not all 200",
    m.rows === 6, `${m.rows} of ${DAYS}`);
}

// PLACEHOLDER_SECTIONS2
console.log("\n4. property isolation — B's identical-looking row never touches A's dedupe");
{
  const seen = await existingTxnDedupeKeys(db.entities.TransactionLine, A, incomingA);
  const bKey = `${B}|${WINDOW_FROM}|09:00|F151|SALE|100|0`;
  const aDupKey = `${A}|${WINDOW_FROM}|09:00|F151|SALE|100|0`;
  ok("B's row key is absent from A's seen set", !seen.has(bKey), bKey);
  ok("A's own day-151 duplicate is still caught", seen.has(aDupKey), aDupKey);
}

console.log("\n5. the imported subset reconciles to the cent");
{
  const seen = await existingTxnDedupeKeys(db.entities.TransactionLine, A, incomingA);
  const newRows = incomingA.filter((r) => !seen.has(r.dedupe_key));
  // $250.55 + $88.10 = $338.65 = 33865 cents.
  ok("imported cents = 33865 ($338.65)", sumCents(newRows.map((r) => r.amount)) === 33865,
    `${sumCents(newRows.map((r) => r.amount))} cents`);
  ok("each summand is cent-exact", newRows.every((r) => toCents(r.amount) === Math.round(r.amount * 100)));
}

console.log("\n6. a non-ISO incoming date drops the bound and reads the full property — still catching every dup");
{
  const incomingBad = assignDedupeKeys([
    txn(A, day(152), "F152", "SALE", 100),  // exact dup of a stored row
    txn(A, "2026.06.02", "FX", "SALE", 5),  // non-ISO → forces the full read
  ]);
  const m = await measure(() => existingTxnDedupeKeys(db.entities.TransactionLine, A, incomingBad));
  ok("the date bound is dropped: all 200 A rows are materialized", m.rows === DAYS, `${m.rows}`);
  const dupKey = `${A}|${day(152)}|09:00|F152|SALE|100|0`;
  ok("the duplicate is STILL caught on the fallback path", m.value.has(dupKey), dupKey);
}

console.log("\n7. an all-property import stays bounded via the single date index");
{
  const m = await measure(() => existingTxnDedupeKeys(db.entities.TransactionLine, "", incomingA));
  ok("drives the single-field date index", m.wheres.includes("date"), m.wheres.join(","));
  ok("materializes only in-window rows across both properties (6 A + 1 B)",
    m.rows === 7, `${m.rows}`);
}

console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
if (fail) { console.log("\nfailures:\n  " + failures.join("\n  ")); }
process.exit(fail === 0 ? 0 : 1);




