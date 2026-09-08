import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  writeJsonSetting,
  readJsonSetting,
  queueCloudSettingSync,
  flushCloudSettingSync,
  pullRemoteSettings,
  setEditingSettingsLock,
  isEditingSettingsLocked,
  getPendingSyncCount,
  clearPendingCloudSyncForTest,
  getCurrentServerRev,
  setCurrentServerRev,
  SYNCABLE_SETTING_KEYS,
} from "./settingsStore";
import {
  notifySettingsChanged,
  subscribeSettingsChange,
  subscribeSettingsConflict,
  getSettingsVersion,
} from "./settingsBus";
import { handleSettingsRequest } from "../../worker/settings";

function createMockD1({ existingSettings = [], scalarMeta = null } = {}) {
  const executedStmts = [];
  let batchCalled = false;

  const mockDb = {
    prepare: (sql) => {
      const stmt = {
        sql,
        args: [],
        run: async () => ({ success: true }),
        first: async () => null,
        all: async () => ({ results: [] }),
        bind: (...args) => {
          const bound = {
            sql,
            args,
            run: async () => ({ success: true }),
            all: async () => {
              if (sql.includes("SELECT setting_key, property_id, value_json")) {
                return { results: existingSettings };
              }
              return { results: [] };
            },
            first: async () => {
              if (sql.includes("SELECT COUNT(1) as total_count")) {
                return scalarMeta || { total_count: existingSettings.length, max_rev: 1, latest_updated: "2026-09-08T00:00:00.000Z" };
              }
              if (sql.includes("SELECT MAX(revision) as max_rev")) {
                return { max_rev: 2 };
              }
              return null;
            },
          };
          return bound;
        },
      };
      return stmt;
    },
    batch: async (stmts) => {
      batchCalled = true;
      executedStmts.push(...stmts);
      return stmts.map(() => ({ success: true }));
    },
  };

  return { mockDb, executedStmts, getBatchCalled: () => batchCalled };
}

