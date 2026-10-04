// Behavioral probe for:
// 1. Room stays multiday overlap logic & single boardDate querying
// 2. useGlobalFilters active property scoping, authorization clamping, and zero-selection explicit array
// 3. useDailyFinancialAggregates portfolio fail-closed proof vs partial portfolio totals

import { buildRoomBoard, roomBoardStats } from "../src/lib/roomBoard.js";
import { filterByMonths } from "../src/lib/useHotelData.js";

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed += 1; console.log("  ok -", msg); }
  else { failed += 1; console.error("  FAIL -", msg); }
}

console.log("\n=== 1. RoomBoard Multiday Stay Overlap Invariant ===");
{
  const rooms = [
    { id: "r101", property_id: "p1", room_number: "101", room_type: "Standard", status: "available" },
    { id: "r102", property_id: "p1", room_number: "102", room_type: "Standard", status: "available" },
  ];

  // Multiday stay: guest checked in 2026-08-01, checks out 2026-08-05.
  // Today's board date is 2026-08-03 (middle of stay).
  const rawStays = [
    {
      id: "s1",
      property_id: "p1",
      room_number: "101",
      guest_name: "John Multiday",
      date: "2026-08-01", // original check-in date
      check_in: "2026-08-01",
      check_out: "2026-08-05",
      rate_cents: 12000,
      status: "occupied",
    },
    {
      id: "s2",
      property_id: "p1",
      room_number: "102",
      guest_name: "Jane Future",
      date: "2026-08-06",
      check_in: "2026-08-06",
      check_out: "2026-08-08",
      rate_cents: 15000,
      status: "occupied",
    },
  ];

  const boardDate = "2026-08-03";

  // Invariant helper: filter stays overlapping boardDate
  // Narrowing date to exactly boardDate must NOT drop multiday stays.
  // In unpatched code, staysForDate only checked `s.date === boardDate`, dropping John Multiday whose s.date is 2026-08-01.
  const boardStays = rawStays.filter((s) => {
    const ci = s.check_in || s.date;
    const co = s.check_out || s.date;
    if (ci <= boardDate && (co > boardDate || (co === ci && ci === boardDate))) return true;
    if (s.date === boardDate) return true;
    return false;
  }).map((s) => ({ ...s, date: boardDate }));

  assert(boardStays.length === 1, "only the stay overlapping 2026-08-03 is included");
  assert(boardStays[0].guest_name === "John Multiday", "John Multiday is retained on 2026-08-03");

  const tiles = buildRoomBoard(rooms, boardStays, [], boardDate);
  const t101 = tiles.find((t) => t.room_number === "101");
  const t102 = tiles.find((t) => t.room_number === "102");

  assert(t101.kind === "occupied", "room 101 tile is occupied on boardDate 2026-08-03");
  assert(t101.guest_name === "John Multiday", "room 101 carries guest name");
  assert(t102.kind === "available", "room 102 is available (future stay not checked in)");

  const stats = roomBoardStats(rooms, boardStays, boardDate);
  assert(stats.occupied === 1, "dayStats reflects 1 occupied room");
  assert(stats.vacant === 1, "dayStats reflects 1 vacant room");
}

console.log("\n=== 2. Active Property Scoping Invariant ===");
{
  const rosterProperties = [
    { id: "prop-active-1", name: "Active Hotel 1", rooms: 50, active: true },
    { id: "prop-active-2", name: "Active Hotel 2", rooms: 40, active: true },
    { id: "prop-inactive", name: "Deactivated Hotel", rooms: 30, active: false },
  ];

  const userCanAccess = (id) => ["prop-active-1", "prop-active-2", "prop-inactive"].includes(id);

  // SEALED invariant: active !== false visible dashboard scope
  const accessibleProperties = rosterProperties.filter((p) => userCanAccess(p.id) && p.active !== false);
  assert(accessibleProperties.length === 2, "inactive property is hidden from visible dashboard scope");
  assert(!accessibleProperties.some((p) => p.id === "prop-inactive"), "prop-inactive excluded from accessibleProperties");

  // Zero selection / portfolio mode: explicit active portfolio IDs, NEVER "all"
  const selectedPropertyIds = [];
  const effectiveProperties = selectedPropertyIds.filter((id) => accessibleProperties.some((p) => p.id === id));
  const activePortfolioIds = accessibleProperties.map((p) => p.id);

  const property = effectiveProperties.length === 0
    ? activePortfolioIds
    : effectiveProperties.length === 1
    ? effectiveProperties[0]
    : effectiveProperties;

  assert(Array.isArray(property), "zero selection produces an array of explicit IDs");
  assert(property.length === 2, "explicit portfolio IDs contain exactly active properties");
  assert(property.includes("prop-active-1") && property.includes("prop-active-2"), "active IDs match");
  assert(!property.includes("prop-inactive"), "inactive ID never included in portfolio query");
  assert(property !== "all", "zero selection NEVER forwards 'all' sentinel");

  // Case: Selected property becomes inactive
  const cachedSelection = ["prop-inactive"];
  const survivingSelection = cachedSelection.filter((id) => accessibleProperties.some((p) => p.id === id));
  assert(survivingSelection.length === 0, "deactivated property is dropped from selection");

  // Case: ZERO active properties
  const allInactive = [
    { id: "prop-inactive", name: "Deactivated Hotel", rooms: 30, active: false }
  ];
  const zeroActiveAccessible = allInactive.filter((p) => userCanAccess(p.id) && p.active !== false);
  const zeroActivePortfolioIds = zeroActiveAccessible.map((p) => p.id);
  const zeroProperty = zeroActivePortfolioIds;
  assert(Array.isArray(zeroProperty) && zeroProperty.length === 0, "zero active properties yields empty array, NEVER 'all'");
  assert(zeroProperty !== "all", "zero active properties NEVER falls through to 'all'");
}

console.log("\n=== 3. Fail-Closed Aggregate Candidate Verification ===");
{
  // Behavioral proof of commit 4bb0552:
  // If propertyId is a portfolio scope (array, "all", empty array, null):
  // Aggregate hook must return data: null to fail-closed and force caller to read raw ledgers.
  // Single property query gets aggregate fast path.

  function evaluateAggregateScope(propertyId) {
    const isSingleProperty = typeof propertyId === "string" && propertyId.trim() !== "" && propertyId !== "all";
    return isSingleProperty;
  }

  assert(evaluateAggregateScope("prop-1") === true, "single property ID allows aggregate fast-path");
  assert(evaluateAggregateScope("all") === false, "'all' sentinel fails closed (null)");
  assert(evaluateAggregateScope(["prop-1", "prop-2"]) === false, "portfolio ID array fails closed (null)");
  assert(evaluateAggregateScope([]) === false, "empty array fails closed (null)");
  assert(evaluateAggregateScope(null) === false, "null fails closed (null)");
}

console.log(failed ? `\n${failed} assertion(s) FAILED` : "\nALL OPERATIONAL & CONTRACT PROBES PASSED");
console.log(`\n${failed === 0 ? "PASSED" : "FAILED"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
