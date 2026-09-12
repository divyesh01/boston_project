import localDb from '../api/localDb.js';
import { decompressPayloadGzip } from './bulkImportPipeline.js';

const BULK_SYNC_KEY = 'authoritative-bulk-bundle-sync';

let inFlightSync = null;

export async function getLastBulkRevision() {
  try {
    const row = await localDb.BusinessSyncState.get(BULK_SYNC_KEY);
    return Number(row?.revision || 0);
  } catch {
    return 0;
  }
}

export async function setLastBulkRevision(revision) {
  try {
    await localDb.BusinessSyncState.put({
      key: BULK_SYNC_KEY,
      revision: Number(revision),
      updated_at: new Date().toISOString(),
    });
  } catch {}
}

/**
 * Hydrate bulk bundles from server manifest.
 * Used by Browser B, fresh tabs, and after reconnection.
 */
export async function syncBulkBundles({ force = false, propertyId = '' } = {}) {
  if (inFlightSync) return inFlightSync;

  inFlightSync = (async () => {
    try {
      const lastRevision = force ? 0 : await getLastBulkRevision();
      const url = new URL('/api/bulk-import/manifest', window?.location?.origin || 'http://localhost');
      url.searchParams.set('since_revision', String(lastRevision));
      if (propertyId) url.searchParams.set('server_property_id', propertyId);

      const res = await fetch(url.toString());
      if (!res.ok) return { synced: 0, lastRevision };

      const data = await res.json();
      const manifests = Array.isArray(data.manifests) ? data.manifests : [];
      if (manifests.length === 0) return { synced: 0, lastRevision };

      let currentRevision = lastRevision;

      for (const manifest of manifests) {
        if (manifest.status === 'active') {
          // Download bundle payload from R2 endpoint
          const bundleRes = await fetch(`/api/bulk-import/bundle/${manifest.id}`);
          if (bundleRes.ok) {
            const buffer = await bundleRes.arrayBuffer();
            const ndjson = await decompressPayloadGzip(buffer);
            const lines = ndjson.split('\n').filter(Boolean);

            const byEntity = {};
            for (const line of lines) {
              try {
                const item = JSON.parse(line);
                if (item && item.entity && item.row) {
                  if (!byEntity[item.entity]) byEntity[item.entity] = [];
                  byEntity[item.entity].push(item.row);
                }
              } catch {}
            }

            // Write materialized entities to Dexie tables
            const tablesToOpen = Object.keys(byEntity)
              .filter((ent) => localDb[ent])
              .map((ent) => localDb[ent]);

            if (tablesToOpen.length > 0) {
              await localDb.transaction('rw', [...tablesToOpen, localDb.UploadedReport], async () => {
                for (const [entityName, rows] of Object.entries(byEntity)) {
                  if (localDb[entityName] && rows.length > 0) {
                    await localDb[entityName].bulkPut(rows);
                  }
                }
                // Ensure UploadedReport reflects this bundle in the UI
                const existingRep = await localDb.UploadedReport.where('import_id').equals(manifest.id).first();
                if (!existingRep) {
                  await localDb.UploadedReport.put({
                    id: manifest.id,
                    file_name: manifest.original_file_name || 'report.csv',
                    report_type: manifest.report_type,
                    rows_imported: manifest.row_count,
                    rows_skipped: 0,
                    rows_parsed: manifest.row_count,
                    property_id: manifest.server_property_id,
                    status: 'completed',
                    raw_rows: [],
                    import_id: manifest.id,
                    file_hash: manifest.raw_file_hash || '',
                    created_date: manifest.activated_at || manifest.created_at,
                  });
                }
              });
            }
          }
        } else if (manifest.status === 'tombstoned') {
          // Evict all local rows materialized from this bundle
          const entityCounts = manifest.entity_counts || {};
          const entitiesToEvict = Object.keys(entityCounts).filter((ent) => localDb[ent]);

          for (const entityName of entitiesToEvict) {
            try {
              const toDelete = await localDb[entityName].where('import_id').equals(manifest.id).primaryKeys();
              if (toDelete.length > 0) {
                await localDb[entityName].bulkDelete(toDelete);
              }
            } catch {}
          }
          try {
            await localDb.UploadedReport.where('import_id').equals(manifest.id).delete();
          } catch {}
        }

        if (Number(manifest.revision) > currentRevision) {
          currentRevision = Number(manifest.revision);
        }
      }

      await setLastBulkRevision(currentRevision);
      return { synced: manifests.length, lastRevision: currentRevision };
    } finally {
      inFlightSync = null;
    }
  })();

  return inFlightSync;
}
