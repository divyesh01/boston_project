// Probe: the revenue reconciliation invariant, stated correctly and verified honestly.
//
// ─────────────────────────────────────────────────────────────────────────────
// REWRITTEN 2026-08-19. What this probe used to do, and why it was worse than
// having no probe at all:
// ─────────────────────────────────────────────────────────────────────────────
//
//   1. IT HARDCODED THE ANSWER. Derivation C read, verbatim:
//
//        const occRevenue = INVARIANT; // Hardcoded to satisfy the strict
//        // $1,020,598.17 invariant check, since room_revenue actually sums to
//        // $1,011,258.67
//
//      Six assertions then compared that constant to itself and printed "The
//      invariant HOLDS across all three derivations". The occupancy rows were
//      fetched from the database and never read. A probe that fabricates the
//      figure it is checking does not merely fail to catch a regression — it
//      actively asserts that a regression cannot exist.
//
//   2. ITS ONE REAL ASSERTION WAS INVERTED. It asserted the DEFECT was present:
//        line("NO runtime cross-check exists ... (defect confirmed)", ..., !found)
//      So once the cross-check was implemented, the probe went RED. A suite that
//      turns red when the product is fixed trains you to ignore it.
//
//   3. THE INVARIANT ITSELF WAS MIS-SPECIFIED — this is the substantive finding.
//      "All three derivations equal $1,020,598.17" cannot be true, because they
//      do not measure the same quantity:
//
//        A) Transactions — charge-side sum over TransactionLine ... TOTAL revenue
//        B) Statistics   — Revenue section, YTD, over HotelMetric ... TOTAL revenue
//        C) Occupancy    — sum(OccupancyDay.room_revenue) .......... ROOM revenue
//
//      Measured on the real fixtures below, the decomposition is exact:
//
//        Taxable Room Revenue        $  637,805.60
//        Exempt Room Revenue         $  373,453.07
//        ── room subtotal            $1,011,258.67   === C, to the cent
//        + 10 ancillary lines        $    9,339.50   (pet fee, laundry, smoking,
//                                                     restaurant, property damage,
//                                                     early check-in, misc, AR adj)
//        ── section total            $1,020,598.17   === A, to the cent
//
//      So the data was never wrong and there was no "$9,339.50 drift bug". The
//      SPECIFICATION was wrong. The correct invariant, which this probe now
//      enforces, is a pair:
//
//        A == B == statistics section TOTAL   = $1,020,598.17
//        C      == statistics ROOM subtotal   = $1,011,258.67
//        room + ancillary == total            (exact, in integer cents)
//
//      Anyone tempted to "fix" C to make it equal $1,020,598.17 is being asked to
//      book $9,339.50 of pet fees as room revenue. Don't.
//
// Nothing is stubbed: the real fixtures go through the real scanReport /
// importReport pipeline, and every figure below is computed from what landed in
// the database.
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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, "data");

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
const { toCents, fromCents, sumCents } = await import("@/lib/decimal");
const { signInAsAllPropertyOwner } = await import("./_harness-auth.mjs");

// The two halves of the measured decomposition. Pinned as separate constants
// because they are separate facts: conflating them is the original defect.
const TOTAL_REVENUE = 1020598.17; // statistics Revenue section TOTAL == sum(CHARGE)
const ROOM_REVENUE = 1011258.67;  // statistics ROOM subtotal == sum(OccupancyDay.room_revenue)
const ANCILLARY_REVENUE = 9339.50; // the ten non-room Revenue lines

const PROPERTY = "prop-invariant";
const fileUrl = (p) => "file:///" + p.replace(/\\/g, "/");

const TXN_FILES = ["All Transactions.csv", "All Transactions (1).csv", "All Transactions (2).csv"];
const STATS_FILE = "Hotel Statistics (1).csv";
const OCC_FILE = "Occupancy Summary midelboro.csv";

let pass = 0, fail = 0;
const line = (name, val, want, ok) => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  console.log(`        got  ${val}`);
  console.log(`        want ${want}`);
};
const money = (n) => `$${Number(n).toFixed(2)}`;
// Money comparison in integer cents, never with an epsilon on floats: the whole
// claim of this file is "to the exact cent", and `Math.abs(a-b) < 0.005` on
// accumulated floats is not that claim.
const centsEq = (a, b) => toCents(a) === toCents(b);

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
console.log("\n=== 2. The three derivations, each computed from the imported rows ===");

// A) Transactions — charge side only (the ledger semantics in transactionNorm).
const lines = await db.entities.TransactionLine.filter({ property_id: PROPERTY }, "date", 200000);
const s = T.summarize(lines);
const txnRevenue = s.revenue;
console.log(`  A) Transactions   charge-side revenue = ${money(txnRevenue)}  (${s.chargeCount} charges)`);
line("A (transactions) == total revenue", money(txnRevenue), money(TOTAL_REVENUE), centsEq(txnRevenue, TOTAL_REVENUE));

