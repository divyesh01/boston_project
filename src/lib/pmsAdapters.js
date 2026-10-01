// Daily-summary adapters only. Unsupported reservation/folio layouts must be
// mapped explicitly; they cannot be safely treated as zero-valued daily reports.
import { PMS_ADAPTERS } from './enterpriseSchema.js';
const normalize = value => String(value ?? '').trim().toLowerCase().replace(/[_\s-]+/g, ' ');
const aliases = Object.freeze({
  'business date': 'Date', 'stay date': 'Date', 'revenue date': 'Date', date: 'Date',
  'room revenue': 'Room Revenue', 'rooms revenue': 'Room Revenue', 'net room revenue': 'Room Revenue',
  'rooms sold': 'Total Sold Rooms', 'rooms occupied': 'Total Sold Rooms', 'occupied rooms': 'Total Sold Rooms',
  'total rooms': 'Total Rooms', 'room inventory': 'Total Rooms',
  'occupancy': 'Occupancy Including OOO Comp and House Use', 'occupancy %': 'Occupancy Including OOO Comp and House Use',
  adr: 'ADR', revpar: 'RevPAR With OOO Rooms', 'room rent': 'Room Rent', 'misc charge': 'Misc Charge',
  'state tax': 'State Tax', 'city tax': 'City Tax', 'other tax': 'Other Tax', 'local tax': 'City Tax',
  'net revenue': 'Net Revenue', 'channel revenue': 'Net Revenue', 'source': 'Source', 'channel': 'Source', 'code': 'Code', stays: 'Stays',
  cash: 'CASH', visa: 'VISA', mastercard: 'MASTER', master: 'MASTER', amex: 'AMEX', discover: 'DISCOVER', check: 'CHECK',
  'direct bill': 'DIRECT BILL', 'wire transfer': 'WIRE TRANSFER', 'payment total': 'Total', total: 'Total',
  'system charge': 'System', food: 'Food', beverage: 'Beverage', laundry: 'Laundry', bar: 'Bar', event: 'Event', phone: 'Phone', other: 'Other',
});
export function adaptPmsGrid(rawRows, { adapter = 'hotelkey', type = 'auto', propertyId } = {}) {
  if (!PMS_ADAPTERS.includes(adapter)) throw new Error('Unsupported PMS adapter. Configure a mapped daily CSV export.');
  if (adapter === 'hotelkey') return { rawRows, adapter, type };
  const headerIndex = rawRows.slice(0, 20).findIndex(row => row.some(cell => aliases[normalize(cell)] === 'Date'));
  if (headerIndex < 0) throw new Error(`${adapter}: no business-date header found. Use a daily summary export.`);
  const original = rawRows[headerIndex].map(normalize);
  const headers = original.map((value, i) => aliases[value] || rawRows[headerIndex][i]);
  const dateIndex = headers.indexOf('Date');
  if (headers.filter(h => h === 'Date').length !== 1) throw new Error('Multiple date columns: map the business-date column explicitly.');
  const recognized = headers.filter(h => Object.values(aliases).includes(h));
  if (new Set(recognized).size !== recognized.length) throw new Error('Multiple columns map to the same daily field. Remove ambiguous columns before import.');
  const inferred = headers.includes('Total Sold Rooms') && headers.includes('Room Revenue') ? 'occupancy'
    : headers.includes('Net Revenue') && headers.includes('Source') ? 'source'
      : headers.includes('Room Rent') ? 'gross'
        : headers.some(h => ['CASH', 'VISA', 'MASTER', 'AMEX', 'DISCOVER', 'DIRECT BILL'].includes(h)) ? 'payments' : null;
  if (!inferred || (type !== 'auto' && type && type !== inferred)) throw new Error(`${adapter}: unsupported or mismatched daily-summary columns. Select the correct report or map this export.`);
  const propertyIndex = original.indexOf('property id');
  const rows = rawRows.slice(headerIndex + 1).filter(row => row.some(cell => cell != null && String(cell).trim()));
  for (const row of rows) {
    if (propertyIndex >= 0 && row[propertyIndex] != null && String(row[propertyIndex]).trim() && String(row[propertyIndex]).trim() !== String(propertyId)) throw new Error('This CSV contains a different property ID. Import each property separately.');
    if (/\d{4}-\d{2}-\d{2}[T ]\d{2}:/.test(String(row[dateIndex] || ''))) throw new Error('Use an explicit business-date column, not a timestamp, for financial imports.');
  }
  return { rawRows: [headers, ...rows], adapter, type: inferred };
}
