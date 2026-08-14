import { db } from '@/api/base44Client';
import { createAuditEntry, verifyAuditChain as verifyAuditChainImpl } from '@/lib/securityUtils';

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

    await db.audit.log({
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
  } catch (e) {
    console.error('[auditLogger] failed to write log:', e);
  }
}


export async function getAuditLogs(filter = {}, limit = 500) {
  return db.audit.list(filter, limit);
}

export async function verifyAuditChain() {
  return verifyAuditChainImpl();
}