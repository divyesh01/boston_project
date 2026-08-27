// End-to-end verification of the transaction ingestion path.
//
// Runs the REAL shipped code (scanReport -> importReport) over the three real
// upload files against a real Dexie DB (fake-indexeddb), then checks the numbers
// against facts established independently of this code:
//   - each file's own trailer checksum
//   - the Hotel Statistics export's revenue total ($1,020,598.17)
//   - the known row counts (4,823 / 8,243 / 3,855 = 16,921)
//
// It also proves the two properties the master task demands: no existing table
// is touched, and a re-import is idempotent.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

register(new URL("./resolve-alias.mjs", import.meta.url));

// fake-indexeddb must be installed before anything imports Dexie.
await import("fake-indexeddb/auto");
globalThis.crypto ??= (await import("node:crypto")).webcrypto;

// Browser-global shims the real modules touch, mirroring scripts/verify-harness.mjs
// so this exercises the same code paths the app does.
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

// The three real exports live next to the other harness fixtures. Resolved
// relative to this file so the script runs from any cwd; UPLOADS_DIR overrides
// it when pointing the harness at a fresh export.
const UPLOADS = process.env.UPLOADS_DIR || join(dirname(fileURLToPath(import.meta.url)), "data");
const FILES = [
  ["All Transactions.csv",     341751.93, 4823, "2026-01-01", "2026-03-31"],
  ["All Transactions (1).csv", 666071.21, 8243, "2026-04-01", "2026-06-30"],
  ["All Transactions (2).csv", 330257.34, 3855, "2026-07-01", "2026-08-02"],
];
const EXPECTED_ROWS = 16921;
const EXPECTED_REVENUE = 1020598.17;   // charge side only — matches Hotel Statistics
const EXPECTED_ALL_ROWS_SUM = 1338080.48;

let pass = 0, fail = 0;
const T = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`); }
};
const money = (n) => `$${n.toFixed(2)}`;

const { scanReport, importReport, REPORT_TYPES } = await import("@/lib/reportParsers");
const localDb = (await import("@/api/localDb")).default;
const { db } = await import("@/api/base44Client");
const {
  summarize, seriesByGrain, employeeStats, compareEmployees, comparePeriods, monthlyBreakdown,
  revenueMix, paymentMix, cardFeeBreakdown,
} = await import("@/lib/transactionAnalytics");
const { filterByMonths } = await import("@/lib/useHotelData");
const { LEDGER_SIDE_CHARGE, LEDGER_SIDE_PAYMENT } = await import("@/lib/transactionNorm");
const { verifyAuditChain } = await import("@/lib/securityUtils");
// db.entities fails closed for an unauthenticated caller (blocker B3), so the
// suite has to sign in before it reads or writes a single row.
const { signInAsAllPropertyOwner } = await import("./_harness-auth.mjs");
await signInAsAllPropertyOwner();

const PROPERTY_ID = "prop-test-1";

// ─────────────────────────────────────────────── 0. baseline of other tables
// Seed a row in every pre-existing table so "no existing data was damaged" is a
// real assertion and not a vacuous one over empty tables.
console.log("\n=== 0. Seed pre-existing data (must survive untouched) ===");
const OTHER_TABLES = [
  "Property", "OccupancyDay", "SourceDay", "GrossRevenueDay", "PaymentDay",
  "ClerkShiftRecord", "UploadedReport", "Expense", "PayrollRun", "User",
  "Staff", "ScanResult", "HotelMetric",
];
for (const t of OTHER_TABLES) {
  await localDb[t].add({ property_id: PROPERTY_ID, date: "2026-01-01", marker: "pre-existing", created_date: new Date().toISOString() });
}
const baseline = {};
for (const t of OTHER_TABLES) baseline[t] = await localDb[t].count();
console.log(`        seeded ${OTHER_TABLES.length} tables`);

// ─────────────────────────────────────────────── 1. detection
console.log("\n=== 1. Report type is auto-detected as `transactions` ===");
T("`transactions` is in REPORT_TYPES", REPORT_TYPES.some((r) => r.key === "transactions"));

const scans = [];
for (const [name, trailer, rowCount] of FILES) {
  const csvText = readFileSync(join(UPLOADS, name), "utf8");
  const scan = await scanReport("auto", `blob:local#${encodeURIComponent(name)}`, {
    propertyId: PROPERTY_ID,
    propertyName: "Test Property",
    importId: `imp_${name}`,
    sourceFile: name,
    csvText,
  });
  scans.push([name, scan, trailer, rowCount]);
  T(`${name}: detected as transactions`, scan.type === "transactions", `got "${scan.type}"`);
}