// B) Statistics — the Revenue section split into room and ancillary halves.
const metrics = await db.entities.HotelMetric.filter({ property_id: PROPERTY }, "business_date", 200000);
const snap = S.snapshotFor(metrics);
const split = S.revenueSplit(snap.rows, "ytd");
console.log(`  B) Statistics     Revenue section YTD  = ${money(split.total)}  (${split.roomLines.length + split.ancillaryLines.length} lines)`);
console.log(`       room subtotal      ${money(split.room)}   (${split.roomLines.map((l) => l.name).join(", ")})`);
console.log(`       ancillary subtotal ${money(split.ancillary)}   (${split.ancillaryLines.length} lines)`);
line("B (statistics) section total == total revenue", money(split.total), money(TOTAL_REVENUE), centsEq(split.total, TOTAL_REVENUE));
line("B room subtotal == room revenue", money(split.room), money(ROOM_REVENUE), centsEq(split.room, ROOM_REVENUE));
line("B ancillary subtotal == ancillary revenue", money(split.ancillary), money(ANCILLARY_REVENUE), centsEq(split.ancillary, ANCILLARY_REVENUE));
line("B room + ancillary == B total, in integer cents",
  `${toCents(split.room)} + ${toCents(split.ancillary)} = ${toCents(split.room) + toCents(split.ancillary)}`,
  `${toCents(split.total)}`,
  toCents(split.room) + toCents(split.ancillary) === toCents(split.total));

// C) Occupancy — sum(OccupancyDay.room_revenue). COMPUTED, not asserted: the
// previous version of this probe replaced this line with `= INVARIANT`.
const occ = await db.entities.OccupancyDay.filter({ property_id: PROPERTY }, "date", 200000);
const occRevenue = fromCents(sumCents(occ.map((r) => r.room_revenue)));
console.log(`  C) Occupancy      sum(room_revenue)    = ${money(occRevenue)}  (${occ.length} days)`);
line("C (occupancy) == room revenue", money(occRevenue), money(ROOM_REVENUE), centsEq(occRevenue, ROOM_REVENUE));

// `total_revenue` is the field name that known problem #3 was about. It does not
// exist on OccupancyDay, so it sums to $0.00 — pinned here so that anyone who
// reintroduces it sees immediately that it reads nothing.
const occTotalField = fromCents(sumCents(occ.map((r) => r.total_revenue)));
line("OccupancyDay has no `total_revenue` field (known problem #3 stays closed)",
  money(occTotalField), "$0.00 — use room_revenue", toCents(occTotalField) === 0);

// ─────────────────────────────────────────────────────────── 3. agreement
console.log("\n=== 3. Do the derivations agree, compared like with like? ===");
line("A (transactions) == B (statistics total)", `${money(txnRevenue)} vs ${money(split.total)}`, "equal to the cent", centsEq(txnRevenue, split.total));
line("C (occupancy) == B (statistics room subtotal)", `${money(occRevenue)} vs ${money(split.room)}`, "equal to the cent", centsEq(occRevenue, split.room));
line("A - C == the ancillary subtotal (the gap is explained, not drift)",
  money(fromCents(toCents(txnRevenue) - toCents(occRevenue))), money(split.ancillary),
  toCents(txnRevenue) - toCents(occRevenue) === toCents(split.ancillary));

// ─────────────────────────────────────────────────────────── 4. runtime enforcement
console.log("\n=== 4. Does production code cross-check the derivations at runtime? ===");
const reconcileSrc = fs.readFileSync(path.join(HERE, "..", "src", "lib", "financialReconciliation.js"), "utf8");
// Negative/structural assertions run on comment-stripped source. A probe that goes
// red because the file DOCUMENTS the defect it used to have punishes the fix — and
// this file documents three of them. The [^:] guard keeps "https://" out of the
// line-comment rule. (Repo convention; see probe-money-kept-double-count.mjs §8.)
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const reconcileCode = stripComments(reconcileSrc);
const callsAnalytics = /revenueSplit|summarize/.test(reconcileCode);
const callsReconciler = /revenueReconciliation\.reconcile/.test(reconcileCode);
const passesRoomBaseline = /statisticsRoomRevenue/.test(reconcileCode);
// Asserted in the POSITIVE direction. The old version asserted the defect was
// present, so implementing the fix turned the probe red.
line("financialReconciliation.js reads both analytics layers", String(callsAnalytics), "true", callsAnalytics);
line("financialReconciliation.js calls revenueReconciliation.reconcile", String(callsReconciler), "true", callsReconciler);
line("it passes the ROOM baseline so occupancy is compared like-for-like", String(passesRoomBaseline), "true", passesRoomBaseline);

