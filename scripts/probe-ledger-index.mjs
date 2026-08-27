// Probe: every date-ranged read materialized the whole table and then threw most
// of it away in JavaScript.
//
// Three reads, all in the Dashboard's path:
//
//   src/lib/dailyAggregates.js getDailyAggregates()  — the hot one. The Dashboard
//     PREFERS this cache over the live ledgers and calls it on every metric view.
//     It passed `{ property_id }` only and then ran
//     `.filter((r) => inRange(r.business_date, from, to))`, so rendering one month
//     read every day the property had ever recorded.
//
//   src/lib/dailyAggregates.js fetchLedger()  — same shape across five ledgers,
//     and for the portfolio case it was `list('-created_date', 200000)`: a cap
//     that dropped the OLDEST rows once a table passed it.
//
//   src/lib/reportParsers.js skipExisting() / dedupePropertyRows()  — already
//     index-driven, but capped at 100000 rows ASCENDING, so what fell off the end
//     was the newest rows: exactly the ones just imported, in the two functions
//     whose whole job is to notice that a row is already there.
//
// The indexes needed already existed — localDb v14 declares [property_id+date] on
// the four daily ledgers and [property_id+expense_date] on Expense, v20 declares
// [property_id+business_date] on the cache — and planQuery() in base44Client.js
// already turns `{ property_id, <date>: {$gte,$lte} }` into a .between() on them.
// Nothing was missing but the condition. Root cause, one sentence: the date range
// was applied after the read instead of inside it.
//
// base44Client.js is a protected file, so everything below works with planQuery()
// exactly as it ships. That is also why `business_date` reads only get the
// compound index when a single property is selected: planQuery's single-field
// driver list does not include `business_date`, and widening it is an owner
// decision. Section 4 measures that boundary rather than papering over it.
//
// The upper bound is padded with U+FFFF because these columns are not guaranteed
// to be date-only. Section 3 seeds a row stored as '...T23:30:00Z' and asserts it
// survives; an unpadded between() drops it, which would make a narrowing change
// silently delete a day's revenue.
//
// Run: node --import ./scripts/_loader-boot.mjs scripts/probe-ledger-index.mjs

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

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

let pass = 0;
let fail = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${label}${detail ? `  (${detail})` : ""}`);
  } else {
    fail += 1;
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${label}${detail ? `  (${detail})` : ""}`);
  }
}

const localDb = (await import("@/api/localDb")).default;
const { db, invalidatePropertyAccess } = await import("@/api/base44Client");
const { dateBound, getDailyAggregates, rebuildDailyAggregates, DAILY_AGGREGATE_VERSION } =
  await import("@/lib/dailyAggregates");
const { secureStore } = await import("@/lib/securityUtils");

const A = "prop_a";
const B = "prop_b";
const LOCAL_SESSION_KEY = "rr_local_session"; // module-private in base44Client.js

// 200 days of history per property; the view under test asks for 7 of them.
const DAYS = 200;
const WINDOW = 7;
const day = (i) => {
  const d = new Date(Date.UTC(2025, 0, 1) + i * 86400000);
  return d.toISOString().slice(0, 10);
};
const FROM = day(100);
const TO = day(100 + WINDOW - 1);

// The specification the whole thing has to preserve: a row is in range when its
// first ten characters fall inside [from, to]. Deliberately NOT a copy of
// inRange() — section 3 compares live database results against this, so if
// inRange() ever drifts from the spec the probe fails instead of agreeing with
// the drift.
const wanted = (stored, from, to) => {
  const d = String(stored).slice(0, 10);
  return d >= from && d <= to;
};

// ── instrumentation ─────────────────────────────────────────────────────────
// Two measured facts about Dexie 4 shaped this, and both would have made the
// numbers below quietly wrong:
//
//   Table.toArray() delegates to Collection.toArray(), so a naive counter on both
//   double-counts every table scan (observed: 800 rows for a 400-row table). Rows
//   are therefore attributed at the Collection layer only — the leaf where the
//   read actually happens — and the table layer only classifies the call as a scan.
//   The nesting is detected synchronously because the delegation is synchronous.
//
//   Collection.first() resolves to a single object, not an array, so `r.length` is
//   undefined and one such call turns the whole total into NaN (observed).
//
// The wrappers stay OUT of async functions on purpose: `.then()` on a Dexie promise
// returns a Dexie promise, so the transaction zone survives. An `async` wrapper
// would hand Dexie a native promise and can commit a zone early — and section 5
// runs inside rebuildDailyAggregates' rw transaction.
const TableProto = Object.getPrototypeOf(localDb.OccupancyDay);
const CollProto = Object.getPrototypeOf(localDb.OccupancyDay.where("date").equals("x"));
const origTableToArray = TableProto.toArray;
const origCollToArray = CollProto.toArray;
const origWhere = TableProto.where;

