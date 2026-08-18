// End-to-end verification of the Hotel Statistics path.
//
// Imports the REAL file through the REAL scanReport/importReport pipeline into a
// real (fake-indexeddb) Dexie database, then reads it back through the same
// analytics the Statistics page uses. Nothing is stubbed, so a green run means
// the page renders these exact numbers.
//
// Usage: node --experimental-loader <loader> scripts/verify-statistics.mjs
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

// Fixture resolution, in order: STATS_FILE env → the repo's own scripts/data →
// give up with an explicit skip.
//
// This used to be a bare absolute path into one particular session's upload
// directory. That directory belongs to a machine and a moment, so the suite
// hard-crashed with EACCES/ENOENT for anyone else who ran it — a failure that
// looks exactly like a real regression but says nothing about the code. The
// fixture now travels with the repo.
import { fileURLToPath } from "node:url";

const LOCAL_STATS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "data",
  "Hotel Statistics (1).csv"
);
const FILE = process.env.STATS_FILE || LOCAL_STATS;

if (!fs.existsSync(FILE)) {
  console.log(
    `SKIP verify-statistics: no statistics fixture found.\n` +
      `  Looked for: ${FILE}\n` +
      `  Set STATS_FILE=/path/to/'Hotel Statistics.csv' or drop the file in scripts/data/ to run it.`
  );
  process.exit(0);
}

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
  if (cond) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function eq(name, actual, expected) {
  check(name, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

const parsers = await import("@/lib/reportParsers");
const { db } = await import("@/api/base44Client");
const S = await import("@/lib/statisticsAnalytics");
const { deriveBusinessDate, dateFromFileName } = await import("@/lib/universalParser");
// db.entities fails closed for an unauthenticated caller (blocker B3), so the
// suite has to sign in before it reads or writes a single row.
const { signInAsAllPropertyOwner } = await import("./_harness-auth.mjs");
await signInAsAllPropertyOwner();

const PROPERTY = "prop-verify";
const fileUrl = "file:///" + FILE.replace(/\\/g, "/");
const meta = {
  propertyId: PROPERTY,
  propertyName: "Red Roof Inn & Suites Middleborough",
  sourceFile: path.basename(FILE),
  fileModified: fs.statSync(FILE).mtimeMs,
};

// ── 1. Date derivation ─────────────────────────────────────────────────────
console.log("\n1. business_date derivation");
{
  eq("explicit date wins", deriveBusinessDate({ businessDate: "2026-02-14", sourceFile: "x 2020-01-01.csv" }).source, "explicit");
  eq("explicit date value", deriveBusinessDate({ businessDate: "2026-02-14" }).date, "2026-02-14");
  eq("filename beats mtime", deriveBusinessDate({ sourceFile: "Hotel Statistics 2026-02-14.csv", fileModified: Date.parse("2020-01-01T12:00:00") }).source, "filename");
  eq("ISO filename parses", dateFromFileName("Hotel Statistics 2026-02-14.csv"), "2026-02-14");
  eq("US-order filename parses", dateFromFileName("hotel_stats_02-14-2026.csv"), "2026-02-14");
  eq("worded filename parses", dateFromFileName("stats 14-Feb-2026.csv"), "2026-02-14");
  eq("'(1)' is not a date", dateFromFileName("Hotel Statistics (1).csv"), "");
  eq("impossible date rejected", dateFromFileName("stats 2026-02-30.csv"), "");
  eq("mtime used when filename is bare", deriveBusinessDate({ sourceFile: "Hotel Statistics (1).csv", fileModified: Date.parse("2026-03-09T15:00:00") }).source, "file_modified");
  eq("mtime read in local time", deriveBusinessDate({ fileModified: Date.parse("2026-03-09T15:00:00") }).date, "2026-03-09");
  eq("falls back to import date", deriveBusinessDate({ sourceFile: "x.csv" }).source, "import_date");
  // Late-evening local times are the ones toISOString() would roll backwards.
  eq("late-evening mtime does not roll back", deriveBusinessDate({ fileModified: Date.parse("2026-03-09T23:30:00") }).date, "2026-03-09");
  check("no date is ever empty", deriveBusinessDate({}).date !== "", "derivation must always produce something placeable");
}

// ── 2. Import through the real pipeline ────────────────────────────────────
console.log("\n2. import");
const scan = await parsers.scanReport("auto", fileUrl, meta);
eq("detected as hotel_statistics", scan.type, "hotel_statistics");
check("scan reports its business date", !!scan.businessDate, `got ${JSON.stringify(scan.businessDate)}`);
eq("scan reports the date source", scan.businessDateSource, "file_modified");

const result = await parsers.importReport(scan, meta);
check("rows imported", result.count > 0, `count=${result.count}`);

const stored = await db.entities.HotelMetric.filter({ property_id: PROPERTY }, "business_date", 200000);
eq("stored count matches import", stored.length, result.count);
check("every row has a business_date", stored.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.business_date || "")),
  `${stored.filter((r) => !/^\d{4}-\d{2}-\d{2}$/.test(r.business_date || "")).length} rows without one`);
