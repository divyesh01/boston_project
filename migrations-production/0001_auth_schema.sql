PRAGMA foreign_keys = ON;

-- Authentication-only production schema. Hotel/business entity tables are
-- intentionally absent; the Worker also denies their API routes unless a
-- separate server-side kill switch is explicitly enabled.
CREATE TABLE account (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_date TEXT NOT NULL
);

CREATE TABLE user (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  username TEXT NOT NULL,
  display_name TEXT,
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  property_access_mode TEXT NOT NULL CHECK (property_access_mode IN ('all','specific')),
  permissions TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  is_locked INTEGER NOT NULL DEFAULT 0,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  mfa_enabled INTEGER NOT NULL DEFAULT 0,
  email_confirmed INTEGER NOT NULL DEFAULT 1,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  mfa_secret TEXT,
  mfa_secret_pending TEXT,
  mfa_last_counter INTEGER,
  reset_token_hash TEXT,
  reset_token_expires_at TEXT,
  last_login TEXT,
  failed_login_count INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  session_created TEXT,
  session_expires TEXT,
  created_date TEXT NOT NULL,
  updated_date TEXT NOT NULL,
  UNIQUE (account_id, id)
);
CREATE UNIQUE INDEX idx_user_username_ci ON user (lower(username));
CREATE UNIQUE INDEX idx_user_email_ci ON user (lower(email));

-- Empty authorization metadata only. These tables let the existing scope
-- resolver project user access; the production kill switch prevents them from
-- becoming a business-data store and no browser hotel rows are migrated here.
CREATE TABLE property (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  rooms REAL,
  city TEXT,
  state TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (account_id, code),
  UNIQUE (account_id, id)
);

CREATE TABLE user_property_access (
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  FOREIGN KEY (account_id, user_id) REFERENCES user(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, property_id) REFERENCES property(account_id, id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, property_id)
);

CREATE TABLE app_session (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  remember INTEGER NOT NULL DEFAULT 0 CHECK (remember IN (0, 1))
);
CREATE INDEX idx_app_session_user ON app_session (user_id);
CREATE INDEX idx_app_session_expiry ON app_session (expires_at);

CREATE TABLE app_mfa_challenge (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_app_mfa_challenge_expiry ON app_mfa_challenge (expires_at);
