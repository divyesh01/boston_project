// ===========================================================================
// worker/settings.js — Cloudflare D1 settings sync endpoint
//
// Synchronizes property-scoped and account-global settings (OTA commission
// rates, credit card fees, tax configuration, tax periods, alert thresholds)
// across all browser sessions and devices.
//
// Optimized for Cloudflare D1 quotas:
// - Conditional HTTP ETag 304 short-circuit (0 D1 reads when unchanged)
// - Compare-And-Swap (CAS) monotonic revision concurrency protection
// - Mathematical input value clamping
// - Immutable app_setting_history audit trail
// ===========================================================================

import { queryAll, queryFirst } from "./db.js";

const ALLOWED_SETTING_KEYS = new Set([
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
]);

const jsonResponse = (body, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders,
    },
  });

function clampSettingValue(key, val) {
  if (key === "rri_cc_fee_rate") {
    const num = Number(val);
    if (isNaN(num)) return 0.03;
    return Math.max(0, Math.min(0.1, num));
  }
  if (key === "rri_cc_fee_refunds_v1") {
    return val === "1" || val === 1 || val === true || val === "true" ? "1" : "0";
  }
  if (key === "rri_commission_rates_v2" && typeof val === "object" && val !== null) {
    const clamped = {};
    for (const [k, v] of Object.entries(val)) {
      if (v && typeof v === "object") {
        const validTypes = ["percentage", "fixed", "actual", "none"];
        const type = validTypes.includes(v.type) ? v.type : "percentage";
        const rateNum = Number(v.rate);
        const rate = isNaN(rateNum) ? 0 : (type === "percentage" ? Math.max(0, Math.min(0.9999, rateNum)) : Math.max(0, rateNum));
        clamped[k] = {
          type,
          rate,
          taxExempt: Boolean(v.taxExempt),
        };
      } else {
        const num = Number(v);
        clamped[k] = {
          type: "percentage",
          rate: isNaN(num) ? 0 : Math.max(0, Math.min(0.9999, num)),
          taxExempt: false,
        };
      }
    }
    return clamped;
  }
  if (key === "rri_tax_config_v1" && typeof val === "object" && val !== null && !Array.isArray(val)) {
    const rateNum = Number(val.taxRate);
    const taxRate = isNaN(rateNum) ? 0.117 : Math.max(0, Math.min(0.35, rateNum));
    const taxEnabled = val.taxEnabled !== undefined ? Boolean(val.taxEnabled) : true;
    let sources = val.sources;
    if (Array.isArray(sources)) {
      sources = sources.map((s) => ({
        key: String(s?.key || "").slice(0, 50),
        label: String(s?.label || s?.key || "").slice(0, 100),
        taxable: Boolean(s?.taxable),
      }));
    }
    return { taxRate, taxEnabled, ...(sources ? { sources } : {}) };
  }
  if (
    (key === "rri_tax_settings_v1" || key === "rri_tax_settings_v2") &&
    Array.isArray(val)
  ) {
    return val.map((row) => ({
      ...row,
      property_id: String(row.property_id || "*"),
      state_rate: Math.max(0, Math.min(0.35, Number(row.state_rate) || 0)),
      city_rate: Math.max(0, Math.min(0.35, Number(row.city_rate) || 0)),
      other_rate: Math.max(0, Math.min(0.35, Number(row.other_rate) || 0)),
      effective_start: String(row.effective_start || "").slice(0, 10),
      effective_end: row.effective_end ? String(row.effective_end).slice(0, 10) : "",
    }));
  }
  if ((key === "rri_alert_thresholds" || key === "rri_alert_thresholds_v1") && typeof val === "object" && val !== null) {
    return {
      revenueDecreasePct: Math.max(0, Math.min(1, Number(val.revenueDecreasePct) || 0.10)),
      occupancyDecreasePoints: Math.max(0, Math.min(1, Number(val.occupancyDecreasePoints) || 0.10)),
      occupancyThreshold: Math.max(0, Math.min(1, Number(val.occupancyThreshold) || 0.60)),
    };
  }
  if ((key === "rri_revenue_thresholds" || key === "rri_revenue_thresholds_v1") && typeof val === "object" && val !== null) {
    return {
      highRevenueThreshold: Math.max(0, Number(val.highRevenueThreshold) || 6000),
      mediumRevenueThreshold: Math.max(0, Number(val.mediumRevenueThreshold) || 3500),
    };
  }
  if ((key === "rri_pricing_config" || key === "rri_pricing_config_v1") && typeof val === "object" && val !== null) {
    return {
      ...val,
      enabled: Boolean(val.enabled !== false),
      minMultiplier: Math.max(0.1, Math.min(2.0, Number(val.minMultiplier) || 0.75)),
      maxMultiplier: Math.max(1.0, Math.min(5.0, Number(val.maxMultiplier) || 1.6)),
    };
  }
  if ((key === "rri_weather_config" || key === "rri_weather_config_v1") && typeof val === "object" && val !== null) {
    return {
      lat: Math.max(-90, Math.min(90, Number(val.lat) || 41.89)),
      lon: Math.max(-180, Math.min(180, Number(val.lon) || -70.91)),
    };
  }
  return val;
}

