import localDb from '../api/localDb.js';

export const ENTITY_MAP = Object.freeze({
  occupancy: "OccupancyDay",
  source: "SourceDay",
  gross_revenue: "GrossRevenueDay",
  payments: "PaymentDay",
  clerk: "ClerkShiftRecord",
  timecard: "TimecardPunch",
  adjustments_refunds: "AdjustmentRefund",
  hotel_statistics: "HotelMetric",
  transactions: "TransactionLine",
  generic: null,
});

export const BULK_REPORT_TYPES = Object.freeze([
  'occupancy', 'source', 'gross_revenue', 'payments', 'clerk',
  'adjustments_refunds', 'hotel_statistics', 'transactions', 'timecard'
]);

const BULK_TYPE_SET = new Set(BULK_REPORT_TYPES);

export function isBulkImportEligible(reportType) {
  return BULK_TYPE_SET.has(reportType);
}

/**
 * Deterministic safe 53-bit positive integer generator from seed string.
 * Guarantees identical row IDs across all browser profiles (Browser A, Browser B, headless).
 */
export function generateDeterministicRowId(bundleHash, entityName, naturalKeyOrIndex) {
  const seed = `${bundleHash}:${entityName}:${naturalKeyOrIndex}`;
  let h1 = 0xdeadbeef, h2 = 0x41c64e6d;
  for (let i = 0; i < seed.length; i++) {
    const ch = seed.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const positive = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return positive || 1;
}

export async function sha256Hex(data) {
  const bytes = typeof data === 'string'
    ? new TextEncoder().encode(data)
    : (data instanceof Uint8Array ? data : new Uint8Array(data));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Gzip compression using standard CompressionStream API.
 */
export async function compressPayloadGzip(payloadString) {
  const bytes = new TextEncoder().encode(payloadString);
  if (typeof CompressionStream !== 'undefined') {
    const cs = new CompressionStream('gzip');
    const writer = cs.writable.getWriter();
    writer.write(bytes);
    writer.close();
    const chunks = [];
    const reader = cs.readable.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const totalLen = chunks.reduce((acc, c) => acc + c.byteLength, 0);
    const result = new Uint8Array(totalLen);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(new Uint8Array(chunk), offset);
      offset += chunk.byteLength;
    }
    return result;
  }
  // Fallback: return raw bytes
  return bytes;
}

/**
 * Gzip decompression using standard DecompressionStream API.
 */
export async function decompressPayloadGzip(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (typeof DecompressionStream !== 'undefined') {
    const ds = new DecompressionStream('gzip');
    const writer = ds.writable.getWriter();
    writer.write(bytes);
    writer.close();
    const chunks = [];
    const reader = ds.readable.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const totalLen = chunks.reduce((acc, c) => acc + c.byteLength, 0);
    const result = new Uint8Array(totalLen);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(new Uint8Array(chunk), offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(result);
  }
  return new TextDecoder().decode(bytes);
}

function dedupByKey(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    const key = keyFn(item);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

/**
 * Normalize scanResult into typed entities with stable deterministic IDs.
 */
export function buildNormalizedBundle(scanResult, meta, bundleId) {
  const { type } = scanResult;
  const propertyId = String(meta.propertyId || '');
  const propertyName = String(meta.propertyName || '');
  const sourceFile = String(meta.sourceFile || '');
  const now = new Date().toISOString();

  const recordsByEntity = {};
  const entityCounts = {};

  function addRow(entityName, row, naturalKey, idx) {
    if (!recordsByEntity[entityName]) {
      recordsByEntity[entityName] = [];
      entityCounts[entityName] = 0;
    }
    const stableId = generateDeterministicRowId(bundleId, entityName, naturalKey || idx);
    const fullRow = {
      ...row,
      id: stableId,
      property_id: propertyId,
      property_name: propertyName,
      import_id: bundleId,
      bulk_import_id: bundleId,
      source_file: sourceFile,
      created_date: row.created_date || now,
      updated_date: now,
    };
    recordsByEntity[entityName].push(fullRow);
    entityCounts[entityName]++;
  }

  let minDate = null;
  let maxDate = null;
  function trackDate(d) {
    if (!d || typeof d !== 'string') return;
    if (!minDate || d < minDate) minDate = d;
    if (!maxDate || d > maxDate) maxDate = d;
  }

  if (type === 'clerk') {
    const all = [
      ...(scanResult.payments || []),
      ...(scanResult.drops || []),
      ...(scanResult.clerkPayments || [])
    ];
    const keyFn = (r) => {
      if (r.record_type === 'payment') return `payment|${r.payment_type}|${r._sectionKey || 'unknown'}`;
      if (r.record_type === 'drop') return `drop|${r.shift_date}|${r.clerk_name}|${r.amount}`;
      return `clerk_payment|${r.clerk_name}|${r.payment_type}|${r.amount}|${r._sectionKey || 'unknown'}`;
    };
    const deduped = dedupByKey(all, keyFn);
    deduped.forEach((r, idx) => {
      trackDate(r.shift_date);
      addRow('ClerkShiftRecord', r, keyFn(r), idx);
    });
  } else if (type === 'adjustments_refunds') {
    const all = [
      ...(scanResult.adjustments || []),
      ...(scanResult.refunds || [])
    ];
    const keyFn = (r) => [
      r.record_type || 'adj',
      r.date || '',
      r.time || '',
      r.username || '',
      r.roomNumber || '',
      r.transactionNumber || '',
      r.adjustedAmount ?? r.amount ?? 0,
    ].join('|');
    const deduped = dedupByKey(all, keyFn);
    deduped.forEach((r, idx) => {
      trackDate(r.date);
      addRow('AdjustmentRefund', r, keyFn(r), idx);
    });
  } else if (type === 'timecard') {
    const rows = scanResult.rowsToImport || [];
    const keyFn = (r) => [r.employee_name || '', r.shift_date || '', r.clock_in || '', r.clock_out || ''].join('|');
    const deduped = dedupByKey(rows, keyFn);
    deduped.forEach((r, idx) => {
      trackDate(r.shift_date);
      addRow('TimecardPunch', r, keyFn(r), idx);
    });
  } else if (type === 'hotel_statistics') {
    const metrics = scanResult.metrics || scanResult.rowsToImport || [];
    const keyFn = (r) => `${r.property_id}|${r.business_date}|${r.section}|${r.metric_name}|${r.period}|${bundleId}`;
    const deduped = dedupByKey(metrics, keyFn);
    deduped.forEach((r, idx) => {
      trackDate(r.business_date);
      addRow('HotelMetric', r, keyFn(r), idx);
    });
  } else if (type === 'transactions') {
    const rows = scanResult.rowsToImport || [];
    rows.forEach((r, idx) => {
      trackDate(r.date);
      const key = r.dedupe_key || `${r.folio_number || ''}|${r.transaction_code || ''}|${idx}`;
      addRow('TransactionLine', r, key, idx);
    });
  } else if (ENTITY_MAP[type]) {
    const entityName = ENTITY_MAP[type];
    const keyFn = type === 'source'
      ? (r) => `${propertyId}|${r.date}|${r.code || r.source}`
      : (r) => `${propertyId}|${r.date}`;
    const rows = scanResult.rowsToImport || [];
    const deduped = dedupByKey(rows, keyFn);
    deduped.forEach((r, idx) => {
      trackDate(r.date);
      addRow(entityName, r, keyFn(r), idx);
    });
  }

  // Format line-delimited JSON (NDJSON)
  const lines = [];
  let totalRowCount = 0;
  for (const [entityName, rows] of Object.entries(recordsByEntity)) {
    totalRowCount += rows.length;
    for (const row of rows) {
      lines.push(JSON.stringify({ entity: entityName, row }));
    }
  }
  const ndjson = lines.join('\n');

  return {
    bundleId,
    recordsByEntity,
    entityCounts,
    totalRowCount,
    minDate,
    maxDate,
    ndjson,
  };
}

/**
 * Check if file or normalized content is duplicate with server D1 manifest.
 * @param {{ serverPropertyId?: string, rawFileHash?: string | null, normalizedHash?: string | null }} [params]
 */
export async function checkDuplicateServer({ serverPropertyId = '', rawFileHash = null, normalizedHash = null } = {}) {
  try {
    const res = await fetch('/api/bulk-import/check-duplicate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        server_property_id: serverPropertyId,
        raw_file_hash: rawFileHash,
        normalized_hash: normalizedHash,
      }),
    });
    if (!res.ok) return { is_duplicate: false };
    return await res.json();
  } catch {
    return { is_duplicate: false };
  }
}

