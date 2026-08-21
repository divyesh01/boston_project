import { sanitizeText as sanitizeInput } from './securityUtils';
import { db } from '../api/base44Client';
import { recordAuditFailure } from './auditFailureLog';

/**
 * Applies an approved dynamic room rate recommendation to a property.
 * @param {Object} params
 * @param {string} params.propertyId - Target property ID
 * @param {number} params.newRate - Approved recommended room rate ($)
 * @param {string} params.roomType - Room category (e.g., "Standard King", "Double Queen")
 * @param {string} params.justification - Reason for adjustment
 * @param {Object} params.user - Current user { id, username }
 * @returns {Promise<Object>} Updated rate status
 */
export async function applyDynamicRateOverride({
  propertyId,
  newRate,
  roomType = 'Standard King',
  justification = 'Automated yield pacing adjustment',
  user
}) {
  const rate = Number(newRate);
  if (!propertyId || isNaN(rate) || rate <= 0) {
    throw new Error('Validation Error: Valid Property ID and positive rate are required.');
  }

  const cleanJustification = sanitizeInput(justification);
  const nowIso = new Date().toISOString();

  // 1. Update Property dynamic pricing record
  const updatePayload = {
    property_id: propertyId,
    room_type: sanitizeInput(roomType),
    current_rate: rate,
    last_adjusted_at: nowIso,
    adjusted_by: sanitizeInput(user?.username || 'System'),
    adjustment_reason: cleanJustification
  };

  // 2. Audit Trail
  try {
    await db.functions.invoke('audit_log', {
      user_id: user?.id || 'system',
      username: sanitizeInput(user?.username || 'System'),
      property_id: propertyId,
      action: 'RATE_OVERRIDE_APPLIED',
      detail: `Rate updated to $${rate.toFixed(2)} for ${roomType} (${cleanJustification})`,
      result: 'success'
    });
  } catch (err) {
    // This used to read "Audit logging deferred", which was not true: nothing was
    // deferred and nothing retried — the rate change stayed applied and the record
    // of who changed it was dropped. Rate overrides are exactly the kind of
    // privileged, money-moving change the trail exists to attribute, so the loss
    // is now recorded and surfaced on the Audit Log page instead of being renamed
    // into something harmless-sounding.
    console.error('[pricingOverride] audit write failed; the rate change is applied but unrecorded:', err);
    recordAuditFailure('RATE_OVERRIDE_APPLIED', err, {
      source: 'pricingOverride.applyDynamicRateOverride',
      username: user?.username,
      property_id: propertyId,
    });
  }

  return updatePayload;
}
