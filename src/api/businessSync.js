import localDb from './localDb.js';
import { toCents } from '../lib/decimal.js';

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
const TRANSACTION_CHUNK_SIZE = 13;
const SYNC_STATE_KEY = 'authoritative-business-data';
const TRANSACTION_OUTBOX_ENTITY = '__business_transaction__';

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

function matchesBusinessFilter(row, filter = {}) {
  return Object.entries(filter).every(([field, condition]) => {
    const value = row?.[field];
    if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
      if ('$gte' in condition && value < condition.$gte) return false;
      if ('$lte' in condition && value > condition.$lte) return false;
      if ('$gt' in condition && value <= condition.$gt) return false;
      if ('$lt' in condition && value >= condition.$lt) return false;
      if ('$in' in condition && !condition.$in.includes(value)) return false;
      if ('$ne' in condition && value === condition.$ne) return false;
      return true;
    }
    return value === condition;
  });
}

function sortBusinessRows(rows, sortField) {
  if (!sortField) return rows;
  const descending = sortField.startsWith('-');
  const field = descending ? sortField.slice(1) : sortField;
  return [...rows].sort((left, right) => {
    const a = left?.[field];
    const b = right?.[field];
    if (a === b) return 0;
    if (a == null) return descending ? 1 : -1;
    if (b == null) return descending ? -1 : 1;
    return (a < b ? -1 : 1) * (descending ? -1 : 1);
  });
}

function centsTotal(rows, field) {
  return rows.reduce((sum, row) => sum + toCents(row?.[field] || 0), 0);
}

async function encodeRow(entity, row, propertyKeyMap = null) {
  assertLosslessJson(row);
  const record_key = typedRecordKey(row.id);
  let property_key = entity === 'Property' ? record_key : typedRecordKey(row.property_id);
  if (entity !== 'Property' && propertyKeyMap && propertyKeyMap.has(property_key)) {
    property_key = propertyKeyMap.get(property_key);
  }
  const row_hash = await sha256Hex(canonicalJson(row));
  return { entity, record_key, property_key, row, row_hash };
}

