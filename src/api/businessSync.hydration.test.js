import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import localDb from './localDb';
import { createBusinessSyncClient } from './businessSync';

const calls = vi.hoisted(() => ({ read: null, rebuild: vi.fn() }));
vi.mock('@/lib/dailyAggregates', () => ({
  rebuildDailyAggregates: async () => { calls.rebuild(); return calls.read(); },
}));
vi.mock('@/lib/bulkHydrationService', () => ({ syncBulkBundles: async () => ({ verified: true }) }));
afterEach(async () => { await localDb.delete(); });

it('finishes snapshot hydration before aggregate readers can wait on that same hydration', async () => {
  await localDb.delete();
  await localDb.open();
  const client = createBusinessSyncClient({ request: async path => {
    if (path.startsWith('business-sync/snapshot')) return {
      generation_id: 'g1', snapshot_revision: 0, scope_fingerprint: 's1', items: [], has_more: false,
    };
    if (path.startsWith('business-sync/feed')) return {
      active_generation_id: 'g1', scope_fingerprint: 's1', items: [], has_more: false, current_revision: 0,
    };
    throw new Error(`Unexpected request: ${path}`);
  } });
  const reader = client.wrapEntity('OccupancyDay', { filter: async () => [] });
  calls.read = () => reader.filter({});
  const hydrated = client.api.hydrateFromServer();
  let timer;
  try {
    const result = await Promise.race([
      hydrated,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Hydration waited on its own aggregate read')), 1000); }),
    ]);
    expect(result.rebuilt).toBe(true);
    expect(calls.rebuild).not.toHaveBeenCalled();
  } finally { clearTimeout(timer); }
});
