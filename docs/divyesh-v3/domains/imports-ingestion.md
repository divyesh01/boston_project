# Imports and Data Ingestion Domain Pack

Use Raw → Parse → Normalize → Validate → Sanitize → Persist → Consume. Test CRLF,
empty rows, quoted commas, malformed headers, Unicode, duplicates, large inputs, and
partial persistence. Never silently drop rows. Formula neutralization belongs at
export, not numeric import. Import retries need idempotency or rollback.