export async function inspectLocalBusinessData() {
  const propertyRows = await localDb.Property.toArray();
  const propertyKeyMap = new Map();
  for (const p of propertyRows) {
    const key = typedRecordKey(p.id);
    propertyKeyMap.set(key, key);
    if (typeof p.id === 'number' && Number.isSafeInteger(p.id)) {
      propertyKeyMap.set(typedRecordKey(String(p.id)), key);
    } else if (typeof p.id === 'string') {
      const num = Number(p.id);
      if (Number.isSafeInteger(num) && String(num) === p.id) {
        propertyKeyMap.set(typedRecordKey(num), key);
      }
    }
  }
  const records = [];
  const counts = {};
  const table_hashes = {};
  const byEntity = {};
  for (const entity of BUSINESS_ENTITIES) {
    const rows = await localDb[entity].toArray();
    const encoded = [];
    for (const row of rows) encoded.push(await encodeRow(entity, row, propertyKeyMap));
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
    revenue_cents: byEntity.OccupancyDay.map((item) => item.row).reduce((sum, row) => sum + toCents(row?.total_revenue ?? row?.room_revenue ?? 0), 0),
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
  prepareCreate = async (_entity, data) => ({ ...data }),
  prepareUpdate = async (_entity, _previous, data) => ({ ...data }),
}) {
  let hydrationPromise = null;
  let isHydrating = false;
  let lastPullAt = 0;
  let pullPromise = null;
  let activeTransaction = null;
  let transactionPending = false;
  let recoveryPromise = null;

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
      isHydrating = true;
      try {
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
        for (const entity of BUSINESS_ENTITIES) {
          if (snapshot.byEntity[entity].length) {
            const payload = { records: snapshot.byEntity[entity] };
            notify(entity, 'hydrate', payload);
            publish(entity, 'hydrate', payload);
          }
        }
        publish('dataset', 'hydrate', { generation_id: snapshot.generation_id });
        try {
          const { rebuildDailyAggregates } = await import('../lib/dailyAggregates.js');
          await rebuildDailyAggregates();
        } catch (e) {
          // Non-blocking in headless/test environments
        }
        const state = await localDb.BusinessSyncState.get(SYNC_STATE_KEY);
        const applied = await applyFeed(state);
        if (applied.rebuild) {
          hydrationPromise = null;
          return hydrate({ force: true });
        }
        return { active: true, rebuilt: true, ...applied.state };
      } finally {
        isHydrating = false;
      }
    })();
    try { return await hydrationPromise; }
    finally { hydrationPromise = null; }
  }

  async function ensureFresh({ allowDuringTransaction = false } = {}) {
    if (isHydrating) return;
    if (transactionPending && !allowDuringTransaction) return;
    await recoverPendingTransactions();
    // A pull in flight is the only thing that can fill an empty cache, so a
    // concurrent reader must join it instead of skipping it. Returning early
    // here would let that reader treat the pre-hydration cache as
    // authoritative and render an empty dashboard on a clean browser while
    // the server holds the data.
    if (pullPromise) { await pullPromise; return; }
    if (Date.now() - lastPullAt < 2_000) return;
    pullPromise = (async () => {
      try { await flushOutbox(); }
      catch (error) { if (error?.status != null) throw error; }
      await hydrate();
      // Arm the throttle only once the pull has left the cache authoritative.
      // `hydrate` resolves for a completed swap, for an offline fall back to a
      // usable prior cache, and for an inactive dataset; it throws only when no
      // usable cache exists. That case must stay immediately retryable, because
      // throttling after a failed cold pull would make the next reader return a
      // silent empty result instead of retrying or surfacing the error.
      lastPullAt = Date.now();
    })();
    try { await pullPromise; }
    finally { pullPromise = null; }
  }

  async function sendOutboxEntry(entry) {
    try {
      const result = await request('business-sync/mutate', { method: 'POST', body: JSON.stringify(entry.payload) });
      await localDb.BusinessSyncOutbox.delete(entry.mutation_id);
      return result;
    } catch (error) {
      if (error?.status >= 400 && error.status < 500) await localDb.BusinessSyncOutbox.delete(entry.mutation_id);
      throw error;
    }
  }

  async function flushOutbox() {
    const pending = await localDb.BusinessSyncOutbox.orderBy('created_at').toArray();
    const mutations = pending.filter((entry) => entry.entity !== TRANSACTION_OUTBOX_ENTITY);
    for (const entry of mutations) await sendOutboxEntry(entry);
    return { flushed: mutations.length };
  }

  function transactionOperations(transaction) {
    return [...transaction.changes.values()].map((change) => ({
      entity: change.entity,
      operation: change.kind === 'delete' ? 'delete' : 'upsert',
      record_key: change.record_key,
      property_key: change.property_key,
      row: change.kind === 'delete' ? null : change.row,
      base_row_hash: change.kind === 'create' ? null : change.base_row_hash,
    }));
  }

  function transactionNotifications(transaction) {
    return [...transaction.changes.values()].map((change) => ({
      entity: change.entity,
      operation: change.kind,
      row: change.kind === 'delete' ? change.original : change.row,
    }));
  }

  async function finalizeTransactionEntry(entry) {
    await hydrate({ force: true });
    const deferred = Array.isArray(entry.payload?.deferred_import_records) ? entry.payload.deferred_import_records : [];
    const groupedDeferred = new Map();
    for (const item of deferred) {
      const key = canonicalJson([item.import_id, item.entity, item.property_id || '']);
      const group = groupedDeferred.get(key) || { ...item, record_ids: [] };
      group.record_ids.push(...item.record_ids);
      groupedDeferred.set(key, group);
    }
    await localDb.transaction('rw', [localDb.ImportRecordIds, localDb.BusinessSyncOutbox], async () => {
      for (const item of groupedDeferred.values()) {
        const candidates = await localDb.ImportRecordIds.where('[import_id+entity]').equals([item.import_id, item.entity]).toArray();
        const exists = candidates.some((row) => row.transaction_id === entry.mutation_id && String(row.property_id || '') === String(item.property_id || ''));
        if (!exists) {
          await localDb.ImportRecordIds.add({
            import_id: item.import_id,
            property_id: item.property_id || '',
            entity: item.entity,
            record_ids: [...new Set(item.record_ids)],
            status: 'active',
            transaction_id: entry.mutation_id,
            created_date: item.created_date,
          });
        }
      }
      await localDb.BusinessSyncOutbox.delete(entry.mutation_id);
    });
    for (const event of entry.payload?.notifications || []) {
      notify(event.entity, event.operation, event.row);
      publish(event.entity, event.operation, event.row);
    }
  }

  async function executeTransactionEntry(entry) {
    const operations = entry.payload.operations;
    const chunks = [];
    for (let offset = 0; offset < operations.length; offset += TRANSACTION_CHUNK_SIZE) chunks.push(operations.slice(offset, offset + TRANSACTION_CHUNK_SIZE));
    await request('business-sync/transaction/start', {
      method: 'POST',
      body: JSON.stringify({ tx_id: entry.mutation_id, request_hash: entry.payload.request_hash, expected_chunks: chunks.length, operation_count: operations.length }),
    });
    for (let index = 0; index < chunks.length; index += 1) {
      const normalized = chunks[index].map((operation) => ({
        entity: operation.entity,
        operation: operation.operation,
        record_key: operation.record_key,
        property_key: operation.property_key,
        row: operation.row || null,
        base_row_hash: operation.base_row_hash ?? null,
      }));
      await request('business-sync/transaction/chunk', {
        method: 'POST',
        body: JSON.stringify({ tx_id: entry.mutation_id, chunk_index: index, chunk_hash: await sha256Hex(canonicalJson(normalized)), operations: normalized }),
      });
    }
    try {
      await request('business-sync/transaction/commit', { method: 'POST', body: JSON.stringify({ tx_id: entry.mutation_id }) });
    } catch (error) {
      if (error?.status != null) throw error;
      const status = await request(`business-sync/transaction/status?tx_id=${encodeURIComponent(entry.mutation_id)}`);
      if (status.status !== 'committed') throw error;
    }
    await finalizeTransactionEntry(entry);
  }

  async function recoverPendingTransactions() {
    if (recoveryPromise) return recoveryPromise;
    recoveryPromise = (async () => {
      const pending = (await localDb.BusinessSyncOutbox.orderBy('created_at').toArray()).filter((entry) => entry.entity === TRANSACTION_OUTBOX_ENTITY);
      for (const entry of pending) {
        let status;
        try {
          status = await request(`business-sync/transaction/status?tx_id=${encodeURIComponent(entry.mutation_id)}`);
        } catch (error) {
          if (error?.status !== 404) throw error;
        }
        if (status?.status === 'committed') {
          await finalizeTransactionEntry(entry);
        } else if (status?.status === 'pending') {
          try {
            await request('business-sync/transaction/abort', { method: 'POST', body: JSON.stringify({ tx_id: entry.mutation_id }) });
          } catch (error) {
            if (error?.status == null || error.status >= 500) throw error;
          }
          await localDb.BusinessSyncOutbox.delete(entry.mutation_id);
        } else if (!status) {
          await localDb.BusinessSyncOutbox.delete(entry.mutation_id);
        } else if (['aborted', 'expired', 'conflict'].includes(status.status)) {
          await localDb.BusinessSyncOutbox.delete(entry.mutation_id);
        }
      }
    })();
    try { return await recoveryPromise; }
    finally { recoveryPromise = null; }
  }

  async function runTransaction(operations) {
    if (transactionPending || activeTransaction) throw new Error('Nested or concurrent authoritative business transactions are not supported.');
    if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new Error('Authoritative business transaction requires an online connection.');
    transactionPending = true;
    try {
      await ensureFresh({ allowDuringTransaction: true });
      const transaction = { changes: new Map(), deferred_import_records: [] };
      activeTransaction = transaction;
      let results;
      const callbacks = Array.isArray(operations) ? operations : [operations];
      results = [];
      for (const callback of callbacks) results.push(await callback());
      activeTransaction = null;
      const captured = transactionOperations(transaction);
      if (captured.length === 0) return results;
      const txId = `webtx_${crypto.randomUUID()}`;
      const entry = {
        mutation_id: txId,
        entity: TRANSACTION_OUTBOX_ENTITY,
        operation: 'commit',
        created_at: new Date().toISOString(),
        payload: {
          operations: captured,
          request_hash: await sha256Hex(canonicalJson(captured)),
          deferred_import_records: transaction.deferred_import_records,
          notifications: transactionNotifications(transaction),
        },
      };
      await localDb.BusinessSyncOutbox.put(entry);
      try {
        await executeTransactionEntry(entry);
      } catch (error) {
        if (error?.status >= 400 && error.status < 500) {
          try { await request('business-sync/transaction/abort', { method: 'POST', body: JSON.stringify({ tx_id: txId }) }); } catch {}
          await localDb.BusinessSyncOutbox.delete(txId);
        }
        throw error;
      }
      return results;
    } finally {
      activeTransaction = null;
      transactionPending = false;
    }
  }

  function deferImportRecordIds(importId, entity, recordIds, propertyId = '') {
    if (!activeTransaction) return false;
    activeTransaction.deferred_import_records.push({ import_id: importId, entity, record_ids: [...recordIds], property_id: propertyId || '', created_date: new Date().toISOString() });
    return true;
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
    const changeKey = (id) => `${entity}\u0000${typedRecordKey(id)}`;
    const getChange = (id) => activeTransaction?.changes.get(changeKey(id)) || null;
    const putChange = (change) => activeTransaction.changes.set(`${entity}\u0000${change.record_key}`, change);

    async function transactionRow(id) {
      const change = getChange(id);
      if (change) return change.kind === 'delete' ? null : change.row;
      return localProxy.get(id);
    }

    async function transactionRows() {
      const rows = await localProxy.list();
      const byKey = new Map(rows.map((row) => [typedRecordKey(row.id), row]));
      for (const change of activeTransaction.changes.values()) {
        if (change.entity !== entity) continue;
        if (change.kind === 'delete') byKey.delete(change.record_key);
        else byKey.set(change.record_key, change.row);
      }
      return [...byKey.values()];
    }

    async function captureCreate(data) {
      if (entity === 'Property') throw new Error('Property roster changes are not supported inside an authoritative business transaction.');
      const now = new Date().toISOString();
      const prepared = await prepareCreate(entity, data);
      const row = { ...prepared, id: prepared.id ?? crypto.randomUUID(), created_date: prepared.created_date || now, updated_date: now };
      const recordKey = typedRecordKey(row.id);
      const key = changeKey(row.id);
      const current = activeTransaction.changes.get(key);
      if (current?.kind === 'delete') {
        putChange({ ...current, kind: 'update', row, property_key: typedRecordKey(row.property_id) });
        return row;
      }
      if (current || await localProxy.get(row.id)) throw new Error(`${entity} record already exists.`);
      putChange({ entity, kind: 'create', record_key: recordKey, property_key: typedRecordKey(row.property_id), row, original: null, base_row_hash: null });
      return row;
    }

    async function captureUpdate(id, data) {
      if (entity === 'Property') throw new Error('Property roster changes are not supported inside an authoritative business transaction.');
      const key = changeKey(id);
      const current = activeTransaction.changes.get(key);
      if (current?.kind === 'delete') throw new Error(`${entity} record was deleted in this transaction.`);
      const previous = current?.row || await localProxy.get(id);
      if (!previous) throw new Error(`${entity} record not found.`);
      const prepared = await prepareUpdate(entity, previous, data);
      const row = { ...previous, ...prepared, id: previous.id, updated_date: new Date().toISOString() };
      if (current?.kind === 'create') {
        putChange({ ...current, row, property_key: typedRecordKey(row.property_id) });
      } else if (current?.kind === 'update') {
        putChange({ ...current, row, property_key: typedRecordKey(row.property_id) });
      } else {
        putChange({ entity, kind: 'update', record_key: typedRecordKey(previous.id), property_key: typedRecordKey(row.property_id), row, original: previous, base_row_hash: await sha256Hex(canonicalJson(previous)) });
      }
      return row;
    }

    async function captureDelete(id) {
      if (entity === 'Property') throw new Error('Property roster changes are not supported inside an authoritative business transaction.');
      const key = changeKey(id);
      const current = activeTransaction.changes.get(key);
      if (current?.kind === 'create') {
        activeTransaction.changes.delete(key);
        return { success: true };
      }
      if (current?.kind === 'delete') return { success: true };
      const previous = current?.row || await localProxy.get(id);
      if (!previous) return { success: true };
      putChange({ entity, kind: 'delete', record_key: typedRecordKey(previous.id), property_key: typedRecordKey(previous.property_id), row: null, original: current?.original || previous, base_row_hash: current?.base_row_hash || await sha256Hex(canonicalJson(previous)) });
      return { success: true };
    }

    const wrapped = {
      async filter(query = {}, sortField, limit) {
        if (!activeTransaction) { await ensureFresh(); return localProxy.filter(query, sortField, limit); }
        let rows = (await transactionRows()).filter((row) => matchesBusinessFilter(row, query));
        rows = sortBusinessRows(rows, sortField);
        return limit ? rows.slice(0, limit) : rows;
      },
      async list(sortField, limit) {
        if (!activeTransaction) { await ensureFresh(); return localProxy.list(sortField, limit); }
        const rows = sortBusinessRows(await transactionRows(), sortField);
        return limit ? rows.slice(0, limit) : rows;
      },
      async paginate(query = {}, sortField, limit = 50, cursor = null) {
        if (!activeTransaction) { await ensureFresh(); return localProxy.paginate(query, sortField, limit, cursor); }
        let rows = sortBusinessRows((await transactionRows()).filter((row) => matchesBusinessFilter(row, query)), sortField);
        const total = rows.length;
        const field = sortField?.replace(/^-/, '') || 'id';
        if (cursor != null) {
          const index = rows.findIndex((row) => String(row?.[field]) === String(cursor));
          if (index >= 0) rows = rows.slice(index + 1);
        }
        const items = rows.slice(0, limit);
        return { items, total, hasMore: rows.length > limit, nextCursor: items.length ? items.at(-1)?.[field] : null };
      },
      async count(query = {}) {
        if (!activeTransaction) { await ensureFresh(); return localProxy.count(query); }
        return (await transactionRows()).filter((row) => matchesBusinessFilter(row, query)).length;
      },
      async get(id) {
        if (!activeTransaction) { await ensureFresh(); return localProxy.get(id); }
        return transactionRow(id);
      },
      async create(data) {
        if (activeTransaction) return captureCreate(data);
        await ensureFresh();
        const now = new Date().toISOString();
        const prepared = await prepareCreate(entity, data);
        const row = { ...prepared, id: prepared.id ?? crypto.randomUUID(), created_date: prepared.created_date || now, updated_date: now };
        const result = await sendMutation(entity, 'upsert', row, null);
        await table.put(result.row);
        notify(entity, 'create', result.row);
        publish(entity, 'create', result.row);
        return result.row;
      },
      async update(id, data) {
        if (activeTransaction) return captureUpdate(id, data);
        await ensureFresh();
        const previous = await exactLocalGet(table, id);
        if (!previous) throw new Error(`${entity} record not found.`);
        const prepared = await prepareUpdate(entity, previous, data);
        const row = { ...previous, ...prepared, id: previous.id, updated_date: new Date().toISOString() };
        const result = await sendMutation(entity, 'upsert', row, previous);
        await table.put(result.row);
        notify(entity, 'update', result.row);
        publish(entity, 'update', result.row);
        return result.row;
      },
      async delete(id) {
        if (activeTransaction) return captureDelete(id);
        await ensureFresh();
        const previous = await exactLocalGet(table, id);
        if (!previous) return { success: true };
        await sendMutation(entity, 'delete', null, previous);
        await localProxy.delete(previous.id);
        return { success: true };
      },
      async bulkCreate(rows) {
        if (activeTransaction) {
          const created = [];
          for (const row of rows) created.push(await captureCreate(row));
          return created;
        }
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
        if (activeTransaction) {
          for (const id of ids) await captureDelete(id);
          return { success: true, deleted: ids.length };
        }
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
        if (activeTransaction) throw new Error('Authoritative business transactions do not permit an unscoped clear.');
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
      runTransaction,
      deferImportRecordIds,
      recoverPendingTransactions,
    },
  };
}