/**
 * Preflight check if raw file is already archived in R2.
 */
export async function checkRawDuplicateServer({ serverPropertyId = '', rawFileHash = '' } = {}) {
  try {
    const res = await fetch('/api/bulk-import/raw-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        server_property_id: serverPropertyId,
        raw_file_hash: rawFileHash,
      }),
    });
    if (!res.ok) return { exists: false, is_archived: false, is_active: false };
    return await res.json();
  } catch {
    return { exists: false, is_archived: false, is_active: false };
  }
}

/**
 * Upload raw original file directly into R2 raw archive.
 */
export async function uploadRawArchiveToServer({
  serverPropertyId,
  reportType = 'unknown',
  rawFileHash,
  rawArchiveId,
  originalFileName = 'report.csv',
  mimeType = 'application/octet-stream',
  reportDate = null,
  rawBuffer,
}) {
  const headers = {
    'Content-Type': mimeType,
    'x-server-property-id': serverPropertyId,
    'x-report-type': reportType,
    'x-raw-hash': rawFileHash,
    'x-archive-id': rawArchiveId,
    'x-file-name': originalFileName,
  };
  if (reportDate) headers['x-report-date'] = reportDate;

  const res = await fetch('/api/bulk-import/raw-upload', {
    method: 'PUT',
    headers,
    body: rawBuffer,
  });

  if (!res.ok && res.status !== 200) {
    const body = await res.json().catch(() => ({}));
    const err = /** @type {Error & { code?: string }} */ (new Error(body.error || `Raw upload failed with status ${res.status}`));
    err.code = body.code || 'RAW_UPLOAD_FAILED';
    throw err;
  }
  return await res.json();
}

