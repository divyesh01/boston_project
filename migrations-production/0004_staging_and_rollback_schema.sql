-- 0004_staging_and_rollback_schema.sql
-- Implements transaction staging and inverse-operation rollback journaling
-- to eliminate full-generation cloning and enable O(M) atomic transactions.

PRAGMA foreign_keys = ON;

-- 1. Transaction Delta Staging Table
-- Holds pending mutations (inserts, updates, deletes) before atomic commit.
CREATE TABLE IF NOT EXISTS business_record_staging (
  account_id         TEXT NOT NULL,
  transaction_id     TEXT NOT NULL,
  entity_name        TEXT NOT NULL,
  record_key         TEXT NOT NULL,
  property_key       TEXT,
  server_property_id TEXT,
  operation          TEXT NOT NULL CHECK (operation IN ('insert', 'update', 'delete')),
  row_json           TEXT,
  row_hash           TEXT,
  base_row_hash      TEXT,
  created_at         TEXT NOT NULL,
  PRIMARY KEY (account_id, transaction_id, entity_name, record_key),
  FOREIGN KEY (account_id) REFERENCES account(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_staging_lookup
  ON business_record_staging (account_id, transaction_id);

-- 2. Transaction Rollback Journal Table
-- Stores pre-images and post-image hashes for committed transactions,
-- enabling safe O(M) rollback with CAS conflict detection.
CREATE TABLE IF NOT EXISTS business_rollback_journal (
  account_id           TEXT NOT NULL,
  transaction_id       TEXT NOT NULL,
  entity_name          TEXT NOT NULL,
  record_key           TEXT NOT NULL,
  property_key         TEXT,
  server_property_id   TEXT,
  operation            TEXT NOT NULL CHECK (operation IN ('create', 'update', 'delete')),
  pre_commit_revision  INTEGER NOT NULL,
  previous_row_json    TEXT,
  previous_row_hash    TEXT,
  applied_row_hash     TEXT,
  committed_at         TEXT NOT NULL,
  PRIMARY KEY (account_id, transaction_id, entity_name, record_key),
  FOREIGN KEY (account_id) REFERENCES account(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_rollback_journal_lookup
  ON business_rollback_journal (account_id, transaction_id);

CREATE INDEX IF NOT EXISTS idx_rollback_journal_record
  ON business_rollback_journal (account_id, entity_name, record_key);

-- 3. Migration Transaction Barrier Flag
-- Track whether post-migration edits have occurred on an active generation.
ALTER TABLE business_dataset ADD COLUMN post_migration_mutated INTEGER NOT NULL DEFAULT 0;

-- 4. Staged Transaction Rollback Timestamp
ALTER TABLE business_staging_transaction ADD COLUMN rolled_back_at TEXT;
