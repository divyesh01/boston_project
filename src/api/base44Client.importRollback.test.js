import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";

// Security utils read crypto.subtle; jsdom's crypto may lack it, so pin the
// Node WebCrypto implementation as the harness scripts do. These shims are
// deliberate PARTIAL doubles, so each assignment carries its own `any` cast:
// a Map stands in for `Storage` (no `length`/`key` — nothing under test reads
// them) and `screen` only needs width/height. The casts are scoped to these
// lines so the rest of the file stays fully type-checked.
globalThis.crypto ??= /** @type {any} */ (await import("node:crypto").then((m) => m.webcrypto));
if (!globalThis.crypto?.subtle) globalThis.crypto = /** @type {any} */ (await import("node:crypto").then((m) => m.webcrypto));

// Dexie resolves the IndexedDB API off `window`, so window must be globalThis.
const __store = new Map();
const __storage = {
  getItem: (k) => (__store.has(k) ? __store.get(k) : null),
  setItem: (k, v) => __store.set(k, String(v)),
  removeItem: (k) => __store.delete(k),
  clear: () => __store.clear(),
};
globalThis.localStorage = /** @type {any} */ (__storage);
globalThis.sessionStorage = /** @type {any} */ (__storage);
globalThis.window = /** @type {any} */ (globalThis);
globalThis.screen = /** @type {any} */ ({ width: 1920, height: 1080 });
if (globalThis.navigator === undefined) {
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "test-harness", language: "en-US" },
    configurable: true,
  });
}

const { default: localDb } = await import("@/api/localDb");
const {
  db,
  runInTransaction,
  createImportSession,
  completeImportSession,
  addImportRecordIds,
  rollbackImportSession,
  listImportSessions,
} = await import("@/api/base44Client");

async function importRows(rows) {
  const session = await createImportSession({
    sourceFile: "test.csv",
    propertyId: "P1",
    propertyName: "Test",
    reportType: "occupancy",
  });
  const created = await db.entities.OccupancyDay.bulkCreate(
    rows.map((r) => ({ ...r, property_id: "P1", import_id: session.importId }))
  );
  await addImportRecordIds(session.importId, "OccupancyDay", created.map((r) => r.id), "P1");
  await completeImportSession(session.importId, { OccupancyDay: created.length });
  return session.importId;
}

beforeEach(async () => {
  await localDb.open();
  await Promise.all(localDb.tables.map((t) => t.clear()));
  localStorage.clear();
  sessionStorage.clear();

  // Mock authenticated owner so property isolation proxy permits writes
  await db.auth.registerUser({
    username: "owner",
    email: "owner@test.local",
    role: "owner",
    permissions: "all",
    property_access: "all",
    is_active: true,
    password: "Password1!",
  });
  await db.auth.login("owner@test.local", "Password1!", true);
});

describe("import rollback", () => {
  it("deletes exactly the rows its import created", async () => {
    await importRows([{ date: "2026-02-01", rooms_sold: 20 }]);
    const drop = await importRows([{ date: "2026-02-02", rooms_sold: 21 }]);
    await importRows([{ date: "2026-02-03", rooms_sold: 22 }]);

    const result = await rollbackImportSession(drop);
    const remaining = await localDb.OccupancyDay.toArray();

    expect(result.success).toBe(true);
    expect(result.deletedCount).toBe(1);
    expect(remaining).toHaveLength(2);
    expect(remaining.map((r) => r.import_id)).not.toContain(drop);
  });

  it("is idempotent — a second rollback is a no-op", async () => {
    const imp = await importRows([{ date: "2026-02-04", rooms_sold: 23 }]);

    const first = await rollbackImportSession(imp);
    const second = await rollbackImportSession(imp);

    expect(first.deletedCount).toBe(1);
    expect(second.deletedCount).toBe(0);
    expect(second.alreadyRolledBack).toBe(true);
    expect(await localDb.OccupancyDay.count()).toBe(0);
  });

  it("reports failure rather than success when there is no ledger", async () => {
    const orphan = await createImportSession({
      sourceFile: "no-ledger.csv",
      propertyId: "P1",
      propertyName: "Test",
      reportType: "occupancy",
    });
    await completeImportSession(orphan.importId, { OccupancyDay: 5 });

    const result = await rollbackImportSession(orphan.importId);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/ledger|not found/i);
  });

  it("marks the lifecycle session as rolled_back", async () => {
    const imp = await importRows([{ date: "2026-02-05", rooms_sold: 24 }]);
    await rollbackImportSession(imp);

    const sessions = await listImportSessions();
    const rolled = sessions.find((s) => s.importId === imp);
    expect(rolled?.status).toBe("rolled_back");
    expect(rolled?.rolledBackCount).toBe(1);
  });

  it("commits no partial rows when a mid-import operation throws", async () => {
    let threw = null;
    try {
      await runInTransaction([async () => {
        await db.entities.OccupancyDay.bulkCreate([
          { date: "2026-04-01", property_id: "P1", rooms_sold: 10 },
          { date: "2026-04-02", property_id: "P1", rooms_sold: 11 },
        ]);
        await db.entities.OccupancyDay.bulkCreate([{ date: "2026-04-03", property_id: "P1", rooms_sold: 12 }]);
        throw new Error("simulated mid-import failure");
      }]);
    } catch (e) {
      threw = e;
    }

    expect(threw).not.toBeNull();
    expect(await localDb.OccupancyDay.count()).toBe(0);
  });

  it("never fails the import when lifecycle storage is unavailable", async () => {
    // Regression: the pre-migration secureStore swallowed storage errors
    // (private mode, quota exhaustion, corruption). The plain localStorage
    // replacement must keep that contract — an import must not abort just
    // because the UI lifecycle tracker cannot persist.
    const realSetItem = localStorage.setItem.bind(localStorage);
    localStorage.setItem = () => { throw new Error("QuotaExceededError"); };
    try {
      const session = await createImportSession({
        sourceFile: "quota.csv",
        propertyId: "P1",
        propertyName: "Test",
        reportType: "occupancy",
      });
      expect(session.importId).toBeTruthy();
      expect(session.status).toBe("in_progress");
    } finally {
      localStorage.setItem = realSetItem;
    }
  });
});