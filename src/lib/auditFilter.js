import { sanitizeInput } from './securityUtils';

export const AUDIT_CATEGORIES = {
  ALL: 'ALL',
  AUTH: ['LOGIN', 'LOGOUT', 'MFA_VERIFY', 'PASSWORD_RESET', 'AUTH_FAILURE'],
  SECURITY: ['ANOMALY_SIGN_OFF', 'ACCOUNT_LOCKOUT', 'PERMISSION_CHANGE', 'RATE_LIMIT_HIT'],
  REVENUE: ['RATE_OVERRIDE_APPLIED', 'EXPENSE_CREATE', 'EXPENSE_DELETE', 'OTA_COMMISSION_UPDATE'],
  DATA: ['REPORT_IMPORT', 'REPORT_DELETE', 'DATABASE_BACKUP']
};

/**
 * Filters audit log entries based on criteria.
 * @param {Array<Object>} logs - Raw audit log records
 * @param {Object} filterOptions
 * @param {string} [filterOptions.category='ALL'] - Action category key
 * @param {string} [filterOptions.propertyId] - Optional property filter
 * @param {string} [filterOptions.searchQuery] - Keyword search
 * @returns {Array<Object>} Filtered audit logs
 */
export function filterAuditLogs(logs = [], { category = 'ALL', propertyId = null, searchQuery = '' } = {}) {
  if (!Array.isArray(logs)) return [];

  const cleanSearch = sanitizeInput(searchQuery).toLowerCase().trim();

  return logs.filter(log => {
    // 1. Property match
    if (propertyId && propertyId !== 'all' && log.property_id && log.property_id !== propertyId) {
      return false;
    }

    // 2. Category match
    if (category !== 'ALL') {
      const allowedActions = AUDIT_CATEGORIES[category] || [];
      if (!allowedActions.includes(log.action)) return false;
    }

    // 3. Search query match (Username, action, or detail string)
    if (cleanSearch) {
      const userMatch = String(log.username || '').toLowerCase().includes(cleanSearch);
      const actionMatch = String(log.action || '').toLowerCase().includes(cleanSearch);
      const detailMatch = String(log.detail || '').toLowerCase().includes(cleanSearch);
      if (!userMatch && !actionMatch && !detailMatch) return false;
    }

    return true;
  });
}
