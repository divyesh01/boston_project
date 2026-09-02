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
  await localDb.transaction('rw', [...BUSINESS_ENTITIES.map((name) => localDb[name]), localDb.BusinessSyncState, localDb.BusinessSyncOutbox], async () => {
    for (const entity of BUSINESS_ENTITIES) await localDb[entity].clear();
    await localDb.BusinessSyncState.clear();
    await localDb.BusinessSyncOutbox.clear();
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
});
