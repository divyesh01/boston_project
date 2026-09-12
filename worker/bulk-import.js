import { assertPropertyInScope, ScopeError } from "./scope.js";
import { queryAll, queryFirst } from "./db.js";

// In-memory bundle storage fallback for local test harnesses when env.BULK_DATA is not bound
const mockObjectStore = new Map();

export function getMockStore() {
  return mockObjectStore;
}

export function clearMockStore() {
  mockObjectStore.clear();
}

class BulkImportError extends Error {
  constructor(message, status = 400, details = {}) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const responseError = (error, status = 400, details = {}) =>
  Response.json({ error, ...details }, { status });

function requireImportRole(scope) {
  const role = String(scope.user.role || "").toLowerCase();
  if (["owner", "admin"].includes(role)) return;
  let permissions = {};
  try {
    permissions = scope.user.permissions ? JSON.parse(String(scope.user.permissions)) : {};
  } catch {}
  if (["gm", "manager"].includes(role) && permissions.import_reports === true) return;
  throw new BulkImportError("forbidden: insufficient permissions for bulk import", 403, { code: "IMPORT_ROLE_FORBIDDEN" });
}

async function readJsonBody(request) {
  try {
    return await request.json();
  } catch {
    throw new BulkImportError("invalid JSON body", 400, { code: "INVALID_JSON" });
  }
}

function isValidHash(hash) {
  return typeof hash === "string" && /^[a-f0-9]{64}$/i.test(hash);
}

/**
 * Check if a file is already imported by raw or normalized hash.
 * Consumes ZERO D1 writes.
 */
async function checkDuplicate(request, env, scope) {
  const body = await readJsonBody(request);
  const propertyId = String(body.server_property_id || "");
  const rawHash = String(body.raw_file_hash || "");
  const normalizedHash = String(body.normalized_hash || "");

  if (!propertyId) throw new BulkImportError("server_property_id is required", 400, { code: "IMPORT_PROPERTY_REQUIRED" });
  assertPropertyInScope(scope, propertyId);

  if (!rawHash && !normalizedHash) {
    throw new BulkImportError("raw_file_hash or normalized_hash is required", 400, { code: "IMPORT_HASH_REQUIRED" });
  }

  const existing = await queryFirst(
    env,
    `SELECT id, report_type, raw_file_hash, normalized_hash, original_file_name, row_count, created_at, status
       FROM import_bundle_manifest
      WHERE account_id = ?
        AND server_property_id = ?
        AND status = 'active'
        AND (raw_file_hash = ? OR (normalized_hash = ? AND ? <> ''))
      LIMIT 1`,
    [scope.accountId, propertyId, rawHash || "", normalizedHash || "", normalizedHash || ""]
  );

  return Response.json({
    is_duplicate: !!existing,
    existing_bundle: existing || null,
  });
}

/**
 * Streaming upload to R2 object storage.
 * Streams gzip-compressed NDJSON into content-addressed key.
 */
async function uploadBundle(request, env, scope) {
  requireImportRole(scope);

  const url = new URL(request.url);
  const propertyId = request.headers.get("x-server-property-id") || url.searchParams.get("server_property_id") || "";
  const reportType = request.headers.get("x-report-type") || url.searchParams.get("report_type") || "";
  const rawHash = request.headers.get("x-raw-hash") || url.searchParams.get("raw_hash") || "";
  const normalizedHash = request.headers.get("x-normalized-hash") || url.searchParams.get("normalized_hash") || "";
  const rowCount = Number(request.headers.get("x-row-count") || url.searchParams.get("row_count") || 0);

  if (!propertyId) throw new BulkImportError("x-server-property-id is required", 400, { code: "IMPORT_PROPERTY_REQUIRED" });
  assertPropertyInScope(scope, propertyId);

  if (!isValidHash(normalizedHash)) {
    throw new BulkImportError("valid 64-character normalized_hash is required", 400, { code: "IMPORT_INVALID_HASH" });
  }

  const objectKey = `rri-bulk/${scope.accountId}/${propertyId}/v1/${normalizedHash}.ndjson.gz`;

  // Read request body stream into bytes
  const arrayBuffer = await request.arrayBuffer();
  if (!arrayBuffer || arrayBuffer.byteLength === 0) {
    throw new BulkImportError("bundle payload cannot be empty", 400, { code: "IMPORT_EMPTY_PAYLOAD" });
  }

  const customMetadata = {
    account_id: scope.accountId,
    server_property_id: propertyId,
    report_type: reportType,
    raw_hash: rawHash,
    normalized_hash: normalizedHash,
    row_count: String(rowCount),
    uploaded_by: String(scope.user.id),
    uploaded_at: new Date().toISOString(),
  };

  if (env.BULK_DATA && typeof env.BULK_DATA.put === "function") {
    await env.BULK_DATA.put(objectKey, arrayBuffer, {
      customMetadata,
      httpMetadata: {
        contentType: "application/x-ndjson",
        contentEncoding: "gzip",
      },
    });
  } else {
    // Local / test storage fallback
    mockObjectStore.set(objectKey, {
      data: arrayBuffer,
      customMetadata,
      httpMetadata: {
        contentType: "application/x-ndjson",
        contentEncoding: "gzip",
      },
    });
  }

  return Response.json({
    ok: true,
    object_key: objectKey,
    normalized_hash: normalizedHash,
    byte_length: arrayBuffer.byteLength,
  }, { status: 201 });
}

/**
 * Compact atomic activation in D1.
 * Inserts manifest, increments revision, and records 1 change event.
 * Exactly 3 D1 rows written!
 */
async function activateBundle(request, env, scope) {
  requireImportRole(scope);
  const body = await readJsonBody(request);

  const bundleId = String(body.id || `imp_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`);
  const propertyId = String(body.server_property_id || "");
  const reportType = String(body.report_type || "");
  const rawHash = String(body.raw_file_hash || "");
  const normalizedHash = String(body.normalized_hash || "");
  const objectKey = String(body.object_key || `rri-bulk/${scope.accountId}/${propertyId}/v1/${normalizedHash}.ndjson.gz`);
  const schemaVersion = Number(body.schema_version || 1);
  const rowCount = Number(body.row_count || 0);
  const entityCountsJson = typeof body.entity_counts === "object" ? JSON.stringify(body.entity_counts) : String(body.entity_counts_json || "{}");
  const minDate = body.min_date ? String(body.min_date) : null;
  const maxDate = body.max_date ? String(body.max_date) : null;
  const originalFileName = String(body.original_file_name || "report.csv");
  const fileSize = Number(body.file_size || 0);
  const compressedSize = Number(body.compressed_size || 0);
  const now = new Date().toISOString();

  if (!propertyId) throw new BulkImportError("server_property_id is required", 400, { code: "IMPORT_PROPERTY_REQUIRED" });
  assertPropertyInScope(scope, propertyId);

  if (!isValidHash(normalizedHash)) {
    throw new BulkImportError("valid normalized_hash is required", 400, { code: "IMPORT_INVALID_HASH" });
  }

  // Verify object exists in storage before activation
  let objectExists = false;
  if (env.BULK_DATA && typeof env.BULK_DATA.head === "function") {
    const head = await env.BULK_DATA.head(objectKey);
    objectExists = !!head;
  } else {
    objectExists = mockObjectStore.has(objectKey);
  }

  if (!objectExists) {
    throw new BulkImportError("bundle payload object does not exist in storage", 400, { code: "IMPORT_OBJECT_NOT_FOUND" });
  }

  // Idempotency check: check if already active
  const existing = await queryFirst(
    env,
    "SELECT id, revision FROM import_bundle_manifest WHERE account_id=? AND server_property_id=? AND normalized_hash=? AND status='active'",
    [scope.accountId, propertyId, normalizedHash]
  );
  if (existing) {
    return Response.json({
      ok: true,
      status: "already_active",
      bundle_id: existing.id,
      revision: existing.revision,
    });
  }

  // Query current revision
  const syncState = await queryFirst(
    env,
    "SELECT revision FROM business_sync_state WHERE account_id=?",
    [scope.accountId]
  );
  const currentRevision = Number(syncState?.revision || 0);
  const newRevision = currentRevision + 1;

  const changeMutationId = `bulk:${bundleId}:activate`;
  const changeRowJson = JSON.stringify({
    bundle_id: bundleId,
    server_property_id: propertyId,
    report_type: reportType,
    object_key: objectKey,
    normalized_hash: normalizedHash,
    row_count: rowCount,
    entity_counts: JSON.parse(entityCountsJson),
  });

  const statements = [
    env.DB.prepare(
      `INSERT INTO import_bundle_manifest (
        id, account_id, server_property_id, report_type, raw_file_hash,
        normalized_hash, object_key, schema_version, row_count, entity_counts_json,
        min_date, max_date, original_file_name, file_size, compressed_size,
        uploaded_by, status, created_at, activated_at, revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`
    ).bind(
      bundleId, scope.accountId, propertyId, reportType, rawHash,
      normalizedHash, objectKey, schemaVersion, rowCount, entityCountsJson,
      minDate, maxDate, originalFileName, fileSize, compressedSize,
      String(scope.user.id), now, now, newRevision
    ),
    env.DB.prepare(
      "UPDATE business_sync_state SET revision=? WHERE account_id=?"
    ).bind(newRevision, scope.accountId),
    env.DB.prepare(
      `INSERT INTO business_change (
        account_id, seq, generation_id, entity_name, record_key,
        server_property_id, operation, row_json, row_hash, mutation_id,
        request_hash, created_at
      ) VALUES (?, ?, 'bulk', 'ImportBundle', ?, ?, 'upsert', ?, ?, ?, ?, ?)`
    ).bind(
      scope.accountId, newRevision, bundleId, propertyId,
      changeRowJson, normalizedHash, changeMutationId, `hash:${normalizedHash}`, now
    ),
  ];

  try {
    await env.DB.batch(statements);
  } catch (err) {
    if (/UNIQUE constraint failed/i.test(String(err?.message || err))) {
      const active = await queryFirst(
        env,
        "SELECT id, revision FROM import_bundle_manifest WHERE account_id=? AND server_property_id=? AND normalized_hash=? AND status='active'",
        [scope.accountId, propertyId, normalizedHash]
      );
      if (active) {
        return Response.json({
          ok: true,
          status: "already_active",
          bundle_id: active.id,
          revision: active.revision,
        });
      }
    }
    throw err;
  }

  return Response.json({
    ok: true,
    bundle_id: bundleId,
    status: "active",
    revision: newRevision,
    row_count: rowCount,
  }, { status: 201 });
}

/**
 * Manifest feed query for incremental client hydration.
 * Returns active bundle manifests since a specific revision.
 */
async function getManifest(url, env, scope) {
  const propertyId = url.searchParams.get("server_property_id");
  const sinceRevision = Number(url.searchParams.get("since_revision") || 0);

  let sql = `SELECT * FROM import_bundle_manifest WHERE account_id = ? AND revision > ?`;
  const params = [scope.accountId, sinceRevision];

  if (propertyId) {
    assertPropertyInScope(scope, propertyId);
    sql += ` AND server_property_id = ?`;
    params.push(propertyId);
  } else if (scope.user.role?.toLowerCase() !== "owner" && scope.user.role?.toLowerCase() !== "admin" && scope.user.property_access_mode !== "all") {
    // Filter to authorized properties
    const grants = await queryAll(env, "SELECT property_id FROM user_property_access WHERE account_id=? AND user_id=?", [scope.accountId, scope.user.id]);
    const allowed = grants.map((g) => g.property_id);
    if (allowed.length === 0) return Response.json({ manifests: [] });
    const placeholders = allowed.map(() => "?").join(",");
    sql += ` AND server_property_id IN (${placeholders})`;
    params.push(...allowed);
  }

  sql += ` ORDER BY revision ASC LIMIT 200`;
  const manifests = await queryAll(env, sql, params);

  return Response.json({
    manifests: manifests.map((m) => ({
      ...m,
      entity_counts: JSON.parse(m.entity_counts_json || "{}"),
    })),
  });
}

/**
 * Download authorized bundle payload from R2 storage.
 */
async function downloadBundle(parts, env, scope) {
  const bundleId = parts[3];
  if (!bundleId) throw new BulkImportError("bundle id is required", 400, { code: "IMPORT_BUNDLE_REQUIRED" });

  const manifest = await queryFirst(
    env,
    "SELECT * FROM import_bundle_manifest WHERE account_id = ? AND id = ?",
    [scope.accountId, bundleId]
  );

  if (!manifest) throw new BulkImportError("bundle manifest not found", 404, { code: "IMPORT_BUNDLE_NOT_FOUND" });
  assertPropertyInScope(scope, manifest.server_property_id);

  if (manifest.status !== "active") {
    throw new BulkImportError(`bundle is not active (status: ${manifest.status})`, 410, { code: "IMPORT_BUNDLE_INACTIVE" });
  }

  if (env.BULK_DATA && typeof env.BULK_DATA.get === "function") {
    const object = await env.BULK_DATA.get(manifest.object_key);
    if (!object) throw new BulkImportError("bundle data object not found in storage", 404, { code: "IMPORT_OBJECT_NOT_FOUND" });

    return new Response(object.body, {
      status: 200,
      headers: {
        "Content-Type": "application/x-ndjson",
        "Content-Encoding": "gzip",
        "x-bundle-id": manifest.id,
        "x-normalized-hash": manifest.normalized_hash,
        "x-row-count": String(manifest.row_count),
      },
    });
  }

  // Local / test storage fallback
  const stored = mockObjectStore.get(manifest.object_key);
  if (!stored) throw new BulkImportError("bundle data object not found in storage", 404, { code: "IMPORT_OBJECT_NOT_FOUND" });

  return new Response(stored.data, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson",
      "Content-Encoding": "gzip",
      "x-bundle-id": manifest.id,
      "x-normalized-hash": manifest.normalized_hash,
      "x-row-count": String(manifest.row_count),
    },
  });
}

