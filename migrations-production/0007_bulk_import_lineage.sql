-- 0007_bulk_import_lineage.sql
-- Relational lineage table for many-to-one report replacement.
-- Tracks explicit predecessor bundle IDs superseded by a successor bundle.
CREATE TABLE IF NOT EXISTS import_bundle_lineage (
  account_id            TEXT NOT NULL,
  successor_bundle_id   TEXT NOT NULL,
  predecessor_bundle_id TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  PRIMARY KEY (account_id, successor_bundle_id, predecessor_bundle_id),
  FOREIGN KEY (account_id) REFERENCES account(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_lineage_pred
  ON import_bundle_lineage (account_id, predecessor_bundle_id);

CREATE INDEX IF NOT EXISTS idx_lineage_succ
  ON import_bundle_lineage (account_id, successor_bundle_id);
