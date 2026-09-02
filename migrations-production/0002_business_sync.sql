PRAGMA foreign_keys = ON;

CREATE TABLE business_dataset (
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  generation_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('staging','active','retired','aborted','rolled_back')),
  schema_version INTEGER NOT NULL,
  manifest_hash TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  expected_chunks INTEGER NOT NULL,
  expected_records INTEGER NOT NULL,
  previous_generation_id TEXT,
  created_by TEXT NOT NULL REFERENCES user(id),
  created_at TEXT NOT NULL,
  activated_at TEXT,
  PRIMARY KEY (account_id, generation_id),
  UNIQUE (account_id, manifest_hash)
);
CREATE INDEX idx_business_dataset_status ON business_dataset (account_id, status);

CREATE TABLE business_dataset_pointer (
  account_id TEXT PRIMARY KEY REFERENCES account(id) ON DELETE CASCADE,
  active_generation_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (account_id, active_generation_id) REFERENCES business_dataset(account_id, generation_id)
);

CREATE TABLE business_property_map (
  account_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  property_key TEXT NOT NULL,
  server_property_id TEXT NOT NULL,
  property_code TEXT NOT NULL,
  PRIMARY KEY (account_id, generation_id, property_key),
  UNIQUE (account_id, generation_id, server_property_id),
  FOREIGN KEY (account_id, generation_id) REFERENCES business_dataset(account_id, generation_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, server_property_id) REFERENCES property(account_id, id) ON DELETE CASCADE
);

CREATE TABLE business_record (
  account_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  entity_name TEXT NOT NULL,
  record_key TEXT NOT NULL,
  property_key TEXT,
  server_property_id TEXT,
  row_json TEXT NOT NULL,
  row_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, generation_id, entity_name, record_key),
  FOREIGN KEY (account_id, generation_id) REFERENCES business_dataset(account_id, generation_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, server_property_id) REFERENCES property(account_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_business_record_snapshot ON business_record (account_id, generation_id, entity_name, record_key);
CREATE INDEX idx_business_record_property ON business_record (account_id, generation_id, server_property_id, entity_name);

CREATE TABLE business_migration_chunk (
  account_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  chunk_hash TEXT NOT NULL,
  record_count INTEGER NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (account_id, generation_id, chunk_index),
  FOREIGN KEY (account_id, generation_id) REFERENCES business_dataset(account_id, generation_id) ON DELETE CASCADE
);

CREATE TABLE business_sync_state (
  account_id TEXT PRIMARY KEY REFERENCES account(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE business_change (
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  generation_id TEXT NOT NULL,
  entity_name TEXT NOT NULL,
  record_key TEXT NOT NULL,
  server_property_id TEXT,
  operation TEXT NOT NULL CHECK (operation IN ('upsert','delete','property_delete')),
  row_json TEXT,
  row_hash TEXT,
  mutation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (account_id, seq),
  UNIQUE (account_id, mutation_id)
);
CREATE INDEX idx_business_change_scope ON business_change (account_id, server_property_id, seq);

CREATE TABLE business_mutation_guard (
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  mutation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  ok INTEGER NOT NULL CHECK (ok = 1),
  created_at TEXT NOT NULL,
  PRIMARY KEY (account_id, mutation_id)
);

CREATE TABLE business_id_sequence (
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  prefix TEXT NOT NULL,
  last_seq INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, prefix)
);
