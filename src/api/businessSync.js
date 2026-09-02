import localDb from '@/api/localDb';
import { toCents } from '@/lib/decimal';

export const BUSINESS_ENTITIES = Object.freeze([
  'Property', 'OccupancyDay', 'SourceDay', 'GrossRevenueDay', 'PaymentDay',
  'ClerkShiftRecord', 'UploadedReport', 'Expense', 'PayrollRun', 'Staff',
  'HotelMetric', 'TransactionLine', 'AnomalyAlert', 'Room', 'RoomStay',
  'HousekeepingTask', 'WeatherSnapshot', 'Review', 'AdjustmentRefund',
  'DailyFinancialAggregate', 'ScanResult', 'TimecardPunch', 'Reservation',
  'RoomType', 'ChannelMap',
]);
const ENTITY_SET = new Set(BUSINESS_ENTITIES);
const CHUNK_SIZE = 40;
const SYNC_STATE_KEY = 'authoritative-business-data';

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function assertLosslessJson(value, path = 'row') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new Error(`${path} contains a non-lossless number.`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertLosslessJson(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, item] of Object.entries(value)) assertLosslessJson(item, `${path}.${key}`);
    return;
  }
  throw new Error(`${path} is not lossless JSON.`);
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(typeof value === 'string' ? value : canonicalJson(value));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (part) => part.toString(16).padStart(2, '0')).join('');
}

export function typedRecordKey(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return `n:${value}`;
  if (typeof value === 'string') return `s:${value.length}:${value}`;
  throw new Error('Business record id must be a safe integer or string.');
}

function centsTotal(rows, field) {
  return rows.reduce((sum, row) => sum + toCents(row?.[field] || 0), 0);
}

async function encodeRow(entity, row) {
  assertLosslessJson(row);
  const record_key = typedRecordKey(row.id);
  const property_key = entity === 'Property' ? record_key : typedRecordKey(row.property_id);
  const row_hash = await sha256Hex(canonicalJson(row));
  return { entity, record_key, property_key, row, row_hash };
}

export async function inspectLocalBusinessData() {
  const records = [];
  const counts = {};
  const table_hashes = {};
  const byEntity = {};
  for (const entity of BUSINESS_ENTITIES) {
    const rows = await localDb[entity].toArray();
    const encoded = [];
    for (const row of rows) encoded.push(await encodeRow(entity, row));
    encoded.sort((left, right) => left.record_key.localeCompare(right.record_key));
    byEntity[entity] = encoded;
    counts[entity] = encoded.length;
    table_hashes[entity] = await sha256Hex(canonicalJson(encoded));
    records.push(...encoded);
  }
  const chunks = [];
  for (let offset = 0; offset < records.length; offset += CHUNK_SIZE) {
    const rows = records.slice(offset, offset + CHUNK_SIZE);
    chunks.push({ index: chunks.length, count: rows.length, hash: await sha256Hex(canonicalJson(rows)), rows });
  }
  const financials = {
    revenue_cents: centsTotal(byEntity.OccupancyDay.map((item) => item.row), 'total_revenue'),
    payments_cents: centsTotal(byEntity.PaymentDay.map((item) => item.row), 'total'),
    refunds_cents: centsTotal(byEntity.AdjustmentRefund.map((item) => item.row), 'amount'),
    expenses_cents: centsTotal(byEntity.Expense.map((item) => item.row), 'amount'),
    payroll_cents: centsTotal(byEntity.PayrollRun.map((item) => item.row), 'total_pay'),
    rooms_sold: byEntity.OccupancyDay.reduce((sum, item) => sum + (Number(item.row.rooms_sold) || 0), 0),
  };
  const manifest = {
    schema_version: 1,
    counts,
    table_hashes,
    financials,
    chunks: chunks.map(({ index, count, hash }) => ({ index, count, hash })),
  };
  return {
    created_at: new Date().toISOString(),
    manifest,
    manifest_hash: await sha256Hex(canonicalJson(manifest)),
    chunks,
    total_records: records.length,
  };
}

export function downloadBusinessBackup(snapshot, filename = `rri-business-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`) {
  if (typeof document === 'undefined' || typeof URL?.createObjectURL !== 'function') {
    throw new Error('A browser is required to download the business-data backup.');
  }
  const payload = {
    format: 'rri-business-backup-v1',
    created_at: snapshot.created_at,
    manifest: snapshot.manifest,
    manifest_hash: snapshot.manifest_hash,
    records: snapshot.chunks.flatMap((chunk) => chunk.rows),
  };
  const url = URL.createObjectURL(new Blob([canonicalJson(payload)], { type: 'application/json' }));
  const link = document.createElement('a');
  try {
    link.href = url;
    link.download = filename;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
  } finally {
    link.remove();
    URL.revokeObjectURL(url);
  }
  return filename;
}

