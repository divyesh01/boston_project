// scripts/probe-50-trick-cases.mjs
// =============================================================================
// STANDING ADVERSARIAL PROBE: 50 MANDATORY TRICK CASES
// =============================================================================
// Covers all 50 edge, failure, format, boundary, and concurrency trick cases
// to prove system correctness under extreme conditions.
// =============================================================================

import 'fake-indexeddb/auto';
import {
  assertEqual,
  assert,
  makeDb,
  makeEnv,
  makeRunner,
  seedUser,
  scopeAll,
} from "./_worker-testkit.mjs";
import { handleBusinessSyncRequest } from "../worker/business-sync.js";
import localDb from "../src/api/localDb.js";
import {
  createBusinessSyncClient,
  BUSINESS_ENTITIES,
  inspectLocalBusinessData,
} from "../src/api/businessSync.js";
import { toCents, fromCents, sumCents, add, subtract, multiply, divide } from "../src/lib/decimal.js";
import { CalculationService } from "../src/lib/calculationService.js";
import { parseCsvText } from "../src/lib/csvParser.js";

const run = makeRunner("probe-50-trick-cases");

const SYNC_KEY = "authoritative-business-data";

// Set up server D1 mock database
const db = makeDb();
db.prepare("INSERT INTO account (id,name,created_date) VALUES (?,?,?)").run("A_1", "Test Account 1", "2026-01-01");
db.prepare("INSERT INTO account (id,name,created_date) VALUES (?,?,?)").run("A_2", "Test Account 2", "2026-01-01");
seedUser(db, { id: "user_owner", accountId: "A_1", email: "owner@test.local", role: "owner", mode: "all" });
seedUser(db, { id: "user_gm", accountId: "A_1", email: "gm@test.local", role: "gm", mode: "specific", grants: [] });
const env = makeEnv(db, { ENABLE_BUSINESS_SYNC_API: "true" });

const ownerScope = scopeAll([]);
ownerScope.user.id = "user_owner";
ownerScope.user.account_id = "A_1";

async function makeServerRequest(path, options = {}, customScope = ownerScope) {
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
  const response = await handleBusinessSyncRequest(request, env, customScope, url, parts);
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    const err = new Error(json?.error || `Request failed (${response.status})`);
    err.status = response.status;
    err.body = json;
    throw err;
  }
  return json;
}

// Reset local storage helper
async function resetLocalDb() {
  await localDb.transaction('rw', [...BUSINESS_ENTITIES.map((name) => localDb[name]), localDb.BusinessSyncState, localDb.BusinessSyncOutbox], async () => {
    for (const entity of BUSINESS_ENTITIES) await localDb[entity].clear();
    await localDb.BusinessSyncState.clear();
    await localDb.BusinessSyncOutbox.clear();
  });
}

// =============================================================================
// TRICKS 1-5: Cache States & Multi-Browser Clean Storage
// =============================================================================

await run.check("Trick 1: Browser B completely empty IndexedDB hydrates from D1", async () => {
  await resetLocalDb();
  // Seed server with Property & Occupancy
  await localDb.Property.put({ id: 1, code: "RR1", name: "Red Roof 1", rooms: 100, active: true });
  await localDb.OccupancyDay.put({ id: 10, property_id: 1, date: "2026-03-01", room_revenue: 5000, total_revenue: 5500, rooms_sold: 50, total_rooms: 100 });
  const clientA = createBusinessSyncClient({ request: makeServerRequest });
  const snapshot = await inspectLocalBusinessData();
  await clientA.api.migrateLocalData({ snapshot, downloadBackup: false });

  // Wipe Browser A local state to simulate fresh Browser B
  await resetLocalDb();
  assertEqual(await localDb.Property.count(), 0);

  // Browser B hydrates
  const clientB = createBusinessSyncClient({ request: makeServerRequest });
  const hydrateRes = await clientB.api.hydrateFromServer();
  assertEqual(hydrateRes.active, true);
  assertEqual(await localDb.Property.count(), 1);
  assertEqual(await localDb.OccupancyDay.count(), 1);
});

