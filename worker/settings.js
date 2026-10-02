// ===========================================================================
// worker/settings.js — Cloudflare D1 settings sync endpoint
//
// Synchronizes property-scoped and account-global settings (OTA commission
// rates, credit card fees, tax configuration, tax periods, alert thresholds)
// across all browser sessions and devices.
//
// Optimized for Cloudflare D1 quotas:
// - Conditional HTTP ETag 304 short-circuit (one metadata read; no data-row reads)
// - Compare-And-Swap (CAS) monotonic revision concurrency protection
// - Mathematical input value clamping
// - Immutable app_setting_history audit trail
// ===========================================================================

import { queryAll, queryFirst } from "./db.js";
import { validateEnterpriseProfile, validateEnterpriseTemplates, validatePeriods, ENTERPRISE_PROFILE_KEY, ENTERPRISE_TEMPLATE_KEY, ENTERPRISE_DEFAULT_KEY, SERVICE_STATEMENT_KEY, PROMOTION_KEY, TAX_REMITTANCE_KEY, validateRemittanceRecords, validateServiceStatements } from "../src/lib/enterpriseSchema.js";
import { calculatePromotionStack } from '../src/lib/promotionStacking.js';

const ALLOWED_SETTING_KEYS = new Set([
  ENTERPRISE_PROFILE_KEY, ENTERPRISE_TEMPLATE_KEY, ENTERPRISE_DEFAULT_KEY, SERVICE_STATEMENT_KEY, PROMOTION_KEY, TAX_REMITTANCE_KEY,
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

const SETTING_KEY_ALIASES = Object.freeze({
  rri_alert_thresholds_v1: "rri_alert_thresholds",
  rri_revenue_thresholds_v1: "rri_revenue_thresholds",
  rri_pricing_config_v1: "rri_pricing_config",
  rri_weather_config_v1: "rri_weather_config",
});

const canonicalSettingKey = (key) => SETTING_KEY_ALIASES[key] || key;

async function validateServiceSources(env, scope, propertyId, statements) {
  const allocation = new Map();
  for (const statement of statements) for (const line of statement.lines) {
    const id = String(line.source_id);
    const cur = allocation.get(id) || { hours:0, overtime:0, lines:[], identities:new Set() };
    cur.hours += line.hours; cur.overtime += line.overtime_hours;
    cur.lines.push(line); cur.identities.add(statement.employee_identity);
    allocation.set(id,cur);
  }
  const pointer = await queryFirst(env,'SELECT active_generation_id FROM business_dataset_pointer WHERE account_id = ?',[scope.accountId]);
  if (allocation.size > 200) throw new Error('Archive older service statements before adding more payroll references.');
  const sources = new Map();
  const ids = [...allocation.keys()];
  for (let offset = 0; offset < ids.length; offset += 50) {
    const part = ids.slice(offset,offset+50), placeholders = part.map(()=>'?').join(',');
    if (pointer) {
      const rows = await queryAll(env,`SELECT record_key,row_json FROM business_record WHERE account_id = ? AND generation_id = ? AND entity_name = 'PayrollRun' AND server_property_id = ? AND record_key IN (${placeholders})`,[scope.accountId,pointer.active_generation_id,propertyId,...part]);
      for (const row of rows) sources.set(String(row.record_key),JSON.parse(row.row_json));
    } else {
      const rows = await queryAll(env,`SELECT * FROM payroll_run WHERE property_id = ? AND id IN (${placeholders})`,[propertyId,...part]);
      for (const row of rows) sources.set(String(row.id),row);
    }
  }
  for (const [id, allocated] of allocation) {
    const source = sources.get(id);
    if (!source || !['paid','approved'].includes(source.payroll_status) || source.pay_type !== 'hourly') throw new Error('Statement requires a synced paid or approved hourly payroll source.');
    if (allocated.hours > Number(source.hours) || allocated.overtime > Number(source.overtime_hours || 0) || allocated.identities.size !== 1) throw new Error('Statement allocations exceed the payroll source or conflict on employee identity.');
    if (source.employee_id && ![...allocated.identities].every(identity=>String(identity)===`${propertyId}:${source.employee_id}`)) throw new Error('Statement employee identity does not match its payroll source.');
    if (allocated.lines.some(line=>Math.round(line.rate*100)!==Math.round(Number(source.base_rate)*100) || Math.round(line.overtime_rate*100)!==Math.round(Number(source.overtime_rate || Number(source.base_rate)*1.5)*100))) throw new Error('Statement rates must match the source payroll run.');
  }
}

const jsonResponse = (body, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders,
    },
  });

