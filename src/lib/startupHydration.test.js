import { describe, expect, it, vi } from 'vitest';
import { hydrateAuthenticatedData, STARTUP_QUERY_PREFIXES } from './startupHydration.js';

describe('startupHydration', () => {
  it('reuses verified bundle from business hydration without re-downloading', async () => {
    const verifiedBulk = { verified: true, synced: 2, lastRevision: 10 };
    const hydrateBusinessData = vi.fn().mockResolvedValue({
      active: true,
      bulk: verifiedBulk,
    });
    const syncBulkBundles = vi.fn();
    const rebuildDailyAggregates = vi.fn().mockResolvedValue({ count: 5 });
    const invalidateQueries = vi.fn().mockResolvedValue();

    const result = await hydrateAuthenticatedData({
      hydrateBusinessData,
      syncBulkBundles,
      rebuildDailyAggregates,
      invalidateQueries,
    });

    expect(hydrateBusinessData).toHaveBeenCalledTimes(1);
    expect(syncBulkBundles).not.toHaveBeenCalled();
    expect(result.bulk).toBe(verifiedBulk);
    expect(rebuildDailyAggregates).toHaveBeenCalledTimes(1);
    expect(invalidateQueries).toHaveBeenCalledTimes(STARTUP_QUERY_PREFIXES.length);
  });

  it('falls back to syncBulkBundles when business hydration has unverified bulk data', async () => {
    const freshBulk = { verified: true, synced: 3 };
    const hydrateBusinessData = vi.fn().mockResolvedValue({
      active: true,
      bulk: { verified: false },
    });
    const syncBulkBundles = vi.fn().mockResolvedValue(freshBulk);
    const rebuildDailyAggregates = vi.fn().mockResolvedValue({ count: 10 });
    const invalidateQueries = vi.fn().mockResolvedValue();

    const result = await hydrateAuthenticatedData({
      hydrateBusinessData,
      syncBulkBundles,
      rebuildDailyAggregates,
      invalidateQueries,
    });

    expect(syncBulkBundles).toHaveBeenCalledWith({ force: true });
    expect(result.bulk).toBe(freshBulk);
  });

  it('throws an error if bundles cannot be verified locally', async () => {
    const hydrateBusinessData = vi.fn().mockResolvedValue({
      active: true,
      bulk: null,
    });
    const syncBulkBundles = vi.fn().mockResolvedValue({ verified: false });
    const rebuildDailyAggregates = vi.fn();
    const invalidateQueries = vi.fn();

    await expect(
      hydrateAuthenticatedData({
        hydrateBusinessData,
        syncBulkBundles,
        rebuildDailyAggregates,
        invalidateQueries,
      })
    ).rejects.toThrow('Active report bundles were not verified in local storage.');

    expect(rebuildDailyAggregates).not.toHaveBeenCalled();
  });
});
