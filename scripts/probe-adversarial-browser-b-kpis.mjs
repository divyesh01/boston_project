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
import { CalculationService } from "../src/lib/calculationService.js";
import { grossRevenueForPeriod } from "../src/lib/hotel.js";
import { rebuildDailyAggregates, getDailyAggregates, buildSyntheticRows } from "../src/lib/dailyAggregates.js";

const run = makeRunner("probe-adversarial-browser-b-kpis");

const db = makeDb();
db.prepare("INSERT INTO account (id,name,created_date) VALUES (?,?,?)").run("A_1", "Test Account", "2026-01-01");
seedUser(db, { id: "owner", email: "owner@test.local", role: "owner", mode: "all" });
const env = makeEnv(db, { ENABLE_BUSINESS_SYNC_API: "true" });
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

let browserAKpis = null;

await run.check("Step 1: Browser A imports HotelKey data and calculates KPIs", async () => {
  await localDb.transaction('rw', [...BUSINESS_ENTITIES.map((name) => localDb[name]), localDb.BusinessSyncState, localDb.BusinessSyncOutbox], async () => {
    for (const entity of BUSINESS_ENTITIES) await localDb[entity].clear();
    await localDb.BusinessSyncState.clear();
    await localDb.BusinessSyncOutbox.clear();
  });

  // Seed Property
  await localDb.Property.put({ id: 1, code: "RR101", name: "Red Roof Boston", rooms: 100, active: true });

  // Seed OccupancyDay
  await localDb.OccupancyDay.bulkPut([
    { id: 101, property_id: 1, date: "2026-03-01", room_revenue: 6000.00, total_revenue: 6543.21, rooms_sold: 70, total_rooms: 100, comp_rooms: 2, out_of_order: 1 },
    { id: 102, property_id: 1, date: "2026-03-02", room_revenue: 7200.00, total_revenue: 7890.12, rooms_sold: 80, total_rooms: 100, comp_rooms: 1, out_of_order: 1 },
    { id: 103, property_id: 1, date: "2026-03-03", room_revenue: 7500.00, total_revenue: 8123.45, rooms_sold: 85, total_rooms: 100, comp_rooms: 0, out_of_order: 0 },
  ]);

  // Seed GrossRevenueDay
  await localDb.GrossRevenueDay.bulkPut([
    { id: 201, property_id: 1, date: "2026-03-01", room_revenue: 6000.00, state_tax: 300.00, city_tax: 243.21 },
    { id: 202, property_id: 1, date: "2026-03-02", room_revenue: 7200.00, state_tax: 360.00, city_tax: 330.12 },
    { id: 203, property_id: 1, date: "2026-03-03", room_revenue: 7500.00, state_tax: 375.00, city_tax: 248.45 },
  ]);

  // Seed SourceDay
  await localDb.SourceDay.bulkPut([
    { id: 301, property_id: 1, date: "2026-03-01", source: "DIRECT", net_revenue: 3000.00, stays: 30 },
    { id: 302, property_id: 1, date: "2026-03-01", source: "EXPEDIA", net_revenue: 3543.21, stays: 40 },
    { id: 303, property_id: 1, date: "2026-03-02", source: "DIRECT", net_revenue: 4000.00, stays: 40 },
    { id: 304, property_id: 1, date: "2026-03-02", source: "BOOKING", net_revenue: 3890.12, stays: 40 },
    { id: 305, property_id: 1, date: "2026-03-03", source: "DIRECT", net_revenue: 8123.45, stays: 85 },
  ]);

  // Seed PaymentDay
  await localDb.PaymentDay.bulkPut([
    { id: 401, property_id: 1, date: "2026-03-01", total: 6543.21, visa: 4000.00, mastercard: 2543.21 },
    { id: 402, property_id: 1, date: "2026-03-02", total: 7890.12, visa: 5000.00, mastercard: 2890.12 },
    { id: 403, property_id: 1, date: "2026-03-03", total: 8123.45, visa: 5000.00, cash: 3123.45 },
  ]);

  // Seed Expenses
  await localDb.Expense.bulkPut([
    { id: 501, property_id: 1, expense_date: "2026-03-01", amount: 500.00, category: "utilities" },
    { id: 502, property_id: 1, expense_date: "2026-03-02", amount: 750.00, category: "maintenance" },
  ]);

  // Build daily aggregates in Browser A
  await rebuildDailyAggregates({ propertyId: 1, from: "2026-03-01", to: "2026-03-03" });

  const occRows = await localDb.OccupancyDay.toArray();
  const grossRows = await localDb.GrossRevenueDay.toArray();

  const stats = CalculationService.calculateOccupancyMetrics(occRows, { 1: 100 });
  const totalRev = grossRevenueForPeriod({ grossRows, occRows });

  browserAKpis = {
    ...stats,
    totalRevDollars: totalRev.dollars,
  };

  assertEqual(browserAKpis.roomsSold, 235);
  assertEqual(browserAKpis.totalRevDollars, 20700);
});

