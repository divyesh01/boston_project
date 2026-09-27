// The manifest is the server's record of an active bulk import. Legacy history
// is kept only where no active manifest represents the same original file.
export function mergeImportHistory(legacyRows, manifests) {
  const active = manifests.filter((manifest) => manifest.status === 'active').map((manifest) => ({
    id: manifest.id,
    import_id: manifest.id,
    bulk_import_id: manifest.id,
    raw_archive_id: manifest.raw_archive_id || manifest.id,
    property_id: manifest.server_property_id,
    property_aliases: manifest.legacy_property_ids || [],
    report_type: manifest.report_type === 'gross_revenue' ? 'gross' : manifest.report_type,
    file_name: manifest.original_file_name,
    content_hash: manifest.raw_file_hash,
    rows_imported: manifest.row_count,
    status: 'completed',
    created_date: manifest.activated_at || manifest.created_at,
  }));
  const activeBundleIds = new Set(active.map((row) => row.id));
  const keys = new Set();
  for (const row of active) {
    for (const propertyId of [row.property_id, ...row.property_aliases]) {
      const key = historyKey({ ...row, property_id: propertyId });
      if (key) keys.add(key);
    }
  }
  // Prefer the first successful legacy import: its session owns the rows and
  // Undo ledger. A later duplicate history entry may own no data at all.
  const legacy = [...legacyRows].sort((a, b) => String(a.created_date || '').localeCompare(String(b.created_date || '')));
  const merged = [...active];
  for (const row of legacy) {
    // Hydration also stores a local UploadedReport for each active bundle.
    // Its report type can differ from the display type (gross_revenue/gross).
    if (activeBundleIds.has(row.bulk_import_id || row.id)) continue;
    const key = historyKey(row);
    if (key && keys.has(key)) continue;
    if (key) keys.add(key);
    merged.push(row);
  }
  return merged.sort((a, b) => String(b.created_date || '').localeCompare(String(a.created_date || '')));
}

function historyKey(row) {
  const hash = row.content_hash || row.file_hash;
  const type = row.report_type === 'gross_revenue' ? 'gross' : row.report_type;
  return hash && row.property_id ? `${row.property_id}:${type}:${hash}` : '';
}

export function importPropertyLabel(row, accessibleProperties) {
  const ids = row.bulk_import_id
    ? [row.property_id, ...(row.property_aliases || [])]
    : [row.property_id];
  const matches = accessibleProperties.filter((property) => ids.includes(property.id));
  if (matches.length === 1) return matches[0].name;
  if (row.bulk_import_id) return '—';
  return row.property_name || (accessibleProperties.length === 1 ? accessibleProperties[0].name : '—');
}
