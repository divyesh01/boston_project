import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  writeRawSetting,
  readRawSetting,
  writeJsonSetting,
  readJsonSetting,
  pullRemoteSettings,
  flushCloudSettingSync,
  SYNCABLE_SETTING_KEYS,
} from "./settingsStore";
import { subscribeSettingsChange } from "./settingsBus";

describe("settingsStore cloud sync and persistence", () => {
  let store = {};
  let fetchMock = vi.fn();

  beforeEach(() => {
    store = {};
    fetchMock = vi.fn();
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
    vi.restoreAllMocks();
  });

  it("identifies commission, tax, and fee keys as syncable", () => {
    expect(SYNCABLE_SETTING_KEYS.has("rri_commission_rates_v2")).toBe(true);
    expect(SYNCABLE_SETTING_KEYS.has("rri_cc_fee_rate")).toBe(true);
    expect(SYNCABLE_SETTING_KEYS.has("rri_tax_settings_v2")).toBe(true);
    expect(SYNCABLE_SETTING_KEYS.has("rri_tax_config_v1")).toBe(true);
    expect(SYNCABLE_SETTING_KEYS.has("rri_alert_thresholds_v1")).toBe(true);
  });

  it("writes locally and flushes to cloud endpoint", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true }),
    });

    const success = writeJsonSetting("rri_commission_rates_v2", {
      "expedia hotel collect": 0.15,
    });
    expect(success).toBe(true);
    expect(readJsonSetting("rri_commission_rates_v2")).toEqual({
      "expedia hotel collect": 0.15,
    });

    await flushCloudSettingSync();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, req] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/settings");
    expect(req.method).toBe("POST");
    const body = JSON.parse(req.body);
    expect(body.settings["rri_commission_rates_v2"]).toEqual({
      "expedia hotel collect": 0.15,
    });
  });

  it("pulls remote settings and updates local storage when different", async () => {
    let notified = false;
    const unsub = subscribeSettingsChange(() => {
      notified = true;
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        settings: {
          rri_commission_rates_v2: { "booking.com": 0.15 },
          rri_cc_fee_rate: 0.03,
        },
      }),
    });

    const pulled = await pullRemoteSettings(true);
    expect(pulled).toBe(true);
    expect(store["rri_cc_fee_rate"]).toBe("0.03");
    expect(store["rri_commission_rates_v2"]).toBe(
      JSON.stringify({ "booking.com": 0.15 })
    );
    expect(notified).toBe(true);

    unsub();
  });
});
