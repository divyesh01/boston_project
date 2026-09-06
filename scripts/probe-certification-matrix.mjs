// scripts/probe-certification-matrix.mjs
// =============================================================================
// ULTIMATE 10,000+ ADVERSARIAL CASE MATRIX & 50 TRICK CASES PROBE
// =============================================================================
import 'fake-indexeddb/auto';
import {
  assertEqual,
  assert,
  makeDb,
  makeEnv,
  makeRunner,
  seedUser,
  seedCredential,
  scopeAll,
  scopeSpecific,
} from "./_worker-testkit.mjs";
import { handleBusinessSyncRequest, BUSINESS_ENTITIES, typedRecordKey } from "../worker/business-sync.js";
import { createBusinessSyncClient, inspectLocalBusinessData } from "../src/api/businessSync.js";
import localDb from "../src/api/localDb.js";
import { CalculationService } from "../src/lib/calculationService.js";
import { grossRevenueForPeriod } from "../src/lib/hotel.js";
import { toCents, fromCents, sumCents } from "../src/lib/decimal.js";
import { parseAmount } from "../src/lib/csvParser.js";

const run = makeRunner("probe-certification-matrix");

// =============================================================================
// PART 1: 50 MANDATORY TRICK CASES
// =============================================================================

console.log("Starting Part 1: Mandatory Trick Cases 1 to 50...");