// ─────────────────────────────────────────────── 2. section selection
console.log("\n=== 2. Section 5 chosen, sections 1-4 not double-counted ===");
for (const [name, scan, _trailer, rowCount] of scans) {
  const used = scan.sections.filter((s) => s.used);
  T(`${name}: exactly one section used`, used.length === 1, JSON.stringify(scan.sections));
  T(`${name}: used the 34-column section`, used[0]?.columns === 34, `columns=${used[0]?.columns}`);
  T(`${name}: parsed ${rowCount} data rows`, scan.totalRows === rowCount, `got ${scan.totalRows}`);
}

// ─────────────────────────────────────────────── 3. checksum vs trailer
console.log("\n=== 3. Parsed sum agrees with each file's own trailer ===");
for (const [name, scan, trailer] of scans) {
  T(`${name}: checksum matches`, scan.checksum?.matches === true,
    `parsed=${scan.checksum?.parsed} declared=${scan.checksum?.declared}`);
  T(`${name}: trailer is ${money(trailer)}`, Math.abs((scan.checksum?.declared ?? 0) - trailer) < 0.005,
    `got ${scan.checksum?.declared}`);
  T(`${name}: no scan errors`, (scan.errors || []).length === 0, JSON.stringify(scan.errors));
}

// ─────────────────────────────────────────────── 4. trailer never ingested
console.log("\n=== 4. Trailer rows are excluded from the data ===");
for (const [name, scan] of scans) {
  const undated = scan.rowsToImport.filter((r) => !r.date);
  T(`${name}: no dateless rows in rowsToImport`, undated.length === 0, `${undated.length} found`);
}

// ─────────────────────────────────────────────── 5. import
console.log("\n=== 5. Import writes every row ===");
let totalImported = 0;
for (const [name, scan] of scans) {
  const res = await importReport(scan, {
    propertyId: PROPERTY_ID,
    propertyName: "Test Property",
    importId: `imp_${name}`,
    sourceFile: name,
  });
  totalImported += res.count;
  T(`${name}: imported ${scan.totalRows} rows`, res.count === scan.totalRows, `got ${res.count}, excluded ${res.excluded}`);
}
const stored = await localDb.TransactionLine.count();
T(`Transaction table holds ${EXPECTED_ROWS} rows`, stored === EXPECTED_ROWS, `got ${stored}`);
T("import count equals stored count", totalImported === stored, `${totalImported} vs ${stored}`);

// ─────────────────────────────────────────────── 6. the revenue number
console.log("\n=== 6. Revenue semantics (the whole point) ===");
const all = await localDb.TransactionLine.toArray();
const s = summarize(all);
T(`revenue = ${money(EXPECTED_REVENUE)} (charge side only)`,
  Math.abs(s.revenue - EXPECTED_REVENUE) < 0.005, `got ${money(s.revenue)}`);

const naive = all.reduce((a, r) => a + Math.round(r.amount * 100), 0) / 100;
T(`naive sum(all rows) = ${money(EXPECTED_ALL_ROWS_SUM)} — the trap`,
  Math.abs(naive - EXPECTED_ALL_ROWS_SUM) < 0.005, `got ${money(naive)}`);
T("revenue is NOT the naive sum", Math.abs(s.revenue - naive) > 1);
console.log(`        naive overstates by ${((naive / s.revenue - 1) * 100).toFixed(1)}%`);

