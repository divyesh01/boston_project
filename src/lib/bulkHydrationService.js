import localDb from '../api/localDb.js';
import { decompressPayloadGzip, generateDeterministicRowId } from './bulkImportPipeline.js';
import { BULK_ENTITIES, parseBundle, contentHash, normalizedContent } from '../../worker/bulk-contract.js';
const BULK_SYNC_KEY = 'authoritative-bulk-bundle-sync-v2';
const COMMIT_KEY = `${BULK_SYNC_KEY}:commit`;
class HydrationConflict extends Error {}
const flights = new Map();
const stateKey = propertyId => `${BULK_SYNC_KEY}:${propertyId || 'all'}`;
export async function getLastBulkRevision(propertyId = '') {
  return Number((await localDb.BusinessSyncState.get(stateKey(propertyId)))?.revision || 0);
}
export async function setLastBulkRevision(revision, propertyId = '', afterId = '', scope = '') {
  await localDb.BusinessSyncState.put({ key: stateKey(propertyId), revision, after_id: afterId, scope });
}

// A page's materialization, evictions and cursor commit together. Failed pages replay.
export async function syncBulkBundles({ force = false, propertyId = '' } = {}) {
  const key = stateKey(propertyId);
  while (flights.has(key)) { await flights.get(key); if (!force) return { synced: 0, lastRevision: await getLastBulkRevision(propertyId) }; }
  const job = (async () => {
    let state = force ? null : await localDb.BusinessSyncState.get(key);
    let revision = Number(state?.revision || 0), afterId = state?.after_id || '', synced = 0;
    let scope = state?.scope || '';
    let conflicts = 0;
    for (;;) {
      const commitToken = (await localDb.BusinessSyncState.get(COMMIT_KEY))?.token;
      const url = new URL('/api/bulk-import/manifest', globalThis.location?.origin || 'http://localhost');
      url.searchParams.set('since_revision', String(revision));
      url.searchParams.set('after_id', afterId);
      if (propertyId) url.searchParams.set('server_property_id', propertyId);
      const response = await fetch(url.toString());
      if (!response.ok) throw new Error(`Manifest download failed: ${response.status}`);
      const data = await response.json();
      if (scope && data.scope !== scope) { revision = 0; afterId = ''; scope = data.scope; continue; }
      scope = data.scope;
      if (!Array.isArray(data.manifests)) throw new Error('Invalid manifest feed');
      const manifests = data.manifests;
      if (!manifests.length) return { synced, lastRevision: revision };
      const payloads = new Map();
      for (const manifest of manifests) {
        if (propertyId && manifest.server_property_id !== propertyId) throw new Error('Manifest scope mismatch');
        if (manifest.status !== 'active') continue;
        const res = await fetch(`/api/bulk-import/bundle/${encodeURIComponent(manifest.id)}`);
        if (!res.ok) throw new Error(`Bundle download failed: ${res.status}`);
        const bytes = await res.arrayBuffer();
        const text = await decompressPayloadGzip(bytes);
        const items = parseBundle(text, manifest.server_property_id);
        const hash = await contentHash(Number(manifest.identity_version) === 2 ? normalizedContent(items) : text);
        if (hash !== manifest.normalized_hash || items.length !== Number(manifest.row_count)) throw new Error('Bundle hash or count mismatch');
        const counts = items.reduce((out, item) => { out[item.entity] = (out[item.entity] || 0) + 1; return out; }, {});
        if (JSON.stringify(Object.entries(counts).sort()) !== JSON.stringify(Object.entries(manifest.entity_counts || {}).sort())) throw new Error('Entity counts mismatch');
        payloads.set(manifest.id, items);
      }
      const tables = [...BULK_ENTITIES.map(name => localDb[name]), localDb.UploadedReport, localDb.BusinessSyncState];
      try {
        await localDb.transaction('rw', tables, async () => {
          // All/property syncs and other tabs share this transactional commit fence.
          if ((await localDb.BusinessSyncState.get(COMMIT_KEY))?.token !== commitToken) throw new HydrationConflict();
          // Remove retired versions before inserting replacements, even at the same revision.
          for (const manifest of manifests) {
            if (!['tombstoned', 'superseded', 'destroyed'].includes(manifest.status)) continue;
            for (const entity of BULK_ENTITIES) await localDb[entity].where('import_id').equals(manifest.id).delete();
            await localDb.UploadedReport.where('import_id').equals(manifest.id).delete();
          }
          for (const manifest of manifests) {
            const items = payloads.get(manifest.id);
            if (!items) continue;
            const groups = {};
            items.forEach((item, index) => {
              (groups[item.entity] ||= []).push({ ...item.row,
                id: generateDeterministicRowId(manifest.id, item.entity, index),
                property_id: manifest.server_property_id, import_id: manifest.id, bulk_import_id: manifest.id });
            });
            for (const [entity, rows] of Object.entries(groups)) {
              // R2 is authoritative for this report's covered dates. Remove overlapping legacy cache rows.
              const dates = new Set(rows.map(row => String(row.date || row.business_date || row.shift_date || '').slice(0, 10)));
              await localDb[entity].where('property_id').equals(manifest.server_property_id)
                .filter(row => !row.bulk_import_id && dates.has(String(row.date || row.business_date || row.shift_date || '').slice(0, 10))).delete();
              await localDb[entity].where('import_id').equals(manifest.id).delete();
              await localDb[entity].bulkPut(rows);
            }
            await localDb.UploadedReport.put({ id: manifest.id, import_id: manifest.id, bulk_import_id: manifest.id, raw_archive_id: manifest.raw_archive_id || manifest.id,
              property_id: manifest.server_property_id, report_type: manifest.report_type, file_name: manifest.original_file_name,
              file_hash: manifest.raw_file_hash, status: 'completed', rows_imported: manifest.row_count, raw_rows: [],
              created_date: manifest.activated_at || manifest.created_at });
          }
          const last = manifests[manifests.length - 1];
          await setLastBulkRevision(Number(last.revision), propertyId, last.id, scope);
          await localDb.BusinessSyncState.put({key: COMMIT_KEY, token: crypto.randomUUID()});
        });
      } catch (error) {
        if (!(error instanceof HydrationConflict)) throw error;
        if (++conflicts >= 5) throw new Error('Concurrent synchronization; retry hydration');
        // Discard this snapshot and fetch fresh authority before materializing it.
        continue;
      }
      conflicts = 0;
      const last = manifests[manifests.length - 1];
      if (revision === Number(last.revision) && afterId === last.id) throw new Error('Manifest cursor did not advance');
      revision = Number(last.revision); afterId = last.id; synced += manifests.length;
      if (manifests.length < 200) return { synced, lastRevision: revision };
    }
  })();
  flights.set(key, job);
  try { return await job; } finally { if (flights.get(key) === job) flights.delete(key); }
}
