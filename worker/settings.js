// ===========================================================================
// worker/settings.js — Cloudflare D1 settings sync endpoint
//
// Synchronizes property-scoped and account-global settings (OTA commission
// rates, credit card fees, tax configuration, tax periods, alert thresholds)
// across all browser sessions and devices.
// ===========================================================================

import { queryAll, queryFirst } from "./db.js";

const ALLOWED_SETTING_KEYS = new Set([
  "rri_commission_rates_v2",
  "rri_cc_fee_rate",
  "rri_cc_fee_refunds_v1",
  "rri_tax_config_v1",
  "rri_tax_settings_v2",
  "rri_alert_thresholds_v1",
  "rri_revenue_thresholds_v1",
  "rri_pricing_config_v1",
]);

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });

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
      const rows = await queryAll(
        env,
        `SELECT setting_key, property_id, value_json, revision, updated_at
         FROM app_setting
         WHERE account_id = ?`,
        [accountId]
      );

      const settings = {};
      let maxRevision = 0;
      let latestUpdated = null;

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
        if (Number(row.revision) > maxRevision) maxRevision = Number(row.revision);
        if (!latestUpdated || String(row.updated_at) > latestUpdated) {
          latestUpdated = String(row.updated_at);
        }
      }

      return jsonResponse({
        ok: true,
        settings,
        revision: maxRevision,
        updated_at: latestUpdated,
      });
    } catch (err) {
      console.error("[settings] get error:", err);
      return jsonResponse({ error: err.message || "could not retrieve settings" }, 500);
    }
  }

  // ─── PUT/POST /api/settings ───
  if (request.method === "PUT" || request.method === "POST") {
    const role = String(scope.user?.role || "").toLowerCase();
    if (!["owner", "admin"].includes(role)) {
      return jsonResponse({ error: "forbidden: only owner and admin may modify settings" }, 403);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "invalid JSON body" }, 400);
    }

    const now = new Date().toISOString();
    const updatedBy = scope.user?.id || "unknown";

    const itemsToSave = [];

    if (body.key && body.value !== undefined) {
      if (ALLOWED_SETTING_KEYS.has(body.key)) {
        itemsToSave.push({
          key: body.key,
          value: body.value,
          propertyId: body.property_id || "*",
        });
      }
    } else if (body.settings && typeof body.settings === "object") {
      const propertyId = body.property_id || "*";
      for (const [k, v] of Object.entries(body.settings)) {
        if (ALLOWED_SETTING_KEYS.has(k) && v !== undefined) {
          itemsToSave.push({
            key: k,
            value: v,
            propertyId,
          });
        }
      }
    }

    if (!itemsToSave.length) {
      return jsonResponse({ error: "no valid setting keys provided" }, 400);
    }

    try {
      const stmts = itemsToSave.map((item) => {
        const valJson = JSON.stringify(item.value);
        return env.DB.prepare(`
          INSERT INTO app_setting (account_id, setting_key, property_id, value_json, revision, updated_by, updated_at)
          VALUES (?, ?, ?, ?, 1, ?, ?)
          ON CONFLICT(account_id, setting_key, property_id) DO UPDATE SET
            value_json = excluded.value_json,
            revision = app_setting.revision + 1,
            updated_by = excluded.updated_by,
            updated_at = excluded.updated_at
        `).bind(accountId, item.key, item.propertyId, valJson, updatedBy, now);
      });

      if (env.DB.batch) {
        await env.DB.batch(stmts);
      } else {
        for (const s of stmts) await s.run();
      }

      const revRow = await queryFirst(
        env,
        `SELECT MAX(revision) as max_rev FROM app_setting WHERE account_id = ?`,
        [accountId]
      );
      const revision = revRow?.max_rev || 1;

      return jsonResponse({
        ok: true,
        saved: true,
        count: itemsToSave.length,
        revision,
        updated_at: now,
      });
    } catch (err) {
      console.error("[settings] save error:", err);
      return jsonResponse({ error: err.message || "could not save settings" }, 500);
    }
  }

  return jsonResponse({ error: "method not allowed" }, 405);
}