check("every row records its date source", stored.every((r) => !!r.business_date_source));

// ── 3. The four metrics that used to be dropped ────────────────────────────
console.log("\n3. previously-dropped leaf metrics");
{
  const snap = S.snapshotFor(stored);
  const idx = S.indexSnapshot(snap.rows);
  eq("Total Rooms present", S.metricValue(idx, "Total Rooms", "actual_today"), 100);
  eq("Total Guests present", S.metricValue(idx, "Total Guests", "actual_today"), 99);
  eq("Total Reservations present", S.metricValue(idx, "Total Reservations", "actual_today"), 75);
  eq("Total Cancellations present", S.metricValue(idx, "Total Cancellations", "actual_today"), 6);

  // The file's own arithmetic proves these are leaves, not subtotal artifacts.
  for (const period of ["actual_today", "mtd", "ytd"]) {
    const adults = S.metricValue(idx, "Adults", period);
    const children = S.metricValue(idx, "Children", period);
    eq(`Adults + Children = Total Guests (${period})`, adults + children, S.metricValue(idx, "Total Guests", period));
    const nonWalk = S.metricValue(idx, "Non Walk-In Reservations", period);
    const walk = S.metricValue(idx, "Walk Ins", period);
    eq(`reservations add up (${period})`, nonWalk + walk, S.metricValue(idx, "Total Reservations", period));
  }
}

// ── 4. Values survive the round trip unchanged ─────────────────────────────
console.log("\n4. value fidelity");
{
  const snap = S.snapshotFor(stored);
  const idx = S.indexSnapshot(snap.rows);
  const expected = [
    ["Room Sold", "actual_today", 62],
    ["Room Sold", "ytd", 12362],
    ["RevPAR", "actual_today", 62.75],
    ["ADR Excluding Comp House Use Rooms", "mtd", 110.62],
    ["Occupancy Excluding Down Comp House Use Rooms", "actual_today", 75.61],
    ["Taxable Room Revenue", "ytd", 637805.6],
    ["VISA", "ytd", 362900.98],
    ["EXEMPTED STATE TAX", "actual_today", -110.83],   // negatives must keep their sign
    ["Out Of Order", "actual_today", 18],
    ["Occupancy % for the next 7 days", "actual_today", 80.43],
  ];
  for (const [name, period, want] of expected) {
    eq(`${name} @ ${period}`, S.metricValue(idx, name, period), want);
  }

  // Units drive formatting on the page; a currency metric typed as a count
  // would render "$3,202.25" as "3,202".
  const unitOf = (n, p) => snap.rows.find((r) => r.metric_name === n && r.period === p)?.unit;
  eq("currency typed as currency", unitOf("Taxable Room Revenue", "actual_today"), "currency");
  eq("room count typed as count", unitOf("Room Sold", "actual_today"), "count");
}