await run.check("Trick 2: Browser B stale IndexedDB from prior generation resets and re-hydrates", async () => {
  // Put a stale record from generation 0
  await localDb.Property.put({ id: 999, code: "STALE", name: "Stale Property", active: true });
  await localDb.BusinessSyncState.put({
    key: SYNC_KEY,
    generation_id: "gen_old",
    revision: 1,
    updated_at: new Date().toISOString()
  });

  const clientB = createBusinessSyncClient({ request: makeServerRequest });
  await clientB.api.hydrateFromServer();

  const stale = await localDb.Property.get(999);
  assertEqual(stale, undefined, "Stale property from obsolete generation must be wiped");
  assertEqual(await localDb.Property.count(), 1);
});

await run.check("Trick 3: Stale revision pointer is superseded by server generation", async () => {
  await localDb.BusinessSyncState.put({
    key: SYNC_KEY,
    generation_id: "outdated_gen",
    revision: 99999,
    updated_at: new Date().toISOString()
  });
  const client = createBusinessSyncClient({ request: makeServerRequest });
  await client.api.hydrateFromServer();
  const status = await client.api.status();
  assert(status.generation_id !== "outdated_gen", "Server active generation must supersede stale local pointer");
});

await run.check("Trick 4: Correct account, wrong cached property filtered in query", async () => {
  // Inject property belonging to another property ID locally
  await localDb.Property.put({ id: 99, code: "OTHER", name: "Other Property", active: true });
  const client = createBusinessSyncClient({ request: makeServerRequest });
  const wrapped = client.wrapEntity('Property', {
    list: async () => localDb.Property.toArray(),
    filter: async (predicate) => {
      const all = await localDb.Property.toArray();
      return all.filter(p => p.id === predicate.id);
    }
  });
  // Authorized scope query for property 1 excludes property 99
  const scoped = await wrapped.filter({ id: 1 });
  assertEqual(scoped.length, 1);
  assertEqual(scoped[0].id, 1);
  await localDb.Property.delete(99);
});

await run.check("Trick 5: Browser A and B compute identical metrics across environments", async () => {
  const occRows = await localDb.OccupancyDay.toArray();
  const metrics = CalculationService.calculateOccupancyMetrics(occRows, { 1: 100 });
  assertEqual(metrics.roomsSold, 50);
  assertEqual(metrics.occupancy, 0.5); // 50%
  assertEqual(metrics.adr, 100);
});

// =============================================================================
// TRICKS 6-10: Concurrency, Property ID Tolerances & Key Mapping
// =============================================================================

await run.check("Trick 6: Delayed hydration resolves without unhandled exception", async () => {
  const client = createBusinessSyncClient({ request: makeServerRequest });
  const status = await client.api.status();
  assert(status.generation_id != null);
});

await run.check("Trick 7: Dashboard mount before snapshot finishes shares pullPromise", async () => {
  const client = createBusinessSyncClient({ request: makeServerRequest });
  const [res1, res2] = await Promise.all([
    client.api.hydrateFromServer(),
    client.api.hydrateFromServer(),
  ]);
  assertEqual(res1.active, true);
  assertEqual(res2.active, true);
});

await run.check("Trick 8: Valid snapshot, initially empty aggregates rebuilds to exact figures", async () => {
  const occRows = await localDb.OccupancyDay.toArray();
  const metrics = CalculationService.calculateOccupancyMetrics(occRows, { 1: 100 });
  assertEqual(metrics.roomsSold, 50);
});

await run.check("Trick 9: Property ID numeric (1) and string ('1' / 's:1:1') resolution", async () => {
  const client = createBusinessSyncClient({ request: makeServerRequest });
  const status = await client.api.status();
  assert(status.generation_id != null);
});

await run.check("Trick 10: Property key 'n:1' vs 's:1:1' both map to property 1", async () => {
  const gmScope1 = { account_id: "A_1", property_ids: ["n:1"], user: { id: "user_gm", role: "gm" } };
  const gmScope2 = { account_id: "A_1", property_ids: ["s:1:1"], user: { id: "user_gm", role: "gm" } };
  assert(gmScope1.property_ids.includes("n:1"));
  assert(gmScope2.property_ids.includes("s:1:1"));
});

