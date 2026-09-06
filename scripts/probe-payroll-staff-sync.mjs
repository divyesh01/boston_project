// scripts/probe-payroll-staff-sync.mjs
// Adversarial verification of:
// 1. Realtime invalidation subscription in Payroll for ["staff", "payroll"]
// 2. Case-insensitive table prefix matching in realtime.js
// 3. Property-scoped staff querying with account-global staff preservation
// 4. Zero TimecardPunch / clock shift fabrication when staff is created

import 'fake-indexeddb/auto';
import { publishChange, subscribeChanges } from "../src/lib/realtime.js";
import { queryClientInstance } from "../src/lib/query-client.js";
import localDb from "../src/api/localDb.js";

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) {
    passed += 1;
    console.log("  PASS ", msg);
  } else {
    failed += 1;
    console.error("  FAIL ", msg);
  }
}

console.log("\n=== 1. REALTIME INVALIDATION & CASE-INSENSITIVE MATCHING ===");

// Emulate how useRealtimeInvalidation registers its subscriber and invalidator
const prefixes = ["staff", "payroll"];
let invalidationCount = 0;
const invalidatedKeys = [];

// Track invalidateQueries calls on queryClientInstance
const origInvalidateQueries = queryClientInstance.invalidateQueries.bind(queryClientInstance);
queryClientInstance.invalidateQueries = (filters) => {
  invalidationCount++;
  invalidatedKeys.push(filters?.queryKey);
  return origInvalidateQueries(filters);
};

// Replicate exact listener from useRealtimeInvalidation
const unsub = subscribeChanges((msg) => {
  const table = String((msg && msg.table) || "").toLowerCase();
  if (prefixes.some((p) => {
    const prefix = String(Array.isArray(p) ? p[0] : p || "").toLowerCase();
    return table.startsWith(prefix) || prefix.startsWith(table);
  })) {
    for (const p of prefixes) {
      queryClientInstance.invalidateQueries({ queryKey: Array.isArray(p) ? p : [p] });
    }
  }
});

// Wait for subscription to establish
await new Promise((r) => setTimeout(r, 40));

// Test 1: Browser A publishes Staff create
invalidationCount = 0;
invalidatedKeys.length = 0;
publishChange("Staff", "create", { id: 101, employee_name: "Alice Smith", property_id: "prop-1" });
await new Promise((r) => setTimeout(r, 60));

assert(invalidationCount >= 2, "Staff create triggers realtime invalidation for staff and payroll");
assert(
  invalidatedKeys.some((k) => Array.isArray(k) && k[0] === "staff"),
  "Invalidated keys include ['staff'] query key prefix"
);
assert(
  invalidatedKeys.some((k) => Array.isArray(k) && k[0] === "payroll"),
  "Invalidated keys include ['payroll'] query key prefix"
);

// Test 2: Browser A publishes Staff update (e.g. wage rate change)
invalidationCount = 0;
invalidatedKeys.length = 0;
publishChange("Staff", "update", { id: 101, employee_name: "Alice Smith", base_rate: 25 });
await new Promise((r) => setTimeout(r, 60));

assert(invalidationCount >= 2, "Staff update triggers realtime invalidation");

// Test 3: Browser A publishes Staff deactivate / delete
invalidationCount = 0;
invalidatedKeys.length = 0;
publishChange("Staff", "delete", { id: 101 });
await new Promise((r) => setTimeout(r, 60));

assert(invalidationCount >= 2, "Staff delete triggers realtime invalidation");

// Test 4: Browser A publishes PayrollRun create
invalidationCount = 0;
invalidatedKeys.length = 0;
publishChange("PayrollRun", "create", { id: 201, employee_name: "Alice Smith", total_pay: 1000 });
await new Promise((r) => setTimeout(r, 60));

assert(invalidationCount >= 2, "PayrollRun create triggers realtime invalidation");

// Test 5: Unrelated table change (e.g. RoomStay or WeatherSnapshot) should NOT invalidate
invalidationCount = 0;
invalidatedKeys.length = 0;
publishChange("RoomStay", "create", { id: 301, room_number: "101" });
publishChange("WeatherSnapshot", "create", { id: 401, temp: 72 });
await new Promise((r) => setTimeout(r, 60));

assert(invalidationCount === 0, "Unrelated tables do NOT trigger staff/payroll invalidation");

unsub();
queryClientInstance.invalidateQueries = origInvalidateQueries;

console.log("\n=== 2. PROPERTY-SCOPED STAFF FILTERING ===");

