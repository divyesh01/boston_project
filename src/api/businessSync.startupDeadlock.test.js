import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import localDb from '@/api/localDb';
import { BUSINESS_ENTITIES, createBusinessSyncClient } from '@/api/businessSync';
import { rebuildDailyAggregates } from '@/lib/dailyAggregates';
import { hydrateAuthenticatedData } from '@/lib/startupHydration';

// A business entity read made during hydration joins the hydration promise.
// Model that wait explicitly so the test detects an aggregate rebuild that
// reads back through the public entity proxy before hydration has resolved.
vi.mock('@/api/base44Client', () => ({
  db: {
    entities: new Proxy({}, {
      get: () => ({ filter: () => new Promise(() => {}) }),
    }),
  },
}));

const withDeadline = (promise, ms = 3000) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), ms); }),
  ]).finally(() => clearTimeout(timer));
};

describe('cold business hydration without report authority', () => {
  beforeEach(async () => {
    await localDb.transaction('rw', [...BUSINESS_ENTITIES.map((name) => localDb[name]), localDb.BusinessSyncState], async () => {
      for (const name of BUSINESS_ENTITIES) await localDb[name].clear();
      await localDb.BusinessSyncState.clear();
    });
  });

  it('finishes the 25-table snapshot and reaches the feed with two properties and empty operational ledgers', async () => {
    const requests = [];
    const request = async (path) => {
      requests.push(path);
      if (path.startsWith('business-sync/snapshot')) {
        const entity = new URL(`https://test.invalid/${path}`).searchParams.get('entity');
        const rows = entity === 'Property'
          ? [{ id: 'HOTEL_A', name: 'Synthetic A' }, { id: 'HOTEL_B', name: 'Synthetic B' }]
          : [];
        return {
          generation_id: 'stage-generation', snapshot_revision: 2,
          scope_fingerprint: 'stage-scope', entity,
          items: rows.map((row) => ({ record_key: row.id, row })),
          has_more: false, next_cursor: null,
        };
      }
      if (path.startsWith('business-sync/feed')) return {
        items: [], active_generation_id: 'stage-generation', scope_fingerprint: 'stage-scope',
        current_revision: 2, has_more: false,
      };
      throw new Error(`unexpected request ${path}`);
    };

    const result = await withDeadline(createBusinessSyncClient({ request }).api.hydrateFromServer());
    expect(requests.filter((path) => path.startsWith('business-sync/snapshot'))).toHaveLength(BUSINESS_ENTITIES.length);
    expect(await localDb.Property.count()).toBe(2);
    expect((await localDb.BusinessSyncState.get('authoritative-business-data'))?.generation_id).toBe('stage-generation');
    expect(result).not.toHaveProperty('timedOut');
    expect(result.active).toBe(true);
    expect(requests.some((path) => path.startsWith('business-sync/feed'))).toBe(true);
    expect(await localDb.DailyFinancialAggregate.count()).toBe(0);
  });

  it('rebuilds a date-bounded property cache without entering the business entity proxy', async () => {
    await localDb.GrossRevenueDay.bulkPut([
      { id: 1, property_id: 'HOTEL_A', date: '2026-01-01', room_rent: 11.23 },
      { id: 2, property_id: 'HOTEL_A', date: '2026-01-02T23:30:00Z', room_rent: 20.45 },
      { id: 3, property_id: 'HOTEL_B', date: '2026-01-01', room_rent: 99.99 },
    ]);
    const result = await withDeadline(rebuildDailyAggregates({ propertyId: 'HOTEL_A', from: '2026-01-01', to: '2026-01-02' }));
    expect(result).toEqual({ written: 2, days: 2 });
    const rows = await localDb.DailyFinancialAggregate.toArray();
    expect(rows.map(({ property_id, business_date, gross_room_rent }) =>
      [property_id, business_date, gross_room_rent])).toEqual([
      ['HOTEL_A', '2026-01-01', 11.23],
      ['HOTEL_A', '2026-01-02', 20.45],
    ]);
  });

  it('resolves an authoritative generation with zero properties and zero operational rows', async () => {
    const client = createBusinessSyncClient({ request: async (path) => {
      if (path.startsWith('business-sync/snapshot')) return {
        generation_id: 'empty-generation', snapshot_revision: 0, scope_fingerprint: 'empty-scope',
        items: [], has_more: false, next_cursor: null,
      };
      if (path.startsWith('business-sync/feed')) return {
        items: [], active_generation_id: 'empty-generation', scope_fingerprint: 'empty-scope',
        current_revision: 0, has_more: false,
      };
      throw new Error(`unexpected request ${path}`);
    } });
    const result = await withDeadline(client.api.hydrateFromServer());
    expect(result).not.toHaveProperty('timedOut');
    expect(result.active).toBe(true);
    expect(await localDb.Property.count()).toBe(0);
    expect(await localDb.DailyFinancialAggregate.count()).toBe(0);
  });

  it('releases the Dashboard barrier after a two-property snapshot with no manifests', async () => {
    const request = async (path) => {
      if (path.startsWith('business-sync/snapshot')) {
        const entity = new URL(`https://test.invalid/${path}`).searchParams.get('entity');
        const rows = entity === 'Property'
          ? [{ id: 'HOTEL_A', name: 'Synthetic A' }, { id: 'HOTEL_B', name: 'Synthetic B' }]
          : [];
        return {
          generation_id: 'stage-generation', snapshot_revision: 2,
          scope_fingerprint: 'stage-scope', entity,
          items: rows.map((row) => ({ record_key: row.id, row })),
          has_more: false, next_cursor: null,
        };
      }
      if (path.startsWith('business-sync/feed')) return {
        items: [], active_generation_id: 'stage-generation', scope_fingerprint: 'stage-scope',
        current_revision: 2, has_more: false,
      };
      throw new Error(`unexpected request ${path}`);
    };
    const client = createBusinessSyncClient({ request });
    const phases = [];
    const result = await withDeadline(hydrateAuthenticatedData({
      hydrateBusinessData: async () => {
        phases.push('business');
        return client.api.hydrateFromServer();
      },
      syncBulkBundles: async () => {
        phases.push('bulk');
        return { verified: true, activeManifests: 0, materializedRows: 0 };
      },
      rebuildDailyAggregates: async () => {
        phases.push('aggregates');
        return rebuildDailyAggregates();
      },
      invalidateQueries: async () => { phases.push('invalidate'); },
    }));
    expect(result).not.toHaveProperty('timedOut');
    expect(phases.slice(0, 3)).toEqual(['business', 'bulk', 'aggregates']);
    expect(phases.filter((phase) => phase === 'invalidate')).toHaveLength(7);
    expect(result.bulk).toMatchObject({ verified: true, activeManifests: 0 });
  });

  it('recovers when the feed scope changes once during the snapshot', async () => {
    let snapshots = 0;
    let feeds = 0;
    const client = createBusinessSyncClient({ request: async (path) => {
      if (path.startsWith('business-sync/snapshot')) {
        snapshots++;
        return { generation_id: 'generation', snapshot_revision: 2, scope_fingerprint: 'current-scope',
          items: [], has_more: false, next_cursor: null };
      }
      if (path.startsWith('business-sync/feed')) {
        feeds++;
        return { items: [], active_generation_id: 'generation',
          scope_fingerprint: feeds === 1 ? 'stale-scope' : 'current-scope',
          current_revision: 2, has_more: false };
      }
      throw new Error(`unexpected request ${path}`);
    } });
    const result = await withDeadline(client.api.hydrateFromServer());
    expect(result).not.toHaveProperty('timedOut');
    expect(result.active).toBe(true);
    expect(feeds).toBe(2);
    expect(snapshots).toBe(BUSINESS_ENTITIES.length * 2);
  });

  it('fails deterministically when the feed scope remains different after retry', async () => {
    let feeds = 0;
    const client = createBusinessSyncClient({ request: async (path) => {
      if (path.startsWith('business-sync/snapshot')) return {
        generation_id: 'generation', snapshot_revision: 2, scope_fingerprint: 'current-scope',
        items: [], has_more: false, next_cursor: null,
      };
      if (path.startsWith('business-sync/feed')) {
        if (++feeds > 3) throw new Error('test request limit exceeded');
        return { items: [], active_generation_id: 'generation',
          scope_fingerprint: 'different-scope', current_revision: 2, has_more: false };
      }
      throw new Error(`unexpected request ${path}`);
    } });
    await expect(client.api.hydrateFromServer()).rejects.toThrow('Authoritative dataset changed repeatedly during hydration');
    expect(feeds).toBe(2);
  });
});
