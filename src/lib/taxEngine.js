import { toCents, fromCents } from './decimal.js';
import { getEnterpriseConfig } from './enterpriseConfigEngine.js';

// PMS tax lines take precedence in calculationService. This engine calculates
// configured estimates only. A channel name alone never proves remittance.
export function calculateJurisdictionTax({ base, roomNights = null, stayNights = null, exemptionConfirmed = false, remittanceEvidence = null }, jurisdictions) {
  const totals = { state: 0, city: 0, other: 0, hotel: 0, marketplace: 0, total: 0, lines: [], incomplete: false };
  for (const j of jurisdictions) {
    const exempt = exemptionConfirmed === true && j.exempt_after_nights != null && Number(stayNights) >= j.exempt_after_nights;
    const unitsKnown = j.type !== 'flat_per_night' || (Number.isFinite(roomNights) && roomNights >= 0);
    const amount = exempt ? 0 : !unitsKnown ? null : j.type === 'percentage' ? Math.round(toCents(base) * j.rate) : Math.round(toCents(j.rate) * roomNights);
    const confirmed = j.remitter === 'marketplace' && remittanceEvidence?.confirmed === true && !!remittanceEvidence?.reference && (remittanceEvidence.jurisdiction_ids || []).includes(j.id);
    const remitter = confirmed ? 'marketplace' : 'hotel';
    const bucket = ['state', 'city'].includes(j.kind) ? j.kind : 'other';
    const cents = amount ?? 0;
    totals[bucket] += cents;
    totals[remitter] += cents;
    totals.total += cents;
    totals.incomplete ||= amount === null;
    totals.lines.push({ id: j.id, label: j.label || j.id, kind: j.kind, type: j.type, rate: j.rate, base: j.type === 'percentage' ? base : roomNights,
      amount: amount == null ? null : fromCents(amount), remitter, exempt, evidence: confirmed ? remittanceEvidence.reference : null,
      confirmationRequired: j.remitter === 'marketplace' && !confirmed });
  }
  for (const key of ['state', 'city', 'other', 'hotel', 'marketplace', 'total']) totals[key] = fromCents(totals[key]);
  return totals;
}

export function estimateEnterpriseTax(propertyId, date, base, occupancyRows) {
  const cfg = getEnterpriseConfig(propertyId, date);
  if (!Array.isArray(cfg.tax_jurisdictions)) return null;
  const rows = occupancyRows.filter(row => String(row.property_id) === String(propertyId) && String(row.date).slice(0, 10) === date);
  const unitsKnown = rows.length > 0 && rows.every(row => row.rooms_sold != null && row.rooms_sold !== '' && Number.isFinite(Number(row.rooms_sold)) && Number(row.rooms_sold) >= 0);
  // Aggregate-day inputs cannot establish guest-specific long-stay exemptions or
  // marketplace remittance. Those facts belong to documented transaction evidence.
  return calculateJurisdictionTax({ base, roomNights: unitsKnown ? rows.reduce((n, row) => n + Number(row.rooms_sold), 0) : null }, cfg.tax_jurisdictions);
}