async function exactLocalGet(table, id) {
  return (await table.get(id)) || null;
}

function decodeRecordKey(key) {
  if (String(key).startsWith('n:')) return Number(String(key).slice(2));
  const match = /^s:\d+:(.*)$/s.exec(String(key));
  return match ? match[1] : key;
}

export function createBusinessSyncClient({
  request,
  notify = (_entity = '', _operation = '', _row = null) => {},
  publish = (_entity = '', _operation = '', _row = null) => {},
}) {
  let hydrationPromise = null;
  let lastPullAt = 0;

  async function requestOptional(path, options) {
    try { return await request(path, options); }
    catch (error) {
      if (error?.status === 404 && error?.body?.code === 'no_active_dataset') return null;
      throw error;
    }
  }

  async function migrateLocalData({ snapshot: reviewedSnapshot = null, downloadBackup = true, onProgress = (_event = null) => {} } = {}) {
    const currentSnapshot = await inspectLocalBusinessData();
    if (reviewedSnapshot && reviewedSnapshot.manifest_hash !== currentSnapshot.manifest_hash) {
      throw new Error('Local business data changed after review. Inspect and confirm the new baseline before migrating.');
    }
    const snapshot = reviewedSnapshot || currentSnapshot;
    if (!snapshot.total_records) throw new Error('There is no local business data to migrate.');
    const backup_filename = downloadBackup ? downloadBusinessBackup(snapshot) : null;
    onProgress({ phase: 'backup', backup_filename, total_records: snapshot.total_records });
    const started = await request('business-sync/migration/start', { method: 'POST', body: JSON.stringify({ manifest: snapshot.manifest, manifest_hash: snapshot.manifest_hash }) });
    if (started.status === 'active') {
      const status = await request(`business-sync/migration/status?generation_id=${encodeURIComponent(started.generation_id)}`);
      if (status.received_records !== snapshot.total_records) throw new Error('Active migration replay does not match the reviewed baseline.');
      await hydrate({ force: true });
      onProgress({ phase: 'active', generation_id: started.generation_id, replayed: true });
      return { generation_id: started.generation_id, status, replayed: true, backup_filename, baseline: snapshot.manifest };
    }
    for (const chunk of snapshot.chunks) {
      await request('business-sync/migration/chunk', { method: 'POST', body: JSON.stringify({ generation_id: started.generation_id, chunk_index: chunk.index, chunk_hash: chunk.hash, rows: chunk.rows }) });
      onProgress({ phase: 'upload', completed_chunks: chunk.index + 1, total_chunks: snapshot.chunks.length });
    }
    const activated = await request('business-sync/migration/activate', { method: 'POST', body: JSON.stringify({ generation_id: started.generation_id }) });
    const status = await request(`business-sync/migration/status?generation_id=${encodeURIComponent(started.generation_id)}`);
    if (status.status !== 'active' || status.received_records !== snapshot.total_records) {
      throw new Error('Server activation did not reconcile with the local baseline.');
    }
    await localDb.BusinessSyncState.put({ key: SYNC_STATE_KEY, generation_id: started.generation_id, revision: 0, manifest_hash: snapshot.manifest_hash, updated_at: new Date().toISOString() });
    onProgress({ phase: 'active', generation_id: started.generation_id });
    return { ...activated, status, backup_filename, baseline: snapshot.manifest };
  }

  async function fetchSnapshot() {
    const byEntity = {};
    let generationId = null;
    let snapshotRevision = null;
    let scopeFingerprint = null;
    for (const entity of BUSINESS_ENTITIES) {
      const rows = [];
      let cursor = '';
      do {
        const revisionQuery = snapshotRevision == null ? '' : `&snapshot_revision=${snapshotRevision}`;
        const page = await requestOptional(`business-sync/snapshot?entity=${encodeURIComponent(entity)}&cursor=${encodeURIComponent(cursor)}&limit=500${revisionQuery}`);
        if (page === null) return null;
        if (generationId !== null && generationId !== page.generation_id) throw new Error('Authoritative dataset changed during snapshot; retry sync.');
        if (snapshotRevision !== null && snapshotRevision !== Number(page.snapshot_revision)) throw new Error('Snapshot revision changed during download; retry sync.');
        if (scopeFingerprint !== null && scopeFingerprint !== page.scope_fingerprint) throw new Error('Property access changed during snapshot; retry sync.');
        generationId = page.generation_id;
        snapshotRevision = Number(page.snapshot_revision) || 0;
        scopeFingerprint = page.scope_fingerprint;
        rows.push(...page.items.map((item) => item.row));
        cursor = page.has_more ? page.next_cursor : '';
      } while (cursor);
      byEntity[entity] = rows;
    }
    return { generation_id: generationId, revision: snapshotRevision || 0, scope_fingerprint: scopeFingerprint, byEntity };
  }

  async function applyFeed(state) {
    let revision = Number(state.revision) || 0;
    let hasMore;
    do {
      const page = await request(`business-sync/feed?since=${revision}&limit=500`);
      if (page.active_generation_id !== state.generation_id || page.scope_fingerprint !== state.scope_fingerprint || page.rebuild_required) {
        return { rebuild: true };
      }
      for (const change of page.items) {
        if (change.generation_id !== state.generation_id || change.operation === 'property_delete') return { rebuild: true };
        const table = localDb[change.entity_name];
        if (!table) continue;
        if (change.operation === 'delete') await table.delete(change.row?.id ?? decodeRecordKey(change.record_key));
        else await table.put(change.row);
        notify(change.entity_name, change.operation, change.row);
        publish(change.entity_name, change.operation, change.row);
        revision = Number(change.seq);
      }
      hasMore = page.has_more;
      if (!page.items.length) revision = Math.max(revision, Number(page.current_revision) || revision);
    } while (hasMore);
    const next = { ...state, revision, updated_at: new Date().toISOString() };
    await localDb.BusinessSyncState.put(next);
    return { rebuild: false, state: next };
  }

  async function hydrate({ force = false } = {}) {
    if (hydrationPromise) return hydrationPromise;
    hydrationPromise = (async () => {
      const prior = await localDb.BusinessSyncState.get(SYNC_STATE_KEY);
      if (!force && prior?.generation_id) {
        try {
          const applied = await applyFeed(prior);
          if (!applied.rebuild) return { active: true, rebuilt: false, ...applied.state };
        } catch (error) {
          if ((typeof navigator !== 'undefined' && navigator.onLine === false) || error?.status == null) return { active: true, offline: true, rebuilt: false, ...prior };
          throw error;
        }
      }
      let snapshot;
      try { snapshot = await fetchSnapshot(); }
      catch (error) {
        if (prior && ((typeof navigator !== 'undefined' && navigator.onLine === false) || error?.status == null)) return { active: true, offline: true, rebuilt: false, ...prior };
        throw error;
      }
      if (!snapshot) return { active: false, rebuilt: false };
      // Existing cache remains untouched until every authoritative table has
      // downloaded. The transaction then swaps all business stores together.
      await localDb.transaction('rw', [...BUSINESS_ENTITIES.map((name) => localDb[name]), localDb.BusinessSyncState], async () => {
        for (const entity of BUSINESS_ENTITIES) {
          await localDb[entity].clear();
          if (snapshot.byEntity[entity].length) await localDb[entity].bulkPut(snapshot.byEntity[entity]);
        }
        await localDb.BusinessSyncState.put({ key: SYNC_STATE_KEY, generation_id: snapshot.generation_id, revision: snapshot.revision, scope_fingerprint: snapshot.scope_fingerprint, updated_at: new Date().toISOString() });
      });
      const state = await localDb.BusinessSyncState.get(SYNC_STATE_KEY);
      const applied = await applyFeed(state);
      if (applied.rebuild) {
        hydrationPromise = null;
        return hydrate({ force: true });
      }
      return { active: true, rebuilt: true, ...applied.state };
    })();
    try { return await hydrationPromise; }
    finally { hydrationPromise = null; }
  }

  async function ensureFresh() {
    const now = Date.now();
    if (now - lastPullAt < 2_000) return;
    lastPullAt = now;
    try { await flushOutbox(); }
    catch (error) { if (error?.status != null) throw error; }
    await hydrate();
  }

  async function sendOutboxEntry(entry) {
    try {
      const result = await request('business-sync/mutate', { method: 'POST', body: JSON.stringify(entry.payload) });
      await localDb.BusinessSyncOutbox.delete(entry.mutation_id);
      return result;
    } catch (error) {
      if (error?.status != null) await localDb.BusinessSyncOutbox.delete(entry.mutation_id);
      throw error;
    }
  }

  async function flushOutbox() {
    const pending = await localDb.BusinessSyncOutbox.orderBy('created_at').toArray();
    for (const entry of pending) await sendOutboxEntry(entry);
    return { flushed: pending.length };
  }

  async function sendMutation(entity, operation, row, previous = null) {
    const effective = row || previous;
    if (row) assertLosslessJson(row);
    const mutation_id = `web_${crypto.randomUUID()}`;
    const payload = {
      mutation_id,
      entity,
      operation,
      record_key: typedRecordKey(effective.id),
      property_key: entity === 'Property' ? typedRecordKey(effective.id) : typedRecordKey(effective.property_id),
      row: row || undefined,
      base_row_hash: previous ? await sha256Hex(canonicalJson(previous)) : null,
    };
    const entry = { mutation_id, entity, operation, payload, created_at: new Date().toISOString() };
    await localDb.BusinessSyncOutbox.put(entry);
    return sendOutboxEntry(entry);
  }

  function wrapEntity(entity, localProxy) {
    if (!ENTITY_SET.has(entity)) return localProxy;
    const table = localDb[entity];
    const wrapped = {
      async filter(...args) { await ensureFresh(); return localProxy.filter(...args); },
      async list(...args) { await ensureFresh(); return localProxy.list(...args); },
      async paginate(...args) { await ensureFresh(); return localProxy.paginate(...args); },
      async count(...args) { await ensureFresh(); return localProxy.count(...args); },
      async get(...args) { await ensureFresh(); return localProxy.get(...args); },
      async create(data) {
        await ensureFresh();
        const now = new Date().toISOString();
        const row = { ...data, id: data.id ?? crypto.randomUUID(), created_date: data.created_date || now, updated_date: now };
        const result = await sendMutation(entity, 'upsert', row, null);
        await table.put(result.row);
        notify(entity, 'create', result.row);
        publish(entity, 'create', result.row);
        return result.row;
      },
      async update(id, data) {
        await ensureFresh();
        const previous = await exactLocalGet(table, id);
        if (!previous) throw new Error(`${entity} record not found.`);
        const row = { ...previous, ...data, id: previous.id, updated_date: new Date().toISOString() };
        const result = await sendMutation(entity, 'upsert', row, previous);
        await table.put(result.row);
        notify(entity, 'update', result.row);
        publish(entity, 'update', result.row);
        return result.row;
      },
      async delete(id) {
        await ensureFresh();
        const previous = await exactLocalGet(table, id);
        if (!previous) return { success: true };
        await sendMutation(entity, 'delete', null, previous);
        await localProxy.delete(previous.id);
        return { success: true };
      },
      async bulkCreate(rows) {
        const created = [];
        try {
          for (const row of rows) created.push(await wrapped.create(row));
          return created;
        } catch (error) {
          const cleanupFailures = [];
          for (const row of created.reverse()) {
            try { await wrapped.delete(row.id); } catch (cleanupError) { cleanupFailures.push(cleanupError); }
          }
          if (cleanupFailures.length) throw new AggregateError([error, ...cleanupFailures], 'Bulk create failed and server compensation was incomplete.');
          throw error;
        }
      },
      async bulkDelete(ids) {
        const deleted = [];
        try {
          for (const id of ids) {
            const row = await exactLocalGet(table, id);
            if (row) deleted.push(row);
            await wrapped.delete(id);
          }
          return { success: true, deleted: deleted.length };
        } catch (error) {
          const cleanupFailures = [];
          for (const row of deleted) {
            try { await wrapped.create(row); } catch (cleanupError) { cleanupFailures.push(cleanupError); }
          }
          if (cleanupFailures.length) throw new AggregateError([error, ...cleanupFailures], 'Bulk delete failed and server compensation was incomplete.');
          throw error;
        }
      },
      async clear() {
        throw new Error('Authoritative sync does not permit an unscoped clear. Delete records through a scoped, auditable workflow.');
      },
    };
    return wrapped;
  }

  return {
    wrapEntity,
    api: {
      inspectLocalBusinessData,
      downloadBusinessBackup,
      migrateLocalData,
      hydrateFromServer: () => hydrate({ force: true }),
      syncNow: async () => { await flushOutbox(); return hydrate(); },
      reserveIdSequence: (prefix, floor) => request('business-sync/id-sequence/reserve', { method: 'POST', body: JSON.stringify({ prefix, floor }) }),
      status: () => localDb.BusinessSyncState.get(SYNC_STATE_KEY),
    },
  };
}