T("collected (payment side) + revenue = naive sum",
  Math.abs(s.revenue + s.collected - naive) < 0.005,
  `${money(s.revenue)} + ${money(s.collected)} != ${money(naive)}`);

const sides = new Set(all.map((r) => r.ledger_side));
T("every row has a ledger_side", !sides.has(undefined) && sides.size === 2, [...sides].join(","));
T("charge rows have a charge_category",
  all.filter((r) => r.ledger_side === LEDGER_SIDE_CHARGE).every((r) => r.charge_category !== ""));
T("payment rows have an empty charge_category",
  all.filter((r) => r.ledger_side === LEDGER_SIDE_PAYMENT).every((r) => !r.charge_category));

// ─────────────────────────────────────────────── 7. no data loss
console.log("\n=== 7. Nothing was silently dropped ===");
const byFileSum = {};
for (const r of all) byFileSum[r.source_file] = (byFileSum[r.source_file] || 0) + Math.round(r.amount * 100);
for (const [name, trailer] of FILES) {
  T(`${name}: stored rows still sum to ${money(trailer)}`,
    Math.abs(byFileSum[name] / 100 - trailer) < 0.005, `got ${money((byFileSum[name] || 0) / 100)}`);
}
T("every row carries property_id", all.every((r) => r.property_id === PROPERTY_ID));
T("every row carries import_id", all.every((r) => !!r.import_id));
T("every row carries a dedupe_key", all.every((r) => !!r.dedupe_key));
T("every row carries source_file", all.every((r) => !!r.source_file));

// The 34-column section's extra fields must actually be present — that is the
// reason we chose it over section 1.
const withNames = all.filter((r) => r.guest_first_name);
T("extra section-5 columns preserved (First Name)", withNames.length > 16000, `${withNames.length} rows`);
const withAdults = all.filter((r) => r.adults != null && r.adults !== 0);
T("extra section-5 columns preserved (Adults)", withAdults.length > 0, `${withAdults.length} rows`);

// Legitimate duplicate rows must survive. These two counts were established
// independently of this codebase, by re-parsing the three files with Python's
// `csv` module: 766 rows are byte-identical repeats of another row, and 769
// collide on the coarser (date, time, folio, code, amount) tuple — the same
// tuple `dedupe_key` is built from. The gap of 3 matters: it is the proof that
// dedupe_key's occurrence counter is what preserves them, since without it
// those 769 would collapse to 769 fewer rows on import.
const extras = (keyOf) => {
  const counts = new Map();
  for (const r of all) { const k = keyOf(r); counts.set(k, (counts.get(k) || 0) + 1); }
  return [...counts.values()].reduce((a, n) => a + (n - 1), 0);
};
const BOOKKEEPING = new Set(["id", "import_id", "dedupe_key", "created_date", "updated_date", "file_hash"]);
const identityKey = (r) => Object.keys(r).filter((k) => !BOOKKEEPING.has(k)).sort()
  .map((k) => `${k}=${r[k]}`).join("");
const coarseKey = (r) => [r.date, r.time, r.folio_number, r.transaction_code, r.amount].join("|");

T("766 byte-identical duplicate rows preserved", extras(identityKey) === 766, `got ${extras(identityKey)}`);
T("769 dedupe-key collisions preserved (occurrence counter works)", extras(coarseKey) === 769, `got ${extras(coarseKey)}`);
T("every dedupe_key is unique", new Set(all.map((r) => r.dedupe_key)).size === all.length,
  `${new Set(all.map((r) => r.dedupe_key)).size} unique of ${all.length}`);

