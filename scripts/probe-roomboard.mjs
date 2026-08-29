// Probe for feature 3 — enhanced Room Board (per-room) logic.
// Runs against the real src/lib/roomBoard.js in Node.
import {
  generateRoomRegister,
  buildRoomBoard,
  roomBoardStats,
  toRateCents,
  sumRateCents,
  staysForDate,
  normalizeRoomId,
  staysByRoom,
  housekeepingByRoom,
} from "../src/lib/roomBoard.js";

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed += 1; console.log("  ok -", msg); }
  else { failed += 1; console.error("  FAIL -", msg); }
}

// ─── 1. Room Register & Rates ───
const rooms = generateRoomRegister("p1", 6);
assert(rooms.length === 6, "register generates 6 rooms");
assert(rooms[0].room_number === "100", "first room numbered 100");
assert(rooms[0].room_type === "Standard", "first room is Standard");

const date = "2026-08-06";
const stays = [
  { room_number: "100", guest_name: "Maria G.", date, check_in: date, check_out: "2026-08-09", rate_cents: toRateCents(139.5), status: "occupied", property_id: "p1" },
  { room_number: "101", guest_name: "James T.", date, check_in: date, check_out: "2026-08-07", rate_cents: 14900, status: "occupied", property_id: "p1" },
];

assert(toRateCents("139.5") === 13950, "139.5 dollars -> 13950 cents");
assert(toRateCents(121.25) === 12125, "121.25 dollars -> 12125 cents");
assert(sumRateCents(stays) === 28850, "integer-cents sum of the two stays is 28850");

const dayStays = staysForDate(stays, date);
assert(dayStays.length === 2, "both stays fall on the date");

const stats = roomBoardStats(rooms, stays, date);
assert(stats.occupied === 2, "occupied counts 2 rooms");
assert(stats.inventory === 6, "inventory is 6");
assert(stats.revenueCents === 28850, "revenue is 28850 cents");
assert(stats.adrCents === 14425, "ADR is 14425 cents");
assert(Math.abs(stats.occupancy - (2 / 6)) < 1e-9, "occupancy is 2/6");

const roomsWithIds = rooms.map((r, idx) => ({ ...r, id: idx + 1, property_id: "p1" }));
const tiles = buildRoomBoard(roomsWithIds, stays, [], date);
const t100 = tiles.find((t) => t.room_number === "100");
assert(t100.kind === "occupied", "room 100 tile is occupied");
assert(t100.guest_name === "Maria G.", "room 100 tile carries guest name");
assert(t100.rate_cents === 13950, "room 100 tile carries integer-cents rate");
assert(t100.id === 1, "room 100 tile carries database id");
assert(t100.roomId === 1, "room 100 tile carries roomId");

// ─── 2. Maintenance & Status Consistency ───
const dirtyRoom = { id: 10, room_number: "201", status: "dirty", maintenance: "available" };
const dirtyTile = buildRoomBoard([dirtyRoom], [], [], date)[0];
assert(dirtyTile.kind === "dirty", "dirty room tile has kind dirty");
assert(dirtyTile.maintenance === "available", "dirty room maintenance is not overwritten by dirty status");

const oosRoomNoMaint = { id: 11, room_number: "202", status: "out_of_service" };
const oosTile = buildRoomBoard([oosRoomNoMaint], [], [], date)[0];
assert(oosTile.kind === "out_of_service", "oos room tile has kind out_of_service");
assert(oosTile.maintenance === "out_of_service", "oos room tile maintenance defaults to out_of_service");

// ─── 3. Unregistered Room Stay Stats ───
const staysWithUnregistered = [
  ...stays,
  { room_number: "999", guest_name: "Ghost", date, check_in: date, check_out: "2026-08-07", rate_cents: 10000, status: "occupied" },
];
const statsWithUnregistered = roomBoardStats(rooms, staysWithUnregistered, date);
assert(statsWithUnregistered.occupied === 3, "occupied counts unregistered stay");
assert(statsWithUnregistered.soldCount === 3, "soldCount counts unregistered stay");
assert(statsWithUnregistered.revenueCents === 38850, "revenueCents includes unregistered stay rate");
assert(statsWithUnregistered.adrCents === Math.round(38850 / 3), "ADR includes unregistered stay rate");

