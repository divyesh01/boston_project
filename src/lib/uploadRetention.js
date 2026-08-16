// Retention hygiene for UploadedReport.raw_rows.
//
// raw_rows is kept only as a 100-row preview (see Import.jsx scanRawRows). To stop
// that preview from living forever in IndexedDB — and to keep the local footprint
// nimble — every preview carries a raw_rows_ttl. This sweep nulls out previews that
// have aged past their TTL. It is safe to run repeatedly; it only writes when
// something is actually expired.
import localDb from '@/api/localDb';
import { db } from '@/api/base44Client';

const RAW_ROWS_TTL_DAYS = 90;

export function isRawRowsExpired(report) {
  const ttl = report?.raw_rows_ttl;
  if (!ttl) return false; // No TTL stamped → leave untouched (legacy rows).
  return new Date(ttl).getTime() <= Date.now();
}

export async function purgeExpiredUploadedReportRawRows() {
  try {
    const nowIso = new Date().toISOString();
    // Scoped read: the sweep may only touch reports the caller is entitled to.
    // Reading the raw table swept every property's previews on behalf of whoever
    // happened to open the import history.
    const all = await db.entities.UploadedReport.list();
    const expired = all.filter((r) => r.raw_rows && r.raw_rows.length && isRawRowsExpired(r));
    if (!expired.length) return { purged: 0 };
    // The writes stay on raw localDb deliberately. They run inside a
    // localDb.transaction zone, and the proxy's scope lookup can await a
    // macrotask, which kills the zone and throws TransactionInactiveError
    // (blocker B6). Scoping already happened on the read above: `expired` only
    // ever contains ids this caller may write.
    await localDb.transaction('rw', localDb.UploadedReport, async () => {
      for (const r of expired) {
        await localDb.UploadedReport.update(r.id, { raw_rows: [], raw_rows_purged_at: nowIso });
      }
    });
    return { purged: expired.length };
  } catch (e) {
    console.warn('[retention] raw_rows TTL sweep failed:', e?.message);
    return { purged: 0, error: e?.message };
  }
}

export const UPLOAD_RETENTION_TTL_DAYS = RAW_ROWS_TTL_DAYS;