let M = null;
TableProto.toArray = function (...a) {
  if (M) { M.scans += 1; M.depth += 1; }
  try {
    return origTableToArray.apply(this, a);
  } finally {
    if (M) M.depth -= 1;
  }
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
  try {
    const value = await fn();
    return { ...M, value };
  } finally {
    M = prev;
  }
}

async function seed() {
  for (const t of localDb.tables) await t.clear();

  await localDb.Property.bulkAdd([
    { id: A, code: "AAA", name: "Alpha Inn", rooms: 40, active: true },
    { id: B, code: "BBB", name: "Bravo Lodge", rooms: 60, active: true },
  ]);
  await localDb.User.bulkAdd([
    {
      id: "u_owner", username: "owner1", email: "owner@probe.local", role: "owner",
      property_access: "all", full_name: "owner1", is_active: true, is_locked: false,
      mfa_enabled: false, failed_login_count: 0, created_date: new Date().toISOString(),
    },
  ]);

  const occ = [];
  const src = [];
  const gross = [];
  const pay = [];
  const exp = [];
  const agg = [];
  for (const pid of [A, B]) {
    for (let i = 0; i < DAYS; i += 1) {
      const d = day(i);
      // The last day of the window is stored as a full timestamp on purpose: the
      // ledgers take their date straight from the CSV, and dailyAggregates slices
      // ten characters off it precisely because it is not always date-only.
      const stored = d === TO ? `${d}T23:30:00Z` : d;
      occ.push({ property_id: pid, date: stored, rooms_sold: 10, total_rooms: 40, room_revenue: 1000 });
      gross.push({ property_id: pid, date: stored, state_tax: 10, city_tax: 5, other_tax: 1 });
      pay.push({ property_id: pid, date: stored, cash: 100, total: 100 });
      exp.push({ property_id: pid, expense_date: stored, category: "supplies", amount: 25 });
      for (const s of ["Direct", "Expedia", "Booking"]) {
        src.push({ property_id: pid, date: stored, source: s, code: s, net_revenue: 300, stays: 2 });
      }
      agg.push({
        property_id: pid, business_date: d, aggregate_version: DAILY_AGGREGATE_VERSION,
        occ_revenue: 1000, occ_rooms_sold: 10, occ_capacity_rooms: 40, payment_total: 100,
        source_net: {}, gross_misc: {}, payment: {}, expense_by_category: {},
        created_date: new Date(Date.UTC(2025, 0, 1) + agg.length * 1000).toISOString(),
      });
    }
  }
  await localDb.OccupancyDay.bulkAdd(occ);
  await localDb.SourceDay.bulkAdd(src);
  await localDb.GrossRevenueDay.bulkAdd(gross);
  await localDb.PaymentDay.bulkAdd(pay);
  await localDb.Expense.bulkAdd(exp);
  await localDb.DailyFinancialAggregate.bulkAdd(agg);

  await secureStore(
    LOCAL_SESSION_KEY,
    JSON.stringify({ userId: "u_owner", expiresAt: new Date(Date.now() + 3600e3).toISOString() }),
  );
  invalidatePropertyAccess();
  const me = await db.auth.me();
  ok("seeded and signed in as an all-property account",
    !!me && me.id === "u_owner",
    `${DAYS} days x 2 properties, window ${FROM}..${TO}`);
}

await seed();

console.log("\n1. the instrument itself (every measurement below depends on it)");
{
  const scan = await measure(() => localDb.OccupancyDay.toArray());
  ok("a table scan is counted once, not twice",
    scan.scans === 1 && scan.indexed === 0, `scans ${scan.scans} indexed ${scan.indexed}`);
  ok("…and reports the real row count", scan.rows === DAYS * 2, `${scan.rows} rows`);
  const one = await measure(() => localDb.DailyFinancialAggregate
    .where("[property_id+business_date]").equals([A, FROM]).first());
  ok("a first() counts as one row rather than turning the total into NaN",
    one.rows === 1 && Number.isFinite(one.rows), `${one.rows} rows`);
  const idx = await measure(() =>
    localDb.OccupancyDay.where("[property_id+date]").between([A, FROM], [A, `${TO}\uffff`], true, true).toArray());
  ok("an indexed read is counted as indexed, not as a scan",
    idx.indexed === 1 && idx.scans === 0, `scans ${idx.scans} indexed ${idx.indexed}`);
  ok("…and the index name is captured", idx.wheres.join(",") === "[property_id+date]", idx.wheres.join(","));
  ok("…and the compound index really does hold this window",
    idx.rows === WINDOW, `${idx.rows} of ${DAYS} days`);
}

