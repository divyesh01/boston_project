// Probe: the audit log's category filter and badge severity.
//
// Two defects, both in pure logic reachable from src/lib/auditFilter.js:
//
//   1. AUDIT_CATEGORIES matched `allowedActions.includes(log.action)` — exact equality
//      against names like 'LOGIN' and 'AUTH_FAILURE' that NOTHING in the codebase ever
//      writes. Of the 17 names listed across the four categories, only two are real
//      (ANOMALY_SIGN_OFF, RATE_OVERRIDE_APPLIED). Picking AUTH emptied the table even
//      though the log is full of logins.
//   2. ACTION_BADGE tested `includes("Login")` before `includes("Failed")`, so
//      'Failed Login' — the row B10 exists to produce — rendered in the same blue as a
//      successful login.
//
// Run: node scripts/probe-audit-filter.mjs

import { register } from "node:module";
register(new URL("./resolve-alias.mjs", import.meta.url));

// filterAuditLogs sanitizes the search query through DOMPurify, which needs a DOM.
// A real jsdom window is used rather than a stub so the sanitizer under test is the
// same one that runs in the browser — section 7 relies on that.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("");
globalThis.window = dom.window;
globalThis.document = dom.window.document;
// globalThis.navigator is getter-only on Node 22, and DOMPurify does not need it.

const { AUDIT_CATEGORIES, filterAuditLogs, auditActionSeverity } = await import("../src/lib/auditFilter.js");

