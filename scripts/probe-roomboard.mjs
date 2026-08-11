// Probe for feature 3 — enhanced Room Board (per-room) logic.
// Runs against the real src/lib/roomBoard.js in Node.
import { generateRoomRegister, buildRoomBoard, roomBoardStats, toRateCents, sumRateCents, staysForDate } from "../src/lib/roomBoard.js";

let failed = 0;
function assert(cond, msg) {
  if (cond) console.log("  ok -", msg);
  else { failed += 1; console.error("  FAIL -", msg); }
}

const rooms = generateRoomRegister("p1", 6);
assert(rooms.length === 6, "register generates 6 rooms");
assert(rooms[0].room_number === "100", "first room numbered 100");
assert(rooms[0].room_type === "Standard", "first room is Standard");

const date = "2026-08-06";
const stays = [
  { room_number: "100", guest_name: "Maria G.", date, check_in: date, check_out: "2026-08-09", rate_cents: toRateCents(139.5), status: "occupied" },
  { room_number: "101", guest_name: "James T.", date, check_in: date, check_out: "2026-08-07", rate_cents: 14900, status: "occupied" },
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

const tiles = buildRoomBoard(rooms, stays, [], date);
const t100 = tiles.find((t) => t.room_number === "100");
assert(t100.kind === "occupied", "room 100 tile is occupied");
assert(t100.guest_name === "Maria G.", "room 100 tile carries guest name");
assert(t100.rate_cents === 13950, "room 100 tile carries integer-cents rate");

console.log(failed ? `\n${failed} assertion(s) FAILED` : "\nALL ROOM BOARD ASSERTIONS PASSED");
process.exit(failed ? 1 : 0);