console.log("\n2. dateBound is a bound, and only when there is something to bound");
ok("no dates at all produces no condition", dateBound("", "") === null);
ok("undefined produces no condition", dateBound(undefined, undefined) === null);
ok("a lower bound alone is inclusive", JSON.stringify(dateBound(FROM, "")) === JSON.stringify({ $gte: FROM }));
ok("an upper bound alone is padded", dateBound("", TO).$lte === `${TO}\uffff`);
ok("both bounds are set together",
  dateBound(FROM, TO).$gte === FROM && dateBound(FROM, TO).$lte === `${TO}\uffff`);
ok("a timestamp passed as a bound is truncated to its date",
  dateBound(`${FROM}T09:00:00Z`, `${TO}T09:00:00Z`).$gte === FROM);
// The property the padding exists for. Checked against the spec across every
// stored shape the ledgers actually contain, not argued for in a comment.
{
  const stored = [];
  for (let i = 0; i < DAYS; i += 1) {
    stored.push(day(i), `${day(i)}T00:00:00Z`, `${day(i)}T23:30:00Z`, `${day(i)} 12:00`);
  }
  const b = dateBound(FROM, TO);
  const admits = (s) => (!b.$gte || s >= b.$gte) && (!b.$lte || s <= b.$lte);
  const dropped = stored.filter((s) => wanted(s, FROM, TO) && !admits(s));
  ok("the index range admits every row the spec wants (superset)",
    dropped.length === 0, dropped.length ? `would drop ${dropped.slice(0, 3).join(", ")}` : `${stored.length} shapes checked`);
  const admitted = stored.filter((s) => admits(s)).length;
  ok("…and is still a narrowing, not a pass-through",
    admitted < stored.length / 4, `${admitted} of ${stored.length} shapes admitted`);
}

console.log("\n3. the cache read: same rows, a fraction of the reads");
{
  // The shipped strategy, executed live rather than described: property only,
  // then discard in JS.
  const before = await measure(() => db.entities.DailyFinancialAggregate.filter({ property_id: A }));
  const oldRows = before.value.filter((r) => wanted(r.business_date, FROM, TO));
  const after = await measure(() => getDailyAggregates({ propertyId: A, from: FROM, to: TO }));

  ok("the old strategy read the property's whole history",
    before.rows === DAYS, `${before.rows} rows materialized to render ${WINDOW} days`);
  ok("the new one reads the window",
    after.rows === WINDOW, `${after.rows} rows materialized`);
  ok("…via the compound index that already existed",
    after.wheres.includes("[property_id+business_date]") && after.scans === 0,
    `where(${after.wheres.join(",")}) scans ${after.scans}`);
  ok("…and returns exactly the same rows",
    JSON.stringify(after.value.map((r) => r.business_date).sort())
    === JSON.stringify(oldRows.map((r) => r.business_date).sort()),
    `${after.value.length} rows, ${FROM}..${TO}`);
  ok("…which is what the spec asks for, so inRange has not drifted",
    after.value.length === WINDOW && after.value.every((r) => wanted(r.business_date, FROM, TO)));
  ok("…measurably fewer rows, not incidentally fewer",
    after.rows * 10 < before.rows, `${before.rows} -> ${after.rows}`);
}

console.log("\n4. the portfolio and multi-property cases still return everything");
{
  const all = await measure(() => getDailyAggregates({ propertyId: "all", from: FROM, to: TO }));
  ok("the portfolio view returns both properties' window",
    all.value.length === WINDOW * 2, `${all.value.length} rows`);
  // Honest boundary: planQuery's single-field driver list has no `business_date`,
  // so with no single property to key on this falls back to a scan. Fixing that
  // means editing a protected file. The cache is one row per property-day, so the
  // scan is hundreds of rows, not the ledgers' tens of thousands.
  ok("…and it is a scan, which is the documented limit of the protected planner",
    all.scans === 1 && !all.wheres.includes("[property_id+business_date]"),
    `scans ${all.scans} wheres ${all.wheres.join(",") || "none"}`);
  const list = await measure(() => getDailyAggregates({ propertyId: [A, B], from: FROM, to: TO }));
  ok("an explicit property list returns both windows",
    list.value.length === WINDOW * 2, `${list.value.length} rows`);
  const unbounded = await measure(() => getDailyAggregates({ propertyId: A }));
  ok("no range means no narrowing — every day is still returned",
    unbounded.value.length === DAYS, `${unbounded.value.length} rows`);
}

