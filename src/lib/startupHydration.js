export const STARTUP_QUERY_PREFIXES = Object.freeze([
  'occupancy',
  'sources',
  'gross',
  'payments',
  'clerk',
  'daily-aggregates',
  'uploads',
]);

// This promise is the authenticated app's initial read barrier. The Dashboard
// must not mount until the account snapshot, active R2 bundles, and derived
// aggregates all describe the same hydrated IndexedDB state.
export async function hydrateAuthenticatedData({
  hydrateBusinessData,
  syncBulkBundles,
  rebuildDailyAggregates,
  invalidateQueries,
}) {
  const business = await hydrateBusinessData();
  const bulk = await syncBulkBundles({ force: true });
  if (!bulk?.verified) throw new Error('Active report bundles were not verified in local storage.');

  const aggregates = await rebuildDailyAggregates();
  await Promise.all(STARTUP_QUERY_PREFIXES.map((prefix) =>
    invalidateQueries({ queryKey: [prefix] })
  ));

  return { business, bulk, aggregates };
}