// ─────────────────────────────────────────────── 8. idempotent re-import
console.log("\n=== 8. Re-importing the same files is a no-op ===");
for (const [name] of FILES) {
  const csvText = readFileSync(join(UPLOADS, name), "utf8");
  const scan = await scanReport("auto", `blob:local#${encodeURIComponent(name)}`, {
    propertyId: PROPERTY_ID, propertyName: "Test Property",
    importId: `imp2_${name}`, sourceFile: name, csvText,
  });
  const res = await importReport(scan, {
    propertyId: PROPERTY_ID, propertyName: "Test Property",
    importId: `imp2_${name}`, sourceFile: name,
  });
  T(`${name}: re-import adds 0 rows`, res.count === 0, `added ${res.count}`);
}
const afterReimport = await localDb.TransactionLine.count();
T(`row count unchanged after re-import (${EXPECTED_ROWS})`, afterReimport === EXPECTED_ROWS, `got ${afterReimport}`);
const s2 = summarize(await localDb.TransactionLine.toArray());
T("revenue unchanged after re-import", Math.abs(s2.revenue - EXPECTED_REVENUE) < 0.005, `got ${money(s2.revenue)}`);

// ─────────────────────────────────────────────── 9. existing tables untouched
console.log("\n=== 9. No existing table was damaged ===");
for (const t of OTHER_TABLES) {
  const now = await localDb[t].count();
  T(`${t}: still ${baseline[t]} row(s)`, now === baseline[t], `got ${now}`);
}
const marker = await localDb.OccupancyDay.toArray();
T("pre-existing row content intact", marker.every((r) => r.marker === "pre-existing"));
// AuditLog is append-only by design and not seeded (its HMAC chain must start
// at a real entry). The imports are expected to append anomaly-detection
// entries per the checklist, and the whole chain must still verify.
const auditLog = await localDb.AuditLog.orderBy("created_date").toArray();
const newAudit = auditLog.slice(0);
T("AuditLog: growth is anomaly-detection entries (checklist: detections in HMAC audit log)",
  newAudit.length > 0 && newAudit.every((r) => r.action === "Anomaly Detection"),
  newAudit.map((r) => r.action).join(","));
const auditChain = await verifyAuditChain();
T("AuditLog: SHA-256 HMAC chain verifies", auditChain.valid, auditChain.valid ? "" : JSON.stringify(auditChain));

// ─────────────────────────────────────────────── 10. analytics
console.log("\n=== 10. Analytics agree with the ledger ===");
for (const grain of ["daily", "weekly", "monthly"]) {
  const series = seriesByGrain(all, grain);
  const sum = series.reduce((a, p) => a + Math.round(p.revenue * 100), 0) / 100;
  T(`${grain}: series revenue sums to total`, Math.abs(sum - EXPECTED_REVENUE) < 0.02,
    `got ${money(sum)} over ${series.length} buckets`);
  const sorted = series.every((p, i) => i === 0 || series[i - 1].bucket <= p.bucket);
  T(`${grain}: buckets ascending`, sorted);
}
const months = monthlyBreakdown(all);
T("8 months Jan-Aug 2026", months.length === 8, months.map((m) => m.bucket).join(","));

const emps = employeeStats(all);
const empRevenue = emps.reduce((a, e) => a + Math.round(e.revenue * 100), 0) / 100;
T("employee stats exclude system accounts by default",
  !emps.some((e) => e.account_class === "system"), emps.filter((e) => e.account_class === "system").map((e) => e.username).join(","));
T("human revenue < total revenue (system excluded from leaderboard, not from totals)",
  empRevenue < EXPECTED_REVENUE && empRevenue > 0, `${money(empRevenue)} of ${money(EXPECTED_REVENUE)}`);

const withSystem = employeeStats(all, { includeSystem: true });
const allEmpRevenue = withSystem.reduce((a, e) => a + Math.round(e.revenue * 100), 0) / 100;
T("includeSystem recovers the full revenue total",
  Math.abs(allEmpRevenue - EXPECTED_REVENUE) < 0.02, `got ${money(allEmpRevenue)}`);

