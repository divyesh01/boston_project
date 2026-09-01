// Frontend route capabilities returned by /api/session. Backend authorization
// remains authoritative and separate; these flags only let the authenticated
// application render routes the server-side role is already allowed to use.

export const SESSION_PERMISSION_KEYS = Object.freeze([
  "view_dashboard",
  "import_reports",
  "delete_imports",
  "replace_imports",
  "export_reports",
  "manage_expenses",
  "manage_ota_commissions",
  "manage_properties",
  "manage_users",
  "view_financial_reports",
  "manage_settings",
  "view_audit_logs",
  "backup_restore",
  "system_administration",
  "manage_pricing",
]);

function storedPermissions(serialized) {
  try {
    const parsed = serialized ? JSON.parse(serialized) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function permissionsForSession(role, serialized) {
  const normalizedRole = String(role || "").toLowerCase();
  const defaults = normalizedRole === "owner" || normalizedRole === "admin"
    ? Object.fromEntries(SESSION_PERMISSION_KEYS.map((key) => [key, true]))
    : {};
  return { ...defaults, ...storedPermissions(serialized) };
}

export function ownerPermissionsJson() {
  return JSON.stringify(permissionsForSession("owner", "{}"));
}
