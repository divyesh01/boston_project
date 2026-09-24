import './_loader-boot.mjs';
import 'fake-indexeddb/auto';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { makeInstrumentedEnv, makeRunner, assert, assertEqual, scopeAll } from './_worker-testkit.mjs';
import { clearMockStore, testR2Binding } from './_r2-testkit.mjs';
import { handleBulkImportRequest } from '../worker/bulk-import.js';
import { handleBusinessSyncRequest } from '../worker/business-sync.js';
import { executeBulkImport } from '../src/lib/bulkImportPipeline.js';
import { createBusinessSyncClient } from '../src/api/businessSync.js';
import { syncBulkBundles, getLastBulkRevision } from '../src/lib/bulkHydrationService.js';
import { aggregateDays, buildSyntheticRows } from '../src/lib/dailyAggregates.js';
import { hydrateAuthenticatedData } from '../src/lib/startupHydration.js';
import { grossRevenueForPeriod } from '../src/lib/hotel.js';
import localDb from '../src/api/localDb.js';

const run = makeRunner('probe-production-hydration-regression');
const nativeFetch = globalThis.fetch;
let db;
let env;
let uploadRequests = 0;
let failBundleDownload = false;
let failBundleDownloadAfter = 0;
let hydrationMetrics = null;

await localDb.delete();
await localDb.open();
clearMockStore();
db = new DatabaseSync(':memory:');
for (const name of readdirSync(new URL('../migrations-production/', import.meta.url)).filter((file) => file.endsWith('.sql')).sort()) {
  db.exec(readFileSync(new URL(`../migrations-production/${name}`, import.meta.url), 'utf8'));
}
db.prepare('INSERT INTO account(id,name,created_date) VALUES(?,?,?)').run('A_1', 'Hydration regression', '2026-09-24');
db.prepare('INSERT INTO property(id,account_id,code,name,rooms,active) VALUES(?,?,?,?,?,1)').run('P_A', 'A_1', 'RRI-A', 'Property A', 100);
db.prepare('INSERT INTO property(id,account_id,code,name,rooms,active) VALUES(?,?,?,?,?,1)').run('P_B', 'A_1', 'RRI-B', 'Property B', 80);
db.prepare('INSERT INTO business_sync_state(account_id,revision) VALUES(?,0)').run('A_1');
env = makeInstrumentedEnv(db, { RAW_ARCHIVE: testR2Binding(), BULK_DATA: testR2Binding() }).env;
const scope = scopeAll(['P_A', 'P_B']);
globalThis.location = { origin: 'https://boston-project.test' };
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input), globalThis.location.origin);
  if (url.pathname.startsWith('/api/bulk-import/raw-upload') || url.pathname.startsWith('/api/bulk-import/upload') || url.pathname.startsWith('/api/bulk-import/activate')) uploadRequests++;
  if (failBundleDownload && url.pathname.startsWith('/api/bulk-import/bundle/')) {
    failBundleDownload = false;
    return Response.json({ error: 'Injected transient bundle outage' }, { status: 503 });
  }
  if (failBundleDownloadAfter > 0 && url.pathname.startsWith('/api/bulk-import/bundle/')) {
    failBundleDownloadAfter--;
    if (failBundleDownloadAfter === 0) return Response.json({ error: 'Injected midway bundle outage' }, { status: 503 });
  }
  const request = new Request(url, init);
  return handleBulkImportRequest(request, env, scope, url, url.pathname.split('/').filter(Boolean));
};

const day = '2026-09-12';
const rawBytes = (name) => new TextEncoder().encode(name);
const importRows = async (type, rows, propertyId = 'P_A') => executeBulkImport(
  { type, totalRows: rows.length, rowsToImport: rows },
  { propertyId, propertyName: propertyId, sourceFile: `${type}.csv`, rawBytes: rawBytes(`${type}-${propertyId}`) },
);