let tableEnsured = false;

async function ensureSettingsTable(env) {
  if (tableEnsured || !env.DB) return;
  try {
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS app_setting (
        account_id   TEXT NOT NULL,
        setting_key  TEXT NOT NULL,
        property_id  TEXT NOT NULL DEFAULT '*',
        value_json   TEXT NOT NULL,
        revision     INTEGER NOT NULL DEFAULT 1,
        updated_by   TEXT,
        updated_at   TEXT NOT NULL,
        PRIMARY KEY (account_id, setting_key, property_id)
      )
    `).run();

    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS app_setting_history (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id   TEXT NOT NULL,
        setting_key  TEXT NOT NULL,
        property_id  TEXT NOT NULL DEFAULT '*',
        old_value    TEXT,
        new_value    TEXT NOT NULL,
        revision     INTEGER NOT NULL,
        changed_by   TEXT,
        changed_at   TEXT NOT NULL
      )
    `).run();

    tableEnsured = true;
  } catch (e) {
    console.warn("[settings] ensure table:", e?.message);
  }
}

/**
 * @param {Request} request
 * @param {import("./index.js").Env} env
 * @param {import("./scope.js").Scope} scope
 * @param {URL} url
 * @param {string[]} parts
 * @returns {Promise<Response>}
 */
