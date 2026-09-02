import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import localDb from '@/api/localDb';
import {
  BUSINESS_ENTITIES,
  canonicalJson,
  createBusinessSyncClient,
  inspectLocalBusinessData,
  sha256Hex,
  typedRecordKey,
} from '@/api/businessSync';

async function clearBusinessCache() {
  await localDb.transaction('rw', [...BUSINESS_ENTITIES.map((name) => localDb[name]), localDb.BusinessSyncState, localDb.BusinessSyncOutbox, localDb.ImportRecordIds], async () => {
    for (const entity of BUSINESS_ENTITIES) await localDb[entity].clear();
    await localDb.BusinessSyncState.clear();
    await localDb.BusinessSyncOutbox.clear();
    await localDb.ImportRecordIds.clear();
  });
}

describe('businessSync', () => {
  beforeEach(clearBusinessCache);

  it('preserves numeric and string IDs as distinct migration identities', () => {
    expect(typedRecordKey(7)).toBe('n:7');
    expect(typedRecordKey('7')).toBe('s:1:7');
  });

  it('builds deterministic counts, hashes, and integer-cent baselines', async () => {
    await localDb.Property.bulkPut([
      { id: 7, code: 'NUM', name: 'Numeric' },
      { id: '7', code: 'STR', name: 'String' },
    ]);
    await localDb.OccupancyDay.bulkPut([
      { id: 1, property_id: 7, total_revenue: 10.01, rooms_sold: 2 },
      { id: 2, property_id: '7', total_revenue: 0.02, rooms_sold: 1 },
    ]);
    await localDb.Expense.put({ id: 1, property_id: 7, amount: 1.11 });
    const first = await inspectLocalBusinessData();
    const second = await inspectLocalBusinessData();
    expect(first.manifest.counts.Property).toBe(2);
    expect(first.manifest.counts.OccupancyDay).toBe(2);
    expect(first.manifest.financials.revenue_cents).toBe(1003);
    expect(first.manifest.financials.expenses_cents).toBe(111);
    expect(first.manifest.financials.rooms_sold).toBe(3);
    expect(first.manifest_hash).toBe(second.manifest_hash);
    expect(first.chunks.flatMap((chunk) => chunk.rows).map((row) => row.record_key)).toContain('n:7');
    expect(first.chunks.flatMap((chunk) => chunk.rows).map((row) => row.record_key)).toContain('s:1:7');
  });

  it('reconstructs a completely empty IndexedDB cache from server snapshots', async () => {
    const property = { id: 4, code: 'BOS', name: 'Boston' };
    const expense = { id: 9, property_id: 4, amount: 12.34 };
    const request = async (path) => {
      if (path.startsWith('business-sync/snapshot')) {
        const entity = new URL(`https://x/${path}`).searchParams.get('entity');
        const rows = entity === 'Property' ? [property] : entity === 'Expense' ? [expense] : [];
        return {
          generation_id: 'generation-1', snapshot_revision: 0, scope_fingerprint: 'scope-1', entity,
          items: await Promise.all(rows.map(async (row) => ({ record_key: typedRecordKey(row.id), row_hash: await sha256Hex(canonicalJson(row)), row }))),
          has_more: false, next_cursor: null,
        };
      }
      if (path.startsWith('business-sync/feed')) return { items: [], active_generation_id: 'generation-1', scope_fingerprint: 'scope-1', current_revision: 0, next_revision: 0, has_more: false };
      throw new Error(`unexpected request ${path}`);
    };
    const client = createBusinessSyncClient({ request });
    const result = await client.api.hydrateFromServer();
    expect(result.active).toBe(true);
    expect(result.rebuilt).toBe(true);
    expect(await localDb.Property.toArray()).toEqual([property]);
    expect(await localDb.Expense.toArray()).toEqual([expense]);
    expect((await localDb.BusinessSyncState.get('authoritative-business-data')).generation_id).toBe('generation-1');
  });

  it('does not write to IndexedDB when the authoritative server rejects a create', async () => {
    await localDb.BusinessSyncState.put({ key: 'authoritative-business-data', generation_id: 'generation-1', revision: 0, scope_fingerprint: 'scope-1' });
    const request = async (path) => {
      if (path.startsWith('business-sync/feed')) return { items: [], active_generation_id: 'generation-1', scope_fingerprint: 'scope-1', current_revision: 0, next_revision: 0, has_more: false };
      if (path === 'business-sync/mutate') throw Object.assign(new Error('server rejected'), { status: 409 });
      throw new Error(`unexpected request ${path}`);
    };
    const client = createBusinessSyncClient({ request });
    const localProxy = { create: async () => { throw new Error('local create must not run'); } };
    const proxy = client.wrapEntity('Expense', localProxy);
    await expect(proxy.create({ property_id: 1, amount: 2 })).rejects.toThrow('server rejected');
    expect(await localDb.Expense.count()).toBe(0);
    expect(await localDb.BusinessSyncOutbox.count()).toBe(0);
  });

  it('keeps one durable mutation id across an ambiguous response loss', async () => {
    await localDb.BusinessSyncState.put({ key: 'authoritative-business-data', generation_id: 'generation-1', revision: 0, scope_fingerprint: 'scope-1' });
    const seen = [];
    let failOnce = true;
    const request = async (path, options) => {
      if (path.startsWith('business-sync/feed')) return { items: [], active_generation_id: 'generation-1', scope_fingerprint: 'scope-1', current_revision: 0, next_revision: 0, has_more: false };
      if (path === 'business-sync/mutate') {
        const payload = JSON.parse(options.body);
        seen.push(payload.mutation_id);
        if (failOnce) { failOnce = false; throw new TypeError('response lost'); }
        return { row: payload.row, row_hash: await sha256Hex(canonicalJson(payload.row)), operation: payload.operation };
      }
      throw new Error(`unexpected request ${path}`);
    };
    const client = createBusinessSyncClient({ request });
    const proxy = client.wrapEntity('Expense', {});
    await expect(proxy.create({ property_id: 1, amount: 2 })).rejects.toThrow('response lost');
    expect(await localDb.BusinessSyncOutbox.count()).toBe(1);
    await client.api.syncNow();
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
    expect(await localDb.BusinessSyncOutbox.count()).toBe(0);
  });

  it('keeps a non-transaction mutation durable across an ambiguous 5xx response', async () => {
    await localDb.BusinessSyncState.put({ key: 'authoritative-business-data', generation_id: 'generation-1', revision: 0, scope_fingerprint: 'scope-1' });
    const request = async (path) => {
      if (path.startsWith('business-sync/feed')) return { items: [], active_generation_id: 'generation-1', scope_fingerprint: 'scope-1', current_revision: 0, next_revision: 0, has_more: false };
      if (path === 'business-sync/mutate') throw Object.assign(new Error('upstream unavailable'), { status: 503 });
      throw new Error(`unexpected request ${path}`);
    };
    const client = createBusinessSyncClient({ request });
    const proxy = client.wrapEntity('Expense', {});
    await expect(proxy.create({ property_id: 1, amount: 2 })).rejects.toThrow('upstream unavailable');
    expect(await localDb.BusinessSyncOutbox.count()).toBe(1);
  });

  it('rejects values that JSON would silently alter', async () => {
    await localDb.Property.put({ id: 1, code: 'X', name: 'X', rooms: Number.NaN });
    await expect(inspectLocalBusinessData()).rejects.toThrow('non-lossless number');
  });

  it('rebuilds on an empty feed when the active generation changes', async () => {
    await localDb.Property.put({ id: 1, code: 'OLD', name: 'Old' });
    await localDb.BusinessSyncState.put({ key: 'authoritative-business-data', generation_id: 'generation-1', revision: 7, scope_fingerprint: 'scope-1' });
    const replacement = { id: 2, code: 'NEW', name: 'New' };
    const request = async (path) => {
      if (path.startsWith('business-sync/feed')) return { items: [], active_generation_id: 'generation-2', scope_fingerprint: 'scope-1', current_revision: 7, next_revision: 7, has_more: false };
      if (path.startsWith('business-sync/snapshot')) {
        const entity = new URL(`https://x/${path}`).searchParams.get('entity');
        const rows = entity === 'Property' ? [replacement] : [];
        return { generation_id: 'generation-2', snapshot_revision: 7, scope_fingerprint: 'scope-1', entity, items: await Promise.all(rows.map(async (row) => ({ record_key: typedRecordKey(row.id), row_hash: await sha256Hex(canonicalJson(row)), row }))), has_more: false, next_cursor: null };
      }
      throw new Error(`unexpected request ${path}`);
    };
    const client = createBusinessSyncClient({ request });
    const result = await client.api.syncNow();
    expect(result.rebuilt).toBe(true);
    expect(await localDb.Property.toArray()).toEqual([replacement]);
  });

  it('does not let a concurrent read observe the pre-hydration cache', async () => {
    const expense = { id: 9, property_id: 4, amount: 12.34 };
    /** @type {() => void} */
    let releaseSnapshot = () => {};
    /** @type {() => void} */
    let markSnapshotRequested = () => {};
    const snapshotGate = new Promise((resolve) => { releaseSnapshot = () => resolve(); });
    const snapshotRequested = new Promise((resolve) => { markSnapshotRequested = () => resolve(); });
    let firstPageHeld = false;
    const request = async (path) => {
      if (path.startsWith('business-sync/snapshot')) {
        if (!firstPageHeld) { firstPageHeld = true; markSnapshotRequested(); await snapshotGate; }
        const entity = new URL(`https://x/${path}`).searchParams.get('entity');
        const rows = entity === 'Expense' ? [expense] : [];
        return {
          generation_id: 'generation-1', snapshot_revision: 0, scope_fingerprint: 'scope-1', entity,
          items: await Promise.all(rows.map(async (row) => ({ record_key: typedRecordKey(row.id), row_hash: await sha256Hex(canonicalJson(row)), row }))),
          has_more: false, next_cursor: null,
        };
      }
      if (path.startsWith('business-sync/feed')) return { items: [], active_generation_id: 'generation-1', scope_fingerprint: 'scope-1', current_revision: 0, next_revision: 0, has_more: false };
      throw new Error(`unexpected request ${path}`);
    };
    const client = createBusinessSyncClient({ request });
    const proxy = client.wrapEntity('Expense', { filter: async () => localDb.Expense.toArray() });
    // Two dashboard panels read the same entity in the same tick, exactly as the
    // page does. Neither read may resolve against the still-empty cache while the
    // authoritative snapshot for this browser is still downloading.
    const first = proxy.filter({});
    const second = proxy.filter({});
    await snapshotRequested;
    releaseSnapshot();
    const [firstRows, secondRows] = await Promise.all([first, second]);
    expect(firstRows).toEqual([expense]);
    expect(secondRows).toEqual([expense]);
  });
});

