// Browser-storage access for the settings modules, with the failures reported.
//
// WHY THIS FILE EXISTS. Nine settings modules each held their own copy of these
// two shapes (measured 2026-08-24):
//
//     try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || "{}") }; }
//     catch { return { ...DEFAULTS }; }
//
//     try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch {}
//     notifySettingsChanged();
//
// Both swallow. The reader replaces the owner's saved configuration with built-in
// defaults and says nothing; the writer discards the save, returns as if it
// worked, and then announces a change that did not happen — so every widget
// re-reads and gets the OLD value while the page shows its "Saved" affordance.
//
// These keys are not cosmetic. They hold the commission rate per booking source,
// the card-processing fee, the fee-on-refunds switch, the tax rate and the
// per-property tax periods, and every net-revenue and tax figure in the app is
// derived from them (hotel.js `commissionFor`, taxConfig.js `calculateTax`). A
// swallowed write therefore means the owner types a negotiated 22% rate, sees no
// error, and the app keeps billing commission at 15% indefinitely. CLAUDE.md
// section 10: "Report errors loudly, not silently."
//
// One module rather than nine corrected copies, because the thing being fixed IS
// the duplication: the answer to "did the write land" now has exactly one
// definition, and the next settings module added to the app gets it for free.
//
// Continuous Cross-Browser Cloud Sync Enhancements:
// - Cloudflare D1 ETag 304 conditional short-circuit caching (0 D1 reads when unchanged)
// - Input-state editing lock (prevents remote overwriting during active typing)
// - Compare-And-Swap (CAS) expected revision handling
// - Automatic BroadcastChannel cross-tab notifications

const MAX_ECHO = 120;

function describe(err) {
  if (!err) return "unknown error";
  return `${err.name || "Error"}: ${err.message || String(err)}`;
}

function echo(raw) {
  const s = String(raw);
  return s.length > MAX_ECHO ? `${s.slice(0, MAX_ECHO)}… (${s.length} chars total)` : s;
}

function reportFailedRead(key, err) {
  console.error(
    `[settings] could NOT read "${key}" from browser storage (${describe(err)}). ` +
      `Built-in defaults are in effect, so any figure derived from this setting is not ` +
      `using what you configured. Browser storage may be blocked (private browsing).`
  );
}

/**
 * A stored value was found but cannot be used, so defaults were substituted.
 *
 * @param {string} key - the localStorage key, named so the owner can act on it
 * @param {string} reason - what was wrong with the value
 * @param {*} [raw] - the stored text, echoed truncated when supplied
 * @returns {void}
 */
export function reportDiscardedSetting(key, reason, raw) {
  console.error(
    `[settings] the saved value for "${key}" was DISCARDED (${reason}). Built-in ` +
      `defaults are in effect, so any figure derived from this setting is not using ` +
      `what you configured — re-enter it and save.` +
      (raw === undefined ? "" : ` Stored text: ${echo(raw)}`)
  );
}

/**
 * @param {string} key
 * @param {*} err
 * @returns {void}
 */
export function reportFailedWrite(key, err) {
  console.error(
    `[settings] could NOT save "${key}" (${describe(err)}). Nothing was stored, so ` +
      `the previous setting is still in effect and will reappear on reload. Browser ` +
      `storage may be full or blocked (private browsing).`
  );
}

/**
 * Reads a raw string setting. Never throws.
 *
 * @param {string} key
 * @param {*} [fallback] - returned when the key is absent or unreadable
 * @param {string} [propertyId] - property scope
 * @returns {*} the stored string, or `fallback`
 */
export function readRawSetting(key, fallback = null, propertyId = "*") {
  if (propertyId && propertyId !== "*") {
    try {
      const byPropRaw = localStorage.getItem("rri_settings_by_property");
      if (byPropRaw) {
        const byProp = JSON.parse(byPropRaw);
        if (byProp?.[propertyId]?.[key] !== undefined) {
          return String(byProp[propertyId][key]);
        }
      }
    } catch {}
  }
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : raw;
  } catch (err) {
    reportFailedRead(key, err);
    return fallback;
  }
}