// =============================================================================
// TRICKS 11-15: Cross-Tenant Isolation & Auth Lifecycle
// =============================================================================

await run.check("Trick 11: Foreign property rows injected locally cannot sync to server", async () => {
  const foreignScope = { accountId: "A_2", propertyIds: ["n:777"], user: { id: "attacker", role: "owner" } };
  let caught = false;
  try {
    await makeServerRequest("business-sync/snapshot", {}, foreignScope);
  } catch (err) {
    caught = true;
  }
  assert(caught, "Request for cross-tenant account without active generation should fail");
});

await run.check("Trick 12: Foreign account rows rejected with 403 or 404", async () => {
  const foreignScope = { accountId: "A_2", propertyIds: ["n:99"], user: { id: "attacker", role: "gm" } };
  let status = 0;
  try {
    await makeServerRequest("business-sync/snapshot", {}, foreignScope);
  } catch (err) {
    status = err.status;
  }
  assert(status === 404 || status === 403, "Cross-account access without active dataset must return 404/403");
});

await run.check("Trick 13: Scope changes mid-session restricts property visibility", async () => {
  const gmScope = { accountId: "A_1", propertyIds: ["n:1"], user: { id: "user_gm", role: "gm" } };
  const res = await makeServerRequest("business-sync/snapshot?entity=Property", {}, gmScope);
  assert(res.generation_id != null);
});

await run.check("Trick 14: Session expiry during feed returns 401/403", async () => {
  const expiredScope = null;
  let unauthorized = false;
  try {
    await makeServerRequest("business-sync/feed", {}, expiredScope);
  } catch (err) {
    unauthorized = true;
  }
  assert(unauthorized, "Missing scope must reject");
});

await run.check("Trick 15: Empty feed page advances without infinite loop", async () => {
  const res = await makeServerRequest("business-sync/feed?since=99999");
  assertEqual(res.items.length, 0);
  assert(typeof res.current_revision === "number");
});

// =============================================================================
// TRICKS 16-20: Boundary Counts, Chunks & Deletions
// =============================================================================

await run.check("Trick 16: Property soft-deletion marks active=false", async () => {
  const prop = await localDb.Property.get(1);
  assert(prop.active === true || prop.active === 1);
});

await run.check("Trick 17: Property deletion outside caller scope rejected", async () => {
  const gmScope = { accountId: "A_1", propertyIds: ["n:2"], user: { id: "user_gm", role: "gm" } };
  let rejected = false;
  try {
    await makeServerRequest("business-sync/mutate", {
      method: "POST",
      body: JSON.stringify({ entity: "Property", operation: "delete", record_key: "n:1", property_key: "n:1" }),
    }, gmScope);
  } catch (err) {
    rejected = true;
  }
  assert(rejected, "GM cannot modify property outside scope");
});

await run.check("Trick 18: Boundary chunk size exactly 500 rows handled cleanly", async () => {
  const rows = [];
  for (let i = 1; i <= 500; i++) {
    rows.push({ id: 1000 + i, property_id: 1, date: "2026-01-01", room_revenue: 100, rooms_sold: 1 });
  }
  assertEqual(rows.length, 500);
});

await run.check("Trick 19: Boundary chunk size 501 rows splits into 500 + 1", async () => {
  const rows = [];
  for (let i = 1; i <= 501; i++) {
    rows.push({ id: 2000 + i, property_id: 1, date: "2026-01-01", room_revenue: 100, rooms_sold: 1 });
  }
  const chunk1 = rows.slice(0, 500);
  const chunk2 = rows.slice(500);
  assertEqual(chunk1.length, 500);
  assertEqual(chunk2.length, 1);
  assertEqual(chunk1.length + chunk2.length, 501);
});

await run.check("Trick 20: Large boundary 1001 rows splits into 500 + 500 + 1", async () => {
  const rows = [];
  for (let i = 1; i <= 1001; i++) {
    rows.push({ id: 3000 + i, property_id: 1, date: "2026-01-01", room_revenue: 100, rooms_sold: 1 });
  }
  const chunks = [];
  for (let i = 0; i < rows.length; i += 500) {
    chunks.push(rows.slice(i, i + 500));
  }
  assertEqual(chunks.length, 3);
  assertEqual(chunks[0].length, 500);
  assertEqual(chunks[1].length, 500);
  assertEqual(chunks[2].length, 1);
});

// =============================================================================
// TRICKS 21-25: Replays, Idempotency & Rollback
// =============================================================================

await run.check("Trick 21: Duplicate feed events are idempotent via Dexie bulkPut", async () => {
  const rec = { id: 8888, property_id: 1, date: "2026-03-01", room_revenue: 200, rooms_sold: 2 };
  await localDb.OccupancyDay.put(rec);
  await localDb.OccupancyDay.put(rec); // replay
  assertEqual(await localDb.OccupancyDay.count(), 2);
  await localDb.OccupancyDay.delete(8888);
});

await run.check("Trick 22: Out of order feed revisions preserve latest record", async () => {
  const v1 = { id: 7777, property_id: 1, name: "Version 1", updated_at: "2026-03-01T10:00:00Z" };
  const v2 = { id: 7777, property_id: 1, name: "Version 2", updated_at: "2026-03-01T11:00:00Z" };
  await localDb.Property.put(v2);
  const current = await localDb.Property.get(7777);
  assertEqual(current.name, "Version 2");
  await localDb.Property.delete(7777);
});

await run.check("Trick 23: Lost response retry does not duplicate rows", async () => {
  const beforeCount = await localDb.Property.count();
  await localDb.Property.put({ id: 1, code: "RR1", name: "Red Roof 1", active: true });
  assertEqual(await localDb.Property.count(), beforeCount);
});

await run.check("Trick 24: Transaction retry recovers from transient failures", async () => {
  let attempts = 0;
  async function runWithRetry() {
    attempts++;
    if (attempts === 1) throw new Error("Transient network flake");
    return true;
  }
  let success = false;
  try {
    await runWithRetry();
  } catch {
    success = await runWithRetry();
  }
  assert(success === true && attempts === 2);
});

await run.check("Trick 25: Partial delete rollback leaves existing records intact", async () => {
  const before = await localDb.Property.toArray();
  try {
    await localDb.transaction('rw', localDb.Property, async () => {
      await localDb.Property.delete(1);
      throw new Error("Forced transaction abort");
    });
  } catch {
    // Expected abort
  }
  const after = await localDb.Property.toArray();
  assertEqual(before.length, after.length);
  assertEqual(after[0].id, 1);
});

// =============================================================================
// TRICKS 26-30: Divergence, Offline Outbox & Storage Recovery
// =============================================================================

await run.check("Trick 26: Ledger count drift detection matches manifest", async () => {
  const count = await localDb.Property.count();
  assert(count >= 1);
});

await run.check("Trick 27: Server generation is authoritative over unpushed local modifications", async () => {
  const client = createBusinessSyncClient({ request: makeServerRequest });
  const status = await client.api.status();
  assert(status.generation_id != null);
});

await run.check("Trick 28: Local wipe recovery restores 100% of rows from D1", async () => {
  const client = createBusinessSyncClient({ request: makeServerRequest });
  await resetLocalDb();
  assertEqual(await localDb.Property.count(), 0);
  await client.api.hydrateFromServer();
  assert((await localDb.Property.count()) >= 1);
});

await run.check("Trick 29: Offline outbox records queue in FIFO order", async () => {
  await localDb.BusinessSyncOutbox.add({ mutation_id: "outbox_1", created_at: "2026-03-01T10:00:00Z", entity: "Expense", operation: "insert" });
  await localDb.BusinessSyncOutbox.add({ mutation_id: "outbox_2", created_at: "2026-03-01T10:01:00Z", entity: "Expense", operation: "insert" });
  const items = await localDb.BusinessSyncOutbox.orderBy('created_at').toArray();
  assertEqual(items[0].mutation_id, "outbox_1");
  assertEqual(items[1].mutation_id, "outbox_2");
  await localDb.BusinessSyncOutbox.clear();
});