function strictBoolean(value, fallback = false) {
  if (value === true || value === 1 || value === "1" || value === "true") return true;
  if (value === false || value === 0 || value === "0" || value === "false") return false;
  return fallback;
}

function settingsScopeClause(scope) {
  if (scope.all) return { sql: "1 = 1", params: [] };
  const propertyIds = Array.isArray(scope.propertyIds) ? scope.propertyIds.map(String) : [];
  if (!propertyIds.length) return { sql: "property_id = '*'", params: [] };
  return {
    sql: `(property_id = '*' OR property_id IN (${propertyIds.map(() => "?").join(",")}))`,
    params: propertyIds,
  };
}

function propertyTargetAllowed(scope, propertyId) {
  if (propertyId === "*") return scope.all === true;
  return Array.isArray(scope.propertyIds) && scope.propertyIds.map(String).includes(propertyId);
}

async function settingsDraftScope(scope) {
  let permissions = scope.user?.permissions || {};
  if (typeof permissions === 'string') {
    try { permissions = JSON.parse(permissions); } catch { permissions = {}; }
  }
  const identity = JSON.stringify([
    scope.accountId, scope.user?.id ?? null, String(scope.user?.role || '').toLowerCase(),
    scope.all === true, scope.all ? [] : [...(scope.propertyIds || [])].map(String).sort(),
    Object.entries(permissions || {}).sort(([a], [b]) => a.localeCompare(b)),
  ]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

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
        const rate = isNaN(rateNum) ? 0 : (type === "percentage" ? Math.max(0, Math.min(0.9999, rateNum)) : Math.max(0, Math.min(10000, rateNum)));
        clamped[k] = {
          type,
          rate,
          taxExempt: strictBoolean(v.taxExempt),
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
    const taxEnabled = val.taxEnabled !== undefined ? strictBoolean(val.taxEnabled, true) : true;
    let sources = val.sources;
    if (Array.isArray(sources)) {
      sources = sources.map((s) => ({
        key: String(s?.key || "").slice(0, 50),
        label: String(s?.label || s?.key || "").slice(0, 100),
        taxable: strictBoolean(s?.taxable),
      }));
    } else {
      sources = undefined;
    }
    return { taxRate, taxEnabled, ...(sources ? { sources } : {}) };
  }
  if (
    (key === "rri_tax_settings_v1" || key === "rri_tax_settings_v2") &&
    Array.isArray(val)
  ) {
    return val.map((row) => ({
      ...row,
      property_id: String(row.property_id ?? "*"),
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

const ensuredDatabases = new WeakSet();

async function ensureSettingsTable(env) {
  if (!env.DB) throw new Error("Settings database unavailable");
  if (ensuredDatabases.has(env.DB)) return;
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

    // A write assigns one account-global revision to every item in its batch.
    // This unique guard turns two concurrent writes to the same setting/revision
    // into an atomic conflict instead of a last-writer-wins overwrite.
    await env.DB.prepare(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_app_setting_history_revision_guard
      ON app_setting_history (account_id, setting_key, property_id, revision)
    `).run();

    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS app_setting_write_guard (
      account_id TEXT NOT NULL, request_id TEXT NOT NULL, next_revision INTEGER NOT NULL,
      valid INTEGER NOT NULL CONSTRAINT settings_revision_match CHECK (valid = 1),
      PRIMARY KEY (account_id, request_id)
    )`).run();
    ensuredDatabases.add(env.DB);
  } catch (e) {
    console.warn("[settings] ensure table:", e?.message);
    throw e;
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
  try { await ensureSettingsTable(env); } catch { return jsonResponse({ error: "settings storage unavailable" }, 503); }

  const accountId = scope.accountId;
  if (!accountId) {
    return jsonResponse({ error: "missing account id" }, 400);
  }
  const draftScope = await settingsDraftScope(scope);

  // ─── GET /api/settings ───
  if (request.method === "GET") {
    try {
      const readScope = settingsScopeClause(scope);
      // Scalar metadata query: compute revision & ETag before reading table rows
      const meta = await queryFirst(
        env,
        `SELECT COUNT(1) as total_count, MAX(revision) as max_rev, MAX(updated_at) as latest_updated
         FROM app_setting
         WHERE account_id = ? AND ${readScope.sql}`,
        [accountId, ...readScope.params]
      );

      const maxRevision = Number(meta?.max_rev || 0);
      const latestUpdated = meta?.latest_updated ? String(meta.latest_updated) : null;
      const totalCount = Number(meta?.total_count || 0);

      // Edge-level ETag 304 conditional short-circuit: 0 data row reads when unchanged
      const etag = `W/"scope-${draftScope}-rev-${maxRevision}-${totalCount}-${latestUpdated ? new Date(latestUpdated).getTime() : 0}"`;
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
         WHERE account_id = ? AND ${readScope.sql}
         ORDER BY revision ASC`,
        [accountId, ...readScope.params]
      );

      const settings = {};
      for (const row of rows) {
        if (!ALLOWED_SETTING_KEYS.has(row.setting_key)) continue;
        try {
          let parsed = JSON.parse(row.value_json);
          if (!scope.all && ["rri_tax_settings_v1","rri_tax_settings_v2"].includes(row.setting_key) && Array.isArray(parsed)) parsed = parsed.filter(period => period.property_id == null || ["*", ""].includes(String(period.property_id)) || propertyTargetAllowed(scope, String(period.property_id)));
          const key = canonicalSettingKey(row.setting_key);
          if (row.property_id === "*") {
            settings[key] = parsed;
          } else {
            if (!settings._byProperty) settings._byProperty = {};
            if (!settings._byProperty[row.property_id]) settings._byProperty[row.property_id] = {};
            settings._byProperty[row.property_id][key] = parsed;
          }
        } catch {
          // Corrupt row ignored
        }
      }

      return new Response(
        JSON.stringify({
          ok: true,
          settings,
          draft_scope: draftScope,
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

    const hasSettingPermission = isFullAdmin || userPermissions.manage_settings === true;
    const hasCommissionPermission = isFullAdmin || userPermissions.manage_ota_commissions === true;
    const hasPricingPermission = isFullAdmin || userPermissions.manage_pricing === true;

    if (!hasSettingPermission && !hasCommissionPermission && !hasPricingPermission) {
      return jsonResponse({ error: "forbidden: insufficient permissions to modify settings" }, 403);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "invalid JSON body" }, 400);
    }

    if (!Number.isSafeInteger(body?.expected_revision) || body.expected_revision < 0) {
      return jsonResponse({ error: "expected_revision is required; load settings before saving", code: "SETTINGS_REVISION_REQUIRED" }, 428);
    }
    if (body.draft_scope != null && body.draft_scope !== draftScope) {
      return jsonResponse({ error: 'Settings session scope changed; review the current server settings.', code: 'SETTINGS_SCOPE_CHANGED' }, 409);
    }
    if (JSON.stringify(body).length > 1000000 || (Array.isArray(body.items) && body.items.length > 100)) {
      return jsonResponse({ error: "settings batch too large" }, 413);
    }
    const now = new Date().toISOString();
    const updatedBy = scope.user?.id || "unknown";

    const itemsToSave = [];

    if (Array.isArray(body.items)) {
      for (const item of body.items) {
        if (item && item.key && ALLOWED_SETTING_KEYS.has(item.key) && item.value !== undefined) {
          itemsToSave.push({
            key: canonicalSettingKey(item.key),
            value: clampSettingValue(item.key, item.value),
            propertyId: String(item.property_id ?? item.propertyId ?? "*"),
          });
        }
      }
    } else if (body.key && body.value !== undefined) {
      if (ALLOWED_SETTING_KEYS.has(body.key)) {
        itemsToSave.push({
          key: canonicalSettingKey(body.key),
          value: clampSettingValue(body.key, body.value),
          propertyId: String(body.property_id ?? "*"),
        });
      }
    } else if (body.settings && typeof body.settings === "object") {
      const defaultPropId = String(body.property_id ?? "*");
      for (const [k, v] of Object.entries(body.settings)) {
        if (k === "_byProperty" && typeof v === "object" && v !== null) {
          for (const [propId, propSettings] of Object.entries(v)) {
            if (typeof propSettings === "object" && propSettings !== null) {
              for (const [propKey, propVal] of Object.entries(propSettings)) {
                if (ALLOWED_SETTING_KEYS.has(propKey) && propVal !== undefined) {
                  itemsToSave.push({
                    key: canonicalSettingKey(propKey),
                    value: clampSettingValue(propKey, propVal),
                    propertyId: String(propId),
                  });
                }
              }
            }
          }
        } else if (ALLOWED_SETTING_KEYS.has(k) && v !== undefined) {
          itemsToSave.push({
            key: canonicalSettingKey(k),
            value: clampSettingValue(k, v),
            propertyId: defaultPropId,
          });
        }
      }
    }

    if (!itemsToSave.length) {
      return jsonResponse({ error: "no valid setting keys provided" }, 400);
    }

    // Reject cross-property and implicit portfolio writes before any existence
    // lookup or mutation. Global settings are portfolio-wide and therefore need
    // an all-property scope; property overrides must name an assigned property.
    for (const item of itemsToSave) {
      item.propertyId = String(item.propertyId ?? "*").trim() || "*";
      if (!propertyTargetAllowed(scope, item.propertyId)) {
        return jsonResponse({ error: "forbidden: setting property is outside caller scope" }, 403);
      }
    }

    try {
      for (const item of itemsToSave) {
        if (item.key === ENTERPRISE_PROFILE_KEY) {
          if (item.propertyId === '*') throw new Error('Property profiles require an explicit property.');
          validateEnterpriseProfile(item.value);
        }
        if ([ENTERPRISE_DEFAULT_KEY, ENTERPRISE_TEMPLATE_KEY].includes(item.key) && item.propertyId !== '*') throw new Error('Templates require portfolio scope.');
        if (item.key === ENTERPRISE_DEFAULT_KEY) validatePeriods(item.value);
        if (item.key === ENTERPRISE_TEMPLATE_KEY) validateEnterpriseTemplates(item.value);
        if (['rri_tax_settings_v1', 'rri_tax_settings_v2'].includes(item.key)) {
          for (const row of item.value || []) {
            if (!propertyTargetAllowed(scope, String(row.property_id ?? '*')) || (item.propertyId !== '*' && String(row.property_id) !== item.propertyId)) throw new Error('Tax period property is outside this setting scope.');
          }
        }
        if (item.key === TAX_REMITTANCE_KEY) { if (item.propertyId === '*') throw new Error('Tax evidence needs an explicit property.'); validateRemittanceRecords(item.value); }
        if (item.key === PROMOTION_KEY) {
          if (item.propertyId === '*' || !Array.isArray(item.value?.discounts) || item.value.discounts.length > 20) throw new Error('Invalid property promotion scenario.');
          calculatePromotionStack(item.value);
        }
        if (item.key === SERVICE_STATEMENT_KEY) {
          if (item.propertyId === '*') throw new Error('Service statements require an employer property.');
          validateServiceStatements(item.value);
          for (const row of item.value) {
            if (String(row.employer_property_id) !== item.propertyId || !propertyTargetAllowed(scope, String(row.service_property_id))) throw new Error('Statement property is outside caller scope.');
          }
          await validateServiceSources(env,scope,item.propertyId,item.value);
        }
      }
    } catch (err) { return jsonResponse({ error: err.message }, 400); }

    if (itemsToSave.length > 100) return jsonResponse({ error: "settings batch too large" }, 413);

    // Last value wins inside one request, but duplicate input cannot create two
    // history rows with the same key/revision and trip the concurrency guard.
    const dedupedItems = new Map();
    for (const item of itemsToSave) dedupedItems.set(`${item.key}::${item.propertyId}`, item);
    itemsToSave.splice(0, itemsToSave.length, ...dedupedItems.values());

    // Role-based check on specific keys: managers can adjust commissions/pricing but not tax/system
    if (!hasSettingPermission) {
      const unpermitted = itemsToSave.filter((item) => {
        if (
          ["rri_commission_rates_v2", "rri_cc_fee_rate", "rri_cc_fee_refunds_v1", PROMOTION_KEY].includes(item.key) &&
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
      if (typeof env.DB.batch !== 'function') return jsonResponse({ error: 'Atomic settings writes unavailable' }, 503);
      const writeScope = settingsScopeClause(scope);
      const requestId = crypto.randomUUID();
      // D1 batch is a transaction. The CHECK aborts the ENTIRE batch when a
      // concurrent write advanced the visible snapshot. Allocate the account
      // revision inside that same transaction, not in an earlier JS read.
      const revisionSql = `(SELECT next_revision FROM app_setting_write_guard WHERE account_id = ? AND request_id = ?)`;
      const stmts = [env.DB.prepare(`
        INSERT INTO app_setting_write_guard (account_id, request_id, next_revision, valid)
        VALUES (?, ?,
          (SELECT COALESCE(MAX(revision), 0) + 1 FROM app_setting WHERE account_id = ?),
          CASE WHEN (SELECT COALESCE(MAX(revision), 0) FROM app_setting WHERE account_id = ? AND ${writeScope.sql}) = ? THEN 1 ELSE 0 END)
        RETURNING next_revision
      `).bind(accountId, requestId, accountId, accountId, ...writeScope.params, body.expected_revision)];
      for (const item of itemsToSave) {
        const valJson = JSON.stringify(item.value);
        stmts.push(env.DB.prepare(`
          INSERT INTO app_setting_history (account_id, setting_key, property_id, old_value, new_value, revision, changed_by, changed_at)
          VALUES (?, ?, ?, (SELECT value_json FROM app_setting WHERE account_id = ? AND setting_key = ? AND property_id = ?), ?, ${revisionSql}, ?, ?)
        `).bind(accountId, item.key, item.propertyId, accountId, item.key, item.propertyId, valJson, accountId, requestId, updatedBy, now));
        stmts.push(env.DB.prepare(`
          INSERT INTO app_setting (account_id, setting_key, property_id, value_json, revision, updated_by, updated_at)
          VALUES (?, ?, ?, ?, ${revisionSql}, ?, ?)
          ON CONFLICT(account_id, setting_key, property_id) DO UPDATE SET
            value_json = excluded.value_json, revision = excluded.revision,
            updated_by = excluded.updated_by, updated_at = excluded.updated_at
        `).bind(accountId, item.key, item.propertyId, valJson, accountId, requestId, updatedBy, now));
      }
      stmts.push(env.DB.prepare('DELETE FROM app_setting_write_guard WHERE account_id = ? AND request_id = ?').bind(accountId, requestId));
      const results = /** @type {Array<{results?: Array<{next_revision?: number}>}>} */ (await env.DB.batch(stmts));
      const nextRevision = Number(results[0]?.results?.[0]?.next_revision);
      if (!Number.isSafeInteger(nextRevision)) throw new Error('Missing settings commit revision');
      const revision = nextRevision;

      return jsonResponse(
        {
          ok: true,
          saved: true,
          count: itemsToSave.length,
          revision,
          draft_scope: draftScope,
          updated_at: now,
        },
        200,
        {
          "x-settings-rev": String(revision),
        }
      );
    } catch (err) {
      // The transactional CHECK guard rolls the whole batch back on stale snapshots.
      const latest = await queryFirst(
        env,
        `SELECT MAX(revision) as max_rev FROM app_setting WHERE account_id = ? AND ${settingsScopeClause(scope).sql}`,
        [accountId, ...settingsScopeClause(scope).params]
      ).catch(() => null);
      const latestRevision = Number(latest?.max_rev || 0);
      if (/settings_revision_match/.test([err?.message, err?.cause?.message].join(" "))) {
        return jsonResponse(
          {
            error: "settings conflict: remote version has advanced",
            code: "SETTINGS_CONFLICT",
            server_revision: latestRevision,
          },
          409
        );
      }
      console.error("[settings] save error:", err);
      return jsonResponse({ error: err.message || "could not save settings" }, 500);
    }
  }

  return jsonResponse({ error: "method not allowed" }, 405);
}