console.log("\n5. the five ledgers: the rebuild reads its window, not the archive");
{
  const before = await measure(() => db.entities.OccupancyDay.filter({ property_id: A }));
  const after = await measure(() => rebuildDailyAggregates({ propertyId: A, from: FROM, to: TO }));

  ok("one ledger's old read was the whole history", before.rows === DAYS, `${before.rows} rows`);
  ok("the rebuild wrote exactly the window", after.value.days === WINDOW, JSON.stringify(after.value));
  // Exact, not an upper bound: occupancy + gross + payment + expense are one row
  // per day, SourceDay is three, and the write half reads back one cached row per
  // day to decide update-or-add. Anything wider than this is a read that stopped
  // being narrowed, which is the whole regression this asserts against.
  const expected = WINDOW * 4 + WINDOW * 3 + WINDOW;
  ok("…having materialized only the window from each ledger",
    after.rows === expected,
    `${after.rows} rows for 5 ledgers + ${WINDOW} cache lookups, vs ${DAYS * 8} unbounded`);
  ok("…through the property-scoped compound index on every one of them",
    after.wheres.filter((w) => w === "[property_id+date]").length === 4
    && after.wheres.includes("[property_id+expense_date]"),
    after.wheres.join(","));
  ok("…and no ledger fell back to a table scan", after.scans === 0, `scans ${after.scans}`);
  ok("…including the day stored as a full timestamp",
    (await localDb.DailyFinancialAggregate
      .where("[property_id+business_date]").equals([A, TO]).first())?.occ_revenue === 1000,
    `${TO} was stored as ${TO}T23:30:00Z in the ledger`);
}

console.log("\n6. the portfolio rebuild is bounded by date instead of by row count");
{
  const r = await measure(() => rebuildDailyAggregates({ propertyId: "all", from: FROM, to: TO }));
  ok("both properties' windows are rebuilt", r.value.days === WINDOW * 2, JSON.stringify(r.value));
  ok("…using the single-column date index, with no property to key on",
    r.wheres.includes("date") && r.wheres.includes("expense_date"), r.wheres.join(","));
  ok("…so it reads two windows, not two archives",
    r.rows === WINDOW * 16, `${r.rows} rows vs ${DAYS * 2 * 8} unbounded`);
}

console.log("\n7. the row caps that silently dropped the newest rows are gone");
// Source facts. Reaching one of these caps in a probe means seeding a million
// rows, and what they broke was not speed but correctness: a truncated read makes
// a stored row look new and imports it twice. The assertion is written against the
// SHAPE of a capped read, not against the digits, because the first version of it
// matched `100000` inside a `1000000` cap in the transaction importer and reported
// a cap that was still there as removed.
{
  const agg = read("src/lib/dailyAggregates.js");
  const rp = read("src/lib/reportParsers.js");
  const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const CAPPED_READ = /,\s*\d{4,}\s*\)/;
  ok("dailyAggregates passes no row limit to any read",
    !CAPPED_READ.test(code(agg)) && !/\.list\(/.test(code(agg)),
    "list('-created_date', 200000) sorted desc then sliced, dropping the OLDEST rows");
  ok("…and passes a date condition into the query instead of filtering after it",
    /query\[field\]\s*=\s*bound/.test(code(agg)) && /query\.business_date\s*=\s*bound/.test(code(agg)));
  ok("reportParsers passes no row limit to any read either",
    !CAPPED_READ.test(code(rp)),
    "sorted ascending then sliced, so the rows dropped were the ones just imported");
  ok("…including the transaction dedupe read — now a date-bounded indexed lookup on the ledger that must reconcile to the cent",
    /existingTxnDedupeKeys\(\s*db\.entities\.TransactionLine/.test(code(rp)) &&
    /query\.date\s*=\s*\{\s*\$gte:/.test(code(rp)),
    "the whole-property materialization was replaced by a [property_id+date] window read (see scripts/probe-dedupe-indexed-lookup.mjs)");
  ok("…and skipExisting still narrows by the dates it is importing",
    /filter\[dateField\]\s*=\s*\{\s*\$in:\s*dates\s*\}/.test(code(rp)));
  ok("…and dedupePropertyRows still reads the whole property, which is its job",
    /filter\(propertyId \? \{ property_id: propertyId \} : \{\}, "created_date"\)/.test(code(rp)),
    "it also clears duplicates left by earlier imports");
}

console.log(`PASS ${pass}   FAIL ${fail}`);
if (fail > 0) {
  console.log(`\nFAILED: ${pass} passed, ${fail} failed`);
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
console.log(`\nPASSED: ${pass} passed, 0 failed`);
process.exit(0);
