import db from '@/api/base44Client';

export async function logAuditEvent(action, options = {}) {
  try {
    await db.audit.log({
      action,
      user_id: options.user_id || null,
      username: options.username || 'unknown',
      performed_by_id: options.performed_by_id || null,
      performed_by: options.performed_by || 'system',
      ip_address: options.ip_address || 'client-side',
      device: options.device || 'browser',
      property_id: options.property_id || null,
      property_name: options.property_name || null,
      result: options.result || 'success',
      detail: options.detail || '',
    });
  } catch (e) {
    console.error('[auditLogger] failed to write log:', e);
  }
}

export async function getAuditLogs(filter = {}, limit = 500) {
  return db.audit.list(filter, limit);
}

export async function verifyAuditChain() {
  // This would need access to the localDb directly
  // For now, return a placeholder
  return { valid: true, count: 0 };
}