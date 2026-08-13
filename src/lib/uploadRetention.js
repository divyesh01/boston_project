// Retention hygiene for UploadedReport.raw_rows.
//
// raw_rows is kept only as a 100-row preview (see Import.jsx scanRawRows). To stop
// that preview from living forever in IndexedDB — and to keep the local footprint
// nimble — every preview carries a raw_rows_ttl. This sweep nulls out previews that
// have aged past their TTL. It is safe to run repeatedly; it only writes when
// something is actually expired.
import localDb from '@/api/localDb';

const RAW_ROWS_TTL_DAYS = 90;

export function isRawRowsExpired(report) {
  const ttl = report?.raw_rows_ttl;
  if (!ttl) return false; // No TTL stamped → leave untouched (legacy rows).
  return new Date(ttl).getTime() <= Date.now();
}

export async function purgeExpiredUploadedReportRawRows() {
  try {
    const nowIso = new Date().toISOString();
    const all = await localDb.UploadedReport.toArray();
    const expired = all.filter((r) => r.raw_rows && r.raw_rows.length && isRawRowsExpired(r));
    if (!expired.length) return { purged: 0 };
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
