import "fake-indexeddb/auto";
import "@/lib/parser.worker.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";

globalThis.crypto ??= /** @type {any} */ (await import("node:crypto").then((m) => m.webcrypto));
if (!globalThis.crypto?.subtle) {
  globalThis.crypto = /** @type {any} */ (await import("node:crypto").then((m) => m.webcrypto));
}

const storage = new Map();
const storageShim = {
  getItem: (/** @type {string} */ key) => storage.has(key) ? storage.get(key) : null,
  setItem: (/** @type {string} */ key, /** @type {unknown} */ value) => storage.set(key, String(value)),
  removeItem: (/** @type {string} */ key) => storage.delete(key),
  clear: () => storage.clear(),
};
globalThis.localStorage = /** @type {any} */ (storageShim);
globalThis.sessionStorage = /** @type {any} */ (storageShim);
globalThis.window = /** @type {any} */ (globalThis);
globalThis.screen = /** @type {any} */ ({ width: 1920, height: 1080 });
if (globalThis.navigator === undefined) {
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "golden-hotel-harness", language: "en-US" },
    configurable: true,
  });
}

const g = /** @type {any} */ (globalThis);
class InProcessWorker {
  constructor() {
    this.onmessage = null;
    this.onerror = null;
  }
  postMessage(data) {
    const handler = g.self?.onmessage || g.onmessage;
    if (typeof handler !== "function") throw new Error("GOLDEN_HOTEL_WORKER_SHIM_UNARMED");
    let reply;
    const realPost = g.postMessage;
    g.postMessage = (msg) => { reply = msg; };
    try {
      handler({ data });
    } finally {
      g.postMessage = realPost;
    }
    this.onmessage?.({ data: reply });
  }
  terminate() {}
}
g.Worker = InProcessWorker;

const { default: localDb } = await import("@/api/localDb");
const { db } = await import("@/api/base44Client");
const { scanReport, importReport } = await import("@/lib/reportParsers.js");
const { summarize } = await import("@/lib/transactionAnalytics.js");
const { snapshotFor, revenueSplit } = await import("@/lib/statisticsAnalytics.js");
const { reconcileRevenuePaths } = await import("@/lib/financialReconciliation.js");
const { toCents, fromCents, sumCents } = await import("@/lib/decimal.js");
const {
  buildNormalizedBundle,
  computeNormalizedHash,
  sha256Hex,
} = await import("@/lib/bulkImportPipeline.js");

const FIXTURE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "__fixtures__",
  "hotelkey",
);

const FILES = Object.freeze({
  transactions: "golden-owner-transactions.csv",
  occupancy: "golden-owner-occupancy.csv",
  source: "golden-owner-source.csv",
  statistics: "golden-owner-statistics.csv",
});

const PROPERTY = "P-GOLDEN-001";
const PROPERTY_NAME = "Golden Hotel";
const ORACLE = Object.freeze({
  totalRevenueCents: 105000,
  roomRevenueCents: 100000,
  ancillaryRevenueCents: 5000,
  directRevenueCents: 40000,
  otaRevenueCents: 60000,
  transactionRows: 7,
  occupancyDays: 3,
  sourceRows: 3,
  statisticsMetrics: 10,
});

/** @param {string} name */
function fixtureText(name) {
  return readFileSync(path.join(FIXTURE_DIR, name), "utf8");
}

/** @param {string} name */
async function scan(name) {
  return /** @type {any} */ (await scanReport("auto", name, {
    csvText: fixtureText(name),
    sourceFile: name,
    propertyId: PROPERTY,
    propertyName: PROPERTY_NAME,
    businessDate: "2026-01-03",
  }));
}

/** @param {string} name */
async function importFixture(name) {
  const scanned = await scan(name);
  expect(scanned.validation?.ok ?? true).toBe(true);
  const result = await importReport(scanned, {
    sourceFile: name,
    propertyId: PROPERTY,
    propertyName: PROPERTY_NAME,
    businessDate: "2026-01-03",
  });
  return { scanned, result };
}

