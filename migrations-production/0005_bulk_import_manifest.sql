-- 0005_bulk_import_manifest.sql
-- Authoritative D1 control plane for R2 immutable bulk import bundles.
-- Stores compact manifest metadata so bulk HotelKey ingestion scales D1 writes
-- O(files) instead of O(rows).

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS import_bundle_manifest (
  id                  TEXT PRIMARY KEY,
  account_id          TEXT NOT NULL,
  server_property_id  TEXT NOT NULL,
  report_type         TEXT NOT NULL,
  raw_file_hash       TEXT NOT NULL,
  normalized_hash     TEXT NOT NULL,
  object_key          TEXT NOT NULL,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  row_count           INTEGER NOT NULL,
  entity_counts_json  TEXT NOT NULL,
  min_date            TEXT,
  max_date            TEXT,
  original_file_name  TEXT NOT NULL,
  file_size           INTEGER NOT NULL,
  compressed_size     INTEGER NOT NULL,
  uploaded_by         TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('staged', 'active', 'tombstoned', 'aborted')) DEFAULT 'staged',
  created_at          TEXT NOT NULL,
  activated_at        TEXT,
  deleted_at          TEXT,
  revision            INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (account_id) REFERENCES account(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bundle_active_normalized
  ON import_bundle_manifest (account_id, server_property_id, normalized_hash)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_bundle_active_raw
  ON import_bundle_manifest (account_id, server_property_id, raw_file_hash)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_bundle_sync_revision
  ON import_bundle_manifest (account_id, status, revision);

CREATE INDEX IF NOT EXISTS idx_bundle_property_type
  ON import_bundle_manifest (account_id, server_property_id, report_type, status);