await run.check("Step 2: Browser A migrates to server D1", async () => {
  const clientA = createBusinessSyncClient({ request: makeRequest });
  const snapshot = await inspectLocalBusinessData();
  const migration = await clientA.api.migrateLocalData({ snapshot, downloadBackup: false });
  assertEqual(migration.status.status, "active");
});

await run.check("Step 3: Browser B (empty storage) logs in, queries, and computes exact KPIs", async () => {
  // Wipe Browser A local storage completely to simulate fresh Browser B
  await localDb.transaction('rw', [...BUSINESS_ENTITIES.map((name) => localDb[name]), localDb.BusinessSyncState, localDb.BusinessSyncOutbox], async () => {
    for (const entity of BUSINESS_ENTITIES) await localDb[entity].clear();
    await localDb.BusinessSyncState.clear();
    await localDb.BusinessSyncOutbox.clear();
  });

  assertEqual(await localDb.Property.count(), 0);
  assertEqual(await localDb.OccupancyDay.count(), 0);

  // Initialize client B
  const clientB = createBusinessSyncClient({ request: makeRequest });
  const wrappedProperty = clientB.wrapEntity('Property', {
    list: async () => localDb.Property.toArray(),
    filter: async (q) => localDb.Property.toArray(),
  });
  const wrappedOccupancy = clientB.wrapEntity('OccupancyDay', {
    list: async () => localDb.OccupancyDay.toArray(),
    filter: async (q) => {
      const all = await localDb.OccupancyDay.toArray();
      return all.filter((r) => !q.date || (r.date >= q.date.$gte && r.date <= q.date.$lte));
    },
  });
  const wrappedGross = clientB.wrapEntity('GrossRevenueDay', {
    list: async () => localDb.GrossRevenueDay.toArray(),
    filter: async (q) => {
      const all = await localDb.GrossRevenueDay.toArray();
      return all.filter((r) => !q.date || (r.date >= q.date.$gte && r.date <= q.date.$lte));
    },
  });
  const wrappedPayment = clientB.wrapEntity('PaymentDay', {
    list: async () => localDb.PaymentDay.toArray(),
    filter: async (q) => {
      const all = await localDb.PaymentDay.toArray();
      return all.filter((r) => !q.date || (r.date >= q.date.$gte && r.date <= q.date.$lte));
    },
  });

  // Browser B issues queries as Dashboard does
  const properties = await wrappedProperty.list();
  assertEqual(properties.length, 1);
  assertEqual(properties[0].name, "Red Roof Boston");

  const filter = { date: { $gte: "2026-03-01", $lte: "2026-03-03" }, property_id: 1 };
  const bOcc = await wrappedOccupancy.filter(filter);
  const bGross = await wrappedGross.filter(filter);

  const bStats = CalculationService.calculateOccupancyMetrics(bOcc, { 1: 100 });
  const bTotalRev = grossRevenueForPeriod({ grossRows: bGross, occRows: bOcc });

  const browserBKpis = {
    ...bStats,
    totalRevDollars: bTotalRev.dollars,
  };

  assertEqual(browserBKpis.totalRevDollars, browserAKpis.totalRevDollars, "Total Revenue must match exactly to the cent");
  assertEqual(browserBKpis.revenue, browserAKpis.revenue, "Room Revenue must match exactly to the cent");
  assertEqual(browserBKpis.adr, browserAKpis.adr, "ADR must match exactly");
  assertEqual(browserBKpis.revpar, browserAKpis.revpar, "RevPAR must match exactly");
  assertEqual(browserBKpis.occupancy, browserAKpis.occupancy, "Occupancy Rate must match exactly");
  assertEqual(browserBKpis.roomsSold, browserAKpis.roomsSold, "Rooms Sold must match exactly");
});

run.done();
if (process.exitCode) process.exit(1);
console.log("PASSED: Adversarial Browser B KPIs matched bit-equal.");
process.exit(0);