let pass = 0, fail = 0;
const T = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`); }
};

// Every action string actually emitted anywhere in the repo, collected with:
//   grep -rhoE "action: *'[^']+'" base44/functions src/lib src/pages src/components
// Both naming conventions land in the same AuditLog table: Title Case from
// custom_auth_login / custom_user_admin, SCREAMING_SNAKE from audit_log invocations.
const REAL_ACTIONS = [
  "Login", "Failed Login", "Failed MFA", "Login Rate Limit Reached",
  "Account Locked", "MFA Enabled", "MFA Disabled", "MFA Verified",
  "Password Changed", "Password Reset",
  "User Created", "User Deleted", "User Invited", "Delete Account",
  "ANOMALY_SIGN_OFF", "RATE_OVERRIDE_APPLIED",
];

const asLogs = (actions) => actions.map((a, i) => ({ action: a, username: `u${i}`, detail: "" }));
const actionsIn = (category, actions = REAL_ACTIONS) =>
  filterAuditLogs(asLogs(actions), { category }).map((l) => l.action);

console.log("\n=== 1. The category keys the UI renders are unchanged ===");
{
  // AuditLog.jsx renders Object.keys(AUDIT_CATEGORIES) as the filter buttons.
  T("keys are still ALL/AUTH/SECURITY/REVENUE/DATA",
    JSON.stringify(Object.keys(AUDIT_CATEGORIES)) === JSON.stringify(["ALL", "AUTH", "SECURITY", "REVENUE", "DATA"]),
    JSON.stringify(Object.keys(AUDIT_CATEGORIES)));
}

console.log("\n=== 2. ALL passes everything through ===");
{
  T("no rows dropped", actionsIn("ALL").length === REAL_ACTIONS.length, `${actionsIn("ALL").length}/${REAL_ACTIONS.length}`);
  T("an unknown category is not a silent empty table",
    filterAuditLogs(asLogs(REAL_ACTIONS), { category: "NOPE" }).length === REAL_ACTIONS.length,
    "an unrecognised key must not hide every row");
}

console.log("\n=== 3. AUTH matches the auth events that are really written ===");
{
  const got = actionsIn("AUTH");
  for (const a of ["Login", "Failed Login", "Failed MFA", "MFA Verified", "Password Changed", "Password Reset"]) {
    T(`AUTH includes "${a}"`, got.includes(a), `got=${JSON.stringify(got)}`);
  }
  T("AUTH excludes a revenue action", !got.includes("RATE_OVERRIDE_APPLIED"), JSON.stringify(got));
  T("AUTH is not empty (the whole defect)", got.length > 0);
}

console.log("\n=== 4. SECURITY surfaces failures and account lockouts ===");
{
  const got = actionsIn("SECURITY");
  for (const a of ["Failed Login", "Failed MFA", "Login Rate Limit Reached", "Account Locked", "ANOMALY_SIGN_OFF", "MFA Disabled", "User Deleted"]) {
    T(`SECURITY includes "${a}"`, got.includes(a), `got=${JSON.stringify(got)}`);
  }
  T("SECURITY excludes an ordinary successful login", !got.includes("Login"), JSON.stringify(got));
}

console.log("\n=== 5. REVENUE and DATA still match their real actions ===");
{
  T("REVENUE includes RATE_OVERRIDE_APPLIED", actionsIn("REVENUE").includes("RATE_OVERRIDE_APPLIED"));
  T("REVENUE excludes logins", !actionsIn("REVENUE").includes("Login"));
  // DATA has no emitter yet; it must return nothing rather than throw or match wrongly.
  T("DATA matches an import action if one is logged",
    actionsIn("DATA", ["REPORT_IMPORT", "Login"]).length === 1, JSON.stringify(actionsIn("DATA", ["REPORT_IMPORT", "Login"])));
}

console.log("\n=== 6. Category matching is convention-agnostic ===");
{
  // The same event has been written both ways over the life of this codebase.
  T("'Failed Login' and 'AUTH_FAILURE' both land in SECURITY",
    actionsIn("SECURITY", ["Failed Login"]).length === 1 && actionsIn("SECURITY", ["AUTH_FAILURE"]).length === 1);
  T("'Logout' and 'LOGOUT' both land in AUTH",
    actionsIn("AUTH", ["Logout"]).length === 1 && actionsIn("AUTH", ["LOGOUT"]).length === 1);
}

console.log("\n=== 7. Search and property filters still work ===");
{
  const logs = [
    { action: "Login", username: "alice", detail: "", property_id: "p1" },
    { action: "Failed Login", username: "bob", detail: "bad password", property_id: "p2" },
  ];
  T("search by username", filterAuditLogs(logs, { searchQuery: "alice" }).length === 1);
  T("search by detail", filterAuditLogs(logs, { searchQuery: "bad password" }).length === 1);
  T("search by action", filterAuditLogs(logs, { searchQuery: "failed" }).length === 1);
  T("property filter", filterAuditLogs(logs, { propertyId: "p1" }).length === 1);
  T("category and search combine",
    filterAuditLogs(logs, { category: "SECURITY", searchQuery: "bob" }).length === 1);
}

console.log("\n=== 8. Badge severity: a failure never reads as a success ===");
{
  // The defect: 'Failed Login' contains "Login", and "Login" was tested first.
  T('"Failed Login" is danger, not info', auditActionSeverity("Failed Login") === "danger",
    auditActionSeverity("Failed Login"));
  T('"Failed MFA" is danger', auditActionSeverity("Failed MFA") === "danger", auditActionSeverity("Failed MFA"));
  T('"Login Rate Limit Reached" is danger, not info', auditActionSeverity("Login Rate Limit Reached") === "danger",
    auditActionSeverity("Login Rate Limit Reached"));
  T('"Account Locked" is danger', auditActionSeverity("Account Locked") === "danger");
  T('"User Deleted" is danger', auditActionSeverity("User Deleted") === "danger");
  T('"MFA Disabled" is danger', auditActionSeverity("MFA Disabled") === "danger");
}

console.log("\n=== 9. Badge severity: successes and neutral events keep their colour ===");
{
  T('"Login" is info', auditActionSeverity("Login") === "info", auditActionSeverity("Login"));
  T('"Logout" is info', auditActionSeverity("Logout") === "info");
  T('"User Created" is success', auditActionSeverity("User Created") === "success");
  T('"MFA Enabled" is success', auditActionSeverity("MFA Enabled") === "success");
  T('"MFA Verified" is success', auditActionSeverity("MFA Verified") === "success");
  T('"Password Changed" is warn', auditActionSeverity("Password Changed") === "warn");
  T('"ANOMALY_SIGN_OFF" is not danger', auditActionSeverity("ANOMALY_SIGN_OFF") !== "danger",
    auditActionSeverity("ANOMALY_SIGN_OFF"));
  T("an unknown action is neutral", auditActionSeverity("Something New") === "neutral");
}

console.log("\n=== 10. Neither function throws on malformed rows ===");
{
  T("null action does not throw", auditActionSeverity(null) === "neutral");
  T("undefined action does not throw", auditActionSeverity(undefined) === "neutral");
  T("a row with no action survives filtering",
    filterAuditLogs([{ username: "x" }, { action: "Login", username: "y" }], { category: "ALL" }).length === 2);
  T("a row with no action is excluded from a specific category",
    filterAuditLogs([{ username: "x" }], { category: "AUTH" }).length === 0);
  T("non-array input returns []", filterAuditLogs(null, {}).length === 0);
}

console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