const [a, b] = emps;
const cmp = compareEmployees(all, a.username, b.username, "monthly");
T("head-to-head: A revenue matches its own rollup", Math.abs(cmp.a.revenue - a.revenue) < 0.005);
T("head-to-head: B revenue matches its own rollup", Math.abs(cmp.b.revenue - b.revenue) < 0.005);
T("head-to-head: delta is A - B",
  Math.abs(cmp.metrics.find((m) => m.key === "revenue").delta - (a.revenue - b.revenue)) < 0.005);
T("head-to-head: series has one point per month present", cmp.series.length > 0 && cmp.series.length <= 8);

const per = comparePeriods(all, { from: "2026-04-01", to: "2026-06-30" }, { from: "2026-01-01", to: "2026-03-31" });
const q1 = summarize(all.filter((r) => r.date >= "2026-01-01" && r.date <= "2026-03-31"));
const q2 = summarize(all.filter((r) => r.date >= "2026-04-01" && r.date <= "2026-06-30"));
T("period compare: A = Q2", Math.abs(per.a.revenue - q2.revenue) < 0.005);
T("period compare: B = Q1", Math.abs(per.b.revenue - q1.revenue) < 0.005);
T("period compare: Q1+Q2+Q3 = total",
  Math.abs(q1.revenue + q2.revenue + summarize(all.filter((r) => r.date >= "2026-07-01")).revenue - EXPECTED_REVENUE) < 0.02);

// ─────────────────────────────────────────────── 11. property isolation
console.log("\n=== 11. Property isolation & indexed lookups ===");
const viaProxy = await db.entities.TransactionLine.filter({ property_id: PROPERTY_ID }, "date", 1000000);
T("entity proxy returns all rows for the property", viaProxy.length === EXPECTED_ROWS, `got ${viaProxy.length}`);
const otherProp = await db.entities.TransactionLine.filter({ property_id: "does-not-exist" }, "date", 1000000);
T("entity proxy returns none for another property", otherProp.length === 0, `got ${otherProp.length}`);

const byIdx = await localDb.TransactionLine.where("[property_id+date]")
  .between([PROPERTY_ID, "2026-01-01"], [PROPERTY_ID, "2026-01-31"], true, true).toArray();
const byScan = all.filter((r) => r.date >= "2026-01-01" && r.date <= "2026-01-31");
T("[property_id+date] index agrees with a full scan", byIdx.length === byScan.length,
  `index=${byIdx.length} scan=${byScan.length}`);
const byUser = await localDb.TransactionLine.where("username").equals(a.username).toArray();
T("username index agrees with a full scan",
  byUser.length === all.filter((r) => r.username === a.username).length);

// ─────────────────────────────────────────────── 12. what the page renders
// Section 10 proves the rollups. This proves the specific derived values the
// Transactions page puts on screen, so a chart cannot silently show a number
// that disagrees with the ledger behind it.
console.log("\n=== 12. Transactions page figures ===");

const stats = summarize(all);
const charges = all.filter((r) => r.ledger_side === LEDGER_SIDE_CHARGE);
const payments = all.filter((r) => r.ledger_side === LEDGER_SIDE_PAYMENT);

// The two headline strips.
T("KPI revenue = charge side", Math.abs(stats.revenue - EXPECTED_REVENUE) < 0.02, money(stats.revenue));
T("KPI charge/payment counts partition the ledger",
  stats.chargeCount + stats.paymentCount === EXPECTED_ROWS,
  `${stats.chargeCount} + ${stats.paymentCount}`);
T("KPI avg per day = revenue / trading days",
  stats.days > 0 && Math.abs(stats.avgPerDay * stats.days - stats.revenue) < 0.02);

// Mix charts must be exhaustive: a pie that does not sum to the total is a lie.
const mix = revenueMix(all, "charge_category");
const mixSum = mix.reduce((s, m) => s + Math.round(m.value * 100), 0) / 100;
T("category mix sums to revenue", Math.abs(mixSum - EXPECTED_REVENUE) < 0.02, money(mixSum));
const codeMix = revenueMix(all, "transaction_code");
T("transaction-code mix sums to revenue",
  Math.abs(codeMix.reduce((s, m) => s + Math.round(m.value * 100), 0) / 100 - EXPECTED_REVENUE) < 0.02);

