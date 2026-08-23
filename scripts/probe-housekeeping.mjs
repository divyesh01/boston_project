// Probe for feature 4 — housekeeping management logic.
import {
  canTransition, defaultChecklist, checklistComplete, checklistProgress,
  housekeepingRollup, overdueTasks, roomHkStatus, roomHkByRoom,
} from "../src/lib/housekeepingService.js";

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed += 1; console.log("  ok -", msg); }
  else { failed += 1; console.error("  FAIL -", msg); }
}

assert(canTransition("pending", "assigned") === true, "pending -> assigned allowed");
assert(canTransition("assigned", "in_progress") === true, "assigned -> in_progress allowed");
assert(canTransition("in_progress", "completed") === true, "in_progress -> completed allowed");
assert(canTransition("completed", "inspected") === true, "completed -> inspected allowed");
assert(canTransition("inspected", "completed") === false, "inspected is terminal (no reverse)");
assert(canTransition("pending", "inspected") === false, "cannot skip states");

const cl = defaultChecklist("205");
assert(cl.length === 7, "checklist has 7 default items");
assert(cl.every((c) => c.room_number === "205"), "checklist items tagged to room 205");
assert(checklistComplete(cl) === false, "empty checklist is incomplete");
assert(checklistProgress(cl) === 0, "0% progress initially");
assert(checklistComplete(cl.map((c, i) => (i < 7 ? { ...c, done: true } : c))) === true, "all-done checklist is complete");

const tasks = [
  { room_number: "101", status: "pending", due_date: "2026-08-01" },
  { room_number: "102", status: "in_progress", due_date: "2026-08-05" },
  { room_number: "103", status: "completed", due_date: "2026-08-01" },
  { room_number: "104", status: "inspected", due_date: "2026-08-01" },
  { room_number: "105", status: "assigned", due_date: "2026-08-02" },
];
const rollup = housekeepingRollup(tasks);
assert(rollup.total === 5, "rollup total is 5");
assert(rollup.open === 3, "open tasks are pending+assigned+in_progress = 3");
assert(rollup.readyToSell === 1, "1 inspected task is ready to sell");

assert(overdueTasks(tasks, "2026-08-03").length === 2, "2 tasks overdue as of 08-03 (101 due 08-01, 105 due 08-02; 102 not yet past due)");

const room = { room_number: "200", status: "available" };
assert(roomHkStatus(room, null) === "available", "no task -> room status available");
assert(roomHkStatus(room, { status: "dirty" }) === "dirty", "task status dirty wins");

const byRoom = roomHkByRoom([{ room_number: "A", status: "pending", task_date: "2026-08-01" }, { room_number: "A", status: "in_progress", task_date: "2026-08-02" }]);
assert(byRoom["A"].status === "in_progress", "most recent task per room wins");

console.log(failed ? `\n${failed} assertion(s) FAILED` : "\nALL HOUSEKEEPING ASSERTIONS PASSED");
console.log(`\n${failed === 0 ? "PASSED" : "FAILED"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);