// Server-side authorization and property-access resolution utilities.
//
// Core invariant: FAIL-CLOSED.
// If property_access is missing, null, empty, or malformed, non-root users
// receive ZERO property grants ([]). Only explicit 'owner', 'admin', or
// property_access === 'all' grant unrestricted access.
//
// Roles & default permissions match src/lib/permissions.js.

export const ROLE_DEFAULT_PERMISSIONS = {
  owner: { all: true },
  admin: { all: true },
  manager: {
    view_dashboard: true,
    import_reports: true,
    delete_imports: true,
    replace_imports: true,
    export_reports: true,
    manage_expenses: true,
    manage_ota_commissions: true,
    manage_properties: false,
    manage_users: false,
    view_financial_reports: true,
    manage_settings: false,
    view_audit_logs: false,
    backup_restore: false,
    system_administration: false,
    manage_pricing: true,
  },
  front_desk: {
    view_dashboard: true,
    import_reports: true,
    delete_imports: false,
    replace_imports: false,
    export_reports: false,
    manage_expenses: false,
    manage_ota_commissions: false,
    manage_properties: false,
    manage_users: false,
    view_financial_reports: false,
    manage_settings: false,
    view_audit_logs: false,
    backup_restore: false,
    system_administration: false,
  },
  accountant: {
    view_dashboard: true,
    import_reports: false,
    delete_imports: false,
    replace_imports: false,
    export_reports: true,
    manage_expenses: true,
    manage_ota_commissions: true,
    manage_properties: false,
    manage_users: false,
    view_financial_reports: true,
    manage_settings: false,
    view_audit_logs: false,
    backup_restore: false,
    system_administration: false,
  },
  read_only: {
    view_dashboard: true,
    import_reports: false,
    delete_imports: false,
    replace_imports: false,
    export_reports: false,
    manage_expenses: false,
    manage_ota_commissions: false,
    manage_properties: false,
    manage_users: false,
    view_financial_reports: true,
    manage_settings: false,
    view_audit_logs: false,
    backup_restore: false,
    system_administration: false,
  },
};

/**
 * Returns whether the user has root-level authorization (owner or admin).
 * @param {{ role?: string }} user
 * @returns {boolean}
 */
export function isRootUser(user) {
  return user?.role === 'owner' || user?.role === 'admin';
}

/**
 * Resolves the user's property scope.
 * - Returns `null` if the user is unrestricted (owner, admin, or property_access === 'all').
 * - Returns `string[]` of allowed property IDs if property_access is an array.
 * - Returns `[]` (empty list) if property_access is missing, null, non-array, or invalid (FAIL CLOSED).
 *
 * @param {{ role?: string, property_access?: unknown }} user
 * @returns {string[] | null}
 */
export function resolvePropertyScope(user) {
  if (isRootUser(user) || user?.property_access === 'all') {
    return null; // Unrestricted bypass
  }
  if (Array.isArray(user?.property_access)) {
    return user.property_access.map(String);
  }
  return []; // Fail-closed default
}

/**
 * Checks whether the user is authorized to access a given propertyId.
 * @param {{ role?: string, property_access?: unknown }} user
 * @param {string | number} propertyId
 * @returns {boolean}
 */
export function isPropertyAuthorized(user, propertyId) {
  if (!propertyId && propertyId !== 0) return false;
  const allowed = resolvePropertyScope(user);
  if (allowed === null) return true; // Unrestricted
  return allowed.includes(String(propertyId));
}

/**
 * Checks if the user has a specific granular permission.
 * Resolves custom user.permissions overrides first, falling back to role defaults.
 * @param {{ role?: string, permissions?: Record<string, boolean> }} user
 * @param {string} permissionKey
 * @returns {boolean}
 */
export function hasPermission(user, permissionKey) {
  if (!user) return false;
  if (isRootUser(user)) return true;

  if (user.permissions && typeof user.permissions === 'object') {
    if (user.permissions[permissionKey] !== undefined) {
      return Boolean(user.permissions[permissionKey]);
    }
  }

  const roleDefaults = ROLE_DEFAULT_PERMISSIONS[user.role];
  if (!roleDefaults) return false;
  if (roleDefaults.all) return true;
  return Boolean(roleDefaults[permissionKey]);
}

/**
 * Validates the double-submit CSRF protection token.
 * Header 'x-csrf-token' must strictly equal the cookie '__Host-csrf_token'.
 * @param {Request} req
 * @returns {boolean}
 */
export function validateCsrf(req) {
  const csrfHeader = req.headers.get('x-csrf-token');
  const cookieHeader = req.headers.get('cookie') || '';
  const match = cookieHeader.match(/__Host-csrf_token=([^;]+)/);
  const csrfCookie = match ? match[1] : null;

  if (!csrfHeader || !csrfCookie) return false;
  return csrfHeader === csrfCookie;
}