async function readOwnerState() {
  const [transactions, occupancy, sources, metrics] = await Promise.all([
    db.entities.TransactionLine.filter({ property_id: PROPERTY }),
    db.entities.OccupancyDay.filter({ property_id: PROPERTY }),
    db.entities.SourceDay.filter({ property_id: PROPERTY }),
    db.entities.HotelMetric.filter({ property_id: PROPERTY }),
  ]);
  return { transactions, occupancy, sources, metrics };
}

function ownerOracle(state) {
  const txn = summarize(state.transactions);
  const snapshot = snapshotFor(state.metrics);
  const statistics = revenueSplit(snapshot.rows, "ytd");
  const roomRevenueCents = sumCents(state.occupancy.map((row) => row.room_revenue));
  const directRevenueCents = sumCents(
    state.sources.filter((row) => row.code === "DIR").map((row) => row.net_revenue),
  );
  const otaRevenueCents = sumCents(
    state.sources.filter((row) => row.code !== "DIR").map((row) => row.net_revenue),
  );
  return {
    transactionRevenueCents: toCents(txn.revenue),
    statisticsTotalCents: toCents(statistics.total),
    statisticsRoomCents: toCents(statistics.room),
    statisticsAncillaryCents: toCents(statistics.ancillary),
    roomRevenueCents,
    directRevenueCents,
    otaRevenueCents,
  };
}

beforeEach(async () => {
  await localDb.open();
  await Promise.all(localDb.tables.map((table) => table.clear()));
  storage.clear();

  await db.auth.registerUser({
    username: "golden-owner",
    email: "golden-owner@example.invalid",
    role: "owner",
    permissions: "all",
    property_access: "all",
    is_active: true,
    password: "Password1!",
  });
  await db.auth.login("golden-owner@example.invalid", "Password1!", true);
});

