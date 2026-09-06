// All four uploaded files in ONE database, imported in one pass.
//
// verify-transactions.mjs and verify-statistics.mjs each start from an empty
// database and load one kind of file. That is the right shape for pinning each
// parser, but it is not the operator's situation: they upload three transaction
// exports AND a statistics export into the same property, and the two paths
// share a scanner, a dedupe guard, an ImportSession table and a property filter.
//
// The failure this exists to catch is cross-contamination — one importer's rows
// landing in the other's table, one dedupe guard suppressing the other's file,
// or the statistics business_date derivation reaching into transaction rows.
// Neither single-path suite can see any of that.
//
// Usage: node --experimental-loader <loader> scripts/verify-coexistence.mjs
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

const DATA = process.env.DATA_DIR || path.resolve(process.env.HARNESS_ROOT || ".", "scripts", "data");
// Resolve the statistics fixture from the repo rather than one session's upload
// directory (see verify-statistics.mjs for the same fix). If it is genuinely
// absent, the transaction half of the coexistence check still runs and the
// statistics half is reported as skipped — a missing fixture must not look like
// a code regression.
const LOCAL_STATS = path.join(
  // fileURLToPath, not `new URL(...).pathname`: the latter keeps a leading slash
  // before the drive letter on Windows ('/C:/repo/scripts') and never decodes
  // %20, so this fixture looked "genuinely absent" and the statistics half of
  // the coexistence check silently skipped. Matches verify-statistics.mjs:42.
  path.dirname(fileURLToPath(import.meta.url)),
  "data",
  "Hotel Statistics (1).csv"
);
const STATS_FILE = process.env.STATS_FILE || LOCAL_STATS;
const HAS_STATS = fs.existsSync(STATS_FILE);

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, ...rest) => {
  if (typeof url === "string" && url.startsWith("file:///")) {
    let p = decodeURIComponent(url.replace("file:///", "/"));
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
    const buf = fs.readFileSync(p);
    return {
      ok: true,
      // fetchCsvRows reads res.headers.get('content-length') for its 10MB guard.
      // A stub without headers throws before any assertion runs.
      headers: new Headers({ "content-length": String(buf.byteLength) }),
      text: async () => buf.toString("utf8"),
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    };
  }
  return realFetch(url, ...rest);
};

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}
function eq(name, actual, expected) {
  check(name, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

const parsers = await import("@/lib/reportParsers");
const { db, listImportSessions } = await import("@/api/base44Client");
const localDb = (await import("@/api/localDb")).default;
const S = await import("@/lib/statisticsAnalytics");
const T = await import("@/lib/transactionAnalytics");
// db.entities fails closed for an unauthenticated caller (blocker B3), so the
// suite has to sign in before it reads or writes a single row.
const { signInAsAllPropertyOwner } = await import("./_harness-auth.mjs");
await signInAsAllPropertyOwner();

const PROPERTY = "prop-coexist";
const PROP_NAME = "Red Roof Inn & Suites Middleborough";
const fileUrl = (p) => "file:///" + p.replace(/\\/g, "/");

// The three transaction exports plus the statistics snapshot, in the order an
// operator would drop them on the Import page.
const TXN_FILES = ["All Transactions.csv", "All Transactions (1).csv", "All Transactions (2).csv"];
const TXN_REVENUE = 1020598.17;   // charge side only, summed across all three
const TXN_ROWS = 16921;           // both ledger sides, all three files

// ── 1. One import pass over all four files ─────────────────────────────────
console.log("\n1. mixed import");
const imported = [];
for (const name of TXN_FILES) {
  const meta = { propertyId: PROPERTY, propertyName: PROP_NAME, sourceFile: name, importId: `imp_txn_${name}` };
  const scan = await parsers.scanReport("auto", fileUrl(path.join(DATA, name)), meta);
  eq(`${name} detected as transactions`, scan.type, "transactions");
  const res = await parsers.importReport(scan, meta);
  imported.push({ name, count: res.count });
}
if (HAS_STATS) {
  const meta = {
    propertyId: PROPERTY,
    propertyName: PROP_NAME,
    sourceFile: path.basename(STATS_FILE),
    importId: "imp_stats",
    fileModified: fs.statSync(STATS_FILE).mtimeMs,
  };
  const scan = await parsers.scanReport("auto", fileUrl(STATS_FILE), meta);
  eq("statistics file detected as hotel_statistics", scan.type, "hotel_statistics");
  const res = await parsers.importReport(scan, meta);
  imported.push({ name: path.basename(STATS_FILE), count: res.count });
} else {
  // "SKIP:" with the colon. scripts/_verdict.mjs anchors on /^SKIP:/i, so the older
  // "SKIP statistics half:" wording matched nothing and this suite reported
  // unqualified green with the statistics importer never exercised — half of a
  // coexistence test is not a coexistence test. This suite prints its own
  // PASSED/FAILED counter, so the runner files the line under PARTIAL COVERAGE
  // rather than treating the whole suite as declined.
  console.log(`  SKIP: statistics half — no fixture at ${STATS_FILE} (set STATS_FILE to enable)`);
}
console.log("   " + imported.map((i) => `${i.name}=${i.count}`).join("  "));

// ── 2. Neither importer wrote into the other's table ───────────────────────
console.log("\n2. table isolation");
const lines = await db.entities.TransactionLine.filter({ property_id: PROPERTY }, "date", 200000);
const metrics = await db.entities.HotelMetric.filter({ property_id: PROPERTY }, "business_date", 200000);
eq("every transaction row landed", lines.length, TXN_ROWS);
if (HAS_STATS) check("statistics rows landed", metrics.length > 500, `${metrics.length} rows`);
check("no metric leaked into TransactionLine", lines.every((r) => !r.metric_name && !r.period),
  "a HotelMetric field appearing here means the two writers share a row shape");
check("no transaction leaked into HotelMetric", metrics.every((r) => !r.ledger_side && !r.folio_number),
  "a TransactionLine field here means the same");

// ── 3. The dedupe guards do not interfere ──────────────────────────────────
//
// Both paths guard on file hash + property. If the guards shared a namespace,
// importing four files under one property would have suppressed some of them —
// which shows up as a short row count above, but the bookkeeping is the direct
// evidence.
//
// Careful here: TWO different things are called "ImportSession". `localDb.
// ImportSession` is a Dexie table of rollback records — one row per
// (import_id, entity), holding the created row ids. The lifecycle session with
// the in_progress/completed status is a separate store behind
// `listImportSessions()`. Reading the first and expecting the second's status
// field silently reports zero, which is what an earlier version of this test
// did. Both are checked below, deliberately, and by their own contract.
console.log("\n3. dedupe independence");
{
  // Counts derive from what was actually imported rather than a literal 4, so
  // the bookkeeping assertions stay honest when the statistics fixture is
  // absent and only the transaction files run.
  //
  // These stay CONDITIONAL on purpose, and that is not the same defect as the
  // silent decline fixed at :129. A hard `3` here would turn a missing fixture into
  // a red on every fresh clone and in CI — the fixture is a *.csv .gitignore keeps
  // out of the repository — which is the permanent false alarm this repo rejects
  // (see probe-config-exposure.mjs:16-18). What was wrong was that the adaptation
  // was unannounced; the runner now names the declined section instead.
  const FILE_COUNT = imported.length;
  const TXN_FILE_COUNT = TXN_FILES.length;
  const STATS_FILE_COUNT = HAS_STATS ? 1 : 0;
  const EXPECTED_ROLLBACKS = (TXN_FILE_COUNT * 2) + STATS_FILE_COUNT;
  const EXPECTED_TABLE_COUNT = HAS_STATS ? 3 : 2; // TransactionLine, AnomalyAlert, (HotelMetric)
  
  const rollbackRecords = await localDb.ImportRecordIds
    .where("property_id").equals(PROPERTY).toArray();
  eq("a rollback record per imported file/table", rollbackRecords.length, EXPECTED_ROLLBACKS);
  check("every rollback record carries its row ids",
    rollbackRecords.every((r) => Array.isArray(r.record_ids) && r.record_ids.length > 0),
    rollbackRecords.map((r) => `${r.entity}:${r.record_ids?.length ?? "none"}`).join(" "));
  check("rollback records cover every table written",
    new Set(rollbackRecords.map((r) => r.entity)).size === EXPECTED_TABLE_COUNT,
    [...new Set(rollbackRecords.map((r) => r.entity))].join(","));

  const lifecycle = (await listImportSessions()).filter((s) => s.propertyId === PROPERTY);
  eq("a lifecycle session per imported file", lifecycle.length, FILE_COUNT);
  eq("every session completed", lifecycle.filter((s) => s.status === "completed").length, FILE_COUNT);

  check("no file imported zero rows", imported.every((i) => i.count > 0),
    imported.filter((i) => !i.count).map((i) => i.name).join(",") || "");
}

// ── 4. Statistics dates did not bleed into transactions ────────────────────
//
// The statistics importer derives a business_date because its file has none.
// Transaction rows carry real dates from the file and must be untouched by it.
console.log("\n4. date derivation stays in its lane");
{
  if (HAS_STATS) {
    const statsDates = S.snapshotDates(metrics);
    eq("statistics produced one snapshot date", statsDates.length, 1);
  }
  check("no transaction row carries a derived-date marker",
    lines.every((r) => !r.business_date_source),
    "business_date_source is a statistics-only field");
  const txnDates = [...new Set(lines.map((r) => String(r.date).slice(0, 10)))].sort();
  eq("transactions span the expected first date", txnDates[0], "2026-01-01");
  check("transactions span many dates", txnDates.length > 200, `${txnDates.length} distinct dates`);
}

// ── 5. Both analytics layers still read their own data correctly ───────────
//
// The point of the whole exercise: the numbers each page shows must be the same
// with the other file type present as they were in isolation.
console.log("\n5. cross-checked totals");
{
  const s = T.summarize(lines);
  eq("transaction revenue unchanged by the statistics import", Number(s.revenue.toFixed(2)), TXN_REVENUE);

  if (HAS_STATS) {
    const snap = S.snapshotFor(metrics);
    const idx = S.indexSnapshot(snap.rows);
    eq("statistics rooms-sold unchanged by the transaction imports",
      S.metricValue(idx, "Room Sold", "actual_today"), 62);

    // The two files describe the same property over the same year, and they
    // agree — the statistics YTD revenue lines sum to the transactions' charge
    // total. This is the strongest available evidence that neither import
    // corrupted the other, because it is the file's own arithmetic, not ours.
    const revLines = S.composition(snap.rows, "Revenue", "ytd");
    const statsRev = Number(revLines.reduce((a, r) => a + r.value, 0).toFixed(2));
    eq("statistics YTD revenue equals the transaction charge total", statsRev, TXN_REVENUE);
  }
}

// ── 6. Property isolation still holds ──────────────────────────────────────
//
// A second property must see none of this. The entity proxy enforces this, and
// a mixed database is where a leak would first show.
console.log("\n6. property isolation");
{
  const other = await db.entities.HotelMetric.filter({ property_id: "prop-somewhere-else" }, "business_date", 1000);
  eq("another property sees no metrics", other.length, 0);
  const otherLines = await db.entities.TransactionLine.filter({ property_id: "prop-somewhere-else" }, "date", 1000);
  eq("another property sees no transactions", otherLines.length, 0);
}

console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
if (fail) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
// Exit explicitly on success too. Pending Base44 SDK retry sockets keep the
// event loop alive, so without this the process hangs after the summary and a
// fully green run gets reported as a timeout (exit 124).
process.exit(0);