export async function handleSettingsRequest(request, env, scope, url, parts) {
  await ensureSettingsTable(env);

  const accountId = scope.accountId;
  if (!accountId) {
    return jsonResponse({ error: "missing account id" }, 400);
  }

  // ─── GET /api/settings ───
  if (request.method === "GET") {
    try {
      // Scalar metadata query: compute revision & ETag before reading table rows
      const meta = await queryFirst(
        env,
        `SELECT COUNT(1) as total_count, MAX(revision) as max_rev, MAX(updated_at) as latest_updated
         FROM app_setting
         WHERE account_id = ?`,
        [accountId]
      );

      const maxRevision = Number(meta?.max_rev || 0);
      const latestUpdated = meta?.latest_updated ? String(meta.latest_updated) : null;
      const totalCount = Number(meta?.total_count || 0);

      // Edge-level ETag 304 conditional short-circuit: 0 data row reads when unchanged
      const etag = `W/"rev-${maxRevision}-${totalCount}-${latestUpdated ? new Date(latestUpdated).getTime() : 0}"`;
      const clientEtag = request.headers.get("if-none-match");
      if (clientEtag && (clientEtag === etag || clientEtag === etag.replace(/^W\//, ""))) {
        return new Response(null, {
          status: 304,
          headers: {
            ETag: etag,
            "Cache-Control": "private, no-cache, must-revalidate",
            "x-settings-rev": String(maxRevision),
          },
        });
      }

      // Read settings rows only when client has no cached copy or state changed
      const rows = await queryAll(
        env,
        `SELECT setting_key, property_id, value_json, revision, updated_at
         FROM app_setting
         WHERE account_id = ?`,
        [accountId]
      );

      const settings = {};
      for (const row of rows) {
        if (!ALLOWED_SETTING_KEYS.has(row.setting_key)) continue;
        try {
          const parsed = JSON.parse(row.value_json);
          if (row.property_id === "*") {
            settings[row.setting_key] = parsed;
          } else {
            if (!settings._byProperty) settings._byProperty = {};
            if (!settings._byProperty[row.property_id]) settings._byProperty[row.property_id] = {};
            settings._byProperty[row.property_id][row.setting_key] = parsed;
          }
        } catch {
          // Corrupt row ignored
        }
      }

      return new Response(
        JSON.stringify({
          ok: true,
          settings,
          revision: maxRevision,
          updated_at: latestUpdated,
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "X-Content-Type-Options": "nosniff",
            ETag: etag,
            "Cache-Control": "private, no-cache, must-revalidate",
            "x-settings-rev": String(maxRevision),
          },
        }
      );
    } catch (err) {
      console.error("[settings] get error:", err);
      return jsonResponse({ error: err.message || "could not retrieve settings" }, 500);
    }
  }

  // ─── PUT/POST /api/settings ───
  if (request.method === "PUT" || request.method === "POST") {
    const role = String(scope.user?.role || "").toLowerCase();
    const isFullAdmin = ["owner", "admin"].includes(role);

    let userPermissions = {};
    try {
      if (typeof scope.user?.permissions === "string") {
        userPermissions = JSON.parse(scope.user.permissions);
      } else if (typeof scope.user?.permissions === "object" && scope.user?.permissions !== null) {
        userPermissions = scope.user.permissions;
      }
    } catch {}

    const hasSettingPermission = isFullAdmin || Boolean(userPermissions.manage_settings);
    const hasCommissionPermission = isFullAdmin || role === "manager" || Boolean(userPermissions.manage_ota_commissions);
    const hasPricingPermission = isFullAdmin || role === "manager" || Boolean(userPermissions.manage_pricing);

    if (!hasSettingPermission && !hasCommissionPermission && !hasPricingPermission) {
      return jsonResponse({ error: "forbidden: insufficient permissions to modify settings" }, 403);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "invalid JSON body" }, 400);
    }

    // Compare-And-Swap (CAS) verification: prevent silent overwriting of newer remote revisions
    if (body.expected_revision !== undefined && Number(body.expected_revision) > 0) {
      const currentRevRow = await queryFirst(
        env,
        `SELECT MAX(revision) as max_rev FROM app_setting WHERE account_id = ?`,
        [accountId]
      );
      if (currentRevRow?.max_rev && Number(currentRevRow.max_rev) > Number(body.expected_revision)) {
        return jsonResponse(
          {
            error: "settings conflict: remote version has advanced",
            code: "SETTINGS_CONFLICT",
            server_revision: Number(currentRevRow.max_rev),
          },
          409
        );
      }
    }

    const now = new Date().toISOString();
    const updatedBy = scope.user?.id || "unknown";

    const itemsToSave = [];

    if (Array.isArray(body.items)) {
      for (const item of body.items) {
        if (item && item.key && ALLOWED_SETTING_KEYS.has(item.key) && item.value !== undefined) {
          itemsToSave.push({
            key: item.key,
            value: clampSettingValue(item.key, item.value),
            propertyId: String(item.property_id || item.propertyId || "*"),
          });
        }
      }
    } else if (body.key && body.value !== undefined) {
      if (ALLOWED_SETTING_KEYS.has(body.key)) {
        itemsToSave.push({
          key: body.key,
          value: clampSettingValue(body.key, body.value),
          propertyId: String(body.property_id || "*"),
        });
      }
    } else if (body.settings && typeof body.settings === "object") {
      const defaultPropId = String(body.property_id || "*");
      for (const [k, v] of Object.entries(body.settings)) {
        if (k === "_byProperty" && typeof v === "object" && v !== null) {
          for (const [propId, propSettings] of Object.entries(v)) {
            if (typeof propSettings === "object" && propSettings !== null) {
              for (const [propKey, propVal] of Object.entries(propSettings)) {
                if (ALLOWED_SETTING_KEYS.has(propKey) && propVal !== undefined) {
                  itemsToSave.push({
                    key: propKey,
                    value: clampSettingValue(propKey, propVal),
                    propertyId: String(propId),
                  });
                }
              }
            }
          }
        } else if (ALLOWED_SETTING_KEYS.has(k) && v !== undefined) {
          itemsToSave.push({
            key: k,
            value: clampSettingValue(k, v),
            propertyId: defaultPropId,
          });
        }
      }
    }

    if (!itemsToSave.length) {
      return jsonResponse({ error: "no valid setting keys provided" }, 400);
    }

    // Role-based check on specific keys: managers can adjust commissions/pricing but not tax/system
    if (!hasSettingPermission) {
      const unpermitted = itemsToSave.filter((item) => {
        if (
          ["rri_commission_rates_v2", "rri_cc_fee_rate", "rri_cc_fee_refunds_v1"].includes(item.key) &&
          hasCommissionPermission
        ) {
          return false;
        }
        if (["rri_pricing_config", "rri_pricing_config_v1"].includes(item.key) && hasPricingPermission) {
          return false;
        }
        return true;
      });
      if (unpermitted.length > 0) {
        return jsonResponse(
          { error: `forbidden: role '${role}' cannot modify restricted setting '${unpermitted[0].key}'` },
          403
        );
      }
    }

    try {
      // Look up existing rows for the keys being saved to record old_value and calculate next revision
      const existingRows = await queryAll(
        env,
        `SELECT setting_key, property_id, value_json, revision
         FROM app_setting
         WHERE account_id = ?`,
        [accountId]
      );
      const existingMap = new Map();
      for (const row of existingRows) {
        existingMap.set(`${row.setting_key}::${row.property_id}`, row);
      }

      const historyStmts = [];
      const upsertStmts = [];

      for (const item of itemsToSave) {
        const itemKey = `${item.key}::${item.propertyId}`;
        const existing = existingMap.get(itemKey);
        const oldValue = existing ? existing.value_json : null;
        const nextRev = existing ? Number(existing.revision) + 1 : 1;
        const valJson = JSON.stringify(item.value);

        historyStmts.push(
          env.DB.prepare(`
            INSERT INTO app_setting_history (
              account_id, setting_key, property_id, old_value, new_value, revision, changed_by, changed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(accountId, item.key, item.propertyId, oldValue, valJson, nextRev, updatedBy, now)
        );

        upsertStmts.push(
          env.DB.prepare(`
            INSERT INTO app_setting (account_id, setting_key, property_id, value_json, revision, updated_by, updated_at)
            VALUES (?, ?, ?, ?, 1, ?, ?)
            ON CONFLICT(account_id, setting_key, property_id) DO UPDATE SET
              value_json = excluded.value_json,
              revision = app_setting.revision + 1,
              updated_by = excluded.updated_by,
              updated_at = excluded.updated_at
          `).bind(accountId, item.key, item.propertyId, valJson, updatedBy, now)
        );
      }

      const allStmts = [...historyStmts, ...upsertStmts];
      if (env.DB.batch) {
        await env.DB.batch(allStmts);
      } else {
        for (const s of allStmts) await s.run();
      }

      const revRow = await queryFirst(
        env,
        `SELECT MAX(revision) as max_rev FROM app_setting WHERE account_id = ?`,
        [accountId]
      );
      const revision = revRow?.max_rev || 1;

      const totalRow = await queryFirst(
        env,
        `SELECT COUNT(1) as total_count FROM app_setting WHERE account_id = ?`,
        [accountId]
      );
      const totalCount = Number(totalRow?.total_count || 0);
      const etag = `W/"rev-${revision}-${totalCount}-${new Date(now).getTime()}"`;

      return jsonResponse(
        {
          ok: true,
          saved: true,
          count: itemsToSave.length,
          revision,
          updated_at: now,
        },
        200,
        {
          ETag: etag,
          "x-settings-rev": String(revision),
        }
      );
    } catch (err) {
      console.error("[settings] save error:", err);
      return jsonResponse({ error: err.message || "could not save settings" }, 500);
    }
  }

  return jsonResponse({ error: "method not allowed" }, 405);
}