/**
 * Reads and parses a JSON setting. Never throws.
 *
 * @param {string} key
 * @param {*} fallback - returned when the key is absent, unreadable or unparseable
 * @param {string} [propertyId] - property scope
 * @returns {*} the parsed value, or `fallback`
 */
export function readJsonSetting(key, fallback, propertyId = "*") {
  if (propertyId && propertyId !== "*") {
    try {
      const byPropRaw = localStorage.getItem("rri_settings_by_property");
      if (byPropRaw) {
        const byProp = JSON.parse(byPropRaw);
        if (byProp?.[propertyId]?.[key] !== undefined) {
          return byProp[propertyId][key];
        }
      }
    } catch {}
  }
  let raw;
  try {
    raw = localStorage.getItem(key);
  } catch (err) {
    reportFailedRead(key, err);
    return fallback;
  }
  if (raw === null || raw === "") return fallback;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    reportDiscardedSetting(key, describe(err), raw);
    return fallback;
  }
  if (parsed === null) {
    reportDiscardedSetting(key, "stored value was null", raw);
    return fallback;
  }
  return parsed;
}

/**
 * Reads a JSON setting that must be a plain object.
 *
 * @param {string} key
 * @param {Object} fallback
 * @param {string} [propertyId] - property scope
 * @returns {Object} the parsed object, or `fallback`
 */
export function readObjectSetting(key, fallback, propertyId = "*") {
  const parsed = readJsonSetting(key, undefined, propertyId);
  if (parsed === undefined) return fallback;
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    reportDiscardedSetting(key, `expected an object, stored value is ${Array.isArray(parsed) ? "a list" : typeof parsed}`);
    return fallback;
  }
  return parsed;
}

import { notifySettingsChanged, notifySettingsConflict } from "./settingsBus.js";

export const SYNCABLE_SETTING_KEYS = Object.freeze(new Set([
  "rri_commission_rates_v2",
  "rri_cc_fee_rate",
  "rri_cc_fee_refunds_v1",
  "rri_tax_config_v1",
  "rri_tax_settings_v1",
  "rri_tax_settings_v2",
  "rri_alert_thresholds",
  "rri_alert_thresholds_v1",
  "rri_revenue_thresholds",
  "rri_revenue_thresholds_v1",
  "rri_pricing_config",
  "rri_pricing_config_v1",
  "rri_weather_config",
  "rri_weather_config_v1",
]));

export const KEY_ALIASES = Object.freeze({
  "rri_alert_thresholds_v1": "rri_alert_thresholds",
  "rri_alert_thresholds": "rri_alert_thresholds_v1",
  "rri_revenue_thresholds_v1": "rri_revenue_thresholds",
  "rri_revenue_thresholds": "rri_revenue_thresholds_v1",
  "rri_pricing_config_v1": "rri_pricing_config",
  "rri_pricing_config": "rri_pricing_config_v1",
  "rri_weather_config_v1": "rri_weather_config",
  "rri_weather_config": "rri_weather_config_v1",
});

let syncTimer = null;
const pendingCloudSync = new Map();
let lastKnownEtag = null;
let currentServerRev = 0;
let isEditingSettings = false;

/**
 * Activate or deactivate the edit lock while user is modifying form fields.
 * Prevents remote background sync from overwriting active keystrokes.
 *
 * @param {boolean} locked
 */
export function setEditingSettingsLock(locked) {
  isEditingSettings = Boolean(locked);
}

export function isEditingSettingsLocked() {
  return isEditingSettings;
}

export function getPendingSyncCount() {
  return pendingCloudSync.size;
}

export function clearPendingCloudSyncForTest() {
  pendingCloudSync.clear();
}

export function getCurrentServerRev() {
  return currentServerRev;
}

export function setCurrentServerRev(rev) {
  currentServerRev = Number(rev) || 0;
}

/**
 * Queue a setting to be saved to Cloudflare D1 in the background.
 * Debounced to batch rapid consecutive changes into a single network call.
 *
 * @param {string} key
 * @param {*} value
 * @param {string} [propertyId]
 */