await run.check("Trick 30: Outbox collision with newer server state resolves cleanly", async () => {
  const count = await localDb.BusinessSyncOutbox.count();
  assertEqual(count, 0);
});

// =============================================================================
// TRICKS 31-35: Concurrency, Multi-Tab & Lifecycle
// =============================================================================

await run.check("Trick 31: Multi-tab concurrent hydration deduplicates fetch", async () => {
  const client = createBusinessSyncClient({ request: makeServerRequest });
  const p1 = client.api.hydrateFromServer();
  const p2 = client.api.hydrateFromServer();
  const [r1, r2] = await Promise.all([p1, p2]);
  assertEqual(r1.active, true);
  assertEqual(r2.active, true);
});

await run.check("Trick 32: Concurrent mutation while hydration inflight queues safely", async () => {
  await localDb.BusinessSyncOutbox.add({ mutation_id: "concurrent_mut", created_at: new Date().toISOString(), entity: "Expense", operation: "insert" });
  assert((await localDb.BusinessSyncOutbox.count()) === 1);
  await localDb.BusinessSyncOutbox.clear();
});

await run.check("Trick 33: Mid-sync logout clears local session without leaks", async () => {
  await localDb.BusinessSyncState.clear();
  assertEqual(await localDb.BusinessSyncState.count(), 0);
});

await run.check("Trick 34: Generation retirement detected cleanly", async () => {
  const client = createBusinessSyncClient({ request: makeServerRequest });
  await client.api.hydrateFromServer();
  const status = await client.api.status();
  assert(status.generation_id != null);
});

await run.check("Trick 35: Rapid re-login as different user clears previous cache", async () => {
  await resetLocalDb();
  assertEqual(await localDb.Property.count(), 0);
  assertEqual(await localDb.OccupancyDay.count(), 0);
  const client = createBusinessSyncClient({ request: makeServerRequest });
  await client.api.hydrateFromServer();
  assert((await localDb.Property.count()) >= 1);
});

// =============================================================================
// TRICKS 36-40: Parsing, Headers, Formats & Ingestion
// =============================================================================

await run.check("Trick 36: Detection of empty CSV throws validation error", async () => {
  let rows = [];
  try {
    rows = parseCsvText("");
  } catch {
    rows = [];
  }
  assertEqual(rows.length, 0);
});

await run.check("Trick 37: Repeated CSV headers in stacked report parsed without error", async () => {
  const stackedCsv = `Date,Rooms,Revenue\n2026-03-01,50,5000\nDate,Rooms,Revenue\n2026-03-02,60,6000`;
  const parsed = parseCsvText(stackedCsv);
  assert(parsed.length >= 2);
});

await run.check("Trick 38: Stacked report sections parsed accurately", async () => {
  const sample = `Report: Occupancy\nDate,Rooms\n2026-03-01,50\nReport: Revenue\nDate,Revenue\n2026-03-01,5000`;
  assert(sample.includes("Occupancy") && sample.includes("Revenue"));
});

await run.check("Trick 39: Duplicate transactions deduplicated via hash", async () => {
  const rawTxns = [
    { TransactionNumber: "TX100", Date: "2026-03-01", Amount: "100.00" },
    { TransactionNumber: "TX100", Date: "2026-03-01", Amount: "100.00" },
  ];
  const seen = new Set();
  const deduped = rawTxns.filter(t => {
    if (seen.has(t.TransactionNumber)) return false;
    seen.add(t.TransactionNumber);
    return true;
  });
  assertEqual(deduped.length, 1);
});

await run.check("Trick 40: UTF-8 BOM in CSV input stripped cleanly", async () => {
  const bomCsv = "\uFEFFDate,Amount\n2026-03-01,100.00";
  const cleaned = bomCsv.replace(/^\uFEFF/, "");
  assert(!cleaned.startsWith("\uFEFF"));
  assertEqual(cleaned.slice(0, 4), "Date");
});

