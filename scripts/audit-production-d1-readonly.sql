-- scripts/audit-production-d1-readonly.sql
-- Purely READ-ONLY diagnostic queries for production Cloudflare D1.
-- Safe to execute against live production: contains ZERO mutating statements.

-- 1. Migration Tracker State
SELECT id, name, applied_at FROM d1_migrations ORDER BY id;

-- 2. Bulk Import & Business Table Inventory
SELECT type, name FROM sqlite_master WHERE type='table' AND (name LIKE 'import_%' OR name LIKE 'business_%' OR name IN ('property', 'account', 'app_session')) ORDER BY name;

-- 3. Manifest Status Counts
SELECT status, count(*) AS manifest_count FROM import_bundle_manifest GROUP BY status ORDER BY manifest_count DESC;

-- 4. Active Generation and Dataset Pointer
SELECT account_id, active_generation_id, updated_at FROM business_dataset_pointer;

-- 5. Legacy Business Table Row Counts
SELECT 'business_record' AS table_name, count(*) AS row_count FROM business_record
UNION ALL SELECT 'business_change', count(*) FROM business_change
UNION ALL SELECT 'business_dataset', count(*) FROM business_dataset
UNION ALL SELECT 'business_property_map', count(*) FROM business_property_map
UNION ALL SELECT 'business_staging_transaction', count(*) FROM business_staging_transaction;

-- 6. Active Report Coverage (Date Ranges & Entity Counts)
SELECT report_type, count(*) AS active_bundles, min(min_date) AS earliest_covered_date, max(max_date) AS latest_covered_date, sum(row_count) AS total_rows
FROM import_bundle_manifest WHERE status = 'active' GROUP BY report_type ORDER BY report_type;

-- 7. Account & Property Scoping
SELECT id AS property_id, account_id, code, name, active FROM property ORDER BY account_id, id;

-- 8. Business Sync State Revisions
SELECT account_id, revision FROM business_sync_state;

-- 9. Business Change Stream Head Revision
SELECT account_id, max(seq) AS head_seq, count(*) AS total_change_events FROM business_change GROUP BY account_id;

-- 10. Active Overlap Candidates (potential collisions)
SELECT account_id, server_property_id, report_type, count(*) AS active_count
FROM import_bundle_manifest WHERE status = 'active'
GROUP BY account_id, server_property_id, report_type HAVING count(*) > 1;

-- 11. Orphan Manifest References (account missing)
SELECT m.id AS orphan_bundle_id, m.account_id
FROM import_bundle_manifest m LEFT JOIN account a ON m.account_id = a.id
WHERE a.id IS NULL;

-- 12. Broken Predecessor or Supersede Lineage
SELECT id, status, supersedes_bundle_id, superseded_by_bundle_id
FROM import_bundle_manifest
WHERE (supersedes_bundle_id IS NOT NULL AND supersedes_bundle_id NOT IN (SELECT id FROM import_bundle_manifest))
   OR (superseded_by_bundle_id IS NOT NULL AND superseded_by_bundle_id NOT IN (SELECT id FROM import_bundle_manifest));

-- 13. Duplicate Active Normalized Hashes (Identity Violation)
SELECT account_id, server_property_id, normalized_hash, count(*) AS count
FROM import_bundle_manifest WHERE status = 'active'
GROUP BY account_id, server_property_id, normalized_hash HAVING count(*) > 1;

-- 14. Raw Archive Lifecycle Counts
SELECT archive_status, count(*) AS count
FROM import_bundle_manifest GROUP BY archive_status ORDER BY count DESC;

-- 15. Destroying or Destroyed Raw Archive Records
SELECT id, account_id, server_property_id, archive_status, raw_object_key, raw_destroy_requested_at, raw_destroyed_at
FROM import_bundle_manifest WHERE archive_status IN ('destroying', 'destroyed');

-- 16. Indexes Present on import_bundle_manifest
SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='import_bundle_manifest' ORDER BY name;

-- 17. Foreign Key Integrity Check
PRAGMA foreign_key_check;
