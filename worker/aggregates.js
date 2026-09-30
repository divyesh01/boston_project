// worker/aggregates.js
// Server-authoritative daily aggregate summaries for fast-path owner intelligence rendering.
// Enables dashboard headline KPIs, occupancy, ADR, RevPAR, and revenue rankings to load in <1s
// without downloading or parsing raw transaction ledgers into client IndexedDB.

import { scopeConstraint } from "./scope.js";
import { queryAll, queryFirst } from "./db.js";
import { typedRecordKey, resolvePropertyKeyFromMappings } from "./business-sync.js";
import { REPORT_ENTITY, normalizedContent, contentHash, parseBundle } from "./bulk-contract.js";
import { isR2S3Enabled, resolveR2S3Stores } from "./r2-s3-adapter.js";

/**
 * Resolve bulk storage store from S3/GCS adapter or Cloudflare R2 binding.
 * @param {any} env
 * @returns {any}
 */
function getStorageStore(env) {
  if (isR2S3Enabled(env)) {
    try {
      const stores = resolveR2S3Stores(env);
      if (stores?.bulkStore) return stores.bulkStore;
    } catch (err) {
      throw new Error(`R2/S3 storage configuration error: ${err?.message || err}`);
    }
  }
  if (env.BULK_DATA && typeof env.BULK_DATA.get === "function") {
    return env.BULK_DATA;
  }
  return null;
}

/**
 * Convert dollars to integer cents safely.
 * @param {number | string | null | undefined} val
 * @returns {number}
 */
function toCents(val) {
  if (val == null || val === "") return 0;
  const num = typeof val === "number" ? val : parseFloat(String(val).replace(/[^0-9.-]/g, ""));
  if (!Number.isFinite(num) || !Number.isSafeInteger(Math.round(num * 100))) throw new Error("Invalid monetary value");
  return Math.round(num * 100);
}

/**
 * Handle /api/aggregates/* routes.
 *
 * @param {Request} request
 * @param {any} env
 * @param {import("./scope.js").Scope} scope
 * @param {URL} url
 * @param {string[]} parts
 * @returns {Promise<Response>}
 */
export async function handleAggregatesRequest(request, env, scope, url, parts) {
  const action = parts[2] || "daily";

  if (action === "daily" && request.method === "GET") {
    return await getDailySummaries(request, env, scope, url);
  }

  if (action === "rebuild" && request.method === "POST") {
    try {return await rebuildSummariesFromBundles(request, env, scope);}
    catch(error) {return Response.json({error:'Invalid aggregate source; previous summaries preserved',detail:String(error?.message || error)},{status:422});}
  }

  return Response.json({ error: "not found" }, { status: 404 });
}

/**
 * GET /api/aggregates/daily?property_id=...&from=...&to=...
 */
