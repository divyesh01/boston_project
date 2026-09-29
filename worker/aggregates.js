// worker/aggregates.js
// Server-authoritative daily aggregate summaries for fast-path owner intelligence rendering.
// Enables dashboard headline KPIs, occupancy, ADR, RevPAR, and revenue rankings to load in <1s
// without downloading or parsing raw transaction ledgers into client IndexedDB.

import { scopeConstraint } from "./scope.js";
import { queryAll, queryFirst } from "./db.js";
import { parseBundle } from "./bulk-contract.js";

/**
 * Convert dollars to integer cents safely.
 * @param {number | string | null | undefined} val
 * @returns {number}
 */
function toCents(val) {
  if (val == null || val === "") return 0;
  const num = typeof val === "number" ? val : parseFloat(String(val).replace(/[^0-9.-]/g, ""));
  if (!Number.isFinite(num)) return 0;
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
    return await rebuildSummariesFromBundles(request, env, scope);
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

  // If table has pre-computed rows, return immediately (1-2 ms path)
  if (rows && rows.length > 0) {
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
        data_health_score: 100,
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

  if (!env.BULK_DATA) {
    return Response.json({ error: "BULK_DATA storage binding unavailable" }, { status: 503 });
  }

  // Find active manifests for this account
  const activeManifests = await queryAll(
    env,
    `SELECT id, server_property_id, report_type, object_key, normalized_object_key,
            min_date, max_date, revision
       FROM import_bundle_manifest
      WHERE account_id = ?
        AND status = 'active'
        AND report_type IN ('occupancy', 'gross_revenue', 'source', 'payments', 'adjustments_refunds')
      ORDER BY revision ASC`,
    [scope.accountId],
  );

  if (!activeManifests.length) {
    return Response.json({ ok: true, message: "No active manifests to aggregate", count: 0 }, { status: 200 });
  }

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
        channels: {},
        revision: 0,
      });
    }
    return dayBuckets.get(key);
  };

  for (const manifest of activeManifests) {
    const objectKey = manifest.normalized_object_key || manifest.object_key;
    if (!objectKey) continue;

    const obj = await env.BULK_DATA.get(objectKey);
    if (!obj) continue;

    try {
      const buffer = await obj.arrayBuffer();
      // Decompress gzip stream
      const stream = new Response(buffer).body?.pipeThrough(new DecompressionStream("gzip"));
      if (!stream) continue;
      const text = await new Response(stream).text();
      const parsedItems = parseBundle(text, manifest.server_property_id, []);

      for (const item of parsedItems) {
        const row = item.row;
        const date = String(row.date || row.business_date || row.shift_date || "").slice(0, 10);
        if (!date || date.length !== 10) continue;

        const b = getBucket(manifest.server_property_id, date);
        b.revision = Math.max(b.revision, Number(manifest.revision) || 0);

        if (item.entity === "OccupancyDay") {
          const revCents = toCents(row.room_revenue);
          b.room_revenue_cents = revCents;
          b.rooms_sold = Number(row.rooms_sold) || 0;
          b.available_rooms = Number(row.total_rooms) || 0;
        } else if (item.entity === "GrossRevenueDay") {
          const rentCents = toCents(row.room_rent);
          const misc = toCents(row.misc_charge) + toCents(row.food) + toCents(row.event) +
                       toCents(row.bar) + toCents(row.laundry) + toCents(row.other);
          if (!b.room_revenue_cents && rentCents > 0) b.room_revenue_cents = rentCents;
          b.ancillary_revenue_cents = misc;
          b.total_revenue_cents = (b.room_revenue_cents || rentCents) + misc;
        } else if (item.entity === "SourceDay") {
          const netCents = toCents(row.net_revenue);
          const ch = String(row.source || row.code || "Direct");
          b.channels[ch] = (b.channels[ch] || 0) + netCents;
          const isOta = /expedia|booking|agoda|priceline|airbnb|hotels\.com|ota/i.test(ch);
          if (isOta) {
            b.gross_ota_revenue_cents += netCents;
            b.ota_commission_cents += Math.round(netCents * 0.15); // standard 15% model
          } else {
            b.direct_revenue_cents += netCents;
          }
        } else if (item.entity === "PaymentDay") {
          b.payment_total_cents += toCents(row.total);
        } else if (item.entity === "AdjustmentRefund") {
          b.refund_cents += Math.abs(toCents(row.amount));
        }
      }
    } catch (err) {
      console.error(`Failed to aggregate bundle ${manifest.id}:`, err);
    }
  }

  // Upsert all buckets into property_day_summary
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

  const batch = [];
  for (const b of dayBuckets.values()) {
    const totalRev = b.total_revenue_cents || (b.room_revenue_cents + b.ancillary_revenue_cents);
    const occRate = b.available_rooms > 0 ? (b.rooms_sold / b.available_rooms) : 0;
    const adrCents = b.rooms_sold > 0 ? Math.round(b.room_revenue_cents / b.rooms_sold) : 0;
    const revparCents = b.available_rooms > 0 ? Math.round(b.room_revenue_cents / b.available_rooms) : 0;
    const id = `${scope.accountId}:${b.property_id}:${b.business_date}`;

    batch.push(
      upsertStmt.bind(
        id, scope.accountId, b.property_id, b.business_date,
        b.room_revenue_cents, b.ancillary_revenue_cents, totalRev,
        b.rooms_sold, b.available_rooms, adrCents, occRate, revparCents,
        b.gross_ota_revenue_cents, b.direct_revenue_cents, b.ota_commission_cents,
        b.refund_cents, b.payment_total_cents, JSON.stringify(b.channels),
        100, b.revision, now
      )
    );
  }

  // Execute in bounded batches (D1 50 statements per batch limit)
  const CHUNK_SIZE = 40;
  for (let i = 0; i < batch.length; i += CHUNK_SIZE) {
    const chunk = batch.slice(i, i + CHUNK_SIZE);
    await env.DB.batch(chunk);
  }

  return Response.json({
    ok: true,
    rebuilt_days: dayBuckets.size,
    message: `Successfully aggregated ${dayBuckets.size} property-day summaries`,
  }, { status: 200 });
}
