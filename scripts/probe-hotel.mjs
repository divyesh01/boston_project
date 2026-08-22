// Probe: the hotel-stats functions, against real Dexie tables with real rows.
//
// WHY THIS FILE WAS REWRITTEN. It used to read whatever happened to be in the
// local Dexie database, print the result, and exit 0 — with no assertions at all.
// In a clean checkout that database is empty, so a full run printed:
//
//     Loaded 0 occupancy rows and 0 properties
//     { revenue: 0, roomsSold: 0, capacity: 0, days: 0, occupancy: 0, adr: 0, revpar: 0 }
//     0
//
// and scripts/verify-all.mjs counted it as PASS. A suite that cannot fail is not a
// test; it is a line in a tally that makes the tally less true. Worse, it was
// green through the entire life of the per-row capacity bug that
// scripts/probe-capacity-per-day.mjs now covers — it would have printed the wrong
// capacity just as happily.
//
// It now WRITES its own rows into Dexie first, so it exercises the same round trip
// the app does (Dexie stores and returns the row, the stats functions read it) and
// it has expected values to check. Dexie is the real thing here — fake-indexeddb
// is the storage engine, not a stub of the query layer — so this is genuinely a
// different test from probe-capacity-per-day.mjs, which calls the functions with
// plain objects. The two overlap on purpose: this one proves nothing is lost or
// coerced on the way through storage.
//
// Run: node --import ./scripts/_loader-boot.mjs scripts/probe-hotel.mjs

// fake-indexeddb must be installed before anything imports Dexie.
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

const { occupancyStats, capacityRoomNights, perPropertyStats, portfolioStats, roomCountsFrom, inventoryInScope, sum } =
  await import("../src/lib/hotel.js");
const localDb = (await import("../src/api/localDb.js")).default;

let pass = 0;
let fail = 0;
const failures = [];

