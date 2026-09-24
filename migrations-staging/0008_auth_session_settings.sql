-- Staging predates the production auth/session and settings tables. Its
-- account, user, and property tables already exist; only add the missing
-- tables from migrations-production/0001_auth_schema.sql and worker/schema.sql.
-- This file is staging-only and safe to re-run.
CREATE TABLE IF NOT EXISTS app_session (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  remember INTEGER NOT NULL DEFAULT 0 CHECK (remember IN (0, 1))
);
CREATE INDEX IF NOT EXISTS idx_app_session_user ON app_session (user_id);
CREATE INDEX IF NOT EXISTS idx_app_session_expiry ON app_session (expires_at);

CREATE TABLE IF NOT EXISTS app_mfa_challenge (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_app_mfa_challenge_expiry ON app_mfa_challenge (expires_at);

CREATE TABLE IF NOT EXISTS app_setting (
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  setting_key TEXT NOT NULL,
  property_id TEXT NOT NULL DEFAULT '*',
  value_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, setting_key, property_id)
);
CREATE INDEX IF NOT EXISTS idx_app_setting_lookup ON app_setting (account_id, property_id);

CREATE TABLE IF NOT EXISTS app_setting_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  setting_key TEXT NOT NULL,
  property_id TEXT NOT NULL DEFAULT '*',
  old_value TEXT,
  new_value TEXT NOT NULL,
  revision INTEGER NOT NULL,
  changed_by TEXT,
  changed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_app_setting_history ON app_setting_history (account_id, setting_key, property_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_app_setting_history_revision_guard
  ON app_setting_history (account_id, setting_key, property_id, revision);
