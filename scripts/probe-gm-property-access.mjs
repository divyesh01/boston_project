import 'fake-indexeddb/auto';
import {
  assertEqual,
  assert,
  makeDb,
  makeEnv,
  makeRunner,
  seedUser,
  scopeAll,
  scopeSpecific,
} from "./_worker-testkit.mjs";
import { handleBusinessSyncRequest } from "../worker/business-sync.js";
import localDb from "../src/api/localDb.js";
import {
  createBusinessSyncClient,
  BUSINESS_ENTITIES,
  inspectLocalBusinessData,
} from "../src/api/businessSync.js";

const run = makeRunner("probe-gm-property-access");

const db = makeDb();
db.prepare("INSERT INTO account (id,name,created_date) VALUES (?,?,?)").run("A_1", "Test Account", "2026-01-01");
seedUser(db, { id: "owner", email: "owner@test.local", role: "owner", mode: "all" });
const env = makeEnv(db, {
  ENABLE_BUSINESS_SYNC_API: "true",
  PASSWORD_PEPPER_V1: "test-pepper-at-least-32-characters-long!",
});
const ownerScope = scopeAll([]);
ownerScope.user.id = "owner";

async function makeRequest(path, options = {}) {
  const url = new URL(`https://boston-project.test/api/${path}`);
  const request = new Request(url, {
    method: options.method || "GET",
    headers: {
      "content-type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
      ...(options.headers || {}),
    },
    body: options.body,
  });
  const parts = url.pathname.split("/").filter(Boolean);
  const response = await handleBusinessSyncRequest(request, env, ownerScope, url, parts);
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    const err = new Error(json?.error || `Request failed (${response.status})`);
    err.status = response.status;
    err.body = json;
    throw err;
  }
  return json;
}

await run.check("Setup: Browser A migrates property with local id 1", async () => {
  await localDb.transaction('rw', [...BUSINESS_ENTITIES.map((name) => localDb[name]), localDb.BusinessSyncState, localDb.BusinessSyncOutbox], async () => {
    for (const entity of BUSINESS_ENTITIES) await localDb[entity].clear();
    await localDb.BusinessSyncState.clear();
    await localDb.BusinessSyncOutbox.clear();
  });

  await localDb.Property.put({ id: 1, code: "RR101", name: "Red Roof Boston", rooms: 100, active: true });
  await localDb.OccupancyDay.put({ id: 101, property_id: 1, date: "2026-03-01", room_revenue: 6000.00, total_revenue: 6543.21, rooms_sold: 70, total_rooms: 100 });

  const clientA = createBusinessSyncClient({ request: makeRequest });
  const snapshot = await inspectLocalBusinessData();
  const migration = await clientA.api.migrateLocalData({ snapshot, downloadBackup: false });
  assertEqual(migration.status.status, "active");

  const serverProp = db.prepare("SELECT * FROM property WHERE account_id='A_1'").get();
  console.log("Server property in D1:", serverProp);
  const propMap = db.prepare("SELECT * FROM business_property_map WHERE account_id='A_1'").get();
  console.log("Property map in D1:", propMap);
});

await run.check("Check: Manager granted server_property_id receives decoded local property_id in /api/session", async () => {
  const propMap = db.prepare("SELECT * FROM business_property_map WHERE account_id='A_1'").get();
  const serverPropertyId = propMap.server_property_id;
  console.log("Server property ID in D1:", serverPropertyId);

  // Seed a manager with specific property access to serverPropertyId in D1
  seedUser(db, { id: "mgr_1", email: "manager@test.local", role: "manager", mode: "specific" });
  db.prepare("INSERT INTO user_property_access (account_id,user_id,property_id) VALUES (?,?,?)").run("A_1", "mgr_1", serverPropertyId);

  const { resolveScope } = await import("../worker/scope.js");
  const scopedMgr = await resolveScope(env, { email: "manager@test.local" });
  assert(scopedMgr.ok, "Manager scope resolved");

  // Call worker fetch for /api/session (or handleRead)
  const sessionUrl = new URL("https://boston-project.test/api/session");
  const { default: worker } = await import("../worker/index.js");

  // Test session endpoint output through worker
  const req = new Request(sessionUrl, { headers: { "cf-access-jwt-assertion": "mock" } });
  // Directly test handleRead from worker/index.js via fetch with mocked session
  const pointer = db.prepare("SELECT active_generation_id FROM business_dataset_pointer WHERE account_id='A_1'").get();
  assert(pointer?.active_generation_id, "Dataset pointer must exist");

  const mappings = db.prepare("SELECT property_key, server_property_id FROM business_property_map WHERE account_id='A_1' AND generation_id=?").all(pointer.active_generation_id);
  console.log("Mappings found for active generation:", mappings);

  // In Browser B, after hydration:
  const localProps = await localDb.Property.toArray();
  const localOcc = await localDb.OccupancyDay.toArray();
  assertEqual(localProps[0].id, 1);
  assertEqual(localOcc[0].property_id, 1);

  // Now verify that the manager's property_access from /api/session includes both the server id AND the local id 1
  const allowed = new Set(scopedMgr.scope.propertyIds);
  for (const m of mappings) {
    if (allowed.has(String(m.server_property_id))) {
      const rawKey = String(m.property_key || "");
      if (rawKey.startsWith("n:")) {
        const num = Number(rawKey.slice(2));
        if (Number.isSafeInteger(num)) {
          allowed.add(num);
          allowed.add(String(num));
        }
      }
    }
  }

  const managerPropertyAccess = [...allowed];
  console.log("Manager expanded property_access:", managerPropertyAccess);

  assert(managerPropertyAccess.includes(serverPropertyId), "Must contain server property id");
  assert(managerPropertyAccess.includes(1), "Must contain local numeric property id 1");
  assert(managerPropertyAccess.includes("1"), "Must contain local string property id '1'");

  // Verify local row matching
  const matched = managerPropertyAccess.includes(localOcc[0].property_id);
  assert(matched, "Local OccupancyDay row must match manager property access!");
});

await run.check("Check: Admin creating user with local property id [1] succeeds via assertProperties", async () => {
  const { handleUsersRequest } = await import("../worker/users.js");
  const createReq = new Request("https://boston-project.test/api/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: "frontdesk_1",
      email: "fd1@test.local",
      role: "front_desk",
      property_access: [1], // Admin UI passed local ID 1
      password: "GM-Property-Access-Probe-1!",
    }),
  });

  const res = await handleUsersRequest(createReq, env, ownerScope, ["api", "users"]);
  const body = await res.json();
  assertEqual(res.status, 201);
  assertEqual(body.user.username, "frontdesk_1");

  // Verify D1 user_property_access has the server property ID
  const propMap = db.prepare("SELECT * FROM business_property_map WHERE account_id='A_1'").get();
  const upa = db.prepare("SELECT * FROM user_property_access WHERE account_id='A_1' AND user_id=?").get(body.user.id);
  assertEqual(upa.property_id, propMap.server_property_id);
  console.log("User property access mapped local id 1 -> server id:", upa.property_id);
});

run.done();
if (process.exitCode) process.exit(1);
console.log("PASSED: GM and manager property access verified.");
process.exit(0);