async function getDailySummaries(request, env, scope, url) {
  const reqProp = url.searchParams.get("property_id") || "all";
  const from = url.searchParams.get("from") || "";
  const to = url.searchParams.get("to") || "";

  // Scope validation: fail closed if user does not have access to requested property
  const c = scopeConstraint(scope, "property_id");
  let propSql = c.sql;
  let params = [...c.params];

  if (reqProp && reqProp !== "all") {
    const requested = Array.isArray(reqProp) ? reqProp : reqProp.split(",").filter(Boolean);
    if (!scope.all) {
      const allowed = new Set(scope.propertyIds.map(String));
      const hasUnauthorized = requested.some((p) => !allowed.has(String(p)));
      if (hasUnauthorized) {
        return Response.json({ error: "forbidden: property access denied" }, { status: 403 });
      }
    }
    const placeholders = requested.map(() => "?").join(",");
    propSql = `property_id IN (${placeholders})`;
    params = [...requested];
  }

  let dateSql = "";
  const dateParams = [];
  if (from) {
    dateSql += " AND business_date >= ?";
    dateParams.push(from.slice(0, 10));
  }
  if (to) {
    dateSql += " AND business_date <= ?";
    dateParams.push(to.slice(0, 10));
  }

  const sql = `
    SELECT id, property_id, business_date,
           room_revenue_cents, ancillary_revenue_cents, total_revenue_cents,
           rooms_sold, available_rooms, adr_cents, occupancy_rate, revpar_cents,
           gross_ota_revenue_cents, direct_revenue_cents, ota_commission_cents,
           refund_cents, payment_total_cents, channel_summary_json,
           data_health_score, source_manifest_revision, updated_at
      FROM property_day_summary
     WHERE account_id = ?
       AND ${propSql}
       ${dateSql}
     ORDER BY business_date ASC, property_id ASC
  `;

  const rows = await queryAll(env, sql, [scope.accountId, ...params, ...dateParams]);

  const currentSnapshot = await queryFirst(env, "SELECT revision FROM business_sync_state WHERE account_id=?", [scope.accountId]);
  const stale = rows.some(row => Number(row.source_manifest_revision) !== (Number(currentSnapshot?.revision)||0));
  // Reject summaries from an older ledger snapshot.
  if (rows && rows.length > 0 && !stale) {
    return Response.json({
      ok: true,
      summaries: rows,
      count: rows.length,
      source: "property_day_summary",
    }, { status: 200 });
  }

  // Fallback: check if D1 daily_financial_aggregate has historical rows
  const dfaSql = `
    SELECT id, property_id, business_date, total_revenue, room_revenue, other_revenue,
           payments_total, expenses_total, created_date
      FROM daily_financial_aggregate
     WHERE property_id IN (SELECT id FROM property WHERE account_id = ?)
       AND ${propSql}
       ${dateSql}
     ORDER BY business_date ASC
  `;
  const dfaRows = await queryAll(env, dfaSql, [scope.accountId, ...params, ...dateParams]);

  if (dfaRows && dfaRows.length > 0) {
    const converted = dfaRows.map((r) => {
      const roomCents = toCents(r.room_revenue);
      const totalCents = toCents(r.total_revenue) || roomCents;
      const otherCents = toCents(r.other_revenue) || Math.max(0, totalCents - roomCents);
      return {
        id: `${scope.accountId}:${r.property_id}:${r.business_date}`,
        property_id: r.property_id,
        business_date: r.business_date,
        room_revenue_cents: roomCents,
        ancillary_revenue_cents: otherCents,
        total_revenue_cents: totalCents,
        rooms_sold: 0,
        available_rooms: 0,
        adr_cents: 0,
        occupancy_rate: 0,
        revpar_cents: 0,
        gross_ota_revenue_cents: 0,
        direct_revenue_cents: 0,
        ota_commission_cents: 0,
        refund_cents: 0,
        payment_total_cents: toCents(r.payments_total),
        channel_summary_json: "{}",
        data_health_score: 0,
        source_manifest_revision: 0,
        updated_at: r.created_date || new Date().toISOString(),
      };
    });

    return Response.json({
      ok: true,
      summaries: converted,
      count: converted.length,
      source: "daily_financial_aggregate",
    }, { status: 200 });
  }

  return Response.json({
    ok: true,
    summaries: [],
    count: 0,
    source: "empty",
  }, { status: 200 });
}

/**
 * POST /api/aggregates/rebuild
 * Rebuilds property_day_summary table from active bulk manifests.
 */