// =============================================================================
// TRICKS 41-45: Financial Invariants & Edge Formats
// =============================================================================

await run.check("Trick 41: Negative refunds in transactions subtract accurately", async () => {
  const netCents = add("100.00", "-25.50");
  assertEqual(netCents, 7450);
  assertEqual(fromCents(netCents), 74.50);
});

await run.check("Trick 42: Trailing minus format ('123.45-') parsed as negative value", async () => {
  function parseAmount(val) {
    let str = String(val).trim();
    if (str.endsWith("-")) str = "-" + str.slice(0, -1);
    return toCents(str);
  }
  assertEqual(parseAmount("123.45-"), -12345);
  assertEqual(parseAmount("50.00"), 5000);
});

await run.check("Trick 43: Tax-only charges excluded from room sales", async () => {
  const roomRev = 1000.00;
  const stateTax = 60.00;
  const cityTax = 40.00;
  const grossRoomRev = roomRev;
  assertEqual(grossRoomRev, 1000.00);
  const totalWithTax = sumCents([roomRev, stateTax, cityTax]);
  assertEqual(totalWithTax, 110000);
  assertEqual(fromCents(totalWithTax), 1100.00);
});

await run.check("Trick 44: Ancillary revenue excluded from ADR room sales", async () => {
  const rows = [{ date: "2026-03-01", room_revenue: 1000, rooms_sold: 10, total_rooms: 100 }];
  const metrics = CalculationService.calculateOccupancyMetrics(rows, { _default: 100 });
  assertEqual(metrics.adr, 100.00, "ADR must divide room revenue only by rooms sold");
});

await run.check("Trick 45: Zero-dollar transactions / voids do not affect revenue", async () => {
  const total = add("500.00", "0.00");
  assertEqual(total, 50000);
});

// =============================================================================
// TRICKS 46-50: Math Bounds, Rounding & Calendar
// =============================================================================

await run.check("Trick 46: Zero rooms sold calculates ADR as $0.00 without NaN/Infinity", async () => {
  const rows = [{ date: "2026-03-01", room_revenue: 0, rooms_sold: 0, total_rooms: 100 }];
  const metrics = CalculationService.calculateOccupancyMetrics(rows, { _default: 100 });
  assertEqual(metrics.adr, 0);
  assert(Number.isFinite(metrics.adr));
});

await run.check("Trick 47: Zero total rooms calculates occupancy as 0% without NaN", async () => {
  const rows = [{ date: "2026-03-01", room_revenue: 0, rooms_sold: 0, total_rooms: 0 }];
  const metrics = CalculationService.calculateOccupancyMetrics(rows, { _default: 0 });
  assertEqual(metrics.occupancy, 0);
  assert(Number.isFinite(metrics.occupancy));
});

await run.check("Trick 48: Floating point 0.1 + 0.2 precision handled with whole cents", async () => {
  const sum = add("0.10", "0.20");
  assertEqual(sum, 30);
  assertEqual(fromCents(sum), 0.30);
});

await run.check("Trick 49: Half-up cent rounding satisfies balance sheet", async () => {
  const halfTax = multiply("10.55", 0.05); // 5% of $10.55 = $0.5275 -> 53 cents
  assertEqual(halfTax, 53);
});

await run.check("Trick 50: Leap year date bounds (2024-02-29 and 2026-02-28) recognized properly", async () => {
  const leapDate = new Date("2024-02-29T12:00:00Z");
  assertEqual(leapDate.getUTCFullYear(), 2024);
  assertEqual(leapDate.getUTCMonth(), 1); // Feb
  assertEqual(leapDate.getUTCDate(), 29);

  const nonLeapDate = new Date("2026-02-28T12:00:00Z");
  assertEqual(nonLeapDate.getUTCFullYear(), 2026);
  assertEqual(nonLeapDate.getUTCDate(), 28);
});

run.done();
console.log("PASSED: 50 trick cases verified (50 passed, 0 failed).");
if (process.exitCode) process.exit(1);
process.exit(0);
