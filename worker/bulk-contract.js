// Shared wire contract; no browser or Worker bindings.
export const BULK_ENTITIES = Object.freeze(['OccupancyDay', 'SourceDay', 'GrossRevenueDay', 'PaymentDay',
  'ClerkShiftRecord', 'TimecardPunch', 'AdjustmentRefund', 'HotelMetric', 'TransactionLine']);
export const REPORT_ENTITY = Object.freeze({occupancy:'OccupancyDay',source:'SourceDay',gross_revenue:'GrossRevenueDay',payments:'PaymentDay',clerk:'ClerkShiftRecord',timecard:'TimecardPunch',adjustments_refunds:'AdjustmentRefund',hotel_statistics:'HotelMetric',transactions:'TransactionLine'});
const provenance = new Set(['id', 'import_id', 'bulk_import_id', 'created_date', 'updated_date',
  'source_file', 'property_name', 'file_hash', 'raw_archive_id']);
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
export function normalizedContent(items) {
  return items.map(({ entity, row }) => JSON.stringify(canonical({ entity,
    row: Object.fromEntries(Object.entries(row).filter(([key]) => !provenance.has(key))) }))).sort().join('\n');
}
export async function contentHash(text) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}
export function parseBundle(text, propertyId) {
  if (!text.trim()) throw new Error('Empty bundle');
  const items = text.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
  for (const item of items) {
    if (!BULK_ENTITIES.includes(item?.entity) || !item.row || Array.isArray(item.row) ||
        typeof item.row !== 'object' || item.row.property_id !== propertyId) throw new Error('Invalid bundle row or property');
  }
  return items;
}
