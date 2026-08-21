// Probe: the "Estimated Money Kept" gross must be TOTAL revenue, not room-only —
// and it must be the same total on BOTH row shapes the widget is ever fed.
//
// THE DEFECT (launch item #2). `MoneyKept.jsx` computed
//     const gross = sum(occRows, "room_revenue");
// so the widget's headline gross, its keep rate, and every deduction percentage
// were measured against ROOM revenue ($1,011,258.67) while the hotel actually
// collected TOTAL revenue ($1,020,598.17). The $9,339.50 of ancillary charges
// (pet fees, laundry, smoking, restaurant, property damage, early check-in, misc,
// AR adjustments) was money the owner kept but the widget never counted.
//
// THE REGRESSION THIS PROBE NOW ALSO GUARDS (found in the running app, not here).
// The first fix derived the total by summing gross-row components including
// `room_rent`. That is correct for raw GrossRevenueDay rows and WRONG for the
// rows the Dashboard actually passes: `aggData.grossRows` comes from the daily
// aggregate cache, whose GROSS_MISC_FIELDS list deliberately omits `room_rent`
// because room revenue travels on the occupancy leg. Summing components off
// those rows produced $9,339.50 as "Total Revenue" and a keep rate of -1262%.
// Section [2] runs the real aggregate path so that can never ship again.
//
// WHAT THIS PROBE IS *NOT* ASSERTING. It does not assert
// sum(OccupancyDay.room_revenue) == $1,020,598.17. That would mean booking pet
// fees as room revenue, and scripts/probe-financial-invariant.mjs exists to
// forbid exactly that. The invariant is a PAIR:
//     room ($1,011,258.67) + ancillary ($9,339.50) == total ($1,020,598.17)
// Section [4] asserts the NEGATIVE case on purpose: the occupancy ledger must
// stay at the room figure. A future "fix" that inflates it fails here.
//
// Run: node --import ./scripts/_loader-boot.mjs scripts/probe-money-kept-gross.mjs

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
const { toCents, sumCents } = await import("@/lib/decimal");
const {
  GROSS_ANCILLARY_COMPONENTS,
  GROSS_NON_REVENUE_COMPONENTS,
  rowAncillaryRevenueCents,
  ancillaryRevenueCents,
  grossRevenueForPeriod,
} = await import("@/lib/hotel");
const { revenueSplit } = await import("@/lib/statisticsAnalytics");
const { aggregateDays, buildSyntheticRows } = await import("@/lib/dailyAggregates");
const { signInAsAllPropertyOwner } = await import("./_harness-auth.mjs");

const PROPERTY = "prop-mk-gross";
const fileUrl = (p) => "file:///" + p.replace(/\\/g, "/");
const money = (c) => `$${(c / 100).toFixed(2)}`;

// The three figures the whole system must agree on, in integer cents.
const TOTAL_CENTS = 102059817; // $1,020,598.17
const ROOM_CENTS = 101125867; //  $1,011,258.67
const ANCILLARY_CENTS = 933950; //   $9,339.50

let pass = 0;
let fail = 0;
const ok = (cond, label, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
};
const eq = (actual, expected, label) =>
  ok(actual === expected, label,
    `got ${typeof actual === "number" ? money(actual) : actual}, expected ${typeof expected === "number" ? money(expected) : expected}`);

await signInAsAllPropertyOwner();

const FILES = [
  "Occupancy Summary midelboro.csv",
  "Gross Revenue Report midelboro.csv",
  "Hotel Statistics (1).csv",
];
for (const name of FILES) {
  const meta = {
    propertyId: PROPERTY,
    propertyName: "Middleborough",
    sourceFile: name,
    importId: `imp_${name}`,
    fileModified: fs.statSync(path.join(DATA, name)).mtimeMs,
  };
  const scan = await parsers.scanReport("auto", fileUrl(path.join(DATA, name)), meta);
  await parsers.importReport(scan, meta);
}

const occ = await db.entities.OccupancyDay.filter({ property_id: PROPERTY }, "date", 200000);
const gross = await db.entities.GrossRevenueDay.filter({ property_id: PROPERTY }, "date", 200000);
const stats = await db.entities.HotelMetric.filter({ property_id: PROPERTY }, "business_date", 200000);

console.log(`\nFixture: ${occ.length} occupancy days, ${gross.length} gross days, ${stats.length} statistics metrics`);
ok(occ.length > 0 && gross.length > 0 && stats.length > 0, "all three ledgers imported",
  `occ=${occ.length} gross=${gross.length} stats=${stats.length}`);

// ── 1. RAW path: straight from the imported ledgers ────────────────────────
console.log("\n[1] RAW GrossRevenueDay + OccupancyDay rows");
const raw = grossRevenueForPeriod({ grossRows: gross, occRows: occ });
eq(raw.cents, TOTAL_CENTS, "total revenue");
eq(raw.roomCents, ROOM_CENTS, "room leg");
eq(raw.ancillaryCents, ANCILLARY_CENTS, "ancillary leg");
ok(raw.basis === "total", "basis is 'total'", `got '${raw.basis}'`);
eq(toCents(raw.dollars), TOTAL_CENTS, "dollars round-trips to the same cents");
eq(raw.roomCents + raw.ancillaryCents, raw.cents, "room + ancillary == total");

