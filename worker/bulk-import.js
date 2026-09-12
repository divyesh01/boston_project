import { parseBundle, normalizedContent, contentHash, REPORT_ENTITY } from './bulk-contract.js';
import { assertPropertyInScope, ScopeError } from "./scope.js";
import { queryAll, queryFirst } from "./db.js";

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

function createBoundedStream(inputStream, maxBytes, emptyCode = "IMPORT_EMPTY_PAYLOAD") {
  let bytesRead = 0;
  const transform = new TransformStream({
    transform(chunk, controller) {
      bytesRead += chunk.byteLength;
      if (bytesRead > maxBytes) {
        controller.error(
          new BulkImportError(`payload exceeds maximum allowed size of ${Math.round(maxBytes / (1024 * 1024))} MB`, 413, {
            code: "PAYLOAD_TOO_LARGE",
            maxBytes,
          })
        );
        return;
      }
      controller.enqueue(chunk);
    },
    flush(controller) {
      if (bytesRead === 0) {
        controller.error(
          new BulkImportError("payload cannot be empty", 400, {
            code: emptyCode,
          })
        );
      }
    },
  });

  return {
    stream: inputStream.pipeThrough(transform),
    getBytesRead: () => bytesRead,
  };
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
  for (const name of ["RAW_ARCHIVE", "BULK_DATA"]) {
    if (!env[name] || ["head", "get", "put", "delete"].some((method) => typeof env[name][method] !== "function")) {
      throw new BulkImportError(`R2 binding ${name} is required`, 503, { code: "IMPORT_STORAGE_UNAVAILABLE" });
    }
  }
  return { rawStore: env.RAW_ARCHIVE, bulkStore: env.BULK_DATA };
}

function canonicalKey(scope, propertyId, hash, raw = false) {
  if (!isValidHash(hash)) throw new BulkImportError("invalid content hash", 400, { code: "IMPORT_INVALID_HASH" });
  return raw ? `rri-raw/${scope.accountId}/${propertyId}/${hash.toLowerCase()}`
    : `rri-bulk/${scope.accountId}/${propertyId}/v1/${hash.toLowerCase()}.ndjson.gz`;
}

function verifyObject(head, scope, propertyId, hash, raw = false) {
  if (!head) throw new BulkImportError("object not found", 404, { code: "IMPORT_OBJECT_NOT_FOUND" });
  const meta = head.customMetadata || {};
  if (meta.account_id !== scope.accountId || meta.server_property_id !== propertyId ||
      meta[raw ? "raw_hash" : "normalized_hash"] !== hash.toLowerCase()) {
    throw new BulkImportError("object metadata does not match manifest", 403, { code: "IMPORT_OBJECT_SCOPE_MISMATCH" });
  }
}

function manifestKey(manifest, scope, raw = false) {
  const key = canonicalKey(scope, manifest.server_property_id, raw ? manifest.raw_file_hash : manifest.normalized_hash, raw);
  if ((raw ? manifest.raw_object_key : manifest.object_key) !== key) {
    throw new BulkImportError("noncanonical object key", 403, { code: "IMPORT_OBJECT_SCOPE_MISMATCH" });
  }
  return key;
}

/**
 * Check if a file is already imported by raw or normalized hash.
 * Consumes ZERO D1 writes.
 */
