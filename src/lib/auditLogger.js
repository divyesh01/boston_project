import { db } from '@/api/base44Client';
import { createAuditEntry, verifyAuditChain as verifyAuditChainImpl } from '@/lib/securityUtils';
import { recordAuditFailure } from '@/lib/auditFailureLog';

/**
 * Write one audit event.
 *
 * Returns `{ ok: true }` or `{ ok: false, error }` rather than throwing. Callers
 * that care can check; the existing ones ignore the result and are unaffected.
 * Throwing is not an option here — `AuthContext.jsx` awaits this during cross-tab
 * session revocation, so a logging outage would become a sign-in outage. What the
 * failure must not do is vanish, which is why it is recorded for the Audit Log
 * page to surface. See src/lib/auditFailureLog.js for the full reasoning.
 */
export async function logAuditEvent(action, options = {}) {
  try {
    const entry = await createAuditEntry(action, {
      userId: options.user_id,
      username: options.username,
      performedById: options.performed_by_id,
      performedBy: options.performed_by,
      ipAddress: options.ip_address,
      device: options.device,
      propertyId: options.property_id,
      propertyName: options.property_name,
      result: options.result,
      detail: options.detail,
    });

    // `db.audit.log` recomputes the entry (and the production chain hash is
    // recomputed again server-side in base44/functions/audit_log, which ignores
    // any client hash), so the `hash`/`previous_hash` built above are not passed
    // on. It also reports rather than throws, so its result is the one that
    // decides whether this event was actually recorded.
    const res = await db.audit.log({
      action: entry.action,
      user_id: entry.userId,
      username: entry.username,
      performed_by_id: entry.performedById,
      performed_by: entry.performedBy,
      ip_address: entry.ipAddress,
      device: entry.device,
      property_id: entry.propertyId,
      property_name: entry.propertyName,
      result: entry.result,
      detail: entry.detail,
      hash: entry.hash,
      previous_hash: entry.previous_hash,
    });

    if (res && res.ok === false) {
      // Already recorded by db.audit.log — do not double-count it here.
      return { ok: false, error: res.error };
    }
    return { ok: true };
  } catch (e) {
    console.error('[auditLogger] failed to write log:', e);
    recordAuditFailure(action, e, {
      source: 'auditLogger.logAuditEvent',
      username: options.username,
      property_id: options.property_id,
    });
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}


export async function getAuditLogs(filter = {}, limit = 500) {
  return db.audit.list(filter, limit);
}

export async function verifyAuditChain() {
  return verifyAuditChainImpl();
}