// ── 2. AGGREGATE path — what the Dashboard actually passes ─────────────────
// This is the shape that produced "$9,339.50 total revenue" in the running app.
console.log("\n[2] AGGREGATE cache rows (the real Dashboard path)");
const aggregates = aggregateDays({ occ, gross });
const synth = buildSyntheticRows(aggregates);
ok(synth.grossRows.length > 0, "aggregate path emitted gross rows", `${synth.grossRows.length} rows`);
ok(synth.occRows.length > 0, "aggregate path emitted occupancy rows", `${synth.occRows.length} rows`);

// Documents the trap rather than assuming it: these rows genuinely have no
// room_rent, so any total built by summing `room_rent` off them reads $0 room.
const aggRoomRent = sumCents(synth.grossRows.map((r) => r.room_rent));
eq(aggRoomRent, 0, "aggregate gross rows carry NO room_rent (this is the trap)");
ok(!Object.prototype.hasOwnProperty.call(synth.grossRows[0] || {}, "room_rent"),
  "room_rent is absent from the aggregate row shape entirely");

const agg = grossRevenueForPeriod({ grossRows: synth.grossRows, occRows: synth.occRows });
eq(agg.cents, TOTAL_CENTS, "total revenue via the aggregate cache");
eq(agg.roomCents, ROOM_CENTS, "room leg via the aggregate cache");
eq(agg.ancillaryCents, ANCILLARY_CENTS, "ancillary leg via the aggregate cache");
eq(agg.cents, raw.cents, "aggregate path and raw path agree to the cent");

// ── 3. No double counting when both ledgers carry room revenue ─────────────
console.log("\n[3] room revenue counted once, never twice");
ok(sumCents(gross.map((r) => r.room_rent)) === ROOM_CENTS,
  "raw gross rows DO carry room_rent", money(sumCents(gross.map((r) => r.room_rent))));
eq(raw.cents, TOTAL_CENTS, "raw path still totals once despite room_rent being present in both");
ok(!GROSS_ANCILLARY_COMPONENTS.includes("room_rent"),
  "room_rent is excluded from the ancillary component list");
eq(ancillaryRevenueCents(gross), ANCILLARY_CENTS, "ancillary sum ignores room_rent");

// ── 4. NEGATIVE: the occupancy ledger must NOT be inflated to match ────────
console.log("\n[4] NEGATIVE — occupancy stays a room ledger");
const occRoom = sumCents(occ.map((r) => r.room_revenue));
eq(occRoom, ROOM_CENTS, "sum(OccupancyDay.room_revenue) is still the ROOM figure");
ok(occRoom !== TOTAL_CENTS, "occupancy room revenue is NOT the total",
  `${money(occRoom)} != ${money(TOTAL_CENTS)}`);
eq(TOTAL_CENTS - occRoom, ANCILLARY_CENTS, "the gap is exactly the ancillary income");

// ── 5. Fallback preserves the old behaviour, and labels itself ─────────────
console.log("\n[5] fallback when no gross rows cover the period");
const fb = grossRevenueForPeriod({ grossRows: [], occRows: occ });
eq(fb.cents, ROOM_CENTS, "falls back to the occupancy room sum");
ok(fb.basis === "room", "basis is 'room' so the UI can say so", `got '${fb.basis}'`);
eq(fb.ancillaryCents, 0, "no ancillary claimed when there are no gross rows");
// Gross rows but no occupancy: room_rent stands in, so a gross-only import is
// still reported as a total rather than silently losing all room revenue.
const grossOnly = grossRevenueForPeriod({ grossRows: gross, occRows: [] });
eq(grossOnly.cents, TOTAL_CENTS, "gross-only period falls back to room_rent for the room leg");
const empty = grossRevenueForPeriod({});
eq(empty.cents, 0, "no data at all is $0.00, not NaN");
ok(Number.isFinite(empty.dollars), "dollars is finite with no data", `got ${empty.dollars}`);

// ── 6. DRIFT LOCK: the statistics export derives the same total ────────────
console.log("\n[6] drift lock — statistics Revenue section agrees to the cent");
const split = revenueSplit(stats, "ytd");
eq(toCents(split.total), TOTAL_CENTS, "statistics total");
eq(toCents(split.total), raw.cents, "statistics total == helper total");
eq(toCents(split.room), ROOM_CENTS, "statistics room subtotal");
eq(toCents(split.room), raw.roomCents, "statistics room == helper room leg");
eq(toCents(split.total) - toCents(split.room), ANCILLARY_CENTS, "statistics ancillary");