describe("Golden Hotel owner journey — committed synthetic oracle", () => {
  it("parses and imports the four owner-facing revenue reports with no blocked validation", async () => {
    const transaction = await importFixture(FILES.transactions);
    const occupancy = await importFixture(FILES.occupancy);
    const source = await importFixture(FILES.source);
    const statistics = await importFixture(FILES.statistics);

    expect(transaction.scanned.type).toBe("transactions");
    expect(occupancy.scanned.type).toBe("occupancy");
    expect(source.scanned.type).toBe("source");
    expect(statistics.scanned.type).toBe("hotel_statistics");

    expect(transaction.result.count).toBe(ORACLE.transactionRows);
    expect(occupancy.result.count).toBe(ORACLE.occupancyDays);
    expect(source.result.count).toBe(ORACLE.sourceRows);
    expect(statistics.result.count).toBe(ORACLE.statisticsMetrics);

    const state = await readOwnerState();
    expect(state.transactions).toHaveLength(ORACLE.transactionRows);
    expect(state.occupancy).toHaveLength(ORACLE.occupancyDays);
    expect(state.sources).toHaveLength(ORACLE.sourceRows);
    expect(state.metrics).toHaveLength(ORACLE.statisticsMetrics);
  });

  it("reconciles total revenue and room revenue to exact integer cents", async () => {
    for (const name of Object.values(FILES)) await importFixture(name);

    const state = await readOwnerState();
    const oracle = ownerOracle(state);

    expect(oracle).toEqual({
      transactionRevenueCents: ORACLE.totalRevenueCents,
      statisticsTotalCents: ORACLE.totalRevenueCents,
      statisticsRoomCents: ORACLE.roomRevenueCents,
      statisticsAncillaryCents: ORACLE.ancillaryRevenueCents,
      roomRevenueCents: ORACLE.roomRevenueCents,
      directRevenueCents: ORACLE.directRevenueCents,
      otaRevenueCents: ORACLE.otaRevenueCents,
    });
    expect(oracle.statisticsRoomCents + oracle.statisticsAncillaryCents)
      .toBe(oracle.statisticsTotalCents);
    expect(oracle.directRevenueCents + oracle.otaRevenueCents)
      .toBe(oracle.roomRevenueCents);

    const { grossRevenue, reconciliation } = await reconcileRevenuePaths(
      "golden-hotel-2026-ytd",
      state.transactions,
      state.metrics,
      state.occupancy,
      { statisticsPeriod: "ytd" },
    );

    expect(toCents(grossRevenue)).toBe(ORACLE.totalRevenueCents);
    expect(reconciliation.reconciliation_status).toBe("PASS");
    expect(reconciliation.all_paths_match).toBe(true);
    expect(reconciliation.authoritative_path).toBe("statistics_analytics");
    expect(toCents(reconciliation.authoritative_revenue)).toBe(ORACLE.totalRevenueCents);
  });

  it("survives a database close/reopen with the exact same owner numbers", async () => {
    for (const name of Object.values(FILES)) await importFixture(name);

    const before = ownerOracle(await readOwnerState());
    await localDb.close();
    await localDb.open();
    const after = ownerOracle(await readOwnerState());

    expect(after).toEqual(before);
    expect(after.transactionRevenueCents).toBe(ORACLE.totalRevenueCents);
    expect(after.roomRevenueCents).toBe(ORACLE.roomRevenueCents);
    expect(after.directRevenueCents + after.otaRevenueCents).toBe(ORACLE.roomRevenueCents);
  });

  it("keeps the golden property isolated and carries source/import provenance on every persisted row", async () => {
    for (const name of Object.values(FILES)) await importFixture(name);
    const state = await readOwnerState();

    for (const [entity, rows] of Object.entries(state)) {
      expect(rows.length, entity).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.property_id, entity).toBe(PROPERTY);
        expect(row.property_name, entity).toBe(PROPERTY_NAME);
        expect(row.import_id, entity).toBeTruthy();
        expect(row.source_file, entity).toMatch(/^golden-owner-/);
      }
    }

    expect(await db.entities.TransactionLine.filter({ property_id: "P-OTHER" })).toEqual([]);
    expect(await db.entities.OccupancyDay.filter({ property_id: "P-OTHER" })).toEqual([]);
    expect(await db.entities.SourceDay.filter({ property_id: "P-OTHER" })).toEqual([]);
    expect(await db.entities.HotelMetric.filter({ property_id: "P-OTHER" })).toEqual([]);
  });

  it("produces stable raw and normalized identities for the same committed source", async () => {
    for (const [kind, name] of Object.entries(FILES)) {
      const scanned = await scan(name);
      const rawBytes = new TextEncoder().encode(fixtureText(name));
      const rawHashA = await sha256Hex(rawBytes);
      const rawHashB = await sha256Hex(rawBytes);

      const bundleA = buildNormalizedBundle(scanned, {
        propertyId: PROPERTY,
        propertyName: PROPERTY_NAME,
        sourceFile: name,
      }, `golden-${kind}-bundle`);
      const bundleB = buildNormalizedBundle(scanned, {
        propertyId: PROPERTY,
        propertyName: PROPERTY_NAME,
        sourceFile: name,
      }, `golden-${kind}-bundle`);

      const normalizedA = await computeNormalizedHash(bundleA);
      const normalizedB = await computeNormalizedHash(bundleB);

      expect(rawHashA).toMatch(/^[0-9a-f]{64}$/);
      expect(rawHashB).toBe(rawHashA);
      expect(normalizedA).toMatch(/^[0-9a-f]{64}$/);
      expect(normalizedB).toBe(normalizedA);
      expect(bundleA.totalRowCount).toBe(bundleB.totalRowCount);
      expect(bundleA.entityCounts).toEqual(bundleB.entityCounts);
      expect(bundleA.minDate).toBe(bundleB.minDate);
      expect(bundleA.maxDate).toBe(bundleB.maxDate);
    }
  });
});