describe("Settings Forensic Fixes Verification Suite (All 8 Findings)", () => {
  let store = {};
  let fetchMock = vi.fn();

  beforeEach(() => {
    store = {};
    fetchMock = vi.fn();
    clearPendingCloudSyncForTest();
    setEditingSettingsLock(false);
    setCurrentServerRev(0);
    vi.stubGlobal("localStorage", {
      getItem: vi.fn((k) => store[k] ?? null),
      setItem: vi.fn((k, v) => {
        store[k] = String(v);
      }),
      removeItem: vi.fn((k) => {
        delete store[k];
      }),
      clear: vi.fn(() => {
        store = {};
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    clearPendingCloudSyncForTest();
    setEditingSettingsLock(false);
    vi.restoreAllMocks();
  });

  // ─── Fix 1: Tax Key Mismatch ───────────────────────────────────────────────
  it("Fix 1: includes rri_tax_settings_v1 in SYNCABLE_SETTING_KEYS and flushes it to cloud", async () => {
    expect(SYNCABLE_SETTING_KEYS.has("rri_tax_settings_v1")).toBe(true);
    expect(SYNCABLE_SETTING_KEYS.has("rri_tax_settings_v2")).toBe(true);

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, revision: 2 }),
      headers: new Headers(),
    });

    const taxRows = [
      { property_id: "*", state_rate: 0.057, city_rate: 0.06, other_rate: 0.0275 },
    ];
    writeJsonSetting("rri_tax_settings_v1", taxRows);

    expect(readJsonSetting("rri_tax_settings_v1")).toEqual(taxRows);

    await flushCloudSettingSync();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, req] = fetchMock.mock.calls[0];
    const body = JSON.parse(req.body);
    expect(body.settings["rri_tax_settings_v1"]).toEqual(taxRows);
    expect(body.items.some((item) => item.key === "rri_tax_settings_v1")).toBe(true);
  });

  // ─── Fix 2: Edge ETag 304 D1 Read Overhead ──────────────────────────────────
  it("Fix 2: worker short-circuits with 304 without querying table rows when ETag matches", async () => {
    let scalarCalled = false;
    let fullQueryCalled = false;

    const mockEnv = /** @type {any} */ ({
      DB: {
        prepare: (sql) => ({
          run: async () => ({ success: true }),
          first: async () => null,
          all: async () => ({ results: [] }),
          bind: (...args) => ({
            first: async () => {
              if (sql.includes("SELECT COUNT(1) as total_count")) {
                scalarCalled = true;
                return { total_count: 5, max_rev: 12, latest_updated: "2026-09-08T00:00:00.000Z" };
              }
              return null;
            },
            all: async () => {
              if (sql.includes("SELECT setting_key, property_id, value_json")) {
                fullQueryCalled = true;
                return { results: [] };
              }
              return { results: [] };
            },
            run: async () => ({ success: true }),
          }),
        }),
        batch: async (stmts) => stmts.map(() => ({ success: true })),
      },
    });

    const mockScope = /** @type {any} */ ({ accountId: "acc_test", user: { role: "owner" } });
    const matchingEtag = `W/"rev-12-5-${new Date("2026-09-08T00:00:00.000Z").getTime()}"`;

    const request = new Request("https://example.com/api/settings", {
      method: "GET",
      headers: { "If-None-Match": matchingEtag },
    });

    const response = await handleSettingsRequest(request, mockEnv, mockScope, new URL(request.url), ["settings"]);

    expect(response.status).toBe(304);
    expect(response.headers.get("ETag")).toBe(matchingEtag);
    expect(response.headers.get("x-settings-rev")).toBe("12");
    expect(scalarCalled).toBe(true);
    expect(fullQueryCalled).toBe(false); // 0 data rows queried!
  });

  // ─── Fix 3: CAS 409 Silent Local Overwrite ─────────────────────────────────
  it("Fix 3: preserves pending local edits and emits conflict event upon 409 conflict", async () => {
    let conflictEvent = /** @type {any} */ (null);
    const unsub = subscribeSettingsConflict((data) => {
      conflictEvent = data;
    });

    setCurrentServerRev(3);

    fetchMock.mockResolvedValueOnce({
      status: 409,
      ok: false,
      json: async () => ({
        error: "settings conflict",
        code: "SETTINGS_CONFLICT",
        server_revision: 5,
      }),
      headers: new Headers(),
    });

    // Queue a local modification
    queueCloudSettingSync("rri_cc_fee_rate", 0.035);
    expect(getPendingSyncCount()).toBe(1);

    await flushCloudSettingSync();

    // The pending item must NOT be wiped
    expect(getPendingSyncCount()).toBe(1);
    expect(conflictEvent).not.toBeNull();
    expect(conflictEvent?.code).toBe("SETTINGS_CONFLICT");
    expect(conflictEvent?.serverRevision).toBe(5);
    expect(getCurrentServerRev()).toBe(5);

    unsub();
  });

  // ─── Fix 4: Reactivity & Edit Lock ──────────────────────────────────────────
  it("Fix 4: pullRemoteSettings updates storage when unlocked, but respects editing lock", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      headers: new Headers({ ETag: 'W/"rev-7-999"', "x-settings-rev": "7" }),
      json: async () => ({
        ok: true,
        settings: {
          rri_cc_fee_rate: 0.029,
        },
      }),
    });

    // 1. While locked, non-forced pull is blocked
    setEditingSettingsLock(true);
    expect(isEditingSettingsLocked()).toBe(true);
    const lockedResult = await pullRemoteSettings(false);
    expect(lockedResult).toBe(false);
    expect(store["rri_cc_fee_rate"]).toBeUndefined();

    // 2. When unlocked, pull updates storage
    setEditingSettingsLock(false);
    const unlockedResult = await pullRemoteSettings(true);
    expect(unlockedResult).toBe(true);
    expect(store["rri_cc_fee_rate"]).toBe("0.029");
  });

  // ─── Fix 5: Multi-Property Scope Preservation ──────────────────────────────
  it("Fix 5: preserves propertyId in sync payload and parses _byProperty on pull", async () => {
    clearPendingCloudSyncForTest();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, revision: 10 }),
      headers: new Headers(),
    });

    queueCloudSettingSync("rri_commission_rates_v2", { expedia: 0.18 }, "prop_boston_1");
    await flushCloudSettingSync();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, req] = fetchMock.mock.calls[0];
    const body = JSON.parse(req.body);
    const propItem = body.items.find((i) => i.key === "rri_commission_rates_v2");
    expect(propItem).toBeDefined();
    expect(propItem.property_id).toBe("prop_boston_1");
    expect(body.settings._byProperty["prop_boston_1"]["rri_commission_rates_v2"]).toEqual({ expedia: 0.18 });

    // Test pull storing _byProperty
    fetchMock.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ ETag: 'W/"rev-11-100"', "x-settings-rev": "11" }),
      json: async () => ({
        ok: true,
        settings: {
          _byProperty: {
            prop_boston_1: { rri_cc_fee_rate: 0.028 },
          },
        },
      }),
    });

    await pullRemoteSettings(true);
    expect(store["rri_settings_by_property"]).toContain("prop_boston_1");
  });

  // ─── Fix 6: Initial Creation in History & Batching ─────────────────────────
  it("Fix 6: worker logs initial row creation with old_value = null and rev 1 in history", async () => {
    const { mockDb, executedStmts, getBatchCalled } = createMockD1({ existingSettings: [] });
    const mockEnv = /** @type {any} */ ({ DB: mockDb });
    const mockScope = /** @type {any} */ ({ accountId: "acc_test", user: { id: "user_owner", role: "owner" } });

    // Initial insert request (no existing rows in D1)
    const request = new Request("https://example.com/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        key: "rri_cc_fee_rate",
        value: 0.03,
      }),
    });

    const response = await handleSettingsRequest(request, mockEnv, mockScope, new URL(request.url), ["settings"]);
    expect(response.status).toBe(200);
    expect(getBatchCalled()).toBe(true);

    const historyStmt = executedStmts.find((s) => s.sql.includes("INSERT INTO app_setting_history"));
    expect(historyStmt).toBeDefined();
    // args: [accountId, setting_key, property_id, oldValue, valJson, nextRev, updatedBy, now]
    expect(historyStmt.args[0]).toBe("acc_test");
    expect(historyStmt.args[1]).toBe("rri_cc_fee_rate");
    expect(historyStmt.args[2]).toBe("*");
    expect(historyStmt.args[3]).toBeNull(); // old_value must be null for brand new setting!
    expect(historyStmt.args[4]).toBe("0.03");
    expect(historyStmt.args[5]).toBe(1); // revision must start at 1
    expect(historyStmt.args[6]).toBe("user_owner");
  });

  // ─── Fix 7: Granular RBAC for Manager Role ──────────────────────────────────
  it("Fix 7: manager role can update commission rates but is blocked from restricted settings", async () => {
    const { mockDb } = createMockD1({ existingSettings: [] });
    const mockEnv = /** @type {any} */ ({ DB: mockDb });
    const managerScope = /** @type {any} */ ({ accountId: "acc_test", user: { id: "user_mgr", role: "manager" } });

    // 1. Manager updating commission rate -> ALLOWED (200)
    const allowedReq = new Request("https://example.com/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        key: "rri_commission_rates_v2",
        value: { expedia: 0.16 },
      }),
    });
    const allowedRes = await handleSettingsRequest(allowedReq, mockEnv, managerScope, new URL(allowedReq.url), ["settings"]);
    expect(allowedRes.status).toBe(200);

    // 2. Manager updating tax settings -> FORBIDDEN (403)
    const forbiddenReq = new Request("https://example.com/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        key: "rri_tax_settings_v1",
        value: [{ state_rate: 0.057 }],
      }),
    });
    const forbiddenRes = await handleSettingsRequest(forbiddenReq, mockEnv, managerScope, new URL(forbiddenReq.url), ["settings"]);
    expect(forbiddenRes.status).toBe(403);
    const errBody = await forbiddenRes.json();
    expect(errBody.error).toContain("cannot modify restricted setting");
  });

  // ─── Fix 8: Deduplication in settingsBus ────────────────────────────────────
  it("Fix 8: coalesces multiple rapid version bumps and deduplicates BroadcastChannel/storage events", async () => {
    let callCount = 0;
    const unsub = subscribeSettingsChange(() => {
      callCount += 1;
    });

    const initialVer = getSettingsVersion();

    // Simulate 3 rapid consecutive settings writes
    notifySettingsChanged();
    notifySettingsChanged();
    notifySettingsChanged();

    expect(getSettingsVersion()).toBe(initialVer + 3);

    // Await microtask flush
    await Promise.resolve();

    // In microtask queue, listener is called ONCE with latest version
    expect(callCount).toBe(1);

    unsub();
  });
});
