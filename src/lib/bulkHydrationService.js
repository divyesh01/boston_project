import localDb from '../api/localDb.js';
import { manifestScopeMatches } from './manifestScopeGuard.js';
import { decompressPayloadGzip, generateDeterministicRowId } from './bulkImportPipeline.js';
import { BULK_ENTITIES, parseBundle, contentHash, normalizedContent } from '../../worker/bulk-contract.js';
import { mapConcurrent } from './mapConcurrent.js';
const BULK_SYNC_KEY = 'authoritative-bulk-bundle-sync-v3-history';
const COMMIT_KEY = `${BULK_SYNC_KEY}:commit`;
const BUSINESS_SYNC_KEY = 'authoritative-business-data';
class HydrationConflict extends Error {}
class InventoryChanged extends Error {}
class DownloadTimeout extends Error {}
class DownloadFailure extends Error {
  constructor(label, status, code = '', retryAfterMs = 0) {
    super(`${label} download failed: ${status}`);
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}
const flights = new Map();
const forcedFollowups = new WeakMap();
const stateKey = propertyId => `${BULK_SYNC_KEY}:${propertyId || 'all'}`;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const businessIdentity = state => JSON.stringify([
  Boolean(state), state?.generation_id ?? null, state?.scope_fingerprint ?? null,
]);

async function assertPageAuthority(commitToken, identity) {
  const [commit, business] = await localDb.BusinessSyncState.bulkGet([COMMIT_KEY, BUSINESS_SYNC_KEY]);
  if (commit?.token !== commitToken || businessIdentity(business) !== identity) throw new HydrationConflict();
}

/**
 * Bound both response headers and body reads. Only idempotent downloads retry;
 * authorization, parsing and integrity failures must remain visible.
 * @template T
 * @param {string} url
 * @param {(response: Response) => Promise<T>} consume
 * @param {string} label
 * @returns {Promise<T>}
 */
async function readDownload(url, consume, label) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    let timeout;
    try {
      /** @type {Promise<never>} */
      const deadline = new Promise((_, reject) => {
        timeout = setTimeout(() => {
          reject(new DownloadTimeout(`${label} download timed out; retry synchronization`));
          controller.abort();
        }, 20000);
      });
      return await Promise.race([deadline, (async () => {
        const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
        if (!response.ok) {
          const retryAfter = response.headers.get('retry-after');
          const retryAfterMs = retryAfter == null ? 0 : /^\d+$/.test(retryAfter)
            ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
          const details = response.status === 409 ? await response.json() : null;
          if (response.status !== 409) void response.body?.cancel().catch(() => {});
          throw new DownloadFailure(label, response.status, details?.code || '', retryAfterMs);
        }
        return consume(response);
      })()]);
    } catch (error) {
      clearTimeout(timeout);
      const transient = error instanceof DownloadTimeout || error instanceof TypeError ||
        (error instanceof DownloadFailure && RETRYABLE_STATUS.has(error.status));
      if (!transient || attempt === 2) throw error;
      const requestedDelay = error instanceof DownloadFailure ? error.retryAfterMs : 0;
      // Do not keep the startup barrier waiting on a long server backoff.
      if (requestedDelay > 3000) throw error;
      const delay = Math.max(Number.isFinite(requestedDelay) ? requestedDelay : 0,
        200 * (2 ** attempt) + Math.floor(Math.random() * 100));
      await new Promise(resolve => setTimeout(resolve, delay));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(`${label} download failed`);
}

async function reusableReport(manifest, scope) {
  const report = await localDb.UploadedReport.get(manifest.id);
  if (report?.bulk_cache_version !== 1 || report.bulk_verified_scope !== scope ||
      report.bulk_verified_hash !== manifest.normalized_hash ||
      report.bulk_verified_revision !== Number(manifest.revision)) return null;
  const propertyIds = [...new Set([manifest.server_property_id, ...(manifest.property_aliases || [])])];
  const properties = await localDb.Property.where('id').anyOf(propertyIds).toArray();
  if (properties.length > 1 || report.property_id !== (properties[0]?.id ?? manifest.server_property_id)) return null;
  const counts = report.bulk_entity_counts;
  if (!counts || !Object.keys(counts).length) return null;
  const entries = Object.entries(counts);
  if (entries.some(([entity, count]) => !BULK_ENTITIES.includes(entity) || !Number.isSafeInteger(count) || count < 0)) return null;
  if (entries.reduce((sum, [, count]) => sum + count, 0) !== report.rows_imported) return null;
  const actual = await Promise.all(entries.map(([entity]) => localDb[entity].where('import_id').equals(manifest.id).count()));
  if (entries.some(([, count], index) => count !== actual[index])) return null;
  return report;
}
export async function getLastBulkRevision(propertyId = '') {
  return Number((await localDb.BusinessSyncState.get(stateKey(propertyId)))?.revision || 0);
}
export async function setLastBulkRevision(revision, propertyId = '', afterId = '', scope = '') {
  await localDb.BusinessSyncState.put({ key: stateKey(propertyId), revision, after_id: afterId, scope });
}

// A page's materialization, evictions and cursor commit together. Failed pages replay.
export async function syncBulkBundles({ force = false, propertyId = '' } = {}) {
  const key = stateKey(propertyId);
  const active = flights.get(key);
  if (active) {
    if (!force) return active;
    // An import may complete after the running scan fetched its manifest.
    // All force callers waiting on that scan share one fresh follow-up.
    let followup = forcedFollowups.get(active);
    if (!followup) {
      followup = active.then(() => {
        if (flights.get(key) === active) flights.delete(key);
        return syncBulkBundles({ force: true, propertyId });
      });
      forcedFollowups.set(active, followup);
    }
    return followup;
  }
  const job = (async () => {
    let state = force ? null : await localDb.BusinessSyncState.get(key);
    let revision = Number(state?.revision || 0), afterId = state?.after_id || '', synced = 0;
    let scope = state?.scope || '';
    let conflicts = 0, inventoryRestarts = 0;
    let activeManifests = 0, materializedRows = 0;
    for (;;) {
      const [commitState, businessState] = await localDb.BusinessSyncState.bulkGet([COMMIT_KEY, BUSINESS_SYNC_KEY]);
      const commitToken = commitState?.token;
      const identity = businessIdentity(businessState);
      const url = new URL('/api/bulk-import/manifest', globalThis.location?.origin || 'http://localhost');
      url.searchParams.set('since_revision', String(revision));
      url.searchParams.set('after_id', afterId);
      if (propertyId) url.searchParams.set('server_property_id', propertyId);
      const data = await readDownload(url.toString(), response => response.json(), 'Manifest');
      if (scope && data.scope !== scope) {
        if (++inventoryRestarts > 2) throw new Error('Report scope keeps changing; retry synchronization');
        revision = 0; afterId = ''; scope = data.scope;
        activeManifests = 0; materializedRows = 0;
        continue;
      }
      scope = data.scope;
      if (!Array.isArray(data.manifests)) throw new Error('Invalid manifest feed');
      const manifests = data.manifests;
      if (!manifests.length) {
        try { await assertPageAuthority(commitToken, identity); }
        catch (error) {
          if (!(error instanceof HydrationConflict)) throw error;
          if (++conflicts >= 5) throw new Error('Concurrent synchronization; retry hydration');
          revision = 0; afterId = '';
          activeManifests = 0; materializedRows = 0;
          continue;
        }
        return { synced, lastRevision: revision, activeManifests, materializedRows, verified: true };
      }
      for (const manifest of manifests) {
        if (propertyId && !manifestScopeMatches(manifest, propertyId)) throw new Error('Manifest scope mismatch');
      }
      // Verify downloads concurrently, then commit the entire page atomically.
      // Retirements/replacements are still applied in manifest order below.
      let downloaded;
      try {
        downloaded = await mapConcurrent(manifests.filter(manifest => manifest.status === 'active'), async (manifest) => {
          // Always fetch current server manifests, but retain successfully committed
          // payloads when their scope, revision, hash, roster and row counts agree.
          // Missing receipts or partially cleared storage take the download path.
          const cached = await reusableReport(manifest, scope);
          if (cached) {
            manifest.materialized_row_count = cached.rows_imported;
            manifest.materialized_entity_counts = cached.bulk_entity_counts;
            return [manifest.id, null];
          }
          const { headers, bytes } = await readDownload(`/api/bulk-import/bundle/${encodeURIComponent(manifest.id)}/history`,
            async response => ({ headers: response.headers, bytes: await response.arrayBuffer() }), 'Bundle');
          const baseHash = headers.get('x-base-normalized-hash');
          if (!baseHash) throw new Error('Missing report history identity');
          if (baseHash !== manifest.normalized_hash) throw new InventoryChanged('Report changed during history recovery');
          const text = await decompressPayloadGzip(bytes);
          const items = parseBundle(text, manifest.server_property_id, manifest.property_aliases || []);
          const hash = await contentHash(normalizedContent(items));
          const effectiveCount = Number(headers.get('x-row-count'));
          const effectiveCounts = JSON.parse(headers.get('x-entity-counts') || '{}');
          if (hash !== headers.get('x-normalized-hash') || items.length !== effectiveCount || effectiveCount < Number(manifest.row_count)) throw new Error('Bundle hash or count mismatch');
          const counts = items.reduce((out, item) => { out[item.entity] = (out[item.entity] || 0) + 1; return out; }, {});
          if (JSON.stringify(Object.entries(counts).sort()) !== JSON.stringify(Object.entries(effectiveCounts).sort())) throw new Error('Entity counts mismatch');
          manifest.materialized_row_count = effectiveCount;
          manifest.materialized_entity_counts = effectiveCounts;
          return [manifest.id, items];
        });
      } catch (error) {
        const changed = error instanceof InventoryChanged || (error instanceof DownloadFailure &&
          (error.status === 410 || (error.status === 409 && error.code === 'IMPORT_HISTORY_CHANGED')));
        if (!changed) throw error;
        if (++inventoryRestarts > 2) throw new Error('Reports keep changing; retry synchronization');
        // Nothing from this page was committed. Fetch current authority instead
        // of retrying a retired bundle or advancing past its replacement.
        revision = 0; afterId = '';
        activeManifests = 0; materializedRows = 0;
        continue;
      }
      const payloads = new Map(downloaded);
      const tables = [...BULK_ENTITIES.map(name => localDb[name]), localDb.UploadedReport, localDb.BusinessSyncState,
        localDb.Property, localDb.DailyFinancialAggregate];
      try {
        await localDb.transaction('rw', tables, async () => {
          // Fence both competing syncs and a changed/cleared business snapshot.
          // An earlier account or generation must never repopulate this cache.
          await assertPageAuthority(commitToken, identity);
          // Remove retired versions before inserting replacements, even at the same revision.
          const retiredIds = manifests.filter(manifest => ['tombstoned', 'superseded', 'destroyed'].includes(manifest.status)).map(manifest => manifest.id);
          if (retiredIds.length) {
            await Promise.all([
              ...BULK_ENTITIES.map(entity => localDb[entity].where('import_id').anyOf(retiredIds).delete()),
              localDb.UploadedReport.where('import_id').anyOf(retiredIds).delete(),
            ]);
          }
          for (const manifest of manifests) {
            const items = payloads.get(manifest.id);
            if (!items) continue;
            // The local roster may still use a typed migration-era id (e.g. 1).
            // Match only aliases verified by the server, and retain the roster's
            // exact type so filters and property rankings join these rows.
            const propertyIds = [...new Set([manifest.server_property_id, ...(manifest.property_aliases || [])])];
            const localProperties = await localDb.Property.where('id').anyOf(propertyIds).toArray();
            if (localProperties.length > 1) throw new Error('Ambiguous local property identity');
            const localPropertyId = localProperties[0]?.id ?? manifest.server_property_id;
            const obsoleteIds = propertyIds.filter(id => id !== localPropertyId);
            if (obsoleteIds.length) await localDb.DailyFinancialAggregate.where('property_id').anyOf(obsoleteIds).delete();
            const groups = {};
            items.forEach((item, index) => {
              (groups[item.entity] ||= []).push({ ...item.row,
                id: generateDeterministicRowId(manifest.id, item.entity, index),
                property_id: localPropertyId, import_id: manifest.id, bulk_import_id: manifest.id });
            });
            for (const [entity, rows] of Object.entries(groups)) {
              // R2 is authoritative for this report's covered dates. Remove overlapping legacy cache rows.
              const dates = new Set(rows.map(row => String(row.date || row.business_date || row.shift_date || '').slice(0, 10)));
              await localDb[entity].where('property_id').anyOf(propertyIds)
                .filter(row => !row.bulk_import_id && dates.has(String(row.date || row.business_date || row.shift_date || '').slice(0, 10))).delete();
              await localDb[entity].where('import_id').equals(manifest.id).delete();
              await localDb[entity].bulkPut(rows);
            }
            await localDb.UploadedReport.put({ id: manifest.id, import_id: manifest.id, bulk_import_id: manifest.id, raw_archive_id: manifest.raw_archive_id || manifest.id,
              property_id: localPropertyId, report_type: manifest.report_type, file_name: manifest.original_file_name,
              file_hash: manifest.raw_file_hash, status: 'completed', rows_imported: manifest.materialized_row_count, raw_rows: [],
              bulk_cache_version: 1, bulk_verified_scope: scope,
              bulk_verified_hash: manifest.normalized_hash, bulk_verified_revision: Number(manifest.revision),
              bulk_entity_counts: manifest.materialized_entity_counts,
              created_date: manifest.activated_at || manifest.created_at });
            const report = await localDb.UploadedReport.get(manifest.id);
            if (!report || report.property_id !== localPropertyId || Number(report.rows_imported) !== Number(manifest.materialized_row_count)) {
              throw new Error(`Active report manifest ${manifest.id} was not materialized locally`);
            }
            for (const [entity, expected] of Object.entries(manifest.materialized_entity_counts || {})) {
              const actual = await localDb[entity].where('import_id').equals(manifest.id).count();
              if (actual !== Number(expected)) throw new Error(`Active report ${manifest.id} ${entity} rows did not reconcile locally`);
            }
          }
          const last = manifests[manifests.length - 1];
          await setLastBulkRevision(Number(last.revision), propertyId, last.id, scope);
          await localDb.BusinessSyncState.put({key: COMMIT_KEY, token: crypto.randomUUID()});
        });
      } catch (error) {
        if (!(error instanceof HydrationConflict)) throw error;
        if (++conflicts >= 5) throw new Error('Concurrent synchronization; retry hydration');
        // Discard this snapshot and fetch fresh authority before materializing it.
        revision = 0; afterId = '';
        activeManifests = 0; materializedRows = 0;
        continue;
      }
      conflicts = 0;
      const last = manifests[manifests.length - 1];
      if (revision === Number(last.revision) && afterId === last.id) throw new Error('Manifest cursor did not advance');
      revision = Number(last.revision); afterId = last.id; synced += manifests.length;
      for (const manifest of manifests) {
        if (manifest.status !== 'active') continue;
        activeManifests++;
        materializedRows += Number(manifest.materialized_row_count) || 0;
      }
      if (manifests.length < 200) return { synced, lastRevision: revision, activeManifests, materializedRows, verified: true };
    }
  })();
  flights.set(key, job);
  try { return await job; } finally { if (flights.get(key) === job) flights.delete(key); }
}
