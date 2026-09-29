-- 0008_property_day_summary.sql
-- Server-authoritative daily aggregates for fast-path owner intelligence rendering.
-- Stores compact daily KPI totals per property-day so dashboard loads in <1s
-- without hydrating entire historical raw ledgers into the browser.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS property_day_summary (
  id                       TEXT PRIMARY KEY,
  account_id               TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  property_id              TEXT NOT NULL REFERENCES property(id) ON DELETE CASCADE,
  business_date            TEXT NOT NULL,
  room_revenue_cents       INTEGER NOT NULL DEFAULT 0,
  ancillary_revenue_cents  INTEGER NOT NULL DEFAULT 0,
  total_revenue_cents      INTEGER NOT NULL DEFAULT 0,
  rooms_sold               REAL NOT NULL DEFAULT 0,
  available_rooms          REAL NOT NULL DEFAULT 0,
  adr_cents                INTEGER NOT NULL DEFAULT 0,
  occupancy_rate           REAL NOT NULL DEFAULT 0,
  revpar_cents             INTEGER NOT NULL DEFAULT 0,
  gross_ota_revenue_cents  INTEGER NOT NULL DEFAULT 0,
  direct_revenue_cents     INTEGER NOT NULL DEFAULT 0,
  ota_commission_cents     INTEGER NOT NULL DEFAULT 0,
  refund_cents             INTEGER NOT NULL DEFAULT 0,
  payment_total_cents      INTEGER NOT NULL DEFAULT 0,
  channel_summary_json     TEXT NOT NULL DEFAULT '{}',
  data_health_score        REAL NOT NULL DEFAULT 100,
  source_manifest_revision INTEGER NOT NULL DEFAULT 0,
  updated_at               TEXT NOT NULL,
  UNIQUE (account_id, property_id, business_date)
);

CREATE INDEX IF NOT EXISTS idx_pds_account_property_date
  ON property_day_summary (account_id, property_id, business_date);

CREATE INDEX IF NOT EXISTS idx_pds_account_date
  ON property_day_summary (account_id, business_date);
