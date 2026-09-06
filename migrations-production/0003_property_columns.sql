-- 0003_property_columns.sql
-- Add property profile and bookkeeping columns to align production property table
-- with business sync insertion statements and worker/schema.sql.

ALTER TABLE property ADD COLUMN address TEXT;
ALTER TABLE property ADD COLUMN phone TEXT;
ALTER TABLE property ADD COLUMN created_date TEXT;

CREATE INDEX IF NOT EXISTS idx_property_account ON property (account_id);
CREATE INDEX IF NOT EXISTS idx_business_record_property_key ON business_record (account_id, generation_id, property_key);
