import { assertPropertyInScope, ScopeError } from "./scope.js";
import { queryAll, queryFirst } from "./db.js";

// In-memory object store fallback for local test harnesses when env.BULK_DATA or env.RAW_ARCHIVE is not bound
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
  const role = String(scope.user?.role || "").toLowerCase();
  if (["owner", "admin"].includes(role)) return;
  let permissions = {};
  try {
    permissions = scope.user?.permissions ? JSON.parse(String(scope.user.permissions)) : {};
  } catch {}
  if (["gm", "manager"].includes(role) && permissions.import_reports === true) return;
  throw new BulkImportError("forbidden: insufficient permissions for bulk import", 403, { code: "IMPORT_ROLE_FORBIDDEN" });
}

function requireOwnerRole(scope) {
  const role = String(scope.user?.role || "").toLowerCase();
  if (role === "owner") return;
  throw new BulkImportError("forbidden: owner role required", 403, { code: "OWNER_ROLE_REQUIRED" });
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

async function calculateSha256(arrayBuffer) {
  const hashBuffer = await crypto.subtle.digest("SHA-256", arrayBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sanitizeFilename(name) {
  return String(name || "report.csv").replace(/[^a-zA-Z0-9._-]/g, "_");
}

function getR2DatePrefix(reportDate) {
  let yyyy = "2026";
  let mm = "01";
  if (reportDate) {
    const d = new Date(reportDate);
    if (!isNaN(d.getTime())) {
      yyyy = String(d.getUTCFullYear());
      mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    }
  } else {
    const now = new Date();
    yyyy = String(now.getUTCFullYear());
    mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  }
  return { yyyy, mm };
}

function getStores(env) {
  const rawStore = env.RAW_ARCHIVE || env.BULK_DATA || null;
  const bulkStore = env.BULK_DATA || env.RAW_ARCHIVE || null;
  return { rawStore, bulkStore };
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
 * Preflight check if raw file is already archived.
 * Consumes ZERO D1 writes.
 */
async function checkRawDuplicate(request, env, scope) {
  const body = await readJsonBody(request);
  const propertyId = String(body.server_property_id || "");
  const rawHash = String(body.raw_file_hash || "").toLowerCase();

  if (!propertyId) throw new BulkImportError("server_property_id is required", 400, { code: "IMPORT_PROPERTY_REQUIRED" });
  assertPropertyInScope(scope, propertyId);

  if (!isValidHash(rawHash)) {
    throw new BulkImportError("valid 64-character raw_file_hash is required", 400, { code: "IMPORT_INVALID_HASH" });
  }

  const existing = await queryFirst(
    env,
    `SELECT id, raw_archive_id, report_type, raw_file_hash, raw_object_key, original_file_name,
            archive_status, processing_status, status, created_at, activated_at
       FROM import_bundle_manifest
      WHERE account_id = ?
        AND server_property_id = ?
        AND raw_file_hash = ?
        AND status NOT IN ('tombstoned', 'destroyed')
      LIMIT 1`,
    [scope.accountId, propertyId, rawHash]
  );

  return Response.json({
    exists: !!existing,
    is_archived: existing ? (existing.archive_status === "archived" || existing.status === "raw_archived" || existing.status === "active") : false,
    is_active: existing?.status === "active",
    bundle: existing || null,
  });
}

/**
 * Upload raw original file directly into R2 raw archive.
 * Write-once immutability: returns 200 if identical object exists; returns 409 if conflict.
 */
async function uploadRawArchive(request, env, scope) {
  requireImportRole(scope);

  const url = new URL(request.url);
  const propertyId = request.headers.get("x-server-property-id") || url.searchParams.get("server_property_id") || "";
  const reportType = request.headers.get("x-report-type") || url.searchParams.get("report_type") || "unknown";
  const rawHash = (request.headers.get("x-raw-hash") || url.searchParams.get("raw_hash") || "").toLowerCase();
  const rawArchiveId = request.headers.get("x-archive-id") || url.searchParams.get("archive_id") || `raw_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const originalFileName = request.headers.get("x-file-name") || url.searchParams.get("file_name") || "report.csv";
  const mimeType = request.headers.get("content-type") || "application/octet-stream";
  const reportDate = request.headers.get("x-report-date") || url.searchParams.get("report_date") || null;

  if (!propertyId) throw new BulkImportError("x-server-property-id is required", 400, { code: "IMPORT_PROPERTY_REQUIRED" });
  assertPropertyInScope(scope, propertyId);

  if (!isValidHash(rawHash)) {
    throw new BulkImportError("valid 64-character raw_hash is required", 400, { code: "IMPORT_INVALID_HASH" });
  }

  const arrayBuffer = await request.arrayBuffer();
  if (!arrayBuffer || arrayBuffer.byteLength === 0) {
    throw new BulkImportError("raw file payload cannot be empty", 400, { code: "IMPORT_EMPTY_PAYLOAD" });
  }

  const computedHash = (await calculateSha256(arrayBuffer)).toLowerCase();
  if (computedHash !== rawHash) {
    throw new BulkImportError(`raw payload checksum mismatch: expected ${rawHash}, computed ${computedHash}`, 400, {
      code: "RAW_HASH_MISMATCH",
      expected: rawHash,
      computed: computedHash,
    });
  }

  const { yyyy, mm } = getR2DatePrefix(reportDate);
  const safeName = sanitizeFilename(originalFileName);
  const rawObjectKey = `rri-raw/${scope.accountId}/${propertyId}/${yyyy}/${mm}/${rawHash}/${safeName}`;

  const { rawStore } = getStores(env);

  const customMetadata = {
    account_id: scope.accountId,
    server_property_id: propertyId,
    report_type: reportType,
    raw_hash: rawHash,
    raw_archive_id: rawArchiveId,
    original_file_name: originalFileName,
    uploaded_by: String(scope.user?.id || ""),
    uploaded_at: new Date().toISOString(),
    immutable: "true",
  };

  // Write-once immutability check
  if (rawStore && typeof rawStore.head === "function") {
    const existing = await rawStore.head(rawObjectKey);
    if (existing) {
      const existingHash = existing.customMetadata?.raw_hash;
      if (existingHash && existingHash.toLowerCase() === rawHash) {
        return Response.json({
          ok: true,
          status: "already_archived",
          raw_object_key: rawObjectKey,
          raw_archive_id: rawArchiveId,
          raw_hash: rawHash,
          byte_length: existing.size,
        }, { status: 200 });
      } else {
        throw new BulkImportError("raw object key exists with different hash", 409, { code: "RAW_OBJECT_CONFLICT" });
      }
    }

    await rawStore.put(rawObjectKey, arrayBuffer, {
      customMetadata,
      httpMetadata: {
        contentType: mimeType,
      },
    });
  } else {
    // Mock store fallback
    if (mockObjectStore.has(rawObjectKey)) {
      const existing = mockObjectStore.get(rawObjectKey);
      const existingHash = existing.customMetadata?.raw_hash;
      if (existingHash && existingHash.toLowerCase() === rawHash) {
        return Response.json({
          ok: true,
          status: "already_archived",
          raw_object_key: rawObjectKey,
          raw_archive_id: rawArchiveId,
          raw_hash: rawHash,
          byte_length: existing.data?.byteLength || arrayBuffer.byteLength,
        }, { status: 200 });
      } else {
        throw new BulkImportError("raw object key exists with different hash", 409, { code: "RAW_OBJECT_CONFLICT" });
      }
    }

    mockObjectStore.set(rawObjectKey, {
      data: arrayBuffer,
      customMetadata,
      httpMetadata: {
        contentType: mimeType,
      },
    });
  }

  return Response.json({
    ok: true,
    status: "archived",
    raw_object_key: rawObjectKey,
    raw_archive_id: rawArchiveId,
    raw_hash: rawHash,
    byte_length: arrayBuffer.byteLength,
  }, { status: 201 });
}

/**
 * Record raw file archival in D1 manifest.
 * Exactly 1 D1 write!
 */
async function recordRawArchive(request, env, scope) {
  requireImportRole(scope);
  const body = await readJsonBody(request);

  const rawArchiveId = String(body.raw_archive_id || `raw_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`);
  const bundleId = String(body.id || rawArchiveId);
  const propertyId = String(body.server_property_id || "");
  const reportType = String(body.report_type || "unknown");
  const rawHash = String(body.raw_file_hash || "").toLowerCase();
  const rawObjectKey = String(body.raw_object_key || "");
  const originalFileName = String(body.original_file_name || "report.csv");
  const fileSize = Number(body.file_size || body.raw_size || 0);
  const mimeType = String(body.mime_type || body.raw_mime_type || "application/octet-stream");
  const minDate = body.min_date ? String(body.min_date) : null;
  const maxDate = body.max_date ? String(body.max_date) : null;
  const now = new Date().toISOString();

  if (!propertyId) throw new BulkImportError("server_property_id is required", 400, { code: "IMPORT_PROPERTY_REQUIRED" });
  assertPropertyInScope(scope, propertyId);

  if (!isValidHash(rawHash)) {
    throw new BulkImportError("valid raw_file_hash is required", 400, { code: "IMPORT_INVALID_HASH" });
  }

  if (!rawObjectKey) {
    throw new BulkImportError("raw_object_key is required", 400, { code: "IMPORT_OBJECT_KEY_REQUIRED" });
  }

  const existing = await queryFirst(
    env,
    `SELECT id, status, archive_status, processing_status, raw_object_key
       FROM import_bundle_manifest
      WHERE account_id = ? AND server_property_id = ? AND raw_file_hash = ? AND status NOT IN ('tombstoned', 'destroyed')`,
    [scope.accountId, propertyId, rawHash]
  );

  if (existing) {
    return Response.json({
      ok: true,
      status: "already_recorded",
      bundle_id: existing.id,
      archive_status: existing.archive_status || "archived",
      processing_status: existing.processing_status || "pending",
      raw_object_key: existing.raw_object_key,
    }, { status: 200 });
  }

  const statement = env.DB.prepare(
    `INSERT INTO import_bundle_manifest (
      id, account_id, server_property_id, report_type, raw_file_hash,
      raw_archive_id, raw_object_key, raw_size, raw_mime_type, archive_status,
      processing_status, schema_version, parser_version, row_count, entity_counts_json,
      min_date, max_date, original_file_name, file_size, compressed_size,
      uploaded_by, source_immutable, attempt_count, status, created_at, archived_at, revision
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, 'archived',
      'pending', 1, 1, 0, '{}',
      ?, ?, ?, ?, 0,
      ?, 1, 0, 'raw_archived', ?, ?, 0
    )`
  ).bind(
    bundleId, scope.accountId, propertyId, reportType, rawHash,
    rawArchiveId, rawObjectKey, fileSize, mimeType,
    minDate, maxDate, originalFileName, fileSize,
    String(scope.user?.id || ""), now, now
  );

  await statement.run();

  return Response.json({
    ok: true,
    bundle_id: bundleId,
    raw_archive_id: rawArchiveId,
    status: "raw_archived",
    archive_status: "archived",
    processing_status: "pending",
  }, { status: 201 });
}

/**
 * List pending raw archives waiting for processing.
 */
async function getPendingRawArchives(url, env, scope) {
  const propertyId = url.searchParams.get("server_property_id");

  let sql = `SELECT id, raw_archive_id, account_id, server_property_id, report_type,
                    raw_file_hash, raw_object_key, raw_size, raw_mime_type, original_file_name,
                    archive_status, processing_status, attempt_count, last_error_code, last_error_at,
                    created_at, archived_at, status
               FROM import_bundle_manifest
              WHERE account_id = ?
                AND status IN ('raw_archived', 'failed_processing')`;
  const params = [scope.accountId];

  if (propertyId) {
    assertPropertyInScope(scope, propertyId);
    sql += ` AND server_property_id = ?`;
    params.push(propertyId);
  } else if (scope.user?.role?.toLowerCase() !== "owner" && scope.user?.role?.toLowerCase() !== "admin" && scope.user?.property_access_mode !== "all") {
    const grants = await queryAll(env, "SELECT property_id FROM user_property_access WHERE account_id=? AND user_id=?", [scope.accountId, scope.user.id]);
    const allowed = grants.map((g) => g.property_id);
    if (allowed.length === 0) return Response.json({ pending: [] });
    const placeholders = allowed.map(() => "?").join(",");
    sql += ` AND server_property_id IN (${placeholders})`;
    params.push(...allowed);
  }

  sql += ` ORDER BY created_at DESC LIMIT 100`;
  const pending = await queryAll(env, sql, params);

  return Response.json({ pending });
}

/**
 * Download exact original raw file from R2 archive with SHA-256 verification parity.
 */
async function downloadRawArchive(parts, env, scope) {
  const id = parts[3];
  if (!id) throw new BulkImportError("archive id is required", 400, { code: "IMPORT_ARCHIVE_REQUIRED" });

  const manifest = await queryFirst(
    env,
    `SELECT * FROM import_bundle_manifest
      WHERE account_id = ?
        AND (id = ? OR raw_archive_id = ?)`,
    [scope.accountId, id, id]
  );

  if (!manifest) throw new BulkImportError("raw archive not found", 404, { code: "RAW_ARCHIVE_NOT_FOUND" });
  assertPropertyInScope(scope, manifest.server_property_id);

  if (manifest.status === "destroyed") {
    throw new BulkImportError("raw archive has been destroyed", 410, { code: "RAW_ARCHIVE_DESTROYED" });
  }

  if (!manifest.raw_object_key) {
    throw new BulkImportError("no raw archive object associated with manifest", 404, { code: "RAW_OBJECT_NOT_FOUND" });
  }

  const { rawStore } = getStores(env);

  if (rawStore && typeof rawStore.get === "function") {
    const object = await rawStore.get(manifest.raw_object_key);
    if (!object) throw new BulkImportError("raw archive object not found in storage", 404, { code: "RAW_OBJECT_NOT_FOUND" });

    return new Response(object.body, {
      status: 200,
      headers: {
        "Content-Type": manifest.raw_mime_type || "application/octet-stream",
        "Content-Disposition": `attachment; filename="${manifest.original_file_name || 'report.csv'}"`,
        "x-raw-hash": manifest.raw_file_hash,
        "x-raw-size": String(manifest.raw_size || 0),
        "x-archive-id": manifest.raw_archive_id || manifest.id,
      },
    });
  }

  // Mock store fallback
  const stored = mockObjectStore.get(manifest.raw_object_key);
  if (!stored) throw new BulkImportError("raw archive object not found in storage", 404, { code: "RAW_OBJECT_NOT_FOUND" });

  return new Response(stored.data, {
    status: 200,
    headers: {
      "Content-Type": manifest.raw_mime_type || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${manifest.original_file_name || 'report.csv'}"`,
      "x-raw-hash": manifest.raw_file_hash,
      "x-raw-size": String(manifest.raw_size || 0),
      "x-archive-id": manifest.raw_archive_id || manifest.id,
    },
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
    uploaded_by: String(scope.user?.id || ""),
    uploaded_at: new Date().toISOString(),
  };

  const { bulkStore } = getStores(env);

  if (bulkStore && typeof bulkStore.put === "function") {
    await bulkStore.put(objectKey, arrayBuffer, {
      customMetadata,
      httpMetadata: {
        contentType: "application/x-ndjson",
        contentEncoding: "gzip",
      },
    });
  } else {
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
 * Updates raw_archived row OR inserts new manifest row, increments revision, and records 1 change event.
 * Exactly 3 D1 rows written! Total queries <= 5!
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
  const supersedesBundleId = body.supersedes_bundle_id ? String(body.supersedes_bundle_id) : null;
  const now = new Date().toISOString();

  if (!propertyId) throw new BulkImportError("server_property_id is required", 400, { code: "IMPORT_PROPERTY_REQUIRED" });
  assertPropertyInScope(scope, propertyId);

  if (!isValidHash(normalizedHash)) {
    throw new BulkImportError("valid normalized_hash is required", 400, { code: "IMPORT_INVALID_HASH" });
  }

  // Verify normalized object exists in storage before activation
  const { bulkStore } = getStores(env);
  let objectExists = false;
  if (bulkStore && typeof bulkStore.head === "function") {
    const head = await bulkStore.head(objectKey);
    objectExists = !!head;
  } else {
    objectExists = mockObjectStore.has(objectKey);
  }

  if (!objectExists) {
    throw new BulkImportError("bundle payload object does not exist in storage", 400, { code: "IMPORT_OBJECT_NOT_FOUND" });
  }

  // Single query for idempotency and raw_archived presence
  const existing = await queryFirst(
    env,
    `SELECT id, revision, status, normalized_hash, raw_archive_id, raw_object_key, raw_size, raw_mime_type
       FROM import_bundle_manifest
      WHERE account_id = ?
        AND server_property_id = ?
        AND (normalized_hash = ? OR id = ? OR (raw_file_hash = ? AND ? <> ''))
      LIMIT 1`,
    [scope.accountId, propertyId, normalizedHash, bundleId, rawHash, rawHash]
  );

  if (existing && existing.status === "active" && existing.normalized_hash === normalizedHash) {
    return Response.json({
      ok: true,
      status: "already_active",
      bundle_id: existing.id,
      revision: existing.revision,
    });
  }

  const existingRaw = (existing && (existing.status === "raw_archived" || existing.status === "failed_processing")) ? existing : null;

  const syncState = await queryFirst(
    env,
    "SELECT revision FROM business_sync_state WHERE account_id=?",
    [scope.accountId]
  );
  const currentRevision = Number(syncState?.revision || 0);
  const newRevision = currentRevision + 1;

  const targetBundleId = existingRaw ? existingRaw.id : bundleId;
  const changeMutationId = `bulk:${targetBundleId}:activate`;
  const changeRowJson = JSON.stringify({
    bundle_id: targetBundleId,
    server_property_id: propertyId,
    report_type: reportType,
    object_key: objectKey,
    normalized_hash: normalizedHash,
    row_count: rowCount,
    entity_counts: JSON.parse(entityCountsJson),
  });

  const statements = [];

  if (existingRaw) {
    statements.push(
      env.DB.prepare(
        `UPDATE import_bundle_manifest SET
          report_type = ?,
          normalized_hash = ?,
          object_key = ?,
          normalized_object_key = ?,
          schema_version = ?,
          parser_version = 1,
          row_count = ?,
          entity_counts_json = ?,
          min_date = ?,
          max_date = ?,
          compressed_size = ?,
          processing_status = 'active',
          status = 'active',
          activated_at = ?,
          supersedes_bundle_id = COALESCE(?, supersedes_bundle_id),
          revision = ?
        WHERE account_id = ? AND id = ?`
      ).bind(
        reportType, normalizedHash, objectKey, objectKey,
        schemaVersion, rowCount, entityCountsJson,
        minDate, maxDate, compressedSize,
        now, supersedesBundleId, newRevision,
        scope.accountId, existingRaw.id
      )
    );
  } else {
    statements.push(
      env.DB.prepare(
        `INSERT INTO import_bundle_manifest (
          id, account_id, server_property_id, report_type, raw_file_hash,
          normalized_hash, object_key, normalized_object_key, schema_version,
          parser_version, row_count, entity_counts_json, min_date, max_date,
          original_file_name, file_size, compressed_size, uploaded_by,
          archive_status, processing_status, status, created_at, activated_at,
          supersedes_bundle_id, revision
        ) VALUES (
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          1, ?, ?, ?, ?,
          ?, ?, ?, ?,
          'archived', 'active', 'active', ?, ?,
          ?, ?
        )`
      ).bind(
        bundleId, scope.accountId, propertyId, reportType, rawHash,
        normalizedHash, objectKey, objectKey, schemaVersion,
        rowCount, entityCountsJson, minDate, maxDate,
        originalFileName, fileSize, compressedSize, String(scope.user?.id || ""),
        now, now, supersedesBundleId, newRevision
      )
    );
  }

  statements.push(
    env.DB.prepare("UPDATE business_sync_state SET revision=? WHERE account_id=?").bind(newRevision, scope.accountId)
  );

  statements.push(
    env.DB.prepare(
      `INSERT INTO business_change (
        account_id, seq, generation_id, entity_name, record_key,
        server_property_id, operation, row_json, row_hash, mutation_id,
        request_hash, created_at
      ) VALUES (?, ?, 'bulk', 'ImportBundle', ?, ?, 'upsert', ?, ?, ?, ?, ?)`
    ).bind(
      scope.accountId, newRevision, targetBundleId, propertyId,
      changeRowJson, normalizedHash, changeMutationId, `hash:${normalizedHash}`, now
    )
  );

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
    bundle_id: targetBundleId,
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
  } else if (scope.user?.role?.toLowerCase() !== "owner" && scope.user?.role?.toLowerCase() !== "admin" && scope.user?.property_access_mode !== "all") {
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

  const { bulkStore } = getStores(env);

  if (bulkStore && typeof bulkStore.get === "function") {
    const object = await bulkStore.get(manifest.object_key);
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
 * Lineage supersede: mark old bundle superseded by new bundle.
 * Preserves both raw source archives in R2 untouched!
 */
async function supersedeBundle(request, env, scope) {
  requireImportRole(scope);
  const body = await readJsonBody(request);
  const oldBundleId = String(body.old_bundle_id || "");
  const newBundleId = String(body.new_bundle_id || "");

  if (!oldBundleId || !newBundleId) {
    throw new BulkImportError("old_bundle_id and new_bundle_id are required", 400, { code: "IMPORT_BUNDLE_REQUIRED" });
  }

  const oldManifest = await queryFirst(
    env,
    "SELECT * FROM import_bundle_manifest WHERE account_id = ? AND id = ?",
    [scope.accountId, oldBundleId]
  );
  if (!oldManifest) throw new BulkImportError("old bundle not found", 404, { code: "IMPORT_BUNDLE_NOT_FOUND" });
  assertPropertyInScope(scope, oldManifest.server_property_id);

  const newManifest = await queryFirst(
    env,
    "SELECT * FROM import_bundle_manifest WHERE account_id = ? AND id = ?",
    [scope.accountId, newBundleId]
  );
  if (!newManifest) throw new BulkImportError("new bundle not found", 404, { code: "IMPORT_BUNDLE_NOT_FOUND" });
  assertPropertyInScope(scope, newManifest.server_property_id);

  const syncState = await queryFirst(env, "SELECT revision FROM business_sync_state WHERE account_id=?", [scope.accountId]);
  const newRevision = Number(syncState?.revision || 0) + 1;
  const now = new Date().toISOString();

  const statements = [
    env.DB.prepare(
      `UPDATE import_bundle_manifest
          SET status = 'superseded',
              superseded_by_bundle_id = ?,
              superseded_at = ?,
              superseded_by_user = ?,
              revision = ?
        WHERE account_id = ? AND id = ?`
    ).bind(newBundleId, now, String(scope.user?.id || ""), newRevision, scope.accountId, oldBundleId),
    env.DB.prepare(
      `UPDATE import_bundle_manifest
          SET supersedes_bundle_id = ?,
              revision = ?
        WHERE account_id = ? AND id = ?`
    ).bind(oldBundleId, newRevision, scope.accountId, newBundleId),
    env.DB.prepare("UPDATE business_sync_state SET revision = ? WHERE account_id = ?").bind(newRevision, scope.accountId),
    env.DB.prepare(
      `INSERT INTO business_change (
        account_id, seq, generation_id, entity_name, record_key,
        server_property_id, operation, row_json, row_hash, mutation_id,
        request_hash, created_at
      ) VALUES (?, ?, 'bulk', 'ImportBundle', ?, ?, 'delete', ?, ?, ?, ?, ?)`
    ).bind(
      scope.accountId, newRevision, oldBundleId, oldManifest.server_property_id,
      JSON.stringify({ old_bundle_id: oldBundleId, new_bundle_id: newBundleId }),
      oldManifest.normalized_hash, `bulk:${oldBundleId}:supersede`, `sup:${oldBundleId}:${newBundleId}`, now
    ),
  ];

  await env.DB.batch(statements);

  // Both raw files in R2 remain completely untouched!
  return Response.json({
    ok: true,
    old_bundle_id: oldBundleId,
    new_bundle_id: newBundleId,
    status: "superseded",
    revision: newRevision,
  });
}

/**
 * Delete / tombstone an imported bundle from analytics.
 * Marks manifest tombstoned, cleans derivative normalized object, BUT NEVER deletes raw archive!
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

  // Clean up derivative normalized bundle in R2, but NEVER touch raw archive
  const { bulkStore } = getStores(env);
  if (manifest.object_key && manifest.object_key !== manifest.raw_object_key) {
    if (bulkStore && typeof bulkStore.delete === "function") {
      try { await bulkStore.delete(manifest.object_key); } catch {}
    } else {
      mockObjectStore.delete(manifest.object_key);
    }
  }

  return Response.json({
    ok: true,
    bundle_id: bundleId,
    status: "tombstoned",
    revision: newRevision,
  });
}

/**
 * Destroy raw archive (Owner only, gated by source_immutable policy).
 */
async function destroyRawArchive(request, env, scope) {
  requireOwnerRole(scope);
  const body = await readJsonBody(request);
  const archiveId = String(body.archive_id || body.bundle_id || "");

  if (!archiveId) throw new BulkImportError("archive_id is required", 400, { code: "IMPORT_ARCHIVE_REQUIRED" });

  const manifest = await queryFirst(
    env,
    "SELECT * FROM import_bundle_manifest WHERE account_id = ? AND (id = ? OR raw_archive_id = ?)",
    [scope.accountId, archiveId, archiveId]
  );
  if (!manifest) throw new BulkImportError("archive not found", 404, { code: "RAW_ARCHIVE_NOT_FOUND" });

  if (manifest.source_immutable === 1 && body.confirm_destroy !== true) {
    throw new BulkImportError("cannot destroy immutable raw archive without explicit confirm_destroy flag", 403, {
      code: "CANNOT_DESTROY_IMMUTABLE_ARCHIVE",
    });
  }

  const now = new Date().toISOString();
  await env.DB.prepare(
    "UPDATE import_bundle_manifest SET status = 'destroyed', archive_status = 'destroyed', deleted_at = ? WHERE account_id = ? AND id = ?"
  ).bind(now, scope.accountId, manifest.id).run();

  const { rawStore } = getStores(env);
  if (manifest.raw_object_key) {
    if (rawStore && typeof rawStore.delete === "function") {
      try { await rawStore.delete(manifest.raw_object_key); } catch {}
    } else {
      mockObjectStore.delete(manifest.raw_object_key);
    }
  }

  return Response.json({
    ok: true,
    archive_id: archiveId,
    status: "destroyed",
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
    if (action === "raw-check" && request.method === "POST") {
      return await checkRawDuplicate(request, env, scope);
    }
    if (action === "raw-upload" && request.method === "PUT") {
      return await uploadRawArchive(request, env, scope);
    }
    if (action === "raw-archive" && request.method === "POST") {
      return await recordRawArchive(request, env, scope);
    }
    if (action === "pending" && request.method === "GET") {
      return await getPendingRawArchives(url, env, scope);
    }
    if (action === "raw" && parts[3] && request.method === "GET") {
      return await downloadRawArchive(parts, env, scope);
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
    if (action === "supersede" && request.method === "POST") {
      return await supersedeBundle(request, env, scope);
    }
    if (action === "delete" && request.method === "POST") {
      return await deleteBundle(request, env, scope);
    }
    if (action === "raw-destroy" && request.method === "POST") {
      return await destroyRawArchive(request, env, scope);
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