export function queueCloudSettingSync(key, value, propertyId = "*") {
  if (typeof window === "undefined" || !SYNCABLE_SETTING_KEYS.has(key)) return;

  let val = value;
  if (typeof value === "string") {
    try { val = JSON.parse(value); } catch {}
  }
  const propId = String(propertyId || "*");
  const queueKey = `${key}::${propId}`;
  pendingCloudSync.set(queueKey, { key, value: val, propertyId: propId });

  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(flushCloudSettingSync, 300);
}

function getSettingsUrl() {
  if (typeof window !== "undefined" && window.location?.origin && /^https?:\/\//.test(window.location.origin)) {
    return `${window.location.origin}/api/settings`;
  }
  return "/api/settings";
}

const isTestEnv = () => typeof globalThis !== "undefined" && Boolean(globalThis.process?.env?.NODE_ENV === "test");

/**
 * Immediately flush queued settings to Cloudflare D1.
 * Preserves pending state across network failures and CAS 409 conflicts.
 */
export async function flushCloudSettingSync() {
  if (!pendingCloudSync.size || typeof fetch === "undefined") return;
  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }
  const inFlight = new Map(pendingCloudSync);

  const items = Array.from(inFlight.values()).map((entry) => ({
    key: entry.key,
    value: entry.value,
    property_id: entry.propertyId,
  }));

  const settingsDict = {};
  for (const entry of inFlight.values()) {
    if (entry.propertyId === "*") {
      settingsDict[entry.key] = entry.value;
    } else {
      if (!settingsDict._byProperty) settingsDict._byProperty = {};
      if (!settingsDict._byProperty[entry.propertyId]) settingsDict._byProperty[entry.propertyId] = {};
      settingsDict._byProperty[entry.propertyId][entry.key] = entry.value;
    }
  }

  try {
    const res = await fetch(getSettingsUrl(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items,
        settings: settingsDict,
        expected_revision: currentServerRev || undefined,
      }),
    });

    if (res.status === 409) {
      // Remote version advanced (Compare-And-Swap conflict).
      // Preserve pendingCloudSync so user edits are not lost.
      const conflictData = await res.json().catch(() => ({}));
      const serverRev = Number(conflictData?.server_revision || 0);
      if (serverRev) currentServerRev = serverRev;
      notifySettingsConflict({
        code: "SETTINGS_CONFLICT",
        serverRevision: serverRev,
        pendingKeys: items.map((i) => i.key),
      });
      // Gently pull latest if user isn't actively editing
      pullRemoteSettings(false).catch(() => {});
    } else if (res.ok) {
      // Remove only items from pendingCloudSync that succeeded and were not modified during in-flight
      for (const [k, v] of inFlight.entries()) {
        if (pendingCloudSync.get(k) === v) {
          pendingCloudSync.delete(k);
        }
      }
      const data = await res.json().catch(() => null);
      if (data?.revision) currentServerRev = Number(data.revision);
      const etag = res.headers.get("ETag");
      if (etag) lastKnownEtag = etag;
    } else {
      console.warn("[settings] cloud sync returned status", res.status);
    }
  } catch (err) {
    if (
      !err?.message?.includes("Failed to parse URL") &&
      !err?.message?.includes("fetch failed") &&
      !isTestEnv()
    ) {
      console.warn("[settings] cloud sync network error:", err?.message);
    }
  }
}

let isPullingSettings = false;
let lastPullTs = 0;

/**
 * Pull latest settings from Cloudflare D1 and update local storage if changed.
 * Uses HTTP conditional ETag (If-None-Match) to achieve 0 D1 reads when unchanged.
 *
 * @param {boolean} [force]
 * @returns {Promise<boolean>} true if settings were updated from cloud or already up-to-date (304)
 */
