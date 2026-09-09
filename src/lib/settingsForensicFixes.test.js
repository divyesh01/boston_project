import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
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
import { getCommissionRates, setCommissionRates } from "./commissionRates";
import { getTaxConfig, setTaxConfig } from "./taxConfig";
import { getTaxSettings, saveTaxSettings, getEffectiveTaxRates } from "./taxSettings";
import { getAlertThresholds, saveAlertThresholds } from "./alertThresholds";
import { getRevenueThresholds, saveRevenueThresholds } from "./revenueThresholds";
import { getPricingConfig, savePricingConfig } from "./pricingSettings";
import { getWeatherConfig, saveWeatherConfig } from "./weatherSettings";

function createMockD1({ existingSettings = [], scalarMeta = null } = {}) {
  const executedStmts = [];
  let batchCalled = false;
  let currentRevision = existingSettings.reduce((max, row) => Math.max(max, Number(row.revision || 0)), 0);
  let currentCount = existingSettings.length;

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
                return scalarMeta || { total_count: currentCount, max_rev: currentRevision, latest_updated: "2026-09-08T00:00:00.000Z" };
              }
              if (sql.includes("SELECT MAX(revision) as max_rev")) {
                return { max_rev: currentRevision };
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
      const history = stmts.filter((s) => s.sql.includes("INSERT INTO app_setting_history"));
      for (const stmt of history) currentRevision = Math.max(currentRevision, Number(stmt.args[5] || 0));
      if (history.length) currentCount = Math.max(currentCount, history.length);
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

    const mockScope = /** @type {any} */ ({ accountId: "acc_test", all: true, propertyIds: ["prop_boston_1"], user: { role: "owner" } });
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
    store["rri_cc_fee_rate"] = "0.035";

    await flushCloudSettingSync();

    // The pending item must NOT be wiped
    expect(getPendingSyncCount()).toBe(1);
    expect(conflictEvent).not.toBeNull();
    expect(conflictEvent?.code).toBe("SETTINGS_CONFLICT");
    expect(conflictEvent?.serverRevision).toBe(5);
    expect(getCurrentServerRev()).toBe(5);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store["rri_cc_fee_rate"]).toBe("0.035");

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
    const mockScope = /** @type {any} */ ({ accountId: "acc_test", all: true, propertyIds: ["prop_boston_1"], user: { id: "user_owner", role: "owner" } });

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
    const managerScope = /** @type {any} */ ({
      accountId: "acc_test",
      all: true,
      propertyIds: ["prop_boston_1"],
      user: { id: "user_mgr", role: "manager", permissions: { manage_ota_commissions: true, manage_pricing: true } },
    });

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

    const strippedManager = /** @type {any} */ ({
      ...managerScope,
      user: { id: "user_mgr", role: "manager", permissions: { manage_ota_commissions: false, manage_pricing: false } },
    });
    const strippedRes = await handleSettingsRequest(allowedReq, mockEnv, strippedManager, new URL(allowedReq.url), ["settings"]);
    expect(strippedRes.status).toBe(403);
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

  // ─── Fix 9: Commission Rates Object Preservation ──────────────────────────
  it("Fix 9: worker preserves commission rate objects { type, rate, taxExempt } without wiping to 0", async () => {
    const { mockDb, executedStmts } = createMockD1({ existingSettings: [] });
    const mockEnv = /** @type {any} */ ({ DB: mockDb });
    const mockScope = /** @type {any} */ ({ accountId: "acc_test", all: true, propertyIds: ["prop_boston_1"], user: { id: "user_owner", role: "owner" } });

    const ratePayload = {
      expedia: { type: "percentage", rate: 0.15, taxExempt: false },
      booking: { type: "fixed", rate: 25, taxExempt: true },
      airbnb: 0.14,
      invalid: "not-a-number",
    };

    const req = new Request("https://example.com/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        key: "rri_commission_rates_v2",
        value: ratePayload,
      }),
    });

    const res = await handleSettingsRequest(req, mockEnv, mockScope, new URL(req.url), ["settings"]);
    expect(res.status).toBe(200);

    const upsertStmt = executedStmts.find((s) => s.sql.includes("INSERT INTO app_setting ("));
    expect(upsertStmt).toBeDefined();
    const savedVal = JSON.parse(upsertStmt.args[3]);
    // Verify object format was preserved!
    expect(savedVal.expedia).toEqual({ type: "percentage", rate: 0.15, taxExempt: false });
    expect(savedVal.booking).toEqual({ type: "fixed", rate: 25, taxExempt: true });
    expect(savedVal.airbnb).toEqual({ type: "percentage", rate: 0.14, taxExempt: false });
    expect(savedVal.invalid).toEqual({ type: "percentage", rate: 0, taxExempt: false });
  });

  // ─── Fix 10: Tax Config Object Clamping ─────────────────────────────────────
  it("Fix 10: worker clamps rri_tax_config_v1 object structure correctly", async () => {
    const { mockDb, executedStmts } = createMockD1({ existingSettings: [] });
    const mockEnv = /** @type {any} */ ({ DB: mockDb });
    const mockScope = /** @type {any} */ ({ accountId: "acc_test", all: true, propertyIds: ["prop_boston_1"], user: { id: "user_owner", role: "owner" } });

    const taxConfigPayload = {
      taxRate: 0.1445,
      taxEnabled: true,
      sources: [
        { key: "EXPEDIA_HC", label: "Expedia", taxable: "true" },
        { key: "OTHER_OTA", label: "Other OTA", taxable: "false" },
      ],
      extra: "ignore",
    };

    const req = new Request("https://example.com/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        key: "rri_tax_config_v1",
        value: taxConfigPayload,
      }),
    });

    const res = await handleSettingsRequest(req, mockEnv, mockScope, new URL(req.url), ["settings"]);
    expect(res.status).toBe(200);

    const upsertStmt = executedStmts.find((s) => s.sql.includes("INSERT INTO app_setting ("));
    expect(upsertStmt).toBeDefined();
    const savedVal = JSON.parse(upsertStmt.args[3]);
    expect(savedVal.taxRate).toBe(0.1445);
    expect(savedVal.taxEnabled).toBe(true);
    expect(savedVal.sources).toEqual([
      { key: "EXPEDIA_HC", label: "Expedia", taxable: true },
      { key: "OTHER_OTA", label: "Other OTA", taxable: false },
    ]);
    expect(savedVal.extra).toBeUndefined();
  });

  // ─── Fix 11: Thresholds & Pricing Sync Keys ────────────────────────────────
  it("Fix 11: verifies alert, revenue, pricing, and weather settings are syncable and allowed on worker", async () => {
    const newKeys = [
      "rri_alert_thresholds",
      "rri_alert_thresholds_v1",
      "rri_revenue_thresholds",
      "rri_revenue_thresholds_v1",
      "rri_pricing_config",
      "rri_pricing_config_v1",
      "rri_weather_config",
      "rri_weather_config_v1",
    ];
    for (const k of newKeys) {
      expect(SYNCABLE_SETTING_KEYS.has(k)).toBe(true);
    }

    const { mockDb } = createMockD1({ existingSettings: [] });
    const mockEnv = /** @type {any} */ ({ DB: mockDb });
    const mockScope = /** @type {any} */ ({ accountId: "acc_test", all: true, propertyIds: ["prop_boston_1"], user: { id: "user_owner", role: "owner" } });

    const req = new Request("https://example.com/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        key: "rri_pricing_config",
        value: { minRate: 75, maxRate: 450, targetOccupancy: 80 },
      }),
    });

    const res = await handleSettingsRequest(req, mockEnv, mockScope, new URL(req.url), ["settings"]);
    expect(res.status).toBe(200);
  });

  // ─── Fix 12: ETag on POST response ─────────────────────────────────────────
  it("Fix 12: POST /api/settings returns computed ETag and x-settings-rev in response headers", async () => {
    const { mockDb } = createMockD1({ existingSettings: [] });
    const mockEnv = /** @type {any} */ ({ DB: mockDb });
    const mockScope = /** @type {any} */ ({ accountId: "acc_test", all: true, propertyIds: ["prop_boston_1"], user: { id: "user_owner", role: "owner" } });

    const req = new Request("https://example.com/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        key: "rri_cc_fee_rate",
        value: 0.029,
      }),
    });

    const res = await handleSettingsRequest(req, mockEnv, mockScope, new URL(req.url), ["settings"]);
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toMatch(/^W\/"rev-1-/);
    expect(res.headers.get("x-settings-rev")).toBe("1");
  });

  // ─── Fix 13: Property-scoped isolation ─────────────────────────────────────
  it("Fix 13: property-scoped commission rates and tax configs isolate by propertyId and fall back to global", () => {
    // Set global commission rate
    setCommissionRates({ expedia: { type: "percentage", rate: 0.15 } }, "*");
    expect(getCommissionRates("*").expedia.rate).toBe(0.15);

    // Set property-specific override
    setCommissionRates({ expedia: { type: "percentage", rate: 0.18 } }, "prop_east_boston");
    expect(getCommissionRates("prop_east_boston").expedia.rate).toBe(0.18);
    // Global remains untouched
    expect(getCommissionRates("*").expedia.rate).toBe(0.15);
    // Other property falls back to global
    expect(getCommissionRates("prop_other").expedia.rate).toBe(0.15);

    // Tax config property scoping
    setTaxConfig({ taxRate: 0.12, taxEnabled: true, sources: {} }, "*");
    setTaxConfig({ taxRate: 0.1445, taxEnabled: true, sources: {} }, "prop_downtown");
    expect(getTaxConfig("*").taxRate).toBe(0.12);
    expect(getTaxConfig("prop_downtown").taxRate).toBe(0.1445);
    expect(getTaxConfig("prop_other").taxRate).toBe(0.12);
  });

  // ─── Fix 14: Effective tax rates resolution ────────────────────────────────
  it("Fix 14: getEffectiveTaxRates resolves property-scoped overrides before falling back to global", () => {
    saveTaxSettings([
      { property_id: "*", state_rate: 0.057, city_rate: 0.06, other_rate: 0.0275 },
      { property_id: "prop_special", state_rate: 0.05, city_rate: 0.05, other_rate: 0.01 },
    ], "*");

    const globalRates = getEffectiveTaxRates("*");
    const globalTotal = globalRates.state + globalRates.city + globalRates.other;
    expect(globalTotal).toBeCloseTo(0.1445, 4);

    const specialRates = getEffectiveTaxRates("prop_special");
    const specialTotal = specialRates.state + specialRates.city + specialRates.other;
    expect(specialTotal).toBeCloseTo(0.11, 4);

    const fallbackRates = getEffectiveTaxRates("prop_unknown");
    const fallbackTotal = fallbackRates.state + fallbackRates.city + fallbackRates.other;
    expect(fallbackTotal).toBeCloseTo(0.1445, 4);
  });

  // ─── Fix 15: pullRemoteSettings alias mapping ──────────────────────────────
  it("Fix 15: pullRemoteSettings maps server _v1 keys to clean local keys", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ ETag: 'W/"rev-20-100"', "x-settings-rev": "20" }),
      json: async () => ({
        ok: true,
        settings: {
          rri_alert_thresholds_v1: { occupancy_drop_pct: 20 },
          rri_pricing_config_v1: { minRate: 80 },
        },
      }),
    });

    const pulled = await pullRemoteSettings(true);
    expect(pulled).toBe(true);

    const alertLocal = readJsonSetting("rri_alert_thresholds");
    expect(alertLocal).toEqual({ occupancy_drop_pct: 20 });
    const pricingLocal = readJsonSetting("rri_pricing_config");
    expect(pricingLocal).toEqual({ minRate: 80 });
  });

  // ─── Fix 16: Module saves trigger bus notification ─────────────────────────
  it("Fix 16: saves to threshold and pricing modules trigger settingsBus notifications", async () => {
    let busNotified = 0;
    const unsub = subscribeSettingsChange(() => {
      busNotified += 1;
    });

    saveAlertThresholds({ occupancy_drop_pct: 25 }, "prop_1");
    saveRevenueThresholds({ daily_revenue_target: 5000 }, "prop_1");
    savePricingConfig({ minRate: 90 }, "prop_1");
    saveWeatherConfig({ enabled: true }, "prop_1");

    await Promise.resolve();
    expect(busNotified).toBeGreaterThan(0);
    unsub();
  });

  it("rejects manager portfolio and cross-property writes while honoring explicit scoped permission", async () => {
    const { mockDb } = createMockD1();
    const mockEnv = /** @type {any} */ ({ DB: mockDb });
    const managerScope = /** @type {any} */ ({
      accountId: "acc_test",
      all: false,
      propertyIds: ["prop_a"],
      user: { id: "user_mgr", role: "manager", permissions: { manage_ota_commissions: true } },
    });
    const save = (propertyId) => handleSettingsRequest(
      new Request("https://example.com/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "rri_cc_fee_rate", value: 0.03, property_id: propertyId }),
      }),
      mockEnv,
      managerScope,
      new URL("https://example.com/api/settings"),
      ["settings"]
    );

    expect((await save("prop_a")).status).toBe(200);
    expect((await save("prop_b")).status).toBe(403);
    expect((await save("*")).status).toBe(403);
  });

  it("advances one global revision so a stale write to a lower-revision key conflicts", async () => {
    const { mockDb } = createMockD1();
    const mockEnv = /** @type {any} */ ({ DB: mockDb });
    const ownerScope = /** @type {any} */ ({ accountId: "acc_test", all: true, propertyIds: ["prop_a"], user: { id: "owner", role: "owner" } });
    const save = (key, value, expectedRevision) => handleSettingsRequest(
      new Request("https://example.com/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key, value, ...(expectedRevision === undefined ? {} : { expected_revision: expectedRevision }) }),
      }),
      mockEnv,
      ownerScope,
      new URL("https://example.com/api/settings"),
      ["settings"]
    );

    expect((await save("rri_cc_fee_rate", 0.03)).headers.get("x-settings-rev")).toBe("1");
    expect((await save("rri_commission_rates_v2", { expedia: 0.15 }, 1)).headers.get("x-settings-rev")).toBe("2");
    const stale = await save("rri_cc_fee_rate", 0.04, 1);
    expect(stale.status).toBe(409);
    expect((await stale.json()).server_revision).toBe(2);
  });

  it("caps fixed commissions and parses string booleans without turning false into true", async () => {
    const { mockDb, executedStmts } = createMockD1();
    const mockEnv = /** @type {any} */ ({ DB: mockDb });
    const ownerScope = /** @type {any} */ ({ accountId: "acc_test", all: true, propertyIds: [], user: { id: "owner", role: "owner" } });
    const req = new Request("https://example.com/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        key: "rri_commission_rates_v2",
        value: { booking: { type: "fixed", rate: 50000, taxExempt: "false" } },
      }),
    });
    expect((await handleSettingsRequest(req, mockEnv, ownerScope, new URL(req.url), ["settings"])).status).toBe(200);
    const upsert = executedStmts.find((s) => s.sql.includes("INSERT INTO app_setting ("));
    expect(JSON.parse(upsert.args[3]).booking).toEqual({ type: "fixed", rate: 10000, taxExempt: false });
  });

  it("mirrors aliases inside property-scoped settings pulled from the server", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ ETag: 'W/"rev-21-1"', "x-settings-rev": "21" }),
      json: async () => ({
        ok: true,
        settings: { _byProperty: { prop_a: { rri_pricing_config_v1: { minRate: 88 } } } },
      }),
    });
    expect(await pullRemoteSettings(true)).toBe(true);
    const byProperty = JSON.parse(store.rri_settings_by_property);
    expect(byProperty.prop_a.rri_pricing_config).toEqual({ minRate: 88 });
    expect(byProperty.prop_a.rri_pricing_config_v1).toEqual({ minRate: 88 });
  });

  it("keeps mount and remote-update suppression active until after every auto-save effect", () => {
    const source = readFileSync(path.join(process.cwd(), "src/pages/Settings.jsx"), "utf8");
    const lastAutoSave = source.indexOf("saveTaxSettings(clean);");
    const disarm = source.indexOf("isInitialMount.current = false;");
    expect(lastAutoSave).toBeGreaterThan(0);
    expect(disarm).toBeGreaterThan(lastAutoSave);
    expect(source).toContain("setRemoteSyncEpoch((epoch) => epoch + 1)");
    expect(source).not.toContain("queueMicrotask(() => {\n          isRemoteUpdate.current = false");
  });
});