// ── 5. Snapshot semantics ──────────────────────────────────────────────────
console.log("\n5. snapshot semantics");
{
  const dates = S.snapshotDates(stored);
  eq("one snapshot from one file", dates.length, 1);
  const snap = S.snapshotFor(stored);
  eq("snapshot returns every row", snap.rows.length, stored.length);
  eq("defaults to the latest date", snap.date, dates[dates.length - 1]);

  // Prior-year coverage is PARTIAL in this export, and that is the trap. The
  // last-year columns exist for every metric but are 0.00 for all but three —
  // and those three are room-inventory counts, not trading figures. Treating
  // the zeros as real would print "+100%" on every revenue card.
  //
  // Pinned by name rather than by count: if the PMS starts shipping real
  // prior-year revenue, this assertion should fail and make someone look,
  // because the page's wording about coverage would then be wrong.
  const lyNames = S.priorYearMetrics(stored);
  eq("prior-year metrics are named exactly", lyNames.join(" | "), "Clean | Rooms Available To Sell | Total Rooms");
  eq("prior-year data does exist, partially", S.hasPriorYear(stored), true);
  check("no trading metric claims prior-year history",
    lyNames.every((n) => /rooms?|clean/i.test(n)),
    "only room-inventory counts carry LY values in this export");

  // The headline cards are all trading metrics, so none of them may show YoY.
  const cards = S.headline(snap.rows, "mtd");
  check("no YoY on metrics whose prior year is zero", cards.every((c) => c.change === null),
    cards.filter((c) => c.change).map((c) => c.key).join(","));

  // But the gate is per-metric, not a page-wide switch: a metric that DOES
  // have prior-year data must still get its comparison.
  const idx = S.indexSnapshot(snap.rows);
  const roomsYoY = S.yoy(idx, "Total Rooms", "mtd");
  check("a metric with real prior-year data still compares", roomsYoY !== null,
    "Total Rooms LY-MTD is 200 — suppressing this would be over-correction");
  eq("prior-year figure read correctly", roomsYoY?.then, 200);
}

// ── 6. Headline cards ──────────────────────────────────────────────────────
console.log("\n6. headline metrics");
{
  const snap = S.snapshotFor(stored);
  const get = (period, key) => S.headline(snap.rows, period).find((c) => c.key === key)?.value;
  eq("occupancy today", get("actual_today", "occupancy"), 75.61);
  eq("ADR today", get("actual_today", "adr"), 83);
  eq("RevPAR today", get("actual_today", "revpar"), 62.75);
  eq("rooms sold today", get("actual_today", "sold"), 62);
  eq("guests today", get("actual_today", "guests"), 99);
  // Room revenue is taxable + exempt: 3202.25 + 1943.61.
  eq("room revenue today", Number(get("actual_today", "revenue").toFixed(2)), 5145.86);
  eq("room revenue YTD", Number(get("ytd", "revenue").toFixed(2)), 1011258.67);
  eq("occupancy MTD", get("mtd", "occupancy"), 88.57);
}

// ── 7. Composition charts ──────────────────────────────────────────────────
console.log("\n7. composition");
{
  const snap = S.snapshotFor(stored);
  const pay = S.composition(snap.rows, "Payments", "actual_today");
  check("payments sorted by magnitude", pay.every((r, i) => i === 0 || Math.abs(pay[i - 1].value) >= Math.abs(r.value)));
  check("zero-value codes hidden from the chart", pay.every((r) => r.value !== 0));
  eq("VISA leads today's settlements", pay[0].name, "VISA");
  check("negative settlement kept", pay.some((r) => r.name === "AMEX" && r.value === -62.22),
    "AMEX is -$62.22 today; dropping the sign would overstate collections");
  // The file's own Payments total is 3536.06 for actual_today.
  const paySum = Number(pay.reduce((a, r) => a + r.value, 0).toFixed(2));
  eq("payments sum to the file's own total", paySum, 3536.06);

  const rev = S.composition(snap.rows, "Revenue", "ytd");
  check("revenue composition non-empty", rev.length > 0);
  const revSum = Number(rev.reduce((a, r) => a + r.value, 0).toFixed(2));
  eq("revenue lines sum to the file's own YTD total", revSum, 1020598.17);
}

