import { sanitizeText as sanitizeInput } from './securityUtils';

// Audit rows arrive under two naming conventions, because two subsystems write them:
// Title Case from base44/functions/custom_auth_login and custom_user_admin
// ('Failed Login', 'Account Locked', 'User Created'), and SCREAMING_SNAKE from
// audit_log invocations ('ANOMALY_SIGN_OFF', 'RATE_OVERRIDE_APPLIED'). Normalising to
// one token form lets a single rule match both, and keeps matching working if a future
// emitter picks either style.
function normalizeAction(action) {
  return String(action ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// Category membership is by TOKEN, not by exact name.
//
// This previously listed exact action names and compared with
// `allowedActions.includes(log.action)`. Of the 17 names listed, only two were ever
// written by anything ('ANOMALY_SIGN_OFF', 'RATE_OVERRIDE_APPLIED') — 'LOGIN',
// 'AUTH_FAILURE', 'ACCOUNT_LOCKOUT', 'EXPENSE_CREATE' and the rest are not emitted
// anywhere in the repo. So picking AUTH showed an empty table on a log full of logins,
// and SECURITY hid every failed login and lockout.
//
// Categories deliberately overlap: a failed login is both an AUTH event and a SECURITY
// event, and someone auditing a break-in attempt should find it under either.
export const AUDIT_CATEGORIES = {
  ALL: 'ALL',
  AUTH: ['LOGIN', 'LOGOUT', 'MFA', 'PASSWORD', 'SESSION', 'AUTH'],
  SECURITY: [
    'FAILED', 'FAILURE', 'DENIED', 'RATE_LIMIT', 'LOCK', 'ANOMALY',
    'PERMISSION', 'ROLE', 'REVOK', 'DELETE', 'DISABLED',
  ],
  REVENUE: ['RATE_OVERRIDE', 'EXPENSE', 'COMMISSION', 'OTA', 'REVENUE', 'PRICING'],
  DATA: ['IMPORT', 'EXPORT', 'BACKUP', 'REPORT', 'ROLLBACK', 'DATABASE', 'CSV'],
};

/**
 * Does this action belong to this category?
 * @param {string} action - raw action string as stored on the audit row
 * @param {string} category - a key of AUDIT_CATEGORIES
 * @returns {boolean}
 */
export function actionInCategory(action, category) {
  if (category === 'ALL') return true;
  const tokens = AUDIT_CATEGORIES[category];
  // An unrecognised category must not silently hide every row — that is
  // indistinguishable from "there are no audit events", which is the one thing an
  // audit view must never imply falsely.
  if (!Array.isArray(tokens)) return true;
  const normalized = normalizeAction(action);
  if (!normalized) return false;
  return tokens.some((t) => normalized.includes(t));
}

// Severity for the badge colour in src/pages/AuditLog.jsx, in priority order.
//
// Order is the whole point. ACTION_BADGE used to test `includes("Login")` before
// `includes("Failed")`, so 'Failed Login' — the row B10 exists to record — was painted
// the same blue as a successful sign-in, making a brute-force attempt visually
// indistinguishable from normal traffic. UNLOCK is checked before the danger rules
// because 'Account Unlocked' contains 'LOCKED'.
// Written as objects rather than [severity, tokens] pairs so the severity keeps its
// literal string type — a tuple widens to (string|string[])[] and loses it.
const SEVERITY_RULES = [
  { severity: 'success', tokens: ['UNLOCK'] },
  { severity: 'danger', tokens: ['FAILED', 'FAILURE', 'DENIED', 'RATE_LIMIT', 'LOCKED', 'LOCKOUT', 'DELETE', 'DISABLED', 'REVOK'] },
  { severity: 'warn', tokens: ['PASSWORD', 'RESET', 'PERMISSION', 'ROLE', 'ANOMALY', 'OVERRIDE'] },
  { severity: 'success', tokens: ['CREATED', 'ENABLED', 'VERIFIED', 'INVITED', 'APPROVED'] },
  { severity: 'info', tokens: ['LOGIN', 'LOGOUT', 'SESSION'] },
];

/**
 * Classify an audit action for display.
 * @param {string} action
 * @returns {'danger'|'warn'|'success'|'info'|'neutral'}
 */
export function auditActionSeverity(action) {
  const normalized = normalizeAction(action);
  if (!normalized) return 'neutral';
  for (const rule of SEVERITY_RULES) {
    if (rule.tokens.some((t) => normalized.includes(t))) {
      return /** @type {'danger'|'warn'|'success'|'info'} */ (rule.severity);
    }
  }
  return 'neutral';
}

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
    if (!actionInCategory(log.action, category)) return false;

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