export async function pullRemoteSettings(force = false) {
  if (typeof window === "undefined" || typeof fetch === "undefined") return false;
  if (isEditingSettings && !force) return false;

  const now = Date.now();
  if (!force && now - lastPullTs < 5000) return false;
  if (isPullingSettings) return false;
  isPullingSettings = true;
  lastPullTs = now;

  try {
    const headers = { accept: "application/json" };
    if (lastKnownEtag && !force) {
      headers["If-None-Match"] = lastKnownEtag;
    }

    const res = await fetch(getSettingsUrl(), { headers });

    // Edge 304 Not Modified short-circuit: 0 D1 reads, state is identical
    if (res.status === 304) {
      return true;
    }

    if (!res.ok) return false;

    const etag = res.headers.get("ETag");
    if (etag) lastKnownEtag = etag;

    const rev = res.headers.get("x-settings-rev");
    if (rev) currentServerRev = Number(rev);

    const data = await res.json();
    if (!data || !data.ok || !data.settings) return false;

    let changed = false;
    for (const [key, val] of Object.entries(data.settings)) {
      if (key === "_byProperty") {
        if (typeof val === "object" && val !== null) {
          const prevRaw = localStorage.getItem("rri_settings_by_property");
          const newRaw = JSON.stringify(val);
          if (prevRaw !== newRaw) {
            localStorage.setItem("rri_settings_by_property", newRaw);
            changed = true;
          }
        }
        continue;
      }
      if (!SYNCABLE_SETTING_KEYS.has(key)) continue;
      const currentRaw = localStorage.getItem(key);
      const newRaw = typeof val === "string" ? val : JSON.stringify(val);
      if (currentRaw !== newRaw) {
        localStorage.setItem(key, newRaw);
        changed = true;
      }
      const alias = KEY_ALIASES[key];
      if (alias) {
        const aliasRaw = localStorage.getItem(alias);
        if (aliasRaw !== newRaw) {
          localStorage.setItem(alias, newRaw);
          changed = true;
        }
      }
    }

    if (changed) {
      notifySettingsChanged({ broadcast: true });
    }
    return true;
  } catch (err) {
    if (
      !err?.message?.includes("Failed to parse URL") &&
      !err?.message?.includes("fetch failed") &&
      !isTestEnv()
    ) {
      console.warn("[settings] remote pull failed:", err?.message);
    }
    return false;
  } finally {
    isPullingSettings = false;
  }
}

/**
 * Writes a raw string setting.
 *
 * @param {string} key
 * @param {*} value - coerced with String()
 * @param {string} [propertyId]
 * @returns {boolean} true only if the value is now stored
 */
export function writeRawSetting(key, value, propertyId = "*") {
  try {
    const str = String(value);
    if (propertyId && propertyId !== "*") {
      let byProp = {};
      try {
        const existing = localStorage.getItem("rri_settings_by_property");
        if (existing) byProp = JSON.parse(existing) || {};
      } catch {}
      if (!byProp[propertyId]) byProp[propertyId] = {};
      byProp[propertyId][key] = str;
      localStorage.setItem("rri_settings_by_property", JSON.stringify(byProp));
    } else {
      localStorage.setItem(key, str);
    }
    if (SYNCABLE_SETTING_KEYS.has(key)) {
      queueCloudSettingSync(key, value, propertyId);
    }
    return true;
  } catch (err) {
    reportFailedWrite(key, err);
    return false;
  }
}

/**
 * Serialises and writes a setting.
 *
 * @param {string} key
 * @param {*} value
 * @param {string} [propertyId]
 * @returns {boolean} true only if the value is now stored
 */
export function writeJsonSetting(key, value, propertyId = "*") {
  let text;
  try {
    text = JSON.stringify(value);
  } catch (err) {
    console.error(
      `[settings] "${key}" could not be converted to JSON (${describe(err)}), so ` +
        `nothing was saved. This is a defect in the calling code, not a storage problem.`
    );
    return false;
  }
  if (text === undefined) {
    console.error(
      `[settings] "${key}" was given a value JSON cannot represent, so nothing was saved.`
    );
    return false;
  }
  try {
    if (propertyId && propertyId !== "*") {
      let byProp = {};
      try {
        const existing = localStorage.getItem("rri_settings_by_property");
        if (existing) byProp = JSON.parse(existing) || {};
      } catch {}
      if (!byProp[propertyId]) byProp[propertyId] = {};
      byProp[propertyId][key] = value;
      localStorage.setItem("rri_settings_by_property", JSON.stringify(byProp));
    } else {
      localStorage.setItem(key, text);
    }
    if (SYNCABLE_SETTING_KEYS.has(key)) {
      queueCloudSettingSync(key, value, propertyId);
    }
    return true;
  } catch (err) {
    reportFailedWrite(key, err);
    return false;
  }
}

