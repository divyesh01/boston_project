PRAGMA foreign_keys = ON;

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE principals (
  access_sub TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'manager', 'staff', 'viewer')),
  property_scope_json TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE snapshot_revisions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  checksum TEXT NOT NULL,
  encoding TEXT NOT NULL CHECK (encoding = 'gzip-json-v1'),
  chunk_count INTEGER NOT NULL CHECK (chunk_count BETWEEN 1 AND 32),
  compressed_bytes INTEGER NOT NULL,
  uncompressed_bytes INTEGER NOT NULL,
  created_by_sub TEXT NOT NULL REFERENCES principals(access_sub),
  created_at TEXT NOT NULL
);

CREATE TABLE snapshot_chunks (
  revision_id TEXT NOT NULL REFERENCES snapshot_revisions(id),
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0 AND chunk_index < 32),
  payload BLOB NOT NULL,
  PRIMARY KEY (revision_id, chunk_index)
);

CREATE TABLE account_snapshots (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  current_revision_id TEXT NOT NULL REFERENCES snapshot_revisions(id),
  version INTEGER NOT NULL CHECK (version >= 1),
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_principals_account ON principals(account_id);
CREATE INDEX idx_revisions_account_created ON snapshot_revisions(account_id, created_at);
