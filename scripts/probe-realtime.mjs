// Probe for feature 7 — realtime cross-tab change channel round trip.
// Verifies publishChange() -> subscribeChanges() delivers the envelope using the
// native BroadcastChannel transport (Node 18+). No IndexedDB involved.
import { publishChange, subscribeChanges } from "../src/lib/realtime.js";

let failed = 0;
function assert(cond, msg) {
  if (cond) console.log("  ok -", msg);
  else { failed += 1; console.error("  FAIL -", msg); }
}

// BroadcastChannel must be available in this Node runtime for a real round trip.
assert(typeof BroadcastChannel !== "undefined", "runtime provides BroadcastChannel");

const received = [];
const unsub = subscribeChanges((msg) => received.push(msg));

// Wait for the subscriber channel to be set up before publishing.
await new Promise((r) => setTimeout(r, 30));

publishChange("RoomStay", "create", { id: 42, room_number: "205" });
publishChange("HousekeepingTask", "update", { id: 7 });

await new Promise((r) => setTimeout(r, 80));
unsub();

assert(received.length >= 1, `at least one change delivered (got ${received.length})`);
const stay = received.find((m) => m.table === "RoomStay");
assert(!!stay && stay.change === "create", "RoomStay create change delivered");
assert(!!stay && stay.record && stay.record.room_number === "205", "change carries the record payload");

console.log(failed ? `\n${failed} assertion(s) FAILED` : "\nALL REALTIME ASSERTIONS PASSED");
process.exit(failed ? 1 : 0);