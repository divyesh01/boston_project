// The manifest is the server's record of an active bulk import. Legacy history
// is kept only where no active manifest represents the same original file.
export function mergeImportHistory(legacyRows, manifests) {
  const active = manifests.filter((manifest) => manifest.status === 'active').map((manifest) => ({
    id: manifest.id,
    import_id: manifest.id,
    bulk_import_id: manifest.id,
    raw_archive_id: manifest.raw_archive_id || manifest.id,
    property_id: manifest.server_property_id,
    report_type: manifest.report_type === 'gross_revenue' ? 'gross' : manifest.report_type,
    file_name: manifest.original_file_name,
    content_hash: manifest.raw_file_hash,
    rows_imported: manifest.row_count,
    status: 'completed',
    created_date: manifest.activated_at || manifest.created_at,
  }));
  const keys = new Set(active.map(historyKey));
  // Prefer the first successful legacy import: its session owns the rows and
  // Undo ledger. A later duplicate history entry may own no data at all.
  const legacy = [...legacyRows].sort((a, b) => String(a.created_date || '').localeCompare(String(b.created_date || '')));
  const merged = [...active];
  for (const row of legacy) {
    const key = historyKey(row);
    if (key && keys.has(key)) continue;
    if (key) keys.add(key);
    merged.push(row);
  }
  return merged.sort((a, b) => String(b.created_date || '').localeCompare(String(a.created_date || '')));
}

function historyKey(row) {
  const hash = row.content_hash || row.file_hash;
  return hash && row.property_id ? `${row.property_id}:${row.report_type}:${hash}` : '';
}