async function rebuildSummariesFromBundles(request, env, scope) {
  const role = String(scope.user?.role || "").toLowerCase();
  if (!["owner", "admin", "gm", "manager"].includes(role)) {
    return Response.json({ error: "forbidden: insufficient permissions to rebuild aggregates" }, { status: 403 });
  }

  // R03: Capability check: GM and manager must have explicit permissions
  let permissions = {};
  try {
    permissions = scope.user?.permissions ? JSON.parse(String(scope.user.permissions)) : {};
  } catch {}
  if (["gm", "manager"].includes(role) && permissions.import_reports !== true) {
    return Response.json({ error: "forbidden: maintenance capability required to rebuild aggregates" }, { status: 403 });
  }

  // R03: Property scope determination
  let requestedProperty = null;
  if (request.method === "POST") {
    try {
      const body = await request.clone().json();
      if (body && typeof body.property_id === "string") {
        requestedProperty = body.property_id.trim();
      }
    } catch {}
  }
  if (!requestedProperty) {
    try {
      const url = new URL(request.url);
      const qProp = url.searchParams.get("property_id");
      if (qProp) requestedProperty = qProp.trim();
    } catch {}
  }

  let targetPropertyIds = [];
  if (requestedProperty && requestedProperty !== "all") {
    if (!scope.propertyIds.map(String).includes(requestedProperty)) {
      return Response.json({ error: `forbidden: property ${requestedProperty} is outside caller scope` }, { status: 403 });
    }
    targetPropertyIds = [requestedProperty];
  } else {
    // Account-wide rebuild requires portfolio-wide access
    if (!scope.all) {
      return Response.json({ error: "forbidden: account-wide aggregate rebuild requires portfolio scope" }, { status: 403 });
    }
    targetPropertyIds = Array.isArray(scope.propertyIds) ? [...scope.propertyIds] : [];
  }

  if (!targetPropertyIds.length) {
    return Response.json({ error: "forbidden: no authorized properties in scope" }, { status: 403 });
  }

  // R04: Resolve storage using consistent storage abstraction (GCS S3-compatible or Cloudflare R2)
  let bulkStore;
  try {
    bulkStore = getStorageStore(env);
  } catch (err) {
    return Response.json({ error: `storage unavailable: ${err.message}` }, { status: 503 });
  }
  if (!bulkStore) {
    return Response.json({ error: "storage binding unavailable: BULK_DATA or S3 storage unconfigured" }, { status: 503 });
  }

  const snapshot = await queryFirst(env, "SELECT revision FROM business_sync_state WHERE account_id=?", [scope.accountId]);
  const pointer = await queryFirst(env, "SELECT active_generation_id FROM business_dataset_pointer WHERE account_id=?", [scope.accountId]);
  const mappings = pointer?.active_generation_id ? await queryAll(env, "SELECT property_key,server_property_id FROM business_property_map WHERE account_id=? AND generation_id=?", [scope.accountId, pointer.active_generation_id]) : [];
  const aliases = new Map();
  for (const m of mappings) {
    const key = String(m.property_key);
    const value = key.startsWith('n:') ? Number(key.slice(2)) : key.slice(key.indexOf(':', 2) + 1);
    try {
      if (typedRecordKey(value) !== key) continue;
      const canonical = resolvePropertyKeyFromMappings(mappings, key);
      if (!targetPropertyIds.includes(canonical)) continue;
      const values = aliases.get(canonical) || [];
      values.push(value);
      if (resolvePropertyKeyFromMappings(mappings, typedRecordKey(String(value))) === canonical) values.push(String(value));
      aliases.set(canonical, values);
    } catch { /* Ambiguous mappings confer no access. */ }
  }
  // R03: Query active manifests ONLY for the authorized properties
  const placeholders = targetPropertyIds.map(() => "?").join(",");
  const activeManifests = await queryAll(
    env,
    `SELECT id, server_property_id, report_type, object_key, normalized_object_key,
            min_date, max_date, revision, normalized_hash, identity_version, row_count
       FROM import_bundle_manifest
      WHERE account_id = ?
        AND server_property_id IN (${placeholders})
        AND status = 'active'
        AND report_type IN ('occupancy', 'gross_revenue', 'source', 'payments', 'adjustments_refunds')
      ORDER BY revision ASC`,
    [scope.accountId, ...targetPropertyIds],
  );

  /** @type {Map<string, Record<string, any>>} */
  const dayBuckets = new Map();

  const getBucket = (propertyId, date) => {
    const key = `${propertyId}:${date}`;
    if (!dayBuckets.has(key)) {
      dayBuckets.set(key, {
        property_id: propertyId,
        business_date: date,
        room_revenue_cents: 0,
        ancillary_revenue_cents: 0,
        total_revenue_cents: 0,
        rooms_sold: 0,
        available_rooms: 0,
        gross_ota_revenue_cents: 0,
        direct_revenue_cents: 0,
        ota_commission_cents: 0,
        refund_cents: 0,
        payment_total_cents: 0,
        channels: Object.create(null),
        tax_fields_present: false,
        taxes: { state_tax_cents: 0, city_tax_cents: 0, other_tax_cents: 0 },
        payments: {},
        ancillary_detail: {},
        reportTypes: new Set(),
        revision: 0,
        gross_room_rent_cents: null,
      });
    }
    return dayBuckets.get(key);
  };

  // R05: Fail closed on corrupt/missing bundles to prevent publishing partial/corrupt summaries
  for (const manifest of activeManifests) {
    const objectKey = manifest.normalized_object_key || manifest.object_key;
    if (!objectKey) {
      return Response.json({
        ok: false,
        error: `manifest ${manifest.id} has no object key`,
        failed_manifest: manifest.id,
      }, { status: 422 });
    }

    let obj;
    try {
      obj = await bulkStore.get(objectKey);
    } catch (getErr) {
      return Response.json({
        ok: false,
        error: `storage read error for manifest ${manifest.id}: ${getErr.message}`,
        failed_manifest: manifest.id,
      }, { status: 502 });
    }

    if (!obj) {
      return Response.json({
        ok: false,
        error: `missing storage bundle object for manifest ${manifest.id}`,
        failed_manifest: manifest.id,
      }, { status: 422 });
    }

    let text;
    try {
      if (obj.size > 16 * 1024 * 1024) throw new Error("Compressed bundle exceeds limit");
      const buffer = await obj.arrayBuffer();
      if (buffer.byteLength > 16 * 1024 * 1024) throw new Error("Compressed bundle exceeds limit");
      const stream = new Response(buffer).body?.pipeThrough(new DecompressionStream("gzip"));
      if (!stream) {
        return Response.json({
          ok: false,
          error: `decompression stream failed for manifest ${manifest.id}`,
          failed_manifest: manifest.id,
        }, { status: 422 });
      }
      const reader = stream.getReader(); const chunks = []; let size = 0;
      try {
        for (;;) { const {done,value} = await reader.read(); if (done) break; size += value.byteLength;
          if (size > 16 * 1024 * 1024) { await reader.cancel(); throw new Error("Decoded bundle exceeds limit"); } chunks.push(value); }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      text = new TextDecoder('utf-8', {fatal:true}).decode(bytes);
    } catch (decompErr) {
      return Response.json({
        ok: false,
        error: `failed to decompress bundle for manifest ${manifest.id}: ${decompErr.message}`,
        failed_manifest: manifest.id,
      }, { status: 422 });
    }

    let parsedItems;
    try {
      parsedItems = parseBundle(text, manifest.server_property_id, aliases.get(manifest.server_property_id) || []);
      if (Number(manifest.row_count) !== parsedItems.length) throw new Error("Manifest row count mismatch");
      if (parsedItems.some(item => item.entity !== REPORT_ENTITY[manifest.report_type])) throw new Error("Manifest entity mismatch");
      const hash = await contentHash(Number(manifest.identity_version) >= 2 ? normalizedContent(parsedItems) : text);
      if (!manifest.normalized_hash || hash !== manifest.normalized_hash) throw new Error("Bundle integrity mismatch");
    } catch (parseErr) {
      return Response.json({
        ok: false,
        error: `failed to parse bundle for manifest ${manifest.id}: ${parseErr.message}`,
        failed_manifest: manifest.id,
      }, { status: 422 });
    }

    for (const item of parsedItems) {
      const row = item.row;
      const date = String(row.date || row.business_date || row.shift_date || "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)) || new Date(date).toISOString().slice(0,10) !== date || (manifest.min_date && date < manifest.min_date) || (manifest.max_date && date > manifest.max_date)) return Response.json({error:"Invalid bundle business date", failed_manifest:manifest.id}, {status:422});

      const b = getBucket(manifest.server_property_id, date);
      b.revision = Math.max(b.revision, Number(manifest.revision) || 0);

      if (item.entity === "OccupancyDay") {
        b.reportTypes.add("occupancy");
        const revCents = toCents(row.room_revenue);
        const sold = Number(row.rooms_sold), capacity = Number(row.total_rooms);
        if (row.rooms_sold == null || row.total_rooms == null || ![sold,capacity].every(n=>Number.isSafeInteger(n)&&n>=0) || sold>capacity) return Response.json({error:"Invalid room counts"},{status:422});
        b.room_revenue_cents += revCents; b.rooms_sold += sold; b.available_rooms += capacity;
      } else if (item.entity === "GrossRevenueDay") {
        b.reportTypes.add("revenue");
        const rentCents = toCents(row.room_rent);
        b.tax_fields_present ||= ["state_tax","city_tax","other_tax"].some(key=>row[key] != null);
        b.gross_room_rent_cents = (b.gross_room_rent_cents ?? 0) + rentCents;
        for (const field of ["misc_charge","system_charge","food","event","bar","laundry","phone","other","beverage"]) {
          const cents = toCents(row[field]); b.ancillary_detail[field + "_cents"] = (b.ancillary_detail[field + "_cents"] || 0) + cents; b.ancillary_revenue_cents += cents;
        }
        for (const field of ["state_tax","city_tax","other_tax"]) b.taxes[field + "_cents"] += toCents(row[field]);
      } else if (item.entity === "SourceDay") {
        b.reportTypes.add("source");
        const netCents = toCents(row.net_revenue);
        const stays = Number(row.stays);
        if (!Number.isSafeInteger(stays) || stays < 0) return Response.json({error:"Invalid source stays"},{status:422});
        const ch = String(row.source || row.code || "Direct");
        if (!b.channels[ch]) {
          b.channels[ch] = { net: 0, stays: 0 };
        }
        b.channels[ch].net += netCents;
        b.channels[ch].stays += stays;

        const isOta = /expedia|booking|agoda|priceline|airbnb|hotels\.com|ota/i.test(ch);
        if (isOta) {
          b.gross_ota_revenue_cents += netCents;
          // Commission rates are property-specific client configuration; never invent a server rate.
        } else {
          b.direct_revenue_cents += netCents;
        }
      } else if (item.entity === "PaymentDay") {
        b.reportTypes.add("payment");
        b.payment_total_cents += toCents(row.total);
        // Track payment method splits (R06)
        for (const f of ["cash", "visa", "master", "amex", "discover", "check", "direct_bill", "corpay", "wire_transfer", "loyalty_certificate", "loyalty_discount", "vip_pass", "other", "closed_balance_folio"]) {
          if (row[f] != null) {
            b.payments[f] = (b.payments[f] || 0) + toCents(row[f]);
          }
        }
      } else if (item.entity === "AdjustmentRefund") {
        b.refund_cents += Math.abs(toCents(row.amount));
      }
    }
  }

  // A single D1 batch is transactional. Never publish deletion and replacement separately.
  const deleteStmts = targetPropertyIds.map(propId => env.DB.prepare("DELETE FROM property_day_summary WHERE account_id=? AND property_id=?").bind(scope.accountId, propId));
  // Upsert statement
  const now = new Date().toISOString();
  const upsertStmt = env.DB.prepare(`
    INSERT INTO property_day_summary (
      id, account_id, property_id, business_date,
      room_revenue_cents, ancillary_revenue_cents, total_revenue_cents,
      rooms_sold, available_rooms, adr_cents, occupancy_rate, revpar_cents,
      gross_ota_revenue_cents, direct_revenue_cents, ota_commission_cents,
      refund_cents, payment_total_cents, channel_summary_json,
      data_health_score, source_manifest_revision, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, property_id, business_date) DO UPDATE SET
      room_revenue_cents = excluded.room_revenue_cents,
      ancillary_revenue_cents = excluded.ancillary_revenue_cents,
      total_revenue_cents = excluded.total_revenue_cents,
      rooms_sold = excluded.rooms_sold,
      available_rooms = excluded.available_rooms,
      adr_cents = excluded.adr_cents,
      occupancy_rate = excluded.occupancy_rate,
      revpar_cents = excluded.revpar_cents,
      gross_ota_revenue_cents = excluded.gross_ota_revenue_cents,
      direct_revenue_cents = excluded.direct_revenue_cents,
      ota_commission_cents = excluded.ota_commission_cents,
      refund_cents = excluded.refund_cents,
      payment_total_cents = excluded.payment_total_cents,
      channel_summary_json = excluded.channel_summary_json,
      data_health_score = excluded.data_health_score,
      source_manifest_revision = excluded.source_manifest_revision,
      updated_at = excluded.updated_at
  `);

  const batch = [...deleteStmts];
  for (const b of dayBuckets.values()) {
    if (!b.reportTypes.has("occupancy")) b.room_revenue_cents = b.gross_room_rent_cents ?? 0;
    if (![b.room_revenue_cents,b.ancillary_revenue_cents,b.rooms_sold,b.available_rooms,b.refund_cents,b.payment_total_cents].every(Number.isSafeInteger)) return Response.json({error:"Aggregate exceeds safe integer range"},{status:422});
    const totalRev = (b.gross_room_rent_cents ?? b.room_revenue_cents) + b.ancillary_revenue_cents;
    const occRate = b.available_rooms > 0 ? (b.rooms_sold / b.available_rooms) : 0;
    const adrCents = b.rooms_sold > 0 ? Math.round(b.room_revenue_cents / b.rooms_sold) : 0;
    const revparCents = b.available_rooms > 0 ? Math.round(b.room_revenue_cents / b.available_rooms) : 0;
    const id = `${scope.accountId}:${b.property_id}:${b.business_date}`;

    // R05: Compute actual health score based on report type completeness (not hardcoded 100)
    const dayHealthScore = Math.round((b.reportTypes.size / 4) * 100);

    // Format channel summary with backwards compatibility:
    // top-level channels mapped to net cents (for existing readers) + extra metadata
    const channelSummary = Object.create(null);
    for (const [ch, data] of Object.entries(b.channels)) {
      channelSummary[ch] = data.net;
    }
    // Also include structured dimensions (R06)
    channelSummary._meta = {
      channelsWithStays: b.channels,
      taxes: b.taxes,
      tax_fields_present:b.tax_fields_present,
      payments: b.payments,
      ancillary: b.ancillary_detail,
      gross_room_rent_cents: b.gross_room_rent_cents,
      coverage: [...b.reportTypes],
      expenses_complete: false,
    };

    batch.push(
      upsertStmt.bind(
        id, scope.accountId, b.property_id, b.business_date,
        b.room_revenue_cents, b.ancillary_revenue_cents, totalRev,
        b.rooms_sold, b.available_rooms, adrCents, occRate, revparCents,
        b.gross_ota_revenue_cents, b.direct_revenue_cents, b.ota_commission_cents,
        b.refund_cents, b.payment_total_cents, JSON.stringify(channelSummary),
        dayHealthScore, Number(snapshot?.revision) || 0, now
      )
    );
  }

  // Bound work before changing authority; callers can split by property, never by publication chunk.
  if (batch.length > 800) return Response.json({error:"Rebuild exceeds atomic statement budget; rebuild one property at a time"},{status:413});
  const guardId = 'aggregates:' + crypto.randomUUID();
  batch.unshift(env.DB.prepare("INSERT INTO business_mutation_guard(account_id,mutation_id,request_hash,ok,created_at) SELECT ?,?,?,CASE WHEN COALESCE((SELECT revision FROM business_sync_state WHERE account_id=?),0)=? AND COALESCE((SELECT active_generation_id FROM business_dataset_pointer WHERE account_id=?),'')=? THEN 1 ELSE 0 END,?").bind(scope.accountId,guardId,guardId,scope.accountId,Number(snapshot?.revision)||0,scope.accountId,pointer?.active_generation_id||'',now));
  for (const prop of targetPropertyIds) {
    batch.unshift(env.DB.prepare("INSERT INTO business_mutation_guard(account_id,mutation_id,request_hash,ok,created_at) SELECT ?,?,?,CASE WHEN EXISTS (SELECT 1 FROM user u JOIN property p ON p.account_id=u.account_id AND p.id=? WHERE u.account_id=? AND u.id=? AND u.is_active=1 AND u.is_locked=0 AND (lower(u.role) IN ('owner','admin') OR (lower(u.role) IN ('gm','manager') AND json_valid(u.permissions) AND json_extract(u.permissions,'$.import_reports')=1)) AND (lower(u.role) IN ('owner','admin','gm') OR u.property_access_mode='all' OR EXISTS (SELECT 1 FROM user_property_access a WHERE a.account_id=u.account_id AND a.user_id=u.id AND a.property_id=p.id))) THEN 1 ELSE 0 END,?").bind(scope.accountId,guardId+':'+prop,guardId,prop,scope.accountId,scope.user.id,now));
  }
  batch.push(env.DB.prepare("DELETE FROM business_mutation_guard WHERE account_id=? AND request_hash=?").bind(scope.accountId,guardId));
  try { await env.DB.batch(batch); }
  catch (error) { return Response.json({error:"Atomic rebuild failed; previous summaries preserved", detail:String(error?.message || error)}, {status:409}); }

  return Response.json({
    ok: true,
    rebuilt_days: dayBuckets.size,
    message: `Successfully aggregated ${dayBuckets.size} property-day summaries`,
  }, { status: 200 });
}