/**
 * Delete / tombstone an imported bundle.
 * Marks manifest tombstoned and emits a change event for clients to evict local rows.
 */
async function deleteBundle(request, env, scope) {
  requireImportRole(scope);
  const body = await readJsonBody(request);
  const bundleId = String(body.bundle_id || "");

  if (!bundleId) throw new BulkImportError("bundle_id is required", 400, { code: "IMPORT_BUNDLE_REQUIRED" });

  const manifest = await queryFirst(
    env,
    "SELECT * FROM import_bundle_manifest WHERE account_id = ? AND id = ? AND status = 'active'",
    [scope.accountId, bundleId]
  );
  if (!manifest) throw new BulkImportError("active bundle not found", 404, { code: "IMPORT_BUNDLE_NOT_FOUND" });
  assertPropertyInScope(scope, manifest.server_property_id);

  const syncState = await queryFirst(env, "SELECT revision FROM business_sync_state WHERE account_id=?", [scope.accountId]);
  const newRevision = Number(syncState?.revision || 0) + 1;
  const now = new Date().toISOString();

  const changeMutationId = `bulk:${bundleId}:delete`;
  const changeRowJson = JSON.stringify({
    bundle_id: bundleId,
    server_property_id: manifest.server_property_id,
    object_key: manifest.object_key,
  });

  const statements = [
    env.DB.prepare(
      "UPDATE import_bundle_manifest SET status = 'tombstoned', deleted_at = ?, revision = ? WHERE account_id = ? AND id = ?"
    ).bind(now, newRevision, scope.accountId, bundleId),
    env.DB.prepare(
      "UPDATE business_sync_state SET revision = ? WHERE account_id = ?"
    ).bind(newRevision, scope.accountId),
    env.DB.prepare(
      `INSERT INTO business_change (
        account_id, seq, generation_id, entity_name, record_key,
        server_property_id, operation, row_json, row_hash, mutation_id,
        request_hash, created_at
      ) VALUES (?, ?, 'bulk', 'ImportBundle', ?, ?, 'delete', ?, ?, ?, ?, ?)`
    ).bind(
      scope.accountId, newRevision, bundleId, manifest.server_property_id,
      changeRowJson, manifest.normalized_hash, changeMutationId, `del:${bundleId}`, now
    ),
  ];

  await env.DB.batch(statements);

  // Asynchronously clean up R2 storage
  if (env.BULK_DATA && typeof env.BULK_DATA.delete === "function") {
    try { await env.BULK_DATA.delete(manifest.object_key); } catch {}
  } else {
    mockObjectStore.delete(manifest.object_key);
  }

  return Response.json({
    ok: true,
    bundle_id: bundleId,
    status: "tombstoned",
    revision: newRevision,
  });
}

/**
 * Top-level bulk import request router.
 */
export async function handleBulkImportRequest(request, env, scope, url, parts) {
  try {
    const action = parts[2] || "";

    if (action === "check-duplicate" && request.method === "POST") {
      return await checkDuplicate(request, env, scope);
    }
    if (action === "upload" && request.method === "PUT") {
      return await uploadBundle(request, env, scope);
    }
    if (action === "activate" && request.method === "POST") {
      return await activateBundle(request, env, scope);
    }
    if (action === "manifest" && request.method === "GET") {
      return await getManifest(url, env, scope);
    }
    if (action === "bundle" && parts[3] && request.method === "GET") {
      return await downloadBundle(parts, env, scope);
    }
    if (action === "delete" && request.method === "POST") {
      return await deleteBundle(request, env, scope);
    }

    return responseError("not found", 404, { code: "ROUTE_NOT_FOUND" });
  } catch (error) {
    if (error instanceof BulkImportError) {
      return responseError(error.message, error.status, error.details);
    }
    if (error instanceof ScopeError) {
      return responseError(error.message, 403, { code: "SCOPE_DENIED" });
    }
    throw error;
  }
}