/**
 * Record raw file archival in D1 manifest.
 */
export async function recordRawArchiveOnServer(metadata) {
  const res = await fetch('/api/bulk-import/raw-archive', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(metadata),
  });

  if (!res.ok && res.status !== 200) {
    const body = await res.json().catch(() => ({}));
    const err = /** @type {Error & { code?: string }} */ (new Error(body.error || `Raw archive record failed with status ${res.status}`));
    err.code = body.code || 'RAW_ARCHIVE_RECORD_FAILED';
    throw err;
  }
  return await res.json();
}

/**
 * Fetch pending raw archives waiting for processing.
 */
export async function fetchPendingRawArchives(serverPropertyId = '') {
  try {
    const url = new URL('/api/bulk-import/pending', typeof window !== 'undefined' ? window.location.origin : 'http://localhost');
    if (serverPropertyId) url.searchParams.set('server_property_id', serverPropertyId);
    const res = await fetch(url.toString());
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.pending) ? data.pending : [];
  } catch {
    return [];
  }
}

/**
 * Download exact original raw file from R2 archive.
 */
export async function downloadRawArchiveFromServer(archiveId) {
  const res = await fetch(`/api/bulk-import/raw/${archiveId}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = /** @type {Error & { code?: string }} */ (new Error(body.error || `Download failed with status ${res.status}`));
    err.code = body.code || 'RAW_DOWNLOAD_FAILED';
    throw err;
  }
  const buffer = await res.arrayBuffer();
  const rawHash = res.headers.get('x-raw-hash') || '';
  const rawSize = Number(res.headers.get('x-raw-size') || buffer.byteLength);
  return { buffer, rawHash, rawSize };
}

/**
 * Trigger client browser download for original raw archive.
 */
export async function downloadOriginalFile(archiveId, suggestedFileName) {
  const { buffer, rawHash } = await downloadRawArchiveFromServer(archiveId);
  const blob = new Blob([buffer]);
  if (typeof window !== 'undefined' && window.document) {
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = suggestedFileName || 'original_report.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
  }
  return { ok: true, blob, rawHash };
}

/**
 * Lineage supersede on server.
 */
export async function supersedeBundleOnServer({ oldBundleId, newBundleId }) {
  const res = await fetch('/api/bulk-import/supersede', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ old_bundle_id: oldBundleId, new_bundle_id: newBundleId }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = /** @type {Error & { code?: string }} */ (new Error(body.error || `Supersede failed with status ${res.status}`));
    err.code = body.code || 'SUPERSEDE_FAILED';
    throw err;
  }
  return await res.json();
}

/**
 * Destroy raw archive on server (Owner only).
 */
export async function destroyRawArchiveOnServer({ archiveId, confirmDestroy = false }) {
  const res = await fetch('/api/bulk-import/raw-destroy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ archive_id: archiveId, confirm_destroy: confirmDestroy }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = /** @type {Error & { code?: string }} */ (new Error(body.error || `Destroy failed with status ${res.status}`));
    err.code = body.code || 'DESTROY_FAILED';
    throw err;
  }
  return await res.json();
}

/**
 * Upload compressed bundle to /api/bulk-import/upload
 */
export async function uploadBundleToServer({
  serverPropertyId,
  reportType,
  rawFileHash,
  normalizedHash,
  rowCount,
  compressedBuffer,
}) {
  const payloadSha256 = await sha256Hex(compressedBuffer);
  const res = await fetch('/api/bulk-import/upload', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Content-Encoding': 'gzip',
      'x-server-property-id': serverPropertyId,
      'x-report-type': reportType,
      'x-raw-hash': rawFileHash,
      'x-normalized-hash': normalizedHash,
      'x-payload-sha256': payloadSha256,
      'x-row-count': String(rowCount),
    },
    body: compressedBuffer,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = /** @type {Error & { code?: string }} */ (new Error(body.error || `Upload failed with status ${res.status}`));
    err.code = body.code || 'IMPORT_BUNDLE_UPLOAD_FAILED';
    throw err;
  }
  return await res.json();
}

/**
 * Activate bundle manifest in D1.
 * Consumes exactly 3 D1 writes!
 */
export async function activateBundleOnServer(metadata) {
  const res = await fetch('/api/bulk-import/activate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(metadata),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = /** @type {Error & { code?: string }} */ (new Error(body.error || `Activation failed with status ${res.status}`));
    err.code = body.code || 'IMPORT_BUNDLE_ACTIVATION_FAILED';
    throw err;
  }
  return await res.json();
}

/**
 * Main execution entry point for decoupled bulk import.
 * Phase 1: Permanent untouched raw archival in R2 (Write-Once).
 * Phase 2: Normalized processing and activation in D1.
 */
export async function executeBulkImport(scanResult, meta = {}) {
  const {
    propertyId,
    propertyName = '',
    sourceFile = 'report.csv',
    forceImport = false,
    rawBytes,
    mimeType = 'application/octet-stream',
    onStageChange,
  } = meta;

  if (typeof propertyId !== 'string' || propertyId.trim() === '') {
    const err = /** @type {Error & { code?: string }} */ (new Error('Import refused: a non-empty propertyId is required to persist rows (property isolation boundary).'));
    err.code = 'IMPORT_PROPERTY_REQUIRED';
    throw err;
  }

  const validation = scanResult?.validation;
  if (validation && !validation.ok && !forceImport) {
    const layer = validation.firstFailingLayer || 'validation';
    const detail = validation.errors.map((f) => `${f.code}: ${f.message}`).join(' | ');
    const err = /** @type {Error & { code?: string, validation?: any }} */ (new Error(`Import blocked by ${layer} validation (${validation.errors.length} error(s)): ${detail}`));
    err.code = 'IMPORT_VALIDATION_BLOCKED';
    err.validation = validation;
    throw err;
  }

  // 1. Calculate raw file hash
  const rawFileHash = rawBytes
    ? await sha256Hex(rawBytes)
    : (scanResult.fileHash || await sha256Hex(sourceFile + ':' + (scanResult.totalRows || 0)));

  // 2. Fast duplicate check against server D1 manifest (0 writes!)
  if (!forceImport) {
    const rawCheck = await checkRawDuplicateServer({
      serverPropertyId: propertyId,
      rawFileHash,
    });
    if (rawCheck.exists && rawCheck.is_active) {
      return {
        count: 0,
        excluded: scanResult.totalRows || 0,
        duplicate: true,
        reason: 'Duplicate file — already imported and active. Use Force Import to re-import.',
      };
    }
  }

  // ============================================================================
  // PHASE 1: Permanent One-Shot Raw Archival (Write-Once Immutability)
  // ============================================================================
  const rawArchiveId = `raw_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  let rawObjectKey = '';

  if (rawBytes) {
    onStageChange?.('archiving', 'Uploading original to permanent archive…');
    const uploadRawRes = await uploadRawArchiveToServer({
      serverPropertyId: propertyId,
      reportType: scanResult.type || 'unknown',
      rawFileHash,
      rawArchiveId,
      originalFileName: sourceFile,
      mimeType,
      rawBuffer: rawBytes,
    });
    rawObjectKey = uploadRawRes.raw_object_key;

    // Record raw archive in D1 manifest (1 D1 write)
    await recordRawArchiveOnServer({
      raw_archive_id: rawArchiveId,
      id: rawArchiveId,
      server_property_id: propertyId,
      report_type: scanResult.type || 'unknown',
      raw_file_hash: rawFileHash,
      raw_object_key: rawObjectKey,
      original_file_name: sourceFile,
      file_size: rawBytes.byteLength,
      mime_type: mimeType,
    });
    onStageChange?.('archived', 'Original safely archived');
  }

  // ============================================================================
  // PHASE 2: Normalized Analytics Processing
  // ============================================================================
  onStageChange?.('processing', 'Processing and normalising records…');

  // Build normalized bundle
  const bundleId = rawArchiveId || `imp_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const bundle = buildNormalizedBundle(scanResult, meta, bundleId);

  // Compute normalized hash
  const normalizedHash = await sha256Hex(bundle.ndjson);

  // Preflight check against normalized hash
  if (!forceImport) {
    const dupCheckNormalized = await checkDuplicateServer({
      serverPropertyId: propertyId,
      normalizedHash,
    });
    if (dupCheckNormalized.is_duplicate) {
      return {
        count: 0,
        excluded: bundle.totalRowCount,
        duplicate: true,
        reason: 'Duplicate content — normalized data already imported.',
      };
    }
  }

  // Gzip compression
  const compressedBuffer = await compressPayloadGzip(bundle.ndjson);

  // Upload normalized bundle to R2
  const uploadResult = await uploadBundleToServer({
    serverPropertyId: propertyId,
    reportType: scanResult.type,
    rawFileHash,
    normalizedHash,
    rowCount: bundle.totalRowCount,
    compressedBuffer,
  });

  // Compact D1 activation (Updates raw_archived row, 3 D1 rows written)
  const activationResult = await activateBundleOnServer({
    id: bundleId,
    server_property_id: propertyId,
    report_type: scanResult.type,
    raw_file_hash: rawFileHash,
    normalized_hash: normalizedHash,
    object_key: uploadResult.object_key,
    schema_version: 1,
    row_count: bundle.totalRowCount,
    entity_counts: bundle.entityCounts,
    min_date: bundle.minDate,
    max_date: bundle.maxDate,
    original_file_name: sourceFile,
    file_size: bundle.ndjson.length,
    compressed_size: compressedBuffer.byteLength,
  });

  // Materialize rows directly into local IndexedDB (Dexie)
  const entityTables = Object.keys(bundle.recordsByEntity)
    .filter((ent) => localDb[ent])
    .map((ent) => localDb[ent]);
  const tablesToOpen = localDb.ImportRecordIds
    ? [...entityTables, localDb.ImportRecordIds]
    : entityTables;

  if (tablesToOpen.length > 0) {
    await localDb.transaction('rw', tablesToOpen, async () => {
      for (const [entityName, rows] of Object.entries(bundle.recordsByEntity)) {
        if (localDb[entityName] && rows.length > 0) {
          await localDb[entityName].bulkPut(rows);
          if (localDb.ImportRecordIds) {
            await localDb.ImportRecordIds.put({
              import_id: bundleId,
              entity: entityName,
              record_ids: rows.map((r) => r.id),
              created_date: new Date().toISOString(),
              status: 'active',
            });
          }
        }
      }
    });
  }

  onStageChange?.('done', 'Import complete');

  return {
    ok: true,
    count: bundle.totalRowCount,
    excluded: (scanResult.totalRows || bundle.totalRowCount) - bundle.totalRowCount,
    importId: bundleId,
    bundle_id: bundleId,
    raw_archive_id: rawArchiveId,
    revision: activationResult.revision,
    duplicate: false,
  };
}