async function checkDuplicate(request, env, scope) {
  const body = await readJsonBody(request);
  const propertyId = String(body.server_property_id || "");
  const rawHash = String(body.raw_file_hash || "");
  const normalizedHash = String(body.normalized_hash || "").toLowerCase();

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

const MAX_RAW_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB max per raw file
const MAX_BUNDLE_SIZE_BYTES = 25 * 1024 * 1024; // 25 MB max per compressed bundle

/**
 * Upload raw original file directly into R2 raw archive.
 * Streams request.body directly to R2 with native checksum verification and write-once immutability.
 * Enforces 50 MB maximum file size limit to protect Worker memory.
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

  // Memory protection: reject oversized payloads before buffering
  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader !== null && contentLengthHeader !== "") {
    const cl = Number(contentLengthHeader);
    if (cl === 0) {
      throw new BulkImportError("raw file payload cannot be empty", 400, { code: "IMPORT_EMPTY_PAYLOAD" });
    }
    if (cl > MAX_RAW_FILE_SIZE_BYTES) {
      throw new BulkImportError(`file exceeds maximum allowed size of 50 MB (${cl} bytes)`, 413, {
        code: "PAYLOAD_TOO_LARGE",
        maxBytes: MAX_RAW_FILE_SIZE_BYTES,
      });
    }
  }

  if (!request.body) {
    throw new BulkImportError("raw file payload cannot be empty", 400, { code: "IMPORT_EMPTY_PAYLOAD" });
  }

  // Canonical raw object key: server MUST ALWAYS compute the canonical key itself.
  // Clients are NEVER allowed to choose or override the R2 object path via headers or query parameters.
  const rawObjectKey = `rri-raw/${scope.accountId}/${propertyId}/${rawHash}`;

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
  if (rawStore && typeof rawStore.put === "function") {
    if (typeof rawStore.head === "function") {
      const existing = await rawStore.head(rawObjectKey);
      if (existing) {
        verifyObject(existing, scope, propertyId, rawHash, true);
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
    }

    // Direct streaming to R2 with native Cloudflare SHA-256 verification and bounded stream
    const bounded = createBoundedStream(request.body, MAX_RAW_FILE_SIZE_BYTES, "IMPORT_EMPTY_PAYLOAD");
    try {
      await rawStore.put(rawObjectKey, bounded.stream, {
        customMetadata,
        httpMetadata: {
          contentType: mimeType,
        },
        sha256: rawHash,
        onlyIf: { etagDoesNotMatch: "*" },
      });
    } catch (err) {
      if (err instanceof BulkImportError) throw err;
      if (err?.code === "PAYLOAD_TOO_LARGE" || String(err?.message || "").includes("PAYLOAD_TOO_LARGE")) {
        throw new BulkImportError("file exceeds maximum allowed size of 50 MB", 413, {
          code: "PAYLOAD_TOO_LARGE",
          maxBytes: MAX_RAW_FILE_SIZE_BYTES,
        });
      }
      if (err?.code === "IMPORT_EMPTY_PAYLOAD" || String(err?.message || "").includes("IMPORT_EMPTY_PAYLOAD")) {
        throw new BulkImportError("raw file payload cannot be empty", 400, {
          code: "IMPORT_EMPTY_PAYLOAD",
        });
      }
      if (String(err?.message || "").toLowerCase().includes("checksum") || String(err?.message || "").includes("sha256")) {
        throw new BulkImportError(`raw payload checksum mismatch: expected ${rawHash}`, 400, {
          code: "RAW_HASH_MISMATCH",
          expected: rawHash,
        });
      }
      throw err;
    }

    return Response.json({
      ok: true,
      status: "archived",
      raw_object_key: rawObjectKey,
      raw_archive_id: rawArchiveId,
      raw_hash: rawHash,
      byte_length: bounded.getBytesRead(),
    }, { status: 201 });
  }


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
  const originalFileName = sanitizeFilename(body.original_file_name || "report.csv");
  let fileSize = Number(body.file_size || body.raw_size || 0);
  const mimeType = String(body.mime_type || body.raw_mime_type || "application/octet-stream");
  const minDate = body.min_date ? String(body.min_date) : null;
  const maxDate = body.max_date ? String(body.max_date) : null;
  const now = new Date().toISOString();

  if (!propertyId) throw new BulkImportError("server_property_id is required", 400, { code: "IMPORT_PROPERTY_REQUIRED" });
  assertPropertyInScope(scope, propertyId);

  if (!isValidHash(rawHash)) {
    throw new BulkImportError("valid raw_file_hash is required", 400, { code: "IMPORT_INVALID_HASH" });
  }

  // Canonical raw object key: NEVER trust body.raw_object_key or client-supplied paths.
  // The server ALWAYS computes the canonical key itself: rri-raw/<account_id>/<server_property_id>/<raw_hash>
  const canonicalObjectKey = `rri-raw/${scope.accountId}/${propertyId}/${rawHash}`;
  const rawObjectKey = canonicalObjectKey;

  // HEAD the R2 object to verify existence and metadata ownership before creating D1 manifest
  const { rawStore } = getStores(env);
  let rawObjectHead = null;
  if (rawStore && typeof rawStore.head === "function") {
    rawObjectHead = await rawStore.head(canonicalObjectKey);
    if (!rawObjectHead) {
      throw new BulkImportError("raw archive object not found in storage", 404, {
        code: "RAW_OBJECT_NOT_FOUND",
        raw_object_key: canonicalObjectKey,
      });
    }
    verifyObject(rawObjectHead, scope, propertyId, rawHash, true);
    const meta = rawObjectHead.customMetadata || {};
    if (meta.account_id && meta.account_id !== scope.accountId) {
      throw new BulkImportError("raw archive object account mismatch", 403, { code: "RAW_OBJECT_ACCOUNT_MISMATCH" });
    }
    if (meta.server_property_id && meta.server_property_id !== propertyId) {
      throw new BulkImportError("raw archive object property mismatch", 403, { code: "RAW_OBJECT_PROPERTY_MISMATCH" });
    }
    if (meta.raw_hash && meta.raw_hash.toLowerCase() !== rawHash) {
      throw new BulkImportError("raw archive object hash mismatch", 400, { code: "RAW_OBJECT_HASH_MISMATCH" });
    }
    if (!fileSize && rawObjectHead.size) {
      fileSize = rawObjectHead.size;
    }
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
    )
    SELECT ?, ?, ?, ?, ?,
           ?, ?, ?, ?, 'archived',
           'pending', 1, 1, 0, '{}',
           ?, ?, ?, ?, 0,
           ?, 1, 0, 'raw_archived', ?, ?, 0
    WHERE NOT EXISTS (
      SELECT 1 FROM import_bundle_manifest
       WHERE account_id = ? AND server_property_id = ? AND raw_file_hash = ? AND status NOT IN ('tombstoned', 'destroyed')
    )`
  ).bind(
    bundleId, scope.accountId, propertyId, reportType, rawHash,
    rawArchiveId, rawObjectKey, fileSize, mimeType,
    minDate, maxDate, originalFileName, fileSize,
    String(scope.user?.id || ""), now, now,
    scope.accountId, propertyId, rawHash
  );

  const res = await statement.run();
  if (res?.meta?.changes === 0 || res?.changes === 0) {
    const winner = await queryFirst(
      env,
      `SELECT id, status, archive_status, processing_status, raw_object_key
         FROM import_bundle_manifest
        WHERE account_id = ? AND server_property_id = ? AND raw_file_hash = ? AND status NOT IN ('tombstoned', 'destroyed')`,
      [scope.accountId, propertyId, rawHash]
    );
    if (winner) {
      return Response.json({
        ok: true,
        status: "already_recorded",
        bundle_id: winner.id,
        archive_status: winner.archive_status || "archived",
        processing_status: winner.processing_status || "pending",
        raw_object_key: winner.raw_object_key,
      }, { status: 200 });
    }
  }

  return Response.json({
    ok: true,
    bundle_id: bundleId,
    raw_archive_id: rawArchiveId,
    raw_object_key: canonicalObjectKey,
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

  if (manifest.archive_status === "destroyed" || manifest.archive_status === "destroying") {
    throw new BulkImportError("raw archive has been destroyed", 410, { code: "RAW_ARCHIVE_DESTROYED" });
  }

  if (!manifest.raw_object_key) {
    throw new BulkImportError("no raw archive object associated with manifest", 404, { code: "RAW_OBJECT_NOT_FOUND" });
  }

  // Security invariant: raw_object_key must strictly belong to the manifest's account and authorized property
  manifestKey(manifest, scope, true);

  const { rawStore } = getStores(env);

  if (rawStore && typeof rawStore.get === "function") {
    const object = await rawStore.get(manifest.raw_object_key);
    if (!object) throw new BulkImportError("raw archive object not found in storage", 404, { code: "RAW_OBJECT_NOT_FOUND" });

    verifyObject(object, scope, manifest.server_property_id, manifest.raw_file_hash, true);
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
  const normalizedHash = (request.headers.get("x-normalized-hash") || url.searchParams.get("normalized_hash") || "").toLowerCase();
  const rowCount = Number(request.headers.get("x-row-count") || url.searchParams.get("row_count") || 0);
  const payloadSha256 = request.headers.get("x-payload-sha256") || request.headers.get("x-content-sha256") || null;

  if (!propertyId) throw new BulkImportError("x-server-property-id is required", 400, { code: "IMPORT_PROPERTY_REQUIRED" });
  assertPropertyInScope(scope, propertyId);

  if (!isValidHash(normalizedHash)) {
    throw new BulkImportError("valid 64-character normalized_hash is required", 400, { code: "IMPORT_INVALID_HASH" });
  }

  // Preflight Content-Length inspection
  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader !== null && contentLengthHeader !== "") {
    const cl = Number(contentLengthHeader);
    if (cl === 0) {
      throw new BulkImportError("bundle payload cannot be empty", 400, { code: "IMPORT_EMPTY_PAYLOAD" });
    }
    if (cl > MAX_BUNDLE_SIZE_BYTES) {
      throw new BulkImportError(`bundle exceeds maximum allowed size of 25 MB (${cl} bytes)`, 413, {
        code: "PAYLOAD_TOO_LARGE",
        maxBytes: MAX_BUNDLE_SIZE_BYTES,
      });
    }
  }

  if (!request.body) {
    throw new BulkImportError("bundle payload cannot be empty", 400, { code: "IMPORT_EMPTY_PAYLOAD" });
  }

  const objectKey = canonicalKey(scope, propertyId, normalizedHash);

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

  // Bound compressed and decoded payloads before verifying the complete content.
  if (bulkStore && typeof bulkStore.put === "function") {
    if (typeof bulkStore.head === "function") {
      const existing = await bulkStore.head(objectKey);
      if (existing) {
        verifyObject(existing, scope, propertyId, normalizedHash);
        return Response.json({
          ok: true,
          status: "already_uploaded",
          object_key: objectKey,
          normalized_hash: normalizedHash,
          byte_length: existing.size,
        }, { status: 200 });
      }
    }

    const bounded = createBoundedStream(request.body, MAX_BUNDLE_SIZE_BYTES, "IMPORT_EMPTY_PAYLOAD");
    const compressed = await new Response(bounded.stream).arrayBuffer();
    let text, items;
    try {
      const decoded = createBoundedStream(new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip')), 16 * 1024 * 1024);
      text = await new Response(decoded.stream).text();
      items = parseBundle(text, propertyId);
    } catch (error) {
      if (error instanceof BulkImportError) throw error;
      throw new BulkImportError('Invalid gzip or bundle rows', 400, { code: 'IMPORT_INVALID_BUNDLE' });
    }
    const identityVersion = Number(request.headers.get('x-identity-version') || 1);
    if (![1, 2].includes(identityVersion)) throw new BulkImportError('Unsupported identity version');
    const computed = await contentHash(identityVersion === 2 ? normalizedContent(items) : text);
    if (computed !== normalizedHash || (request.headers.has("x-row-count") && items.length !== rowCount)) throw new BulkImportError('Bundle hash/count mismatch', 400, { code: 'BUNDLE_HASH_MISMATCH' });
    const entityNames = [...new Set(items.map(item => item.entity))];
    if (entityNames.length !== 1) throw new BulkImportError('One report entity is required');
    const detectedType = Object.keys(REPORT_ENTITY).find(type => REPORT_ENTITY[type] === entityNames[0]);
    if (reportType && reportType !== detectedType) throw new BulkImportError('Report type does not match payload');
    customMetadata.report_type = detectedType;
    const dates = items.map(item => String(item.row.date || item.row.business_date || item.row.shift_date || '')).filter(Boolean).sort();
    customMetadata.min_date = dates[0] || '';
    customMetadata.max_date = dates[dates.length - 1] || '';
    customMetadata.row_count = String(items.length);
    customMetadata.identity_version = String(identityVersion);
    customMetadata.entity_counts_json = JSON.stringify(items.reduce((counts, item) => {
      counts[item.entity] = (counts[item.entity] || 0) + 1; return counts;
    }, {}));
    const r2Options = {
      customMetadata,
      httpMetadata: {
        contentType: "application/x-ndjson",
        contentEncoding: "gzip",
      },
    };
    if (payloadSha256 && isValidHash(payloadSha256)) {
      r2Options.sha256 = payloadSha256;
    }

    try {
      await bulkStore.put(objectKey, compressed, { ...r2Options, onlyIf: { etagDoesNotMatch: "*" } });
    } catch (err) {
      if (err instanceof BulkImportError) throw err;
      if (err?.code === "PAYLOAD_TOO_LARGE" || String(err?.message || "").includes("PAYLOAD_TOO_LARGE")) {
        throw new BulkImportError(`bundle exceeds maximum allowed size of 25 MB`, 413, {
          code: "PAYLOAD_TOO_LARGE",
          maxBytes: MAX_BUNDLE_SIZE_BYTES,
        });
      }
      if (err?.code === "IMPORT_EMPTY_PAYLOAD" || String(err?.message || "").includes("IMPORT_EMPTY_PAYLOAD")) {
        throw new BulkImportError("bundle payload cannot be empty", 400, {
          code: "IMPORT_EMPTY_PAYLOAD",
        });
      }
      if (String(err?.message || "").toLowerCase().includes("checksum") || String(err?.message || "").includes("sha256")) {
        throw new BulkImportError(`bundle checksum verification failed`, 400, {
          code: "BUNDLE_HASH_MISMATCH",
        });
      }
      throw err;
    }

    return Response.json({
      ok: true,
      status: "uploaded",
      object_key: objectKey,
      normalized_hash: normalizedHash,
      byte_length: bounded.getBytesRead(),
    }, { status: 201 });
  }


}

/**
 * Compact atomic activation in D1.
 * Updates raw_archived row OR inserts new manifest row, increments revision, and records 1 change event.
 * Exactly 3 D1 rows written! Total queries <= 5!
 */
async function activateBundle(request, env, scope) {
  requireImportRole(scope);
  const body = await readJsonBody(request);
  const propertyId = String(body.server_property_id || '');
  if (!propertyId) throw new BulkImportError('Property required', 400);
  assertPropertyInScope(scope, propertyId);
  const hash = String(body.normalized_hash || '').toLowerCase();
  const rawHash = String(body.raw_file_hash || '').toLowerCase();
  const key = canonicalKey(scope, propertyId, hash);
  if (body.object_key && body.object_key !== key) throw new BulkImportError('Noncanonical object key', 403, { code: 'IMPORT_OBJECT_SCOPE_MISMATCH' });
  const { bulkStore } = getStores(env);
  const head = await bulkStore.head(key);
  verifyObject(head, scope, propertyId, hash);
  const reportType = head.customMetadata.report_type || String(body.report_type || '');
  if (body.report_type !== reportType) throw new BulkImportError('Report type mismatch');
  const minDate = head.customMetadata.min_date || null, maxDate = head.customMetadata.max_date || null;
  const identityVersion = Number(head.customMetadata.identity_version || 1);
  const counts = JSON.parse(head.customMetadata.entity_counts_json || '{}');
  const rowCount = Number(head.customMetadata.row_count);
  if ((body.row_count != null && body.row_count !== rowCount) || (body.entity_counts && JSON.stringify(Object.entries(body.entity_counts).sort()) !== JSON.stringify(Object.entries(counts).sort()))) {
    throw new BulkImportError('Manifest counts do not match verified payload', 400, { code: 'IMPORT_COUNT_MISMATCH' });
  }
  const active = await queryFirst(env, "SELECT * FROM import_bundle_manifest WHERE account_id=? AND server_property_id=? AND normalized_hash=? AND status='active'", [scope.accountId, propertyId, hash]);
  if (active) {
    // A distinct original with identical business content remains archived, but is no longer pending processing.
    if (body.id && body.id !== active.id) await env.DB.prepare(`UPDATE import_bundle_manifest SET status='superseded',
      processing_status='active',superseded_by_bundle_id=? WHERE account_id=? AND server_property_id=? AND id=?
      AND raw_file_hash=? AND status IN ('raw_archived','failed_processing')`)
      .bind(active.id,scope.accountId,propertyId,String(body.id),rawHash).run();
    return Response.json({ ok: true, status: 'already_active', bundle_id: active.id, revision: active.revision });
  }
  const raw = await queryFirst(env, "SELECT * FROM import_bundle_manifest WHERE account_id=? AND server_property_id=? AND raw_file_hash=? AND status IN ('raw_archived','failed_processing') AND archive_status='archived' ORDER BY created_at,id LIMIT 1", [scope.accountId, propertyId, rawHash]);
  const source = raw || (body.source_archive_id ? await queryFirst(env,
    "SELECT * FROM import_bundle_manifest WHERE account_id=? AND server_property_id=? AND id=? AND raw_file_hash=? AND archive_status='archived'",
    [scope.accountId,propertyId,String(body.source_archive_id),rawHash]) : null);
  if (identityVersion === 2 && (!source || (raw && raw.id !== body.id))) throw new BulkImportError('Original archive required', 409, { code: 'IMPORT_ARCHIVE_REQUIRED' });
  if (source) {
    const sourceKey = manifestKey(source, scope, true);
    verifyObject(await env.RAW_ARCHIVE.head(sourceKey),scope,propertyId,rawHash,true);
  }
  const bundleId = raw?.id || String(body.id || crypto.randomUUID());
  const predecessorId = body.supersedes_bundle_id ? String(body.supersedes_bundle_id) : null;
  let predecessor = null;
  if (predecessorId) {
    predecessor = await queryFirst(env, "SELECT * FROM import_bundle_manifest WHERE account_id=? AND id=?", [scope.accountId, predecessorId]);
    if (!predecessor || predecessor.id === bundleId || predecessor.server_property_id !== propertyId ||
        predecessor.report_type !== body.report_type || predecessor.status !== 'active' || predecessor.superseded_by_bundle_id ||
        Number(body.expected_revision) !== predecessor.revision) throw new BulkImportError('Replacement is stale or out of scope', 409, { code: 'IMPORT_LINEAGE_CONFLICT' });
  }
  const overlap = await queryFirst(env, `SELECT id FROM import_bundle_manifest WHERE account_id=? AND server_property_id=? AND report_type=?
    AND status='active' AND id<>? AND (raw_file_hash=? OR (min_date<=? AND max_date>=?)) LIMIT 1`,
    [scope.accountId, propertyId, String(body.report_type || ''), predecessorId || '', rawHash, maxDate || '', minDate || '']);
  if (overlap) throw new BulkImportError('Report overlaps an active import; select its replacement explicitly', 409, { code: 'IMPORT_REPLACEMENT_REQUIRED', existing_bundle_id: overlap.id });
  const state = await queryFirst(env, 'SELECT revision FROM business_sync_state WHERE account_id=?', [scope.accountId]);
  if (!state) throw new BulkImportError('Sync state is not initialized', 409);
  const revision = Number(state.revision) + 1;
  const now = new Date().toISOString();
  const statements = [];
  // Transaction-time overlap guard: a concurrent activation can commit an
  // overlapping bundle after the preflight SELECT above returned null but before
  // this batch executes, and it would allocate a distinct revision, so the unique
  // business_change seq cannot catch it. Re-check the overlap predicate at commit
  // time behind CHECK(ok=1), which rolls back the whole batch atomically.
  statements.push(env.DB.prepare(`INSERT INTO business_mutation_guard(account_id,mutation_id,request_hash,ok,created_at)
    VALUES(?,?,?,CASE WHEN NOT EXISTS(SELECT 1 FROM import_bundle_manifest WHERE account_id=? AND server_property_id=? AND report_type=?
      AND status='active' AND id<>? AND (raw_file_hash=? OR (min_date<=? AND max_date>=?)) LIMIT 1) THEN 1 ELSE 0 END,?)`)
    .bind(scope.accountId,`overlap-activate:${bundleId}`,hash,scope.accountId,propertyId,String(body.report_type||''),predecessorId||'',rawHash,maxDate||'',minDate||'',now));
  if (source && !raw) statements.push(env.DB.prepare(`INSERT INTO business_mutation_guard(account_id,mutation_id,request_hash,ok,created_at)
    VALUES(?,?,?,CASE WHEN EXISTS(SELECT 1 FROM import_bundle_manifest WHERE account_id=? AND id=? AND archive_status='archived') THEN 1 ELSE 0 END,?)`)
    .bind(scope.accountId,`source-activate:${bundleId}`,hash,scope.accountId,source.id,now));
  if (raw) statements.push(env.DB.prepare(`INSERT INTO business_mutation_guard(account_id,mutation_id,request_hash,ok,created_at)
    VALUES(?,?,?,CASE WHEN EXISTS(SELECT 1 FROM import_bundle_manifest WHERE account_id=? AND id=?
      AND status IN ('raw_archived','failed_processing') AND archive_status='archived') THEN 1 ELSE 0 END,?)`)
    .bind(scope.accountId,`raw-activate:${bundleId}`,hash,scope.accountId,bundleId,now));
  // CHECK(ok=1) aborts the complete transaction if concurrent state changed.
  if (predecessor) statements.push(env.DB.prepare(`INSERT INTO business_mutation_guard(account_id,mutation_id,request_hash,ok,created_at)
    VALUES (?,?,?, CASE WHEN EXISTS(SELECT 1 FROM import_bundle_manifest WHERE account_id=? AND id=? AND status='active' AND revision=?) THEN 1 ELSE 0 END,?)`)
    .bind(scope.accountId, `replace:${bundleId}`, hash, scope.accountId, predecessor.id, predecessor.revision, now));
  if (predecessor) statements.push(env.DB.prepare("UPDATE import_bundle_manifest SET status='superseded',superseded_by_bundle_id=?,superseded_at=?,revision=? WHERE account_id=? AND id=?")
    .bind(bundleId, now, revision, scope.accountId, predecessor.id));
  if (raw) {
    statements.push(env.DB.prepare(`UPDATE import_bundle_manifest SET normalized_hash=?,object_key=?,normalized_object_key=?,identity_version=?,
      report_type=?,row_count=?,entity_counts_json=?,min_date=?,max_date=?,compressed_size=?,processing_status='active',status='active',activated_at=?,revision=?,supersedes_bundle_id=?
      WHERE account_id=? AND id=? AND status IN ('raw_archived','failed_processing')`)
      .bind(hash,key,key,identityVersion,String(body.report_type||''),rowCount,JSON.stringify(counts),minDate,maxDate,head.size,now,revision,predecessorId,scope.accountId,bundleId));
  } else {
    statements.push(env.DB.prepare(`INSERT INTO import_bundle_manifest(id,account_id,server_property_id,report_type,raw_file_hash,normalized_hash,object_key,normalized_object_key,
      identity_version,row_count,entity_counts_json,min_date,max_date,original_file_name,compressed_size,uploaded_by,processing_status,status,created_at,activated_at,revision,supersedes_bundle_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'active','active',?,?,?,?)`)
      .bind(bundleId,scope.accountId,propertyId,String(body.report_type||''),rawHash,hash,key,key,identityVersion,rowCount,JSON.stringify(counts),minDate,maxDate,String(body.original_file_name||'report.csv'),head.size,String(scope.user.id),now,now,revision,predecessorId));
    if (source) statements.push(env.DB.prepare("UPDATE import_bundle_manifest SET raw_archive_id=?,raw_object_key=?,raw_size=?,raw_mime_type=?,archive_status='archived' WHERE account_id=? AND id=?")
      .bind(source.raw_archive_id||source.id,source.raw_object_key,source.raw_size,source.raw_mime_type,scope.accountId,bundleId));
  }
  statements.push(env.DB.prepare('UPDATE business_sync_state SET revision=? WHERE account_id=?').bind(revision,scope.accountId));
  statements.push(env.DB.prepare(`INSERT INTO business_change(account_id,seq,generation_id,entity_name,record_key,server_property_id,operation,row_json,row_hash,mutation_id,request_hash,created_at)
    VALUES(?,?,'bulk','ImportBundle',?,?,'upsert',?,?,?,?,?)`)
    .bind(scope.accountId,revision,bundleId,propertyId,JSON.stringify({bundle_id:bundleId}),hash,`bulk:${bundleId}:activate`,hash,now));
  await env.DB.batch(statements);
  return Response.json({ok:true,status:'active',bundle_id:bundleId,revision,row_count:rowCount,superseded_count:predecessor ? 1 : 0},{status:201});
}

/**
 * Manifest feed query for incremental client hydration.
 * Returns active bundle manifests since a specific revision.
 */
async function getManifest(url, env, scope) {
  const propertyId = url.searchParams.get("server_property_id");
  const sinceRevision = Number(url.searchParams.get("since_revision") || 0);
  const afterId = url.searchParams.get("after_id") || "";

  let sql = `SELECT * FROM import_bundle_manifest WHERE account_id = ? AND (revision > ? OR (revision = ? AND id > ?))`;
  const params = [scope.accountId, sinceRevision, sinceRevision, afterId];

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

  sql += ` ORDER BY revision ASC, id ASC LIMIT 200`;
  const manifests = await queryAll(env, sql, params);

  return Response.json({
    scope: `${scope.accountId}:${[...scope.propertyIds].sort().join(",")}`,
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
    const object = await bulkStore.get(manifestKey(manifest, scope));
    if (!object) throw new BulkImportError("bundle data object not found in storage", 404, { code: "IMPORT_OBJECT_NOT_FOUND" });

    verifyObject(object, scope, manifest.server_property_id, manifest.normalized_hash);
    return new Response(object.body, {
      status: 200,
      headers: {
        "Content-Type": "application/gzip",
        "Cache-Control": "private, no-store",
        "x-bundle-id": manifest.id,
        "x-normalized-hash": manifest.normalized_hash,
        "x-row-count": String(manifest.row_count),
      },
    });
  }


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

  if (oldBundleId === newBundleId || oldManifest.server_property_id !== newManifest.server_property_id ||
      oldManifest.report_type !== newManifest.report_type || oldManifest.status !== 'active' || newManifest.status !== 'active' ||
      oldManifest.supersedes_bundle_id || newManifest.superseded_by_bundle_id || newManifest.supersedes_bundle_id ||
      Number(body.expected_revision) !== oldManifest.revision) {
    throw new BulkImportError('Invalid or stale lineage', 409, { code: 'IMPORT_LINEAGE_CONFLICT' });
  }
  const syncState = await queryFirst(env, "SELECT revision FROM business_sync_state WHERE account_id=?", [scope.accountId]);
  const newRevision = Number(syncState?.revision || 0) + 1;
  const now = new Date().toISOString();

  const statements = [
    env.DB.prepare(`INSERT INTO business_mutation_guard(account_id,mutation_id,request_hash,ok,created_at)
      VALUES(?,?,?, CASE WHEN EXISTS(SELECT 1 FROM import_bundle_manifest WHERE account_id=? AND id=? AND status='active' AND revision=?)
      AND EXISTS(SELECT 1 FROM import_bundle_manifest WHERE account_id=? AND id=? AND status='active' AND revision=?) THEN 1 ELSE 0 END,?)`)
      .bind(scope.accountId, `supersede:${oldBundleId}:${newBundleId}`, newBundleId,
        scope.accountId,oldBundleId,oldManifest.revision,scope.accountId,newBundleId,newManifest.revision,now),
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
 * Marks manifest tombstoned; immutable payload collection is a separate operation.
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
  manifestKey(manifest, scope);

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

  // Keep immutable payloads here. A concurrent reactivation can still reference the
  // same content key; physical collection requires a separate reference-aware GC.

  return Response.json({
    ok: true,
    bundle_id: bundleId,
    status: "tombstoned",
    revision: newRevision,
  });
}

/**
 * Destroy raw archive (Owner only, gated by source_immutable policy and Cloudflare R2 Bucket Locks).
 * Attempts R2 deletion FIRST; if R2 deletion fails (e.g. object is protected by a Cloudflare R2 Bucket Lock rule),
 * D1 remains intact and throws RAW_ARCHIVE_LOCKED.
 */
async function destroyRawArchive(request, env, scope) {
  requireOwnerRole(scope);
  const body = await readJsonBody(request);
  const archiveId = String(body.archive_id || body.bundle_id || body.raw_archive_id || "");
  const manifest = await queryFirst(env,
    "SELECT * FROM import_bundle_manifest WHERE account_id=? AND (id=? OR raw_archive_id=?)",
    [scope.accountId, archiveId, archiveId]);
  if (!manifest) throw new BulkImportError("archive not found", 404, { code: "RAW_ARCHIVE_NOT_FOUND" });
  assertPropertyInScope(scope, manifest.server_property_id);
  if (body.confirm_destroy !== true && body.confirm !== "I_UNDERSTAND_THIS_PERMANENTLY_DELETES_RAW_SOURCE") {
    throw new BulkImportError("explicit confirmation required", 403, { code: "CANNOT_DESTROY_IMMUTABLE_ARCHIVE" });
  }
  const key = manifestKey(manifest, scope, true);
  if (manifest.archive_status === "destroyed") return Response.json({ ok: true, archive_id: archiveId, status: "destroyed" });
  const { rawStore } = getStores(env);
  const head = await rawStore.head(key);
  if (head) verifyObject(head, scope, manifest.server_property_id, manifest.raw_file_hash, true);
  else if (manifest.archive_status !== "destroying") {
    throw new BulkImportError("archived source is missing; reconciliation required", 409, { code: "RAW_OBJECT_MISSING" });
  }
  // Durable intent first. A retry can complete after deletion even when HEAD is absent.
  await env.DB.prepare(`UPDATE import_bundle_manifest SET archive_status='destroying',
    raw_destroy_requested_at=COALESCE(raw_destroy_requested_at, ?)
    WHERE account_id=? AND raw_object_key=? AND archive_status IN ('archived','destroying')`)
    .bind(new Date().toISOString(), scope.accountId, key).run();
  try {
    await rawStore.delete(key);
  } catch (error) {
    const code = String(error?.code ?? '');
    const message = String(error?.message ?? '');
    // Match structured R2 codes or the operation error marker, not generic failures.
    const locked = code === '10069' || code === 'ObjectLockedByBucketPolicy' || /^ObjectLockedByBucketPolicy(?::|$)/.test(message) || /\(10069\)\s*$/.test(message);
    // Preserve intent: generic errors can be ambiguous about physical deletion.
    throw new BulkImportError(locked ? "raw archive is retention locked" : "raw deletion pending; retry required",
      locked ? 423 : 503, { code: locked ? "RAW_ARCHIVE_LOCKED" : "RAW_DESTRUCTION_PENDING" });
  }
  await env.DB.prepare(`UPDATE import_bundle_manifest SET archive_status='destroyed', raw_destroyed_at=?
    WHERE account_id=? AND raw_object_key=? AND archive_status='destroying'`)
    .bind(new Date().toISOString(), scope.accountId, key).run();
  return Response.json({ ok: true, archive_id: archiveId, status: "destroyed" });
}

/**
 * Top-level bulk import request router.
 */
export async function handleBulkImportRequest(request, env, scope, url, parts) {
  try {
    getStores(env);
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
      return await retryRevision(() => activateBundle(request.clone(), env, scope));
    }
    if (action === "manifest" && request.method === "GET") {
      return await getManifest(url, env, scope);
    }
    if (action === "bundle" && parts[3] && request.method === "GET") {
      return await downloadBundle(parts, env, scope);
    }
    if (action === "supersede" && request.method === "POST") {
      return await retryRevision(() => supersedeBundle(request.clone(), env, scope));
    }
    if (action === "delete" && request.method === "POST") {
      return await retryRevision(() => deleteBundle(request.clone(), env, scope));
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
    if (/CHECK constraint failed: ok/.test(String(error?.message || error))) return responseError("Concurrent state changed",409,{code:"IMPORT_LINEAGE_CONFLICT"});
    throw error;
  }
}

async function retryRevision(operation) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (!/CHECK constraint failed: ok|business_change.account_id, business_change.seq|business_mutation_guard.account_id, business_mutation_guard.mutation_id|import_bundle_manifest.account_id, import_bundle_manifest.server_property_id, import_bundle_manifest.normalized_hash/.test(String(error?.message || error))) throw error;
    }
  }
  throw new BulkImportError('Concurrent import; retry request', 409, { code: 'IMPORT_REVISION_CONFLICT' });
}
