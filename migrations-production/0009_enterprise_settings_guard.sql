-- Property enterprise profiles/templates use app_setting's existing account and
-- property scope. This guard makes expected_revision transactional in D1.
CREATE TABLE IF NOT EXISTS app_setting (
  account_id TEXT NOT NULL, setting_key TEXT NOT NULL,
  property_id TEXT NOT NULL DEFAULT '*', value_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1, updated_by TEXT, updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, setting_key, property_id)
);
CREATE INDEX IF NOT EXISTS idx_app_setting_lookup ON app_setting (account_id, property_id);
CREATE TABLE IF NOT EXISTS app_setting_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL,
  setting_key TEXT NOT NULL, property_id TEXT NOT NULL DEFAULT '*', old_value TEXT,
  new_value TEXT NOT NULL, revision INTEGER NOT NULL, changed_by TEXT, changed_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_app_setting_history_revision_guard
  ON app_setting_history (account_id, setting_key, property_id, revision);
CREATE TABLE IF NOT EXISTS app_setting_write_guard (
  account_id TEXT NOT NULL, request_id TEXT NOT NULL, next_revision INTEGER NOT NULL,
  valid INTEGER NOT NULL CONSTRAINT settings_revision_match CHECK (valid = 1),
  PRIMARY KEY (account_id, request_id)
);
