import { TAX_REMITTANCE_KEY } from './enterpriseSchema.js';
import { readScopedJsonSetting } from './settingsStore.js';
import { toCents, fromCents } from './decimal.js';

export { validateRemittanceRecords } from './enterpriseSchema.js';

export function allocateDocumentedRemittance(propertyId, date, base, amounts) {
  const records = readScopedJsonSetting(TAX_REMITTANCE_KEY, [], propertyId);
  const matching = records.filter(r => r.date === date && r.reviewed === true && !!r.reference && toCents(r.taxable_base) === toCents(base));
  const reported = ['state', 'city', 'other'].reduce((n, key) => n + toCents(amounts[key]), 0);
  // Negative correction days cannot be allocated from positive statement entries.
  if (reported < 0) return { hotel: fromCents(reported), marketplace: 0, references: [], stale: false };
  const allocation = Object.fromEntries(['state', 'city', 'other'].map(key => [key, matching.reduce((n, r) => n + toCents(r[key]), 0)]));
  const excessive = ['state', 'city', 'other'].some(key => allocation[key] > Math.max(0, toCents(amounts[key])));
  const stale = records.some(r => r.date === date && toCents(r.taxable_base) !== toCents(base));
  if (excessive) return { hotel: fromCents(reported), marketplace: 0, references: [], stale: true };
  const marketplace = Object.values(allocation).reduce((n, cents) => n + cents, 0);
  return { hotel: fromCents(reported - marketplace), marketplace: fromCents(marketplace), references: matching.map(r => r.reference), stale };
}
