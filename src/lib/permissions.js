// Roles & permission catalog for role-based access control.

export const ROLES = [
  { key: "owner", label: "Owner" },
  { key: "admin", label: "Admin" },
  { key: "manager", label: "Manager" },
  { key: "front_desk", label: "Front Desk" },
  { key: "accountant", label: "Accountant" },
  { key: "read_only", label: "Read Only" },
];

export const PERMISSIONS = [
  { key: "view_dashboard", label: "View Dashboard", group: "General" },
  { key: "import_reports", label: "Import Reports", group: "Data" },
  { key: "delete_imports", label: "Delete Imports", group: "Data" },
  { key: "replace_imports", label: "Replace Imports", group: "Data" },
  { key: "export_reports", label: "Export Reports", group: "Data" },
  { key: "manage_expenses", label: "Manage Expenses", group: "Finance" },
  { key: "manage_ota_commissions", label: "Manage OTA Commissions", group: "Finance" },
  { key: "manage_properties", label: "Manage Properties", group: "Admin" },
  { key: "manage_users", label: "Manage Users", group: "Admin" },
  { key: "view_financial_reports", label: "View Financial Reports", group: "Finance" },
  { key: "manage_settings", label: "Manage Settings", group: "Admin" },
  { key: "view_audit_logs", label: "View Audit Logs", group: "Admin" },
  { key: "backup_restore", label: "Backup & Restore", group: "Admin" },
  { key: "system_administration", label: "System Administration", group: "Admin" },
];

export const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);

const all = () => PERMISSION_KEYS.reduce((acc, k) => ({ ...acc, [k]: true }), {});

// Default permission set per role. Owner/Admin get everything; each role below
// is a sensible starting point and can be fine-tuned per user by the owner.
export const ROLE_DEFAULTS = {
  owner: all(),
  admin: all(),
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

export function defaultPermissionsForRole(role) {
  return { ...(ROLE_DEFAULTS[role] || ROLE_DEFAULTS.read_only) };
}

// Map route path -> required permission (used by the route guard & nav filtering)
export const ROUTE_PERMISSIONS = {
  "/": "view_dashboard",
  "/compare": "view_dashboard",
  "/rooms": "view_dashboard",
  "/charts": "view_dashboard",
  "/employees": "view_dashboard",
  "/payments": "view_financial_reports",
  "/settings": "manage_settings",
  "/upload": "import_reports",
  "/calendar": "view_dashboard",
  "/mtd": "view_dashboard",
  "/expenses": "manage_expenses",
  "/payroll": "manage_expenses",
  "/ota": "manage_ota_commissions",
  "/data-template": "import_reports",
  "/manual-entry": "import_reports",
  "/forecasting": "view_dashboard",
  "/users": "manage_users",
  "/audit-log": "view_audit_logs",
};

export function canUser(permissions, permissionKey) {
  return !!(permissions && permissions[permissionKey]);
}
