import { describe, expect, it } from 'vitest';
import { mergeImportHistory } from './importHistory.js';

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
});