// ── 8. Section table completeness ──────────────────────────────────────────
console.log("\n8. section table");
{
  const snap = S.snapshotFor(stored);
  const table = S.sectionTable(snap.rows);
  const shown = table.reduce((a, s) => a + s.metrics.length, 0);
  const distinct = new Set(snap.rows.map((r) => `${r.section}|${r.metric_name}`)).size;
  eq("every metric reachable in the table", shown, distinct);
  eq("sections in house order", table[0].name, "Room Inventory");
  check("no section dropped", table.length === new Set(snap.rows.map((r) => r.section)).size);
  check("all five periods per metric", table.every((s) => s.metrics.every((m) => Object.keys(m.values).length === 5)));

  // Blank forecast columns parse as "unknown"; a metric's real unit must win.
  const forecast = table.find((s) => s.name === "Forecast");
  const arrivals = forecast?.metrics.find((m) => m.name === "Tomorrows Arrivals");
  check("blank columns do not erase a unit", arrivals && arrivals.unit !== "unknown", `unit=${arrivals?.unit}`);
}

// ── 9. Trend refuses to overlap windows ────────────────────────────────────
console.log("\n9. trend");
{
  const t = S.trend(stored, ["Room Sold"]);
  eq("one snapshot yields one point", t.length, 1);
  eq("trend point carries the value", t[0].value, 62);
  check("trend point is dated", /^\d{4}-\d{2}-\d{2}$/.test(t[0].date));
  const trends = S.headlineTrends(stored);
  check("a trend exists for every headline metric", S.HEADLINE.every((m) => Array.isArray(trends[m.key])));
}

// ── 10. Re-import is idempotent ────────────────────────────────────────────
console.log("\n10. re-import safety");
{
  const before = (await db.entities.HotelMetric.filter({ property_id: PROPERTY }, "business_date", 200000)).length;
  const scan2 = await parsers.scanReport("auto", fileUrl, meta);
  const r2 = await parsers.importReport(scan2, meta);
  const after = (await db.entities.HotelMetric.filter({ property_id: PROPERTY }, "business_date", 200000)).length;
  eq("second import adds nothing", r2.count, 0);
  eq("row count unchanged", after, before);

  // The old file guard keyed on business_date, which only worked while the date
  // was permanently "". Re-importing the same bytes a day later must still be a
  // no-op — this is the regression that change could have introduced.
  const tomorrow = { ...meta, businessDate: "2099-01-01" };
  const scan3 = await parsers.scanReport("auto", fileUrl, tomorrow);
  const r3 = await parsers.importReport(scan3, tomorrow);
  const after3 = (await db.entities.HotelMetric.filter({ property_id: PROPERTY }, "business_date", 200000)).length;
  eq("same file under a different date still de-dupes", r3.count, 0);
  eq("row count still unchanged", after3, before);
}

// ── 11. Data-quality summary ───────────────────────────────────────────────
console.log("\n11. quality summary");
{
  const q = S.quality(stored);
  eq("one snapshot", q.snapshots, 1);
  eq("metric count", q.metrics, stored.length);
  eq("nothing uncategorised", q.unknownCount, 0);
  check("inferred date is disclosed", q.inferredDates.length === 1,
    "the page must tell the operator the date was guessed");
  eq("quality summary names the prior-year metrics", q.priorYearMetrics.length, 3);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
// Exit explicitly on success too. Pending Base44 SDK retry sockets keep the
// event loop alive, so without this the process hangs after the summary and a
// fully green run gets reported as a timeout (exit 124).
process.exit(0);