const pay = paymentMix(all);
const paySum = pay.reduce((s, m) => s + Math.round(m.value * 100), 0) / 100;
T("payment mix sums to settlements", Math.abs(paySum - stats.collected) < 0.02,
  `${money(paySum)} vs ${money(stats.collected)}`);

// Card fees: the one cost this ledger can attribute on its own.
const RATE = 0.025;
const cardRows = payments.filter((r) => r.payment_method === "Card");
const cardSettled = cardRows.reduce((s, r) => s + Math.round(Number(r.amount) * 100), 0) / 100;
const fees = cardFeeBreakdown(all, RATE, { byEmployee: true });
T("card fee: settled volume matches a direct sum of card rows",
  Math.abs(fees.settled - cardSettled) < 0.02, `${money(fees.settled)} vs ${money(cardSettled)}`);
T("card fee = settled x rate", Math.abs(fees.fee - Math.round(cardSettled * 100 * RATE) / 100) < 0.02, money(fees.fee));
T("card fee: per-employee volume sums to the total",
  Math.abs(fees.byEmployee.reduce((s, e) => s + Math.round(e.settled * 100), 0) / 100 - fees.settled) < 0.02);
T("card fee: zero rate produces zero fee", cardFeeBreakdown(all, 0).fee === 0);
T("card fee: non-card settlements excluded", fees.count === cardRows.length && fees.count < payments.length,
  `${fees.count} card of ${payments.length} settlements`);

// The ledger table's search + side filter run over this same array.
T("side filter partitions with no overlap",
  charges.every((r) => r.ledger_side !== LEDGER_SIDE_PAYMENT) &&
  payments.every((r) => r.ledger_side !== LEDGER_SIDE_CHARGE));
T("every row has a stable React key (id)", all.every((r) => r.id !== undefined && r.id !== null));
T("every row carries an employee label for display",
  all.every((r) => typeof r.employee_label === "string" && r.employee_label.length > 0));

// ─────────────────────────────────────────────── 13. month filter correctness
// filterByMonths used to read the month via `new Date(str).getMonth()`, which
// parses "2026-02-01" as UTC midnight and reports it in LOCAL time — so west of
// Greenwich every 1st of the month was filed under the previous month. This
// pins the corrected behaviour, and does so under a westward TZ where the old
// code demonstrably failed.
console.log("\n=== 13. Month multi-select files rows in the right month ===");
const firstOfMonth = all.filter((r) => String(r.date).slice(8, 10) === "01");
T("fixture actually contains 1st-of-month rows", firstOfMonth.length > 0, `${firstOfMonth.length} rows`);

for (const m of [1, 2, 6]) {                       // Feb, Mar, Jul (0-based)
  const viaFilter = filterByMonths(all, [m]);
  const expected = all.filter((r) => Number(String(r.date).slice(5, 7)) === m + 1);
  T(`month ${m + 1}: filter returns exactly the rows dated in it`,
    viaFilter.length === expected.length, `filter=${viaFilter.length} expected=${expected.length}`);
  T(`month ${m + 1}: no row from an adjacent month leaked in`,
    viaFilter.every((r) => Number(String(r.date).slice(5, 7)) === m + 1));
}
const multi = filterByMonths(all, [0, 1, 2]);
T("multi-month selection unions the months",
  multi.length === all.filter((r) => ["01", "02", "03"].includes(String(r.date).slice(5, 7))).length,
  `got ${multi.length}`);
T("empty selection is a pass-through, not an empty result", filterByMonths(all, []).length === EXPECTED_ROWS);
T("month totals reconcile to the annual total",
  Math.abs([...Array(12).keys()]
    .reduce((s, m) => s + Math.round(summarize(filterByMonths(all, [m])).revenue * 100), 0) / 100 - EXPECTED_REVENUE) < 0.02);

console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