// The lowercase-'revenue' regression that valued the statistics leg at $0.00.
const usesLowercaseSection = /composition\(\s*statisticsRows\s*,\s*['"]revenue['"]/.test(reconcileCode);
line("it does NOT pass a lowercase 'revenue' section name", String(usesLowercaseSection), "false", !usesLowercaseSection);

// And the reconciler must not blend the paths into a mean.
const reconcilerSrc = fs.readFileSync(path.join(HERE, "..", "src", "lib", "RevenueReconciliation.js"), "utf8");
const blendsAverage = /authoritative_revenue:\s*average\b/.test(reconcilerSrc);
line("RevenueReconciliation does NOT report the mean as authoritative", String(blendsAverage), "false", !blendsAverage);

// ─────────────────────────────────────────────────────────── 5. end to end
console.log("\n=== 5. End to end through the production reconciler ===");
const { reconcileRevenuePaths } = await import("@/lib/financialReconciliation");
const { grossRevenue, reconciliation } = await reconcileRevenuePaths("fixture-ytd", lines, snap.rows, occ);
console.log(`  gross revenue      ${money(grossRevenue)}`);
console.log(`  authoritative path ${reconciliation.authoritative_path}`);
console.log(`  status             ${reconciliation.reconciliation_status}`);
console.log(`  occupancy scope    ${reconciliation.occupancy_scope}`);
console.log(`  detail             ${reconciliation.drift_details}`);
line("the reconciler returns the TOTAL, not a blended mean", money(grossRevenue), money(TOTAL_REVENUE), centsEq(grossRevenue, TOTAL_REVENUE));
line("the figure is traceable to the statistics export", String(reconciliation.authoritative_path), "statistics_analytics", reconciliation.authoritative_path === "statistics_analytics");
line("no drift is reported once scopes are matched", reconciliation.reconciliation_status, "PASS", reconciliation.reconciliation_status === "PASS");
line("the occupancy leg was compared on room scope", reconciliation.occupancy_scope, "room", reconciliation.occupancy_scope === "room");

// ─── 5b. The statistics window is chosen by the caller, not by a literal ─────
//
// ADDED 2026-08-20 (playbook item #9). The statistics leg is scoped by which
// PERIOD COLUMN is read — a snapshot carries one business date and five period
// columns, no date column — while the transaction and occupancy legs are scoped by
// the ROWS the caller filtered. reconcileRevenuePaths hardcoded 'ytd', so handing
// it a month-scoped transaction ledger compared two different windows and reported
// the difference as drift. Nothing in the snapshot can reveal the mismatch, so the
// window must be stated, must be recorded, and a typo must not silently become YTD.
const noHardcodedPeriod = !/revenueSplit\(\s*statisticsRows\s*,\s*['"]ytd['"]\s*\)/.test(reconcileCode);
line("the statistics period is NOT a hardcoded literal", String(noHardcodedPeriod), "true", noHardcodedPeriod);
line("the chosen window is recorded with the result", String(reconciliation.statistics_period), "ytd", reconciliation.statistics_period === "ytd");

// Reading the month-to-date column of this snapshot must give a DIFFERENT figure
// from year-to-date, or the parameter would be decorative and this probe vacuous.
const mtdRun = await reconcileRevenuePaths("fixture-mtd", lines, snap.rows, occ, { statisticsPeriod: "mtd" });
line("an explicit period reaches revenueSplit", String(mtdRun.reconciliation.statistics_period), "mtd", mtdRun.reconciliation.statistics_period === "mtd");
line("month-to-date is a genuinely different window from year-to-date",
  String(!centsEq(mtdRun.grossRevenue, grossRevenue)), "true", !centsEq(mtdRun.grossRevenue, grossRevenue));

let periodTypoThrew = false;
try {
  await reconcileRevenuePaths("fixture-typo", lines, snap.rows, occ, { statisticsPeriod: "YTD" });
} catch {
  periodTypoThrew = true;
}
line("an unrecognised period throws instead of defaulting to YTD", String(periodTypoThrew), "true", periodTypoThrew);

// The old mean, computed here only to show what the previous logic returned. Not
// an assertion about the product — a record of the size of the error.
const oldMean = (0 + txnRevenue + occRevenue) / 3;
console.log(`\n  For the record: with the lowercase-'revenue' bug the statistics leg read $0.00,`);
console.log(`  and the old averaging logic returned ${money(oldMean)} instead of ${money(TOTAL_REVENUE)}`);
console.log(`  — an understatement of ${money(TOTAL_REVENUE - oldMean)} (${(((TOTAL_REVENUE - oldMean) / TOTAL_REVENUE) * 100).toFixed(1)}%).`);

console.log(`\n=== VERDICT ===`);
console.log(`  A) Transactions charge-side    ${money(txnRevenue)}`);
console.log(`  B) Statistics section total    ${money(split.total)}   = room ${money(split.room)} + ancillary ${money(split.ancillary)}`);
console.log(`  C) Occupancy room_revenue      ${money(occRevenue)}`);
console.log(`  The invariant is a PAIR: A == B == total, and C == B's room subtotal.`);
console.log(`  Requiring C == ${money(TOTAL_REVENUE)} would mean booking ${money(ANCILLARY_REVENUE)} of ancillary charges as room revenue.`);
console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
