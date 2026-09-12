-- Expand only raw-source lifecycle; analytics status remains independent.
CREATE TABLE import_bundle_manifest_next (
  id                      TEXT PRIMARY KEY,
  account_id              TEXT NOT NULL,
  server_property_id      TEXT NOT NULL,
  report_type             TEXT NOT NULL,
  raw_archive_id          TEXT,
  raw_object_key          TEXT,
  raw_file_hash           TEXT NOT NULL,
  raw_size                INTEGER DEFAULT 0,
  raw_mime_type           TEXT,
  archive_status          TEXT CHECK (archive_status IN ('pending', 'archived', 'failed', 'destroying', 'destroyed')) DEFAULT 'pending',
  processing_status       TEXT CHECK (processing_status IN ('pending', 'processing', 'active', 'failed')) DEFAULT 'pending',
  normalized_hash         TEXT,
  object_key              TEXT,
  normalized_object_key   TEXT,
  schema_version          INTEGER NOT NULL DEFAULT 1,
  parser_version          INTEGER NOT NULL DEFAULT 1,
  source_immutable        INTEGER NOT NULL DEFAULT 1,
  row_count               INTEGER NOT NULL DEFAULT 0,
  entity_counts_json      TEXT NOT NULL DEFAULT '{}',
  min_date                TEXT,
  max_date                TEXT,
  original_file_name      TEXT NOT NULL,
  file_size               INTEGER NOT NULL DEFAULT 0,
  compressed_size         INTEGER NOT NULL DEFAULT 0,
  attempt_count           INTEGER NOT NULL DEFAULT 0,
  last_error_code         TEXT,
  last_error_at           TEXT,
  uploaded_by             TEXT NOT NULL,
  status                  TEXT NOT NULL CHECK (status IN ('staged', 'raw_archived', 'processing', 'active', 'failed_processing', 'tombstoned', 'superseded', 'destroyed', 'aborted')) DEFAULT 'staged',
  created_at              TEXT NOT NULL,
  archived_at             TEXT,
  activated_at            TEXT,
  deleted_at              TEXT,
  supersedes_bundle_id    TEXT,
  superseded_by_bundle_id TEXT,
  superseded_at           TEXT,
  superseded_by_user      TEXT,
  revision                INTEGER NOT NULL DEFAULT 0,
  identity_version        INTEGER NOT NULL DEFAULT 1,
  raw_destroy_requested_at TEXT,
  raw_destroyed_at         TEXT,
  FOREIGN KEY (account_id) REFERENCES account(id) ON DELETE CASCADE
);


INSERT INTO import_bundle_manifest_next (id, account_id, server_property_id, report_type, raw_archive_id, raw_object_key, raw_file_hash, raw_size, raw_mime_type, archive_status, processing_status, normalized_hash, object_key, normalized_object_key, schema_version, parser_version, source_immutable, row_count, entity_counts_json, min_date, max_date, original_file_name, file_size, compressed_size, attempt_count, last_error_code, last_error_at, uploaded_by, status, created_at, archived_at, activated_at, deleted_at, supersedes_bundle_id, superseded_by_bundle_id, superseded_at, superseded_by_user, revision) SELECT id, account_id, server_property_id, report_type, raw_archive_id, raw_object_key, raw_file_hash, raw_size, raw_mime_type, archive_status, processing_status, normalized_hash, object_key, normalized_object_key, schema_version, parser_version, source_immutable, row_count, entity_counts_json, min_date, max_date, original_file_name, file_size, compressed_size, attempt_count, last_error_code, last_error_at, uploaded_by, status, created_at, archived_at, activated_at, deleted_at, supersedes_bundle_id, superseded_by_bundle_id, superseded_at, superseded_by_user, revision FROM import_bundle_manifest;
DROP TABLE import_bundle_manifest;
ALTER TABLE import_bundle_manifest_next RENAME TO import_bundle_manifest;
CREATE UNIQUE INDEX IF NOT EXISTS idx_bundle_active_normalized
  ON import_bundle_manifest (account_id, server_property_id, normalized_hash)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_bundle_active_raw
  ON import_bundle_manifest (account_id, server_property_id, raw_file_hash)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_bundle_raw_hash
  ON import_bundle_manifest (account_id, server_property_id, raw_file_hash);

CREATE INDEX IF NOT EXISTS idx_bundle_sync_revision
  ON import_bundle_manifest (account_id, status, revision);

CREATE INDEX IF NOT EXISTS idx_bundle_property_type
  ON import_bundle_manifest (account_id, server_property_id, report_type, status);

CREATE INDEX IF NOT EXISTS idx_bundle_pending_processing
  ON import_bundle_manifest (account_id, server_property_id, status);