await run.check('Active server imports reproduce the fresh-browser zero-revenue symptom and startup heals it without upload', async () => {
  await importRows('gross', [{ date: day, room_revenue: 12000, state_tax: 600, city_tax: 300, other_tax: 0 }]);
  await importRows('occupancy', [{ date: day, room_revenue: 12000, total_revenue: 12900, rooms_sold: 1, total_rooms: 2 }]);
  await importRows('source', [{ date: day, source: 'Direct', code: 'DIR', net_revenue: 12000, stays: 1 }]);
  await importRows('payments', [{ date: day, total: 12900, cash: 1000, visa: 11900 }]);
  await importRows('gross', [{ date: day, room_rent: 7000, state_tax: 350, city_tax: 175, other_tax: 0 }], 'P_B');

  const serverActive = db.prepare("SELECT COUNT(*) AS n FROM import_bundle_manifest WHERE status='active'").get().n;
  assertEqual(serverActive, 5, 'D1 has active authority for the four P_A ledgers plus P_B gross');
  const requestsBeforeHydration = uploadRequests;

  await localDb.transaction('rw', [localDb.Property, localDb.OccupancyDay, localDb.SourceDay, localDb.GrossRevenueDay,
    localDb.PaymentDay, localDb.ClerkShiftRecord, localDb.TimecardPunch, localDb.AdjustmentRefund,
    localDb.HotelMetric, localDb.TransactionLine, localDb.UploadedReport, localDb.DailyFinancialAggregate,
    localDb.BusinessSyncState], async () => {
    for (const table of [localDb.Property, localDb.OccupancyDay, localDb.SourceDay, localDb.GrossRevenueDay,
      localDb.PaymentDay, localDb.ClerkShiftRecord, localDb.TimecardPunch, localDb.AdjustmentRefund,
      localDb.HotelMetric, localDb.TransactionLine, localDb.UploadedReport, localDb.DailyFinancialAggregate,
      localDb.BusinessSyncState]) await table.clear();
  });

  let businessHydrationCalls = 0;
  const businessClient = createBusinessSyncClient({
    request: async (path, options = {}) => {
      const url = new URL(`/api/${path}`, globalThis.location.origin);
      const request = new Request(url, { method: options.method || 'GET', headers: { 'content-type': 'application/json' }, body: options.body });
      const response = await handleBusinessSyncRequest(request, env, scope, url, url.pathname.split('/').filter(Boolean));
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        const error = new Error(body?.error || `Request failed (${response.status})`);
        error.status = response.status;
        error.body = body;
        throw error;
      }
      return body;
    },
  });

  const invalidateCalls = [];
  const rebuild = async () => {
    const days = aggregateDays({
      occ: await localDb.OccupancyDay.toArray(),
      src: await localDb.SourceDay.toArray(),
      gross: await localDb.GrossRevenueDay.toArray(),
      pay: await localDb.PaymentDay.toArray(),
      exp: await localDb.Expense.toArray(),
    });
    await localDb.transaction('rw', localDb.DailyFinancialAggregate, async () => {
      for (const row of days) {
        const prior = await localDb.DailyFinancialAggregate.where('[property_id+business_date]').equals([row.property_id, row.business_date]).first();
        if (prior) await localDb.DailyFinancialAggregate.update(prior.id, row);
        else await localDb.DailyFinancialAggregate.add(row);
      }
    });
    return { written: days.length, days: days.length };
  };
  failBundleDownload = true;
  let failed = false;
  try {
    await hydrateAuthenticatedData({
      hydrateBusinessData: async () => { businessHydrationCalls++; return businessClient.api.hydrateFromServer(); },
      syncBulkBundles,
      rebuildDailyAggregates: rebuild,
      invalidateQueries: async ({ queryKey }) => invalidateCalls.push(queryKey[0]),
    });
  } catch { failed = true; }
  assert(failed, 'failed bundle download rejects startup hydration instead of returning empty data');
  assertEqual(await getLastBulkRevision(), 0, 'failed initial hydration does not advance the active manifest cursor');
  assertEqual(await localDb.GrossRevenueDay.count(), 0, 'failed initial hydration leaves ledgers unmaterialized');
  assertEqual(invalidateCalls.length, 0, 'failed initial hydration does not invalidate queries as success');

  // Scenario A: a prior browser has wrong cached totals for the same day.
  await localDb.GrossRevenueDay.add({ property_id: 'P_A', date: day, room_rent: 999, misc_charge: 0, state_tax: 0, city_tax: 0, other_tax: 0 });
  await localDb.DailyFinancialAggregate.add({ property_id: 'P_A', business_date: day, aggregate_version: 1, occ_revenue: 999 });

  const result = await hydrateAuthenticatedData({
    hydrateBusinessData: async () => { businessHydrationCalls++; return businessClient.api.hydrateFromServer(); },
    syncBulkBundles,
    rebuildDailyAggregates: rebuild,
    invalidateQueries: async ({ queryKey }) => invalidateCalls.push(queryKey[0]),
  });
  assertEqual(businessHydrationCalls, 2, 'retry reruns authoritative business hydration');
  assertEqual(result.bulk.verified, true, 'active bundle hashes/counts and local materialization are verified');
  assertEqual(result.bulk.activeManifests, 5, 'all active manifests are accounted for');
  assertEqual(await localDb.GrossRevenueDay.where('property_id').equals('P_A').count(), 1, 'P_A gross revenue materializes locally');
  assertEqual(await localDb.OccupancyDay.where('property_id').equals('P_A').count(), 1, 'P_A occupancy materializes locally');
  assertEqual(await localDb.SourceDay.where('property_id').equals('P_A').count(), 1, 'P_A source rows materialize locally');
  assertEqual(await localDb.PaymentDay.where('property_id').equals('P_A').count(), 1, 'P_A payment rows materialize locally');
  assertEqual(await localDb.GrossRevenueDay.where('property_id').equals('P_B').count(), 1, 'P_B rows retain their own property scope');
  assertEqual(await localDb.GrossRevenueDay.where('property_id').equals('P_A').count(), 1, 'stale same-date P_A gross cache row is replaced by authority');
  assertEqual(await localDb.OccupancyDay.where('property_id').equals('P_B').count(), 0, 'P_B has no occupancy report and stays unavailable');

  const grossA = await localDb.GrossRevenueDay.where('property_id').equals('P_A').toArray();
  const occupancyA = await localDb.OccupancyDay.where('property_id').equals('P_A').toArray();
  const dashboardRevenue = grossRevenueForPeriod({ grossRows: grossA, occRows: occupancyA }).dollars;
  assertEqual(dashboardRevenue, 12000, 'Dashboard revenue calculation sees the imported P_A room revenue');
  assert(await localDb.DailyFinancialAggregate.where('property_id').equals('P_A').count() > 0, 'daily aggregates are rebuilt after local ledgers exist');
  assertEqual(new Set(invalidateCalls).size, 7, 'occupancy, sources, gross, payments, clerk, aggregates and uploads are invalidated');

  const dashboardRevenueCentsFor = async (propertyId) => {
    const aggregates = await localDb.DailyFinancialAggregate.where('property_id').equals(propertyId).toArray();
    const rows = buildSyntheticRows(aggregates);
    return grossRevenueForPeriod({ grossRows: rows.grossRows, occRows: rows.occRows }).cents;
  };
  const rawGrossB = await localDb.GrossRevenueDay.where('property_id').equals('P_B').toArray();
  assertEqual(grossRevenueForPeriod({ grossRows: rawGrossB, occRows: [] }).cents, 700000, 'raw P_B gross ledger proves revenue exists without occupancy');
  assertEqual(await dashboardRevenueCentsFor('P_B'), 700000, 'aggregate Dashboard path keeps P_B room rent when occupancy is absent');
  const propertyAFirst = await dashboardRevenueCentsFor('P_A');
  assertEqual(propertyAFirst, Math.round(dashboardRevenue * 100), 'P_A raw and aggregate Dashboard paths reconcile to the exact same cents');
  const propertyBAfterA = await dashboardRevenueCentsFor('P_B');
  const propertyAAfterB = await dashboardRevenueCentsFor('P_A');
  assertEqual(propertyAFirst, propertyAAfterB, 'property A -> B -> A returns A totals unchanged');
  assertEqual(propertyBAfterA, 700000, 'switching to B does not reuse A aggregate totals');

  const firstCounts = await Promise.all(['GrossRevenueDay', 'OccupancyDay', 'SourceDay', 'PaymentDay'].map((name) => localDb[name].count()));
  const firstRevenue = grossRevenueForPeriod({ grossRows: grossA, occRows: occupancyA }).dollars;
  const second = await hydrateAuthenticatedData({
    hydrateBusinessData: async () => businessClient.api.hydrateFromServer(),
    syncBulkBundles,
    rebuildDailyAggregates: rebuild,
    invalidateQueries: async () => {},
  });
  const secondCounts = await Promise.all(['GrossRevenueDay', 'OccupancyDay', 'SourceDay', 'PaymentDay'].map((name) => localDb[name].count()));
  const grossAfter = await localDb.GrossRevenueDay.where('property_id').equals('P_A').toArray();
  const occupancyAfter = await localDb.OccupancyDay.where('property_id').equals('P_A').toArray();
  assertEqual(JSON.stringify(secondCounts), JSON.stringify(firstCounts), 'second refresh is idempotent without duplicate rows');
  assertEqual(grossRevenueForPeriod({ grossRows: grossAfter, occRows: occupancyAfter }).dollars, firstRevenue, 'second refresh preserves dashboard revenue');
  assertEqual(second.bulk.verified, true, 'second refresh re-verifies active manifests');
  assertEqual(uploadRequests, requestsBeforeHydration, 'startup and second refresh perform no report upload');
  assertEqual(db.prepare("SELECT COUNT(*) AS n FROM import_bundle_manifest WHERE status='active'").get().n, serverActive, 'Import History authority remains unchanged');

  // Scenario G: fail after one bundle has already downloaded. The whole page
  // must remain atomic and the cursor must stay at its last committed value.
  const cursorBeforeMidwayFailure = await getLastBulkRevision();
  const aBeforeMidwayFailure = await localDb.GrossRevenueDay.where('property_id').equals('P_A').toArray();
  const bBeforeMidwayFailure = await localDb.GrossRevenueDay.where('property_id').equals('P_B').toArray();
  failBundleDownloadAfter = 2;
  let midwayFailure = false;
  try { await syncBulkBundles({ force: true }); } catch { midwayFailure = true; }
  assert(midwayFailure, 'failure after one bundle download rejects the whole manifest page');
  assertEqual(await getLastBulkRevision(), cursorBeforeMidwayFailure, 'mid-page failure does not advance the all-property cursor');
  assertEqual(JSON.stringify(await localDb.GrossRevenueDay.where('property_id').equals('P_A').toArray()), JSON.stringify(aBeforeMidwayFailure), 'P_A rows stay safe after a B-side hydration failure');
  assertEqual(JSON.stringify(await localDb.GrossRevenueDay.where('property_id').equals('P_B').toArray()), JSON.stringify(bBeforeMidwayFailure), 'P_B rows stay atomic after a mid-page failure');

  // Scenario B: a brand-new browser starts with no ledgers, history or cursor.
  await localDb.transaction('rw', [localDb.OccupancyDay, localDb.SourceDay, localDb.GrossRevenueDay,
    localDb.PaymentDay, localDb.ClerkShiftRecord, localDb.TimecardPunch, localDb.AdjustmentRefund,
    localDb.HotelMetric, localDb.TransactionLine, localDb.UploadedReport, localDb.DailyFinancialAggregate,
    localDb.BusinessSyncState], async () => {
    for (const table of [localDb.OccupancyDay, localDb.SourceDay, localDb.GrossRevenueDay,
      localDb.PaymentDay, localDb.ClerkShiftRecord, localDb.TimecardPunch, localDb.AdjustmentRefund,
      localDb.HotelMetric, localDb.TransactionLine, localDb.UploadedReport, localDb.DailyFinancialAggregate,
      localDb.BusinessSyncState]) await table.clear();
  });
  const fresh = await hydrateAuthenticatedData({
    hydrateBusinessData: async () => businessClient.api.hydrateFromServer(),
    syncBulkBundles,
    rebuildDailyAggregates: rebuild,
    invalidateQueries: async () => {},
  });
  assertEqual(fresh.bulk.verified, true, 'empty browser completes verified hydration');
  assertEqual(await localDb.GrossRevenueDay.count(), 2, 'fresh browser restores both properties gross rows');
  assertEqual(await localDb.GrossRevenueDay.where('property_id').equals('P_A').count(), 1, 'fresh browser restores P_A gross row');
  assertEqual(await localDb.GrossRevenueDay.where('property_id').equals('P_B').count(), 1, 'fresh browser restores P_B gross row');
  hydrationMetrics = {
    grossRowsA: await localDb.GrossRevenueDay.where('property_id').equals('P_A').count(),
    grossRowsB: await localDb.GrossRevenueDay.where('property_id').equals('P_B').count(),
    occupancyRowsA: await localDb.OccupancyDay.where('property_id').equals('P_A').count(),
    occupancyRowsB: await localDb.OccupancyDay.where('property_id').equals('P_B').count(),
    aggregateRowsA: await localDb.DailyFinancialAggregate.where('property_id').equals('P_A').count(),
    aggregateRowsB: await localDb.DailyFinancialAggregate.where('property_id').equals('P_B').count(),
    dashboardRevenueA: dashboardRevenue,
    dashboardRevenueB: (await dashboardRevenueCentsFor('P_B')) / 100,
    uploadRequests: uploadRequests - requestsBeforeHydration,
  };
});

db.close();
globalThis.fetch = nativeFetch;
run.done();
if (process.exitCode) process.exit(1);
console.log('PASSED: hydration regression verified stale and empty browsers, retry, exact manifests, gross-only revenue, property switching, midway failure safety, idempotency, isolation, and no upload.');
console.log(`  P_A local rows: gross=${hydrationMetrics?.grossRowsA}, occupancy=${hydrationMetrics?.occupancyRowsA}, aggregates=${hydrationMetrics?.aggregateRowsA}; Dashboard revenue=$${hydrationMetrics?.dashboardRevenueA}.`);
console.log(`  P_B local rows: gross=${hydrationMetrics?.grossRowsB}, occupancy=${hydrationMetrics?.occupancyRowsB}, aggregates=${hydrationMetrics?.aggregateRowsB}; Dashboard revenue=$${hydrationMetrics?.dashboardRevenueB}.`);
console.log(`  Report uploads during hydration=${hydrationMetrics?.uploadRequests}.`);
process.exit(0);
