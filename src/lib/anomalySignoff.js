import { sanitizeText as sanitizeInput } from './securityUtils';
import { db } from '../api/base44Client';

/**
 * Records a formal manager review and sign-off on a shift anomaly.
 * @param {Object} params
 * @param {string} params.shiftId - ID of the clerk shift record
 * @param {string} params.managerUserId - ID of the reviewing manager/owner
 * @param {string} params.managerName - Display name of manager
 * @param {string} params.resolutionNotes - Manager explanation/justification
 * @param {string} params.propertyId - Property ID
 * @returns {Promise<Object>} Updated shift review status
 */
export async function signOffShiftAnomaly({
  shiftId,
  managerUserId,
  managerName,
  resolutionNotes,
  propertyId
}) {
  if (!shiftId || !managerUserId) {
    throw new Error('Validation Error: Shift ID and Manager ID are required.');
  }

  const cleanNotes = sanitizeInput(resolutionNotes || 'Reviewed and approved by manager.');
  const nowIso = new Date().toISOString();

  // 1. Update the shift record status
  const updatedShift = await db.entities.ClerkShiftRecord.update(shiftId, {
    review_status: 'RESOLVED',
    reviewed_by_id: managerUserId,
    reviewed_by_name: sanitizeInput(managerName),
    reviewed_at: nowIso,
    resolution_notes: cleanNotes
  });

  // 2. Write an immutable server audit log entry
  try {
    await db.functions.invoke('audit_log', {
      user_id: managerUserId,
      username: sanitizeInput(managerName),
      property_id: propertyId || null,
      action: 'ANOMALY_SIGN_OFF',
      detail: `Manager signed off on shift ${shiftId}: ${cleanNotes}`,
      result: 'success'
    });
  } catch (err) {
    console.warn('Audit log write deferred:', err.message);
  }

  return updatedShift;
}