// ─── 4. Identifier Normalization & Fuzzing Probes (normalizeRoomId) ───
assert(normalizeRoomId(1) === 1, "normalizeRoomId(1) -> 1");
assert(normalizeRoomId(42) === 42, "normalizeRoomId(42) -> 42");
assert(normalizeRoomId("105") === 105, "normalizeRoomId('105') -> 105");
assert(normalizeRoomId(" 105 ") === 105, "normalizeRoomId(' 105 ') -> 105");
assert(normalizeRoomId("room_abc") === "room_abc", "normalizeRoomId('room_abc') -> 'room_abc'");
assert(normalizeRoomId(null) === null, "normalizeRoomId(null) -> null");
assert(normalizeRoomId(undefined) === null, "normalizeRoomId(undefined) -> null");
assert(normalizeRoomId(NaN) === null, "normalizeRoomId(NaN) -> null");
assert(normalizeRoomId(0) === null, "normalizeRoomId(0) -> null");
assert(normalizeRoomId("0") === null, "normalizeRoomId('0') -> null");
assert(normalizeRoomId(-1) === null, "normalizeRoomId(-1) -> null");
assert(normalizeRoomId("") === null, "normalizeRoomId('') -> null");
assert(normalizeRoomId("   ") === null, "normalizeRoomId('   ') -> null");
assert(normalizeRoomId("null") === null, "normalizeRoomId('null') -> null");
assert(normalizeRoomId("undefined") === null, "normalizeRoomId('undefined') -> null");
assert(normalizeRoomId("NaN") === null, "normalizeRoomId('NaN') -> null");
assert(normalizeRoomId({}) === null, "normalizeRoomId({}) -> null");
assert(normalizeRoomId([]) === null, "normalizeRoomId([]) -> null");
assert(normalizeRoomId(true) === null, "normalizeRoomId(true) -> null");

// ─── 5. Multi-Night Stays Interval Evaluation ───
const multiNightStay = {
  property_id: "p1",
  room_number: "100",
  guest_name: "Maria G.",
  date: "2026-08-01",
  check_in: "2026-08-01",
  check_out: "2026-08-05",
  rate_cents: 12000,
  status: "occupied",
};
assert(staysForDate([multiNightStay], "2026-08-01").length === 1, "multi-night stay active on check-in date 2026-08-01");
assert(staysForDate([multiNightStay], "2026-08-02").length === 1, "multi-night stay active on middle date 2026-08-02");
assert(staysForDate([multiNightStay], "2026-08-04").length === 1, "multi-night stay active on last night 2026-08-04");
assert(staysForDate([multiNightStay], "2026-08-05").length === 0, "multi-night stay not active on checkout date 2026-08-05");
assert(staysForDate([multiNightStay], "2026-08-06").length === 0, "multi-night stay not active after checkout 2026-08-06");

// ─── 6. Multi-Property Composite Key Disambiguation ───
const p1Room = { id: 1, property_id: "p1", room_number: "101", status: "occupied" };
const p2Room = { id: 2, property_id: "p2", room_number: "101", status: "available" };
const multiPropStays = [
  { property_id: "p1", room_number: "101", guest_name: "P1 Guest", date: "2026-08-06", check_in: "2026-08-06", check_out: "2026-08-07", rate_cents: 15000, status: "occupied" },
];
const multiPropTiles = buildRoomBoard([p1Room, p2Room], multiPropStays, [], "2026-08-06");
assert(multiPropTiles.length === 2, "2 tiles generated for multi-property rooms");
assert(multiPropTiles[0].guest_name === "P1 Guest" && multiPropTiles[0].kind === "occupied", "p1 room 101 has guest P1 Guest");
assert(multiPropTiles[1].guest_name === "" && multiPropTiles[1].kind === "available", "p2 room 101 stays available without P1 guest leakage");

// ─── 7. Housekeeping Status Mapping ───
const hkTasks = [
  { property_id: "p1", room_number: "102", status: "in_progress", task_date: "2026-08-06" },
  { property_id: "p1", room_number: "103", status: "inspected", task_date: "2026-08-06" },
];
const hkRooms = [
  { id: 3, property_id: "p1", room_number: "102", status: "available" },
  { id: 4, property_id: "p1", room_number: "103", status: "dirty" },
];
const hkTiles = buildRoomBoard(hkRooms, [], hkTasks, "2026-08-06");
assert(hkTiles[0].kind === "dirty", "in_progress housekeeping task maps room to dirty, not false clean");
assert(hkTiles[1].kind === "inspected", "inspected housekeeping task maps room to inspected");

console.log(failed ? `\n${failed} assertion(s) FAILED` : "\nALL ROOM BOARD ASSERTIONS PASSED");
console.log(`\n${failed === 0 ? "PASSED" : "FAILED"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);