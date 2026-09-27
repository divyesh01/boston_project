import { describe, expect, it } from 'vitest';
import { mergeImportHistory, importPropertyLabel } from './importHistory.js';

describe('authoritative import history', () => {
  it('shows a server success even when this browser has no local history', () => {
    const rows = mergeImportHistory([], [{ id: 'source-1', status: 'active', server_property_id: 'property-1',
      report_type: 'source', original_file_name: 'Source Summary.csv', raw_file_hash: 'hash-1',
      row_count: 7918, activated_at: '2026-09-24T13:00:00Z' }]);
    expect(rows).toMatchObject([{ id: 'source-1', rows_imported: 7918, report_type: 'source' }]);
  });

  it('keeps the legacy history session that owns the rows and hides its orphan duplicate', () => {
    const older = { id: 'first', import_id: 'data-owner', property_id: 'property-1', report_type: 'gross',
      content_hash: 'same-file', created_date: '2026-09-24T04:00:00Z' };
    const newer = { ...older, id: 'second', import_id: 'orphan', created_date: '2026-09-24T13:00:00Z' };
    expect(mergeImportHistory([newer, older], []).map((row) => row.import_id)).toEqual(['data-owner']);
  });

  it('prefers an active manifest over local history for the same source', () => {
    const rows = mergeImportHistory([{ id: 'stale', property_id: 'property-1', report_type: 'source',
      content_hash: 'same-file' }], [{ id: 'active', status: 'active', server_property_id: 'property-1',
      report_type: 'source', raw_file_hash: 'same-file' }]);
    expect(rows.map((row) => row.id)).toEqual(['active']);
  });

  it('does not show a hydrated gross report twice under gross and gross_revenue', () => {
    const rows = mergeImportHistory([
      { id: 'bundle-1', bulk_import_id: 'bundle-1', property_id: 'HOTEL_A', report_type: 'gross_revenue',
        file_hash: 'raw-1', rows_imported: 214 },
    ], [
      { id: 'bundle-1', status: 'active', server_property_id: 'HOTEL_A', report_type: 'gross_revenue',
        raw_file_hash: 'raw-1', original_file_name: 'Gross Revenue.csv', row_count: 214 },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'bundle-1', report_type: 'gross', rows_imported: 214 });
  });

  it('reconciles a local property alias only when the server proves it belongs to the manifest', () => {
    const manifest = { id: 'bundle-1', status: 'active', server_property_id: 'HOTEL_A',
      legacy_property_ids: ['local-a'], report_type: 'source', raw_file_hash: 'raw-1' };
    const rows = mergeImportHistory([
      { id: 'local-copy', property_id: 'local-a', report_type: 'source', file_hash: 'raw-1' },
      { id: 'other-property', property_id: 'local-b', report_type: 'source', file_hash: 'raw-1' },
    ], [manifest]);
    expect(rows.map((row) => row.id)).toEqual(['bundle-1', 'other-property']);
  });

  it('uses only a server-proven property alias to label an active report', () => {
    const properties = [{ id: 'local-a', name: 'Hotel A' }, { id: 'local-b', name: 'Hotel B' }];
    expect(importPropertyLabel({ bulk_import_id: 'bundle-a', property_id: 'HOTEL_A',
      property_aliases: ['local-a'] }, properties)).toBe('Hotel A');
    expect(importPropertyLabel({ bulk_import_id: 'bundle-x', property_id: 'HOTEL_X',
      property_aliases: [] }, properties)).toBe('—');
  });
});