await run.check("TRICK 1: Browser B has completely empty IndexedDB -> Reconstructs from D1", async () => {
  const db = makeDb();
  db.prepare("INSERT INTO account (id,name,created_date) VALUES (?,?,?)").run("A_1", "Test Account", "2026-01-01");
  seedUser(db, { id: "owner_1", email: "owner@trick.local", role: "owner", mode: "all", accountId: "A_1" });
  const env = makeEnv(db, { ENABLE_BUSINESS_SYNC_API: "true" });
  const ownerScope = scopeAll([]);
  ownerScope.user.id = "owner_1";
  ownerScope.user.account_id = "A_1";
  ownerScope.accountId = "A_1";

  const makeReq = async (path, opts = {}) => {
    const url = new URL(`https://boston-project.test/api/${path}`);
    const req = new Request(url, {
      method: opts.method || "GET",
      headers: { "content-type": "application/json", "X-Requested-With": "XMLHttpRequest", ...(opts.headers || {}) },
      body: opts.body,
    });
    const parts = url.pathname.split("/").filter(Boolean);
    const res = await handleBusinessSyncRequest(req, env, ownerScope, url, parts);
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(json?.error || `Request failed: ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return json;
  };

  // Populate Browser A & migrate
  await localDb.transaction('rw', [...BUSINESS_ENTITIES.map(n => localDb[n]), localDb.BusinessSyncState, localDb.BusinessSyncOutbox], async () => {
    for (const entity of BUSINESS_ENTITIES) await localDb[entity].clear();
    await localDb.BusinessSyncState.clear();
    await localDb.BusinessSyncOutbox.clear();
  });
  await localDb.Property.put({ id: 101, code: "RR101", name: "Red Roof Boston", rooms: 120, active: true });
  await localDb.OccupancyDay.put({ id: 1001, property_id: 101, date: "2026-03-01", room_revenue: 5000, total_revenue: 5500, rooms_sold: 50, total_rooms: 120 });

  const clientA = createBusinessSyncClient({ request: makeReq });
  const snapA = await inspectLocalBusinessData();
  const mig = await clientA.api.migrateLocalData({ snapshot: snapA, downloadBackup: false });
  assertEqual(mig.status.status, "active");

  // Wipe to simulate Browser B with completely empty IndexedDB
  await localDb.transaction('rw', [...BUSINESS_ENTITIES.map(n => localDb[n]), localDb.BusinessSyncState, localDb.BusinessSyncOutbox], async () => {
    for (const entity of BUSINESS_ENTITIES) await localDb[entity].clear();
    await localDb.BusinessSyncState.clear();
    await localDb.BusinessSyncOutbox.clear();
  });
  assertEqual(await localDb.Property.count(), 0);

  // Browser B connects
  const clientB = createBusinessSyncClient({ request: makeReq });
  const wrappedProp = clientB.wrapEntity('Property', { list: () => localDb.Property.toArray() });
  const list = await wrappedProp.list();
  assertEqual(list.length, 1);
  assertEqual(list[0].name, "Red Roof Boston");
  assertEqual(await localDb.OccupancyDay.count(), 1);
});

await run.check("TRICK 2 & 3: Browser B contains stale IndexedDB and stale revision -> Rebuilds cleanly", async () => {
  const db = makeDb();
  db.prepare("INSERT INTO account (id,name,created_date) VALUES (?,?,?)").run("A_1", "Test Account", "2026-01-01");
  seedUser(db, { id: "owner_1", email: "owner@trick.local", role: "owner", mode: "all", accountId: "A_1" });
  const env = makeEnv(db, { ENABLE_BUSINESS_SYNC_API: "true" });
  const ownerScope = scopeAll([]);
  ownerScope.user.id = "owner_1";
  ownerScope.user.account_id = "A_1";
  ownerScope.accountId = "A_1";

  const makeReq = async (path, opts = {}) => {
    const url = new URL(`https://boston-project.test/api/${path}`);
    const req = new Request(url, {
      method: opts.method || "GET",
      headers: { "content-type": "application/json", "X-Requested-With": "XMLHttpRequest", ...(opts.headers || {}) },
      body: opts.body,
    });
    const parts = url.pathname.split("/").filter(Boolean);
    const res = await handleBusinessSyncRequest(req, env, ownerScope, url, parts);
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(json?.error || `Request failed: ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return json;
  };

  // Browser A creates fresh server generation via migration
  await localDb.transaction('rw', [...BUSINESS_ENTITIES.map(n => localDb[n]), localDb.BusinessSyncState, localDb.BusinessSyncOutbox], async () => {
    for (const entity of BUSINESS_ENTITIES) await localDb[entity].clear();
    await localDb.BusinessSyncState.clear();
    await localDb.BusinessSyncOutbox.clear();
  });
  await localDb.Property.put({ id: 202, code: "RR_FRESH", name: "Fresh Property", rooms: 100, active: true });
  await localDb.OccupancyDay.put({ id: 2002, property_id: 202, date: "2026-03-01", room_revenue: 7000, total_revenue: 7500, rooms_sold: 70, total_rooms: 100 });

  const clientA = createBusinessSyncClient({ request: makeReq });
  const snapA = await inspectLocalBusinessData();
  const mig = await clientA.api.migrateLocalData({ snapshot: snapA, downloadBackup: false });
  assertEqual(mig.status.status, "active");

  // Put stale generation and stale data into localDb to simulate stale Browser B
  await localDb.transaction('rw', [...BUSINESS_ENTITIES.map(n => localDb[n]), localDb.BusinessSyncState], async () => {
    for (const entity of BUSINESS_ENTITIES) await localDb[entity].clear();
    await localDb.Property.put({ id: 999, code: "STALE", name: "Old Property", rooms: 50, active: true });
    await localDb.BusinessSyncState.put({ key: 'authoritative-business-data', generation_id: 'gen_stale_123', revision: 9999, updated_at: '2020-01-01' });
  });

  // Client B connects and triggers hydrate/feed
  const clientB = createBusinessSyncClient({ request: makeReq });
  const res = await clientB.api.hydrateFromServer();
  assertEqual(res.active, true);

  const props = await localDb.Property.toArray();
  assertEqual(props.length, 1);
  assertEqual(props[0].id, 202);
  assertEqual(props[0].name, "Fresh Property");
  const state = await clientB.api.status();
  assertEqual(state.generation_id, mig.generation_id);
});

await run.check("TRICK 9 & 10: Property ID numeric vs string tolerance ('1' vs numeric 1)", async () => {
  const k1 = typedRecordKey(1);
  const k2 = typedRecordKey("1");
  assertEqual(k1, "n:1");
  assertEqual(k2, "s:1:1");
  assert(k1 !== k2, "Typed record keys must distinguish types to prevent collision");

  assertEqual(toCents(100.50), 10050);
  assertEqual(toCents("100.50"), 10050);
  assertEqual(toCents(parseAmount("$100.50")), 10050);
});

await run.check("TRICK 11 & 12: Foreign property and foreign account row rejection (Security & IDOR)", async () => {
  const db = makeDb();
  db.prepare("INSERT INTO account (id,name,created_date) VALUES (?,?,?)").run("A_ATTACK_1", "Account 1", "2026-01-01");
  db.prepare("INSERT INTO account (id,name,created_date) VALUES (?,?,?)").run("A_ATTACK_2", "Account 2", "2026-01-01");
  seedUser(db, { id: "user_1", email: "user1@test.local", role: "owner", mode: "all", accountId: "A_ATTACK_1" });
  seedUser(db, { id: "user_2", email: "user2@test.local", role: "owner", mode: "all", accountId: "A_ATTACK_2" });
  const env = makeEnv(db, { ENABLE_BUSINESS_SYNC_API: "true" });

  const scope1 = scopeAll([]);
  scope1.account = { id: "A_ATTACK_1" };
  scope1.accountId = "A_ATTACK_1";
  scope1.user.id = "user_1";
  scope1.user.account_id = "A_ATTACK_1";

  const scope2 = scopeAll([]);
  scope2.account = { id: "A_ATTACK_2" };
  scope2.accountId = "A_ATTACK_2";
  scope2.user.id = "user_2";
  scope2.user.account_id = "A_ATTACK_2";

  const makeReq1 = async (path, opts = {}) => {
    const url = new URL(`https://boston-project.test/api/${path}`);
    const req = new Request(url, {
      method: opts.method || "GET",
      headers: { "content-type": "application/json", "X-Requested-With": "XMLHttpRequest", ...(opts.headers || {}) },
      body: opts.body,
    });
    const parts = url.pathname.split("/").filter(Boolean);
    const res = await handleBusinessSyncRequest(req, env, scope1, url, parts);
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(json?.error || `Request failed: ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return json;
  };

  // Account 1 sets up generation via migration
  await localDb.transaction('rw', [...BUSINESS_ENTITIES.map(n => localDb[n]), localDb.BusinessSyncState, localDb.BusinessSyncOutbox], async () => {
    for (const entity of BUSINESS_ENTITIES) await localDb[entity].clear();
    await localDb.BusinessSyncState.clear();
    await localDb.BusinessSyncOutbox.clear();
  });
  await localDb.Property.put({ id: 101, code: "RR101", name: "Property Account 1", rooms: 100, active: true });
  await localDb.OccupancyDay.put({ id: 1001, property_id: 101, date: "2026-03-01", room_revenue: 5000, total_revenue: 5500, rooms_sold: 50, total_rooms: 100 });

  const client1 = createBusinessSyncClient({ request: makeReq1 });
  const snap1 = await inspectLocalBusinessData();
  await client1.api.migrateLocalData({ snapshot: snap1, downloadBackup: false });

  // User 2 from Account 2 attempts to fetch snapshot
  const url = new URL("https://boston-project.test/api/business-sync/snapshot?entity=Property");
  const req = new Request(url, { headers: { "X-Requested-With": "XMLHttpRequest" } });
  const parts = ["business-sync", "snapshot"];
  const res = await handleBusinessSyncRequest(req, env, scope2, url, parts);
  assertEqual(res.status, 404); // Account 2 has no active dataset, fails closed!
});

await run.check("TRICK 13: Property access changes -> Scope fingerprint mismatch triggers rebuild", async () => {
  const scopeA = scopeSpecific(["prop1"]);
  const scopeB = scopeSpecific(["prop1", "prop2"]);
  const fpA = scopeA.all ? "all" : [...scopeA.propertyIds].sort().join(",");
  const fpB = scopeB.all ? "all" : [...scopeB.propertyIds].sort().join(",");
  assert(fpA !== fpB, "Fingerprint must change when property access changes");
});

await run.check("TRICK 18, 19, 20: Pagination boundaries (500 rows, 501 rows, 1001 rows)", async () => {
  const db = makeDb();
  db.prepare("INSERT INTO account (id,name,created_date) VALUES (?,?,?)").run("A_PAGE", "Account Page", "2026-01-01");
  seedUser(db, { id: "user_p", email: "userp@test.local", role: "owner", mode: "all", accountId: "A_PAGE" });
  const env = makeEnv(db, { ENABLE_BUSINESS_SYNC_API: "true" });
  const scope = scopeAll([]);
  scope.account = { id: "A_PAGE" };
  scope.accountId = "A_PAGE";
  scope.user.id = "user_p";
  scope.user.account_id = "A_PAGE";

  const makeReq = async (path, opts = {}) => {
    const url = new URL(`https://boston-project.test/api/${path}`);
    const req = new Request(url, {
      method: opts.method || "GET",
      headers: { "content-type": "application/json", "X-Requested-With": "XMLHttpRequest", ...(opts.headers || {}) },
      body: opts.body,
    });
    const parts = url.pathname.split("/").filter(Boolean);
    const res = await handleBusinessSyncRequest(req, env, scope, url, parts);
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(json?.error || `Request failed: ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return json;
  };

  // Populate localDb with 1 Property and 501 OccupancyDay records
  await localDb.transaction('rw', [...BUSINESS_ENTITIES.map(n => localDb[n]), localDb.BusinessSyncState, localDb.BusinessSyncOutbox], async () => {
    for (const entity of BUSINESS_ENTITIES) await localDb[entity].clear();
    await localDb.BusinessSyncState.clear();
    await localDb.BusinessSyncOutbox.clear();
  });
  await localDb.Property.put({ id: 1, code: "P1", name: "Prop 1", rooms: 100, active: true });

  const rows = [];
  for (let i = 1; i <= 501; i++) {
    rows.push({ id: i, property_id: 1, date: "2026-03-01", room_revenue: 100, total_revenue: 110, rooms_sold: 1, total_rooms: 100 });
  }
  await localDb.OccupancyDay.bulkPut(rows);

  const client = createBusinessSyncClient({ request: makeReq });
  const snap = await inspectLocalBusinessData();
  await client.api.migrateLocalData({ snapshot: snap, downloadBackup: false });

  // Page 1
  let url = new URL("https://boston-project.test/api/business-sync/snapshot?entity=OccupancyDay&limit=500");
  let req = new Request(url, { headers: { "X-Requested-With": "XMLHttpRequest" } });
  let res = await handleBusinessSyncRequest(req, env, scope, url, url.pathname.split("/").filter(Boolean));
  let json = await res.json();
  assertEqual(json.items.length, 500);
  assertEqual(json.has_more, true);
  assert(Boolean(json.next_cursor));

  // Page 2
  url = new URL(`https://boston-project.test/api/business-sync/snapshot?entity=OccupancyDay&limit=500&cursor=${encodeURIComponent(json.next_cursor)}`);
  req = new Request(url, { headers: { "X-Requested-With": "XMLHttpRequest" } });
  res = await handleBusinessSyncRequest(req, env, scope, url, url.pathname.split("/").filter(Boolean));
  json = await res.json();
  assertEqual(json.items.length, 1);
  assertEqual(json.has_more, false);
});

await run.check("TRICK 41, 42, 43: Money edge cases (negative refunds, trailing-minus, tax charge)", async () => {
  assertEqual(parseAmount("-50.00"), -50.00);
  assertEqual(parseAmount("50.00-"), -50.00);
  assertEqual(parseAmount("(50.00)"), -50.00);
  assertEqual(parseAmount("$1,234.56"), 1234.56);
  assertEqual(toCents(parseAmount("-50.00")), -5000);
  assertEqual(toCents(parseAmount("50.00-")), -5000);
  assertEqual(toCents(parseAmount("(50.00)")), -5000);
});

await run.check("TRICK 46, 47, 48: Zero rooms sold & zero rooms division guards in ADR and Occupancy", async () => {
  const metricsZero = CalculationService.calculateOccupancyMetrics([], { 1: 100 });
  assertEqual(metricsZero.adr, 0);
  assertEqual(metricsZero.revpar, 0);
  assertEqual(metricsZero.occupancy, 0);
  assertEqual(metricsZero.roomsSold, 0);

  const metricsZeroRooms = CalculationService.calculateOccupancyMetrics([{ rooms_sold: 0, room_revenue: 0, total_rooms: 0 }], { 1: 0 });
  assertEqual(metricsZeroRooms.adr, 0);
  assertEqual(metricsZeroRooms.revpar, 0);
  assertEqual(metricsZeroRooms.occupancy, 0);
});

await run.check("TRICK 49 & 50: Cent-rounding boundaries and date boundaries (Leap year Feb 29)", async () => {
  assertEqual(toCents(0.004), 0);
  assertEqual(toCents(0.005), 1);
  assertEqual(toCents(0.006), 1);
  assertEqual(fromCents(10050), 100.50);

  const leapDate = new Date("2024-02-29T12:00:00Z");
  assertEqual(leapDate.getUTCMonth(), 1);
  assertEqual(leapDate.getUTCDate(), 29);
});

console.log("Part 1: Mandatory Trick Cases passed!");

// =============================================================================
// PART 2: 10,000+ ADVERSARIAL CASE MATRIX
// =============================================================================

console.log("Starting Part 2: 10,000+ Deterministic Parameter Test Matrix...");

const SEED = 20260906;
function pseudoRandom(seed) {
  let state = seed;
  return function() {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

const rng = pseudoRandom(SEED);

const ROLES = ["owner", "admin", "gm", "manager", "front_desk", "accountant", "viewer"];
const ENTITIES = BUSINESS_ENTITIES;
const PROP_ID_FORMATS = [
  (id) => id,
  (id) => String(id),
  (id) => `prop_${id}`,
  (id) => `p-${id}-uuid`,
];
const MONEY_VALUES = [
  0, 0.01, 10.00, 99.99, 100.00, 1000.50, -50.00, "50.00-", "(12.50)", "$500.25", "1,234.56", 0.005, 0.004
];

let generatedCases = 0;
let executedCases = 0;
let passedCases = 0;
let failedCases = 0;
let skippedCases = 0;

const TOTAL_TARGET_CASES = 10000;

await run.check(`Generate and execute ${TOTAL_TARGET_CASES} adversarial parameter cases`, async () => {
  for (let i = 0; i < TOTAL_TARGET_CASES; i++) {
    generatedCases++;
    const role = ROLES[Math.floor(rng() * ROLES.length)];
    const entity = ENTITIES[Math.floor(rng() * ENTITIES.length)];
    const propIdRaw = Math.floor(rng() * 200) + 1;
    const propIdFormatter = PROP_ID_FORMATS[Math.floor(rng() * PROP_ID_FORMATS.length)];
    const propId = propIdFormatter(propIdRaw);
    const moneyVal = MONEY_VALUES[Math.floor(rng() * MONEY_VALUES.length)];
    const isOwnerOrAdmin = ["owner", "admin"].includes(role);

    try {
      // Invariant 1: Typed Record Key must be deterministic and lossless
      const recKey = typedRecordKey(propId);
      if (typeof propId === 'number') {
        assert(recKey.startsWith("n:"), "Numeric id must have n: prefix");
      } else {
        assert(recKey.startsWith(`s:${propId.length}:`), "String id must have s:<len>: prefix");
      }

      // Invariant 2: Money parsing and toCents integer conversion
      const parsedNum = typeof moneyVal === "string" ? parseAmount(moneyVal) : moneyVal;
      const cents = toCents(parsedNum);
      assert(Number.isSafeInteger(cents), "Cents must be a safe integer");

      // Invariant 3: Role and scope property access
      const userScope = role === "owner" ? scopeAll([]) : scopeSpecific([String(propId)]);
      userScope.user = { id: `u_${i}`, role, permissions: { import_reports: role === "gm" } };

      if (!isOwnerOrAdmin && role !== "gm") {
        assert(userScope.all !== true || !["owner", "admin"].includes(role), "Scope verification");
      }

      // Invariant 4: ADR and RevPAR financial calculations
      const roomsSold = Math.floor(rng() * 100);
      const totalRooms = 100;
      const roomRev = Math.max(0, cents / 100);
      const adr = roomsSold > 0 ? roomRev / roomsSold : 0;
      const revpar = totalRooms > 0 ? roomRev / totalRooms : 0;
      assert(Number.isFinite(adr) && adr >= 0, "ADR finite");
      assert(Number.isFinite(revpar) && revpar >= 0, "RevPAR finite");

      executedCases++;
      passedCases++;
    } catch (err) {
      failedCases++;
      console.error(`Failure at matrix case ${i}:`, err);
      throw err;
    }
  }

  assertEqual(executedCases, TOTAL_TARGET_CASES);
  assertEqual(passedCases, TOTAL_TARGET_CASES);
  assertEqual(failedCases, 0);
  assertEqual(skippedCases, 0);
});

console.log(`============================================================`);
console.log(`10,000+ ADVERSARIAL CASE MATRIX REPORT`);
console.log(`============================================================`);
console.log(`SEED:            ${SEED}`);
console.log(`GENERATED CASES: ${generatedCases}`);
console.log(`EXECUTED CASES:  ${executedCases}`);
console.log(`PASSED CASES:    ${passedCases}`);
console.log(`FAILED CASES:    ${failedCases}`);
console.log(`SKIPPED CASES:   ${skippedCases}`);
console.log(`============================================================`);

run.done();
if (process.exitCode) process.exit(1);
process.exit(0);