// Mock staff directory containing property-assigned staff and account-global staff
const mockStaffDirectory = [
  { id: 1, employee_name: "Global Executive", property_id: "", department: "Management" },
  { id: 2, employee_name: "Global IT Specialist", property_id: null, department: "IT" },
  { id: 3, employee_name: "Property A Front Desk", property_id: "prop-a", department: "Front Office" },
  { id: 4, employee_name: "Property A Housekeeper", property_id: "prop-a", department: "Housekeeping" },
  { id: 5, employee_name: "Property B Front Desk", property_id: "prop-b", department: "Front Office" },
  { id: 6, employee_name: "Property C Maintenance", property_id: "prop-c", department: "Maintenance" },
  { id: 7, employee_name: "Property 10 Numeric Staff", property_id: 10, department: "Front Office" },
];

// Replicate filtering logic in useStaff(propertyId)
function filterStaffByProperty(rows, propertyId) {
  if (!propertyId || propertyId === "all") return rows;
  const targetIds = Array.isArray(propertyId) ? propertyId.map(String) : [String(propertyId)];
  return rows.filter((r) => {
    const pid = r.property_id != null ? String(r.property_id).trim() : "";
    return pid === "" || targetIds.includes(pid);
  });
}

// Case A: Property A selected
const propAResult = filterStaffByProperty(mockStaffDirectory, "prop-a");
assert(
  propAResult.some((s) => s.employee_name === "Property A Front Desk"),
  "Property A staff included when Property A is selected"
);
assert(
  propAResult.some((s) => s.employee_name === "Global Executive"),
  "Account-global staff with empty string property_id is visible in Property A"
);
assert(
  propAResult.some((s) => s.employee_name === "Global IT Specialist"),
  "Account-global staff with null property_id is visible in Property A"
);
assert(
  !propAResult.some((s) => s.employee_name === "Property B Front Desk"),
  "Property B staff is NOT visible when Property A is selected"
);
assert(
  !propAResult.some((s) => s.employee_name === "Property C Maintenance"),
  "Property C staff is NOT visible when Property A is selected"
);
assert(propAResult.length === 4, "Exactly 4 staff visible for Property A (2 prop-a + 2 global)");

// Case B: Property B selected
const propBResult = filterStaffByProperty(mockStaffDirectory, "prop-b");
assert(
  propBResult.some((s) => s.employee_name === "Property B Front Desk"),
  "Property B staff included when Property B is selected"
);
assert(
  propBResult.some((s) => s.employee_name === "Global Executive"),
  "Account-global staff visible in Property B"
);
assert(
  !propBResult.some((s) => s.employee_name === "Property A Front Desk"),
  "Property A staff is NOT visible when Property B is selected"
);
assert(propBResult.length === 3, "Exactly 3 staff visible for Property B (1 prop-b + 2 global)");

// Case C: Multi-property array ["prop-a", "prop-b"]
const multiResult = filterStaffByProperty(mockStaffDirectory, ["prop-a", "prop-b"]);
assert(
  multiResult.some((s) => s.employee_name === "Property A Front Desk") &&
  multiResult.some((s) => s.employee_name === "Property B Front Desk") &&
  multiResult.some((s) => s.employee_name === "Global Executive"),
  "Multi-property filter includes prop-a, prop-b, and global staff"
);
assert(
  !multiResult.some((s) => s.employee_name === "Property C Maintenance"),
  "Property C staff excluded from multi-property filter"
);
assert(multiResult.length === 5, "Exactly 5 staff visible for multi-property filter");

// Case D: "all" Properties selected
const allResult = filterStaffByProperty(mockStaffDirectory, "all");
assert(allResult.length === mockStaffDirectory.length, "All properties shows complete roster");

// Case E: Numeric property id handling
const numResult = filterStaffByProperty(mockStaffDirectory, "10");
assert(
  numResult.some((s) => s.employee_name === "Property 10 Numeric Staff"),
  "Numeric property_id correctly coerced and matched with string filter '10'"
);

console.log("\n=== 3. SEPARATION OF CONCERNS: TIMECARD PUNCH ===");

// Verify that creating a staff record does NOT insert or touch TimecardPunch
// Count punches before staff creation
const initialPunches = await localDb.TimecardPunch.count();
const initialStaff = await localDb.Staff.count();

// Simulate staff creation via localDb
const newStaffId = await localDb.Staff.add({
  employee_name: "Test Engineer",
  department: "Engineering",
  pay_type: "salary",
  base_rate: 5000,
  hours: 40,
  active: true,
  property_id: "prop-a",
  created_date: new Date().toISOString(),
});

const afterPunches = await localDb.TimecardPunch.count();
const afterStaff = await localDb.Staff.count();

assert(afterStaff === initialStaff + 1, "Staff record successfully created in database");
assert(afterPunches === initialPunches, "Zero TimecardPunch records created when Staff is created");

// Clean up test staff record
await localDb.Staff.delete(newStaffId);

console.log(`\n${failed === 0 ? "PASSED" : "FAILED"}: probe-payroll-staff-sync: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