function ok(label, cond, detail = "") {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function eq(label, actual, expected) {
  ok(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const near = (a, b, eps = 0.0001) =>
  typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= eps;

function section(title) {
  console.log(`\n── ${title}`);
}

async function main() {
  await localDb.open();
  // Start from a known state. Reading "whatever is there" is what made the old
  // version vacuous, and it would also make this one flaky.
  await Promise.all(localDb.tables.map((t) => t.clear()));

  // ── The fixture ───────────────────────────────────────────────────────────
  // Two properties of different sizes, so a percentage average and a proper
  // capacity-weighted fold give DIFFERENT answers and the assertions can tell
  // them apart. Alpha's second date carries two report sections, which is the
  // shape this PMS really emits and the shape the old capacity rule mishandled.
  const properties = [
    { code: "ALPHA", name: "Alpha Inn", rooms: 50, active: true },
    { code: "BRAVO", name: "Bravo Lodge", rooms: 100, active: true },
  ];
  const [alphaId, bravoId] = await Promise.all(properties.map((p) => localDb.Property.add(p)));

  const rows = [
    // Alpha: 2 dates x 50 rooms = 100 room-nights of capacity.
    { property_id: alphaId, date: "2026-03-01", room_revenue: 4000, rooms_sold: 15, total_rooms: 0 },
    { property_id: alphaId, date: "2026-03-02", room_revenue: 3000, rooms_sold: 12, total_rooms: 0 },
    // A SECOND section for the same date — real duplicate report data.
    { property_id: alphaId, date: "2026-03-02", room_revenue: 2000, rooms_sold: 8, total_rooms: 0 },
    // Bravo: 2 dates x 100 rooms = 200 room-nights.
    { property_id: bravoId, date: "2026-03-01", room_revenue: 12000, rooms_sold: 30, total_rooms: 0 },
    { property_id: bravoId, date: "2026-03-02", room_revenue: 14000, rooms_sold: 35, total_rooms: 0 },
  ];
  await localDb.OccupancyDay.bulkAdd(rows);

  const occ = await localDb.OccupancyDay.toArray();
  const props = await localDb.Property.toArray();

  section("1. The fixture really reached Dexie and came back intact");
  eq("all five occupancy rows round-tripped", occ.length, 5);
  eq("both properties round-tripped", props.length, 2);
  // Dexie stores what it is given; a silent coercion here would invalidate every
  // number below, so it is checked rather than assumed.
  ok("revenue survived storage as a number",
    occ.every((r) => typeof r.room_revenue === "number"),
    JSON.stringify(occ.map((r) => typeof r.room_revenue)));
  eq("revenue sums to 35000 after the round trip", sum(occ, "room_revenue"), 35000);
  eq("rooms sold sums to 100", sum(occ, "rooms_sold"), 100);

  section("2. Capacity is per (property, DAY) — not per row");
  // Alpha 2 days x 50 + Bravo 2 days x 100 = 300. The five ROWS would give 350
  // under the old per-row rule (three Alpha rows x 50 + two Bravo rows x 100).
  eq("capacityRoomNights = 300", capacityRoomNights(occ, props), 300);
  ok("the old per-row answer (350) is genuinely different",
    capacityRoomNights(occ, props) !== 350,
    "if these were equal the fixture could not detect the bug");

  section("3. occupancyStats over stored rows");
  const stats = occupancyStats(occ, props);
  eq("revenue", stats.revenue, 35000);
  eq("roomsSold", stats.roomsSold, 100);
  eq("capacity", stats.capacity, 300);
  eq("days = 2 distinct business dates, not 5 rows", stats.days, 2);
  ok("occupancy = 100/300 = 33.33%", near(stats.occupancy, 100 / 300), String(stats.occupancy));
  ok("adr = 35000/100 = $350", near(stats.adr, 350), String(stats.adr));
  ok("revpar = 35000/300 = $116.67", near(stats.revpar, 35000 / 300), String(stats.revpar));
  // ADR divides by rooms sold, RevPAR by capacity. They must not be equal here, or
  // one of them is reading the wrong denominator.
  ok("adr and revpar use different denominators", !near(stats.adr, stats.revpar));

  section("4. perPropertyStats splits by property and keeps names");
  const per = perPropertyStats(occ, props);
  eq("one row per property", per.length, 2);
  const alpha = per.find((p) => p.property_id === alphaId);
  const bravo = per.find((p) => p.property_id === bravoId);
  ok("Alpha is present", !!alpha, JSON.stringify(per));
  ok("Bravo is present", !!bravo, JSON.stringify(per));
  eq("Alpha name comes from the Property row", alpha?.property_name, "Alpha Inn");
  eq("Alpha revenue = 4000+3000+2000", alpha?.revenue, 9000);
  eq("Alpha rooms sold = 15+12+8", alpha?.roomsSold, 35);
  eq("Alpha days = 2 dates, not 3 rows", alpha?.days, 2);
  ok("Alpha occupancy = 35/100", near(alpha?.occupancy, 0.35, 0.0002), String(alpha?.occupancy));
  eq("Bravo revenue = 12000+14000", bravo?.revenue, 26000);
  ok("Bravo occupancy = 65/200", near(bravo?.occupancy, 0.325, 0.0002), String(bravo?.occupancy));
  // Sorted by revenue, descending — the portfolio table depends on this order.
  eq("sorted by revenue descending", per[0].property_id, bravoId);

  section("5. portfolioStats is capacity-weighted, not an average of percentages");
  const roomCounts = roomCountsFrom(props);
  const ps = portfolioStats(occ, roomCounts);
  eq("portfolio capacity = 300", ps.capacity, 300);
  ok("portfolio occupancy = 33.33% (weighted)", near(ps.occupancy, 100 / 300, 0.0002), String(ps.occupancy));
  const naive = (0.35 + 0.325) / 2; // 33.75% — close, but wrong
  ok("NOT the mean of the two property percentages",
    !near(ps.occupancy, naive, 0.0002),
    `weighted=${ps.occupancy} naiveMean=${naive} — this fixture is deliberately lopsided so the two differ`);
  ok("portfolio and occupancyStats agree on the same rows",
    near(ps.occupancy, stats.occupancy, 0.0002) && ps.capacity === stats.capacity,
    `portfolio=${JSON.stringify(ps)} occupancyStats=${JSON.stringify(stats)}`);

  section("6. roomCountsFrom and inventoryInScope read the Property table");
  eq("Alpha inventory", roomCounts[alphaId], 50);
  eq("Bravo inventory", roomCounts[bravoId], 100);
  eq("'all' scope sums every property's rooms", inventoryInScope("all", props), 150);
  eq("a single property scope", inventoryInScope(alphaId, props), 50);
  eq("an explicit multi-property selection", inventoryInScope([alphaId, bravoId], props), 150);

  section("7. An explicit total_rooms on a stored row wins over the default");
  // A renovation day: Alpha runs 40 rooms on 2026-03-03 instead of 50.
  await localDb.OccupancyDay.add({
    property_id: alphaId, date: "2026-03-03", room_revenue: 1000, rooms_sold: 8, total_rooms: 40,
  });
  const withReno = await localDb.OccupancyDay.toArray();
  eq("capacity = 300 + 40, not 300 + 50", capacityRoomNights(withReno, props), 340);

  section("8. An empty table is still answered, not crashed");
  await localDb.OccupancyDay.clear();
  const emptyStats = occupancyStats(await localDb.OccupancyDay.toArray(), props);
  eq("empty: capacity 0", emptyStats.capacity, 0);
  eq("empty: occupancy 0 rather than NaN", emptyStats.occupancy, 0);
  eq("empty: revpar 0 rather than Infinity", emptyStats.revpar, 0);
  eq("empty: perPropertyStats returns no rows", perPropertyStats([], props).length, 0);

  console.log(`\n─── RESULT: ${pass} passed, ${fail} failed ───`);
  if (fail > 0) {
    console.log(`Failures:\n  - ${failures.join("\n  - ")}`);
    process.exitCode = 1;
    return;
  }
  console.log("PASSED: hotel stats are correct over rows that really went through Dexie.");
  process.exitCode = 0;
}

main().catch((err) => {
  console.error(`FAILED: probe crashed: ${err?.stack || err}`);
  process.exitCode = 1;
});