// ── 7. Day series sums to the headline (lump-allocation denominator) ───────
// Replicates MoneyKept's two bumps exactly: room from occupancy, ancillary from
// the charge ledger. The widget allocates lump payroll/expenses by each day's
// share of this series, so a series that summed to anything else would
// mis-weight every one of those allocations.
console.log("\n[7] per-day ledger sums to the headline gross");
for (const [label, oRows, gRows] of [["raw", occ, gross], ["aggregate", synth.occRows, synth.grossRows]]) {
  const dayMap = new Map();
  const bump = (d, c) => dayMap.set(d, (dayMap.get(d) || 0) + c);
  for (const r of oRows) bump(String(r.date).slice(0, 10), toCents(r.room_revenue));
  for (const r of gRows) bump(String(r.date).slice(0, 10), rowAncillaryRevenueCents(r));
  const daySum = [...dayMap.values()].reduce((a, b) => a + b, 0);
  eq(daySum, TOTAL_CENTS, `${label}: sum of per-day totals == period total`);
  const negativeDays = [...dayMap.entries()].filter(([, c]) => c < 0);
  ok(negativeDays.length === 0, `${label}: no day has negative total revenue`,
    negativeDays.length ? `first: ${negativeDays[0][0]} ${money(negativeDays[0][1])}` : "0 days");
}

// ── 8. Exclusions are by NAME, so a posted non-revenue line cannot inflate ─
console.log("\n[8] non_revenue and advance_deposit are excluded by name");
const synthetic = { misc_charge: 25, non_revenue: 500, advance_deposit: 750 };
eq(rowAncillaryRevenueCents(synthetic), 2500, "a row posting both exclusions counts only real revenue");
for (const f of GROSS_NON_REVENUE_COMPONENTS) {
  ok(!GROSS_ANCILLARY_COMPONENTS.includes(f), `${f} is not in the ancillary component list`);
  eq(rowAncillaryRevenueCents({ [f]: 1234.56 }), 0, `a row of only ${f} totals $0.00`);
}
const overlap = GROSS_ANCILLARY_COMPONENTS.filter((f) => GROSS_NON_REVENUE_COMPONENTS.includes(f));
ok(overlap.length === 0, "the two component lists are disjoint", overlap.join(",") || "no overlap");
eq(rowAncillaryRevenueCents(null), 0, "a null row totals $0.00");
eq(ancillaryRevenueCents(null), 0, "null rows total $0.00");

// ── 9. DRIFT GUARD: every numeric charge column is classified ──────────────
// If a future export adds a revenue column ("Spa", "Parking") and nobody adds it
// to GROSS_ANCILLARY_COMPONENTS, the total silently under-reports — the same
// class of bug as the original defect. Fail loudly instead.
console.log("\n[9] drift guard — every numeric column on a gross row is classified");
const KNOWN_NON_CHARGE = new Set([
  "id",
  // the room ledger's quantity, added from the occupancy leg — not ancillary
  "room_rent",
  // taxes are a liability collected on the guest's behalf, summed separately by
  // MoneyKept's tax path — never part of revenue
  "state_tax", "city_tax", "other_tax",
  // the vendor's own row total; adding it would double-count every component
  "total",
  // import/audit metadata
  "file_hash", "row_index", "row_number", "fileModified", "file_modified",
]);
const declared = new Set([...GROSS_ANCILLARY_COMPONENTS, ...GROSS_NON_REVENUE_COMPONENTS]);
for (const [label, rows] of [["raw", gross], ["aggregate", synth.grossRows]]) {
  const unclassified = new Set();
  for (const r of rows) {
    for (const [k, v] of Object.entries(r)) {
      if (declared.has(k) || KNOWN_NON_CHARGE.has(k)) continue;
      if (typeof v === "number" && Number.isFinite(v)) unclassified.add(k);
    }
  }
  ok(unclassified.size === 0, `${label}: no unclassified numeric column`,
    unclassified.size ? `unclassified: ${[...unclassified].join(", ")}` : "all classified");
}
console.log(`  (raw row keys:       ${Object.keys(gross[0] || {}).join(", ")})`);
console.log(`  (aggregate row keys: ${Object.keys(synth.grossRows[0] || {}).join(", ")})`);

// ── 10. Coverage: the two ledgers describe the same days ───────────────────
console.log("\n[10] gross and occupancy cover the same date span");
const occDates = new Set(occ.map((r) => String(r.date).slice(0, 10)));
const grossDates = new Set(gross.map((r) => String(r.date).slice(0, 10)));
const onlyOcc = [...occDates].filter((d) => !grossDates.has(d));
const onlyGross = [...grossDates].filter((d) => !occDates.has(d));
ok(onlyOcc.length === 0, "no occupancy day missing from the gross report",
  onlyOcc.slice(0, 5).join(",") || "none");
ok(onlyGross.length === 0, "no gross day missing from occupancy",
  onlyGross.slice(0, 5).join(",") || "none");

console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