describe('authoritative business transactions', () => {
  beforeEach(async () => {
    await clearBusinessCache();
    await localDb.BusinessSyncState.put({ key: 'authoritative-business-data', generation_id: 'gen-tx', revision: 0, scope_fingerprint: 'scope-tx' });
  });

  const localExpenseProxy = () => ({
    list: () => localDb.Expense.toArray(),
    get: (id) => localDb.Expense.get(id),
  });

  const baseTxRequest = async (path, _options = {}) => {
    if (path.startsWith('business-sync/feed')) return { items: [], active_generation_id: 'gen-tx', scope_fingerprint: 'scope-tx', current_revision: 0, next_revision: 0, has_more: false };
    if (path === 'business-sync/transaction/start') return { status: 'pending' };
    if (path === 'business-sync/transaction/chunk') return { accepted: true };
    if (path === 'business-sync/transaction/commit') return { status: 'committed' };
    if (path.startsWith('business-sync/snapshot')) {
      const entity = new URL(`https://x/${path}`).searchParams.get('entity');
      return { generation_id: 'gen-tx', snapshot_revision: 1, scope_fingerprint: 'scope-tx', entity, items: [], has_more: false, next_cursor: null };
    }
    throw new Error(`unexpected request ${path}`);
  };

  it('chunks more than 13 operations without writing local rows before commit', async () => {
    const chunkSizes = [];
    let countAtCommit = -1;
    const request = async (path, options) => {
      if (path === 'business-sync/transaction/chunk') chunkSizes.push(JSON.parse(options.body).operations.length);
      if (path === 'business-sync/transaction/commit') countAtCommit = await localDb.Expense.count();
      return baseTxRequest(path, options);
    };
    const client = createBusinessSyncClient({ request });
    const proxy = client.wrapEntity('Expense', localExpenseProxy());
    await client.api.runTransaction(async () => {
      for (let id = 1; id <= 14; id += 1) await proxy.create({ id, property_id: 1, amount: id });
    });
    expect(chunkSizes).toEqual([13, 1]);
    expect(countAtCommit).toBe(0);
  });

  it('collapses create-update and lets reads observe the overlay', async () => {
    const sent = [];
    const request = async (path, options) => {
      if (path === 'business-sync/transaction/chunk') sent.push(...JSON.parse(options.body).operations);
      return baseTxRequest(path, options);
    };
    const client = createBusinessSyncClient({ request });
    const proxy = client.wrapEntity('Expense', localExpenseProxy());
    await client.api.runTransaction(async () => {
      await proxy.create({ id: 1, property_id: 7, amount: 10 });
      await proxy.update(1, { amount: 20 });
      expect(await proxy.filter({ property_id: 7 })).toMatchObject([{ id: 1, property_id: 7, amount: 20 }]);
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ operation: 'upsert', record_key: 'n:1', property_key: 'n:7', base_row_hash: null, row: { amount: 20 } });
  });

  it('cancels create-delete without starting a server transaction', async () => {
    const transactionPaths = [];
    const request = async (path, options) => {
      if (path.startsWith('business-sync/transaction/')) transactionPaths.push(path);
      return baseTxRequest(path, options);
    };
    const client = createBusinessSyncClient({ request });
    const proxy = client.wrapEntity('Expense', localExpenseProxy());
    await client.api.runTransaction(async () => {
      await proxy.create({ id: 1, property_id: 7, amount: 10 });
      await proxy.delete(1);
    });
    expect(transactionPaths).toEqual([]);
    expect(await localDb.BusinessSyncOutbox.count()).toBe(0);
  });

  it('rejects nested and concurrent transactions before callbacks can interleave', async () => {
    const client = createBusinessSyncClient({ request: baseTxRequest });
    await expect(client.api.runTransaction(async () => client.api.runTransaction(async () => {}))).rejects.toThrow('Nested or concurrent');
    /** @type {() => void} */
    let release = () => {};
    const gate = new Promise((resolve) => { release = () => resolve(); });
    const first = client.api.runTransaction(async () => gate);
    await expect(client.api.runTransaction(async () => {})).rejects.toThrow('Nested or concurrent');
    release();
    await first;
  });

  it('aborts and clears the outbox after a controlled commit conflict', async () => {
    let aborted = false;
    const request = async (path, options) => {
      if (path === 'business-sync/transaction/commit') throw Object.assign(new Error('conflict'), { status: 409 });
      if (path === 'business-sync/transaction/abort') { aborted = true; return { status: 'aborted' }; }
      return baseTxRequest(path, options);
    };
    const client = createBusinessSyncClient({ request });
    const proxy = client.wrapEntity('Expense', localExpenseProxy());
    await expect(client.api.runTransaction(async () => proxy.create({ id: 1, property_id: 7, amount: 1 }))).rejects.toThrow('conflict');
    expect(aborted).toBe(true);
    expect(await localDb.BusinessSyncOutbox.count()).toBe(0);
  });

  it('preserves the durable outbox after an ambiguous 5xx commit response', async () => {
    let aborted = false;
    const request = async (path, options) => {
      if (path === 'business-sync/transaction/commit') throw Object.assign(new Error('gateway timeout'), { status: 504 });
      if (path === 'business-sync/transaction/abort') aborted = true;
      return baseTxRequest(path, options);
    };
    const client = createBusinessSyncClient({ request });
    const proxy = client.wrapEntity('Expense', localExpenseProxy());
    await expect(client.api.runTransaction(async () => proxy.create({ id: 1, property_id: 7, amount: 1 }))).rejects.toThrow('gateway timeout');
    expect(aborted).toBe(false);
    expect(await localDb.BusinessSyncOutbox.count()).toBe(1);
  });

  it('validates property moves through the transaction update authorizer', async () => {
    await localDb.Expense.put({ id: 1, property_id: 7, amount: 1 });
    const prepareUpdate = async (_entity, _previous, data) => {
      if (data.property_id === 8) throw new Error('unauthorized property move');
      return data;
    };
    const client = createBusinessSyncClient({ request: baseTxRequest, prepareUpdate });
    const proxy = client.wrapEntity('Expense', localExpenseProxy());
    await expect(client.api.runTransaction(async () => proxy.update(1, { property_id: 8 }))).rejects.toThrow('unauthorized property move');
    expect(await localDb.BusinessSyncOutbox.count()).toBe(0);
    expect((await localDb.Expense.get(1)).property_id).toBe(7);
  });

  it('recovers a committed response loss through status and finalizes once', async () => {
    let commitAttempts = 0;
    const request = async (path, options) => {
      if (path === 'business-sync/transaction/commit') { commitAttempts += 1; throw new TypeError('response lost'); }
      if (path.startsWith('business-sync/transaction/status')) return { status: 'committed' };
      return baseTxRequest(path, options);
    };
    const client = createBusinessSyncClient({ request });
    const proxy = client.wrapEntity('Expense', localExpenseProxy());
    await client.api.runTransaction(async () => {
      const created = await proxy.create({ id: 1, property_id: 7, amount: 1 });
      expect(client.api.deferImportRecordIds('import-1', 'Expense', [created.id], '7')).toBe(true);
      expect(client.api.deferImportRecordIds('import-1', 'Expense', [2], '7')).toBe(true);
    });
    expect(commitAttempts).toBe(1);
    expect(await localDb.BusinessSyncOutbox.count()).toBe(0);
    const ledger = await localDb.ImportRecordIds.toArray();
    expect(ledger).toHaveLength(1);
    expect(ledger[0].record_ids).toEqual([1, 2]);
  });

  it('aborts a pending durable transaction on reload instead of ghost-committing it', async () => {
    const txId = 'webtx_00000000-0000-4000-8000-000000000001';
    await localDb.BusinessSyncOutbox.put({
      mutation_id: txId,
      entity: '__business_transaction__',
      operation: 'commit',
      created_at: new Date().toISOString(),
      payload: { operations: [], request_hash: await sha256Hex('pending'), deferred_import_records: [], notifications: [] },
    });
    let aborted = false;
    let committed = false;
    const request = async (path, options) => {
      if (path.startsWith('business-sync/transaction/status')) return { status: 'pending' };
      if (path === 'business-sync/transaction/abort') { aborted = true; throw Object.assign(new Error('already expired'), { status: 404 }); }
      if (path === 'business-sync/transaction/commit') committed = true;
      return baseTxRequest(path, options);
    };
    const client = createBusinessSyncClient({ request });
    await client.api.recoverPendingTransactions();
    expect(aborted).toBe(true);
    expect(committed).toBe(false);
    expect(await localDb.BusinessSyncOutbox.count()).toBe(0);
  });

  it('recovers a prior ambiguous transaction before an immediate retry callback', async () => {
    const events = [];
    let firstChunk = true;
    const request = async (path, options) => {
      if (path === 'business-sync/transaction/chunk' && firstChunk) { firstChunk = false; throw new TypeError('network lost'); }
      if (path.startsWith('business-sync/transaction/status')) { events.push('status'); return { status: 'pending' }; }
      if (path === 'business-sync/transaction/abort') { events.push('abort'); return { status: 'aborted' }; }
      return baseTxRequest(path, options);
    };
    const client = createBusinessSyncClient({ request });
    const proxy = client.wrapEntity('Expense', localExpenseProxy());
    await expect(client.api.runTransaction(async () => proxy.create({ id: 1, property_id: 7, amount: 1 }))).rejects.toThrow('network lost');
    await client.api.runTransaction(async () => {
      events.push('retry-callback');
      await proxy.create({ id: 2, property_id: 7, amount: 2 });
    });
    expect(events.slice(0, 3)).toEqual(['status', 'abort', 'retry-callback']);
  });

  it('does not let a concurrent read abort the foreground transaction', async () => {
    const events = [];
    /** @type {() => void} */
    let releaseChunk = () => {};
    /** @type {() => void} */
    let markChunkStarted = () => {};
    const chunkGate = new Promise((resolve) => { releaseChunk = () => resolve(); });
    const chunkStarted = new Promise((resolve) => { markChunkStarted = () => resolve(); });
    const request = async (path, options) => {
      if (path === 'business-sync/transaction/chunk') {
        events.push('chunk');
        markChunkStarted();
        await chunkGate;
      }
      if (path.startsWith('business-sync/transaction/status')) events.push('status');
      if (path === 'business-sync/transaction/abort') events.push('abort');
      return baseTxRequest(path, options);
    };
    const client = createBusinessSyncClient({ request });
    const proxy = client.wrapEntity('Expense', localExpenseProxy());
    const committing = client.api.runTransaction(async () => proxy.create({ id: 1, property_id: 7, amount: 1 }));
    await chunkStarted;
    await proxy.list();
    releaseChunk();
    await committing;
    expect(events).toEqual(['chunk']);
  });

  it('notifies affected entities after forced snapshot hydration', async () => {
    const events = [];
    const published = [];
    const request = async (path) => {
      if (path.startsWith('business-sync/snapshot')) {
        const entity = new URL(`https://x/${path}`).searchParams.get('entity');
        const rows = entity === 'Expense' ? [{ id: 9, property_id: 7, amount: 9 }] : [];
        return { generation_id: 'gen-tx', snapshot_revision: 1, scope_fingerprint: 'scope-tx', entity, items: await Promise.all(rows.map(async (row) => ({ record_key: typedRecordKey(row.id), row_hash: await sha256Hex(canonicalJson(row)), row }))), has_more: false, next_cursor: null };
      }
      if (path.startsWith('business-sync/feed')) return { items: [], active_generation_id: 'gen-tx', scope_fingerprint: 'scope-tx', current_revision: 1, next_revision: 1, has_more: false };
      throw new Error(`unexpected request ${path}`);
    };
    const client = createBusinessSyncClient({ request, notify: (...args) => events.push(args), publish: (...args) => published.push(args) });
    await client.api.hydrateFromServer();
    expect(events).toContainEqual(['Expense', 'hydrate', { records: [{ id: 9, property_id: 7, amount: 9 }] }]);
    expect(published).toContainEqual(['Expense', 'hydrate', { records: [{ id: 9, property_id: 7, amount: 9 }] }]);
  });
});
