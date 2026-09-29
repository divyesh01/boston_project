// Read-only report for a JSON array exported from PayrollRun.
// Run: node scripts/report-duplicate-payroll.mjs path/to/payroll-runs.json
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function findDuplicatePayroll(runs) {
  if (!Array.isArray(runs)) throw new TypeError("Expected a JSON array of PayrollRun records");
  const exact = new Map();
  const byName = new Map();
  for (const run of runs) {
    if (!run || typeof run !== "object") throw new TypeError("Each payroll run must be an object");
    const propertyId = String(run.property_id || "");
    const start = String(run.pay_period_start || "");
    const end = String(run.pay_period_end || "");
    const name = String(run.employee_name || "").trim().toLowerCase();
    if (!end || !name) throw new TypeError("Every payroll run needs pay_period_end and employee_name");
    const staffId = String(run.staff_id || "").trim();
    const employeeId = String(run.employee_id || "").trim();
    const kind = staffId ? "staff" : employeeId ? "employee" : "name";
    const identity = staffId || employeeId || name;
    const key = JSON.stringify([propertyId, start, end, kind, identity]);
    const nameKey = JSON.stringify([propertyId, start, end, name]);
    const item = { id: run.id || null, employee_name: run.employee_name, staff_id: staffId || null };
    if (!exact.has(key)) exact.set(key, { property_id: propertyId, pay_period_start: start, pay_period_end: end, identity: `${kind}:${identity}`, runs: [] });
    exact.get(key).runs.push(item);
    if (!byName.has(nameKey)) byName.set(nameKey, { property_id: propertyId, pay_period_start: start, pay_period_end: end, employee_name: run.employee_name, runs: [], hasLegacy: false });
    byName.get(nameKey).runs.push(item);
    if (kind === "name") byName.get(nameKey).hasLegacy = true;
  }
  return {
    exact: [...exact.values()].filter((group) => group.runs.length > 1),
    possibleLegacy: [...byName.values()].filter((group) => group.hasLegacy && group.runs.length > 1),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const path = process.argv[2];
  if (!path) {
    console.error("Usage: node scripts/report-duplicate-payroll.mjs <PayrollRun JSON array>");
    process.exitCode = 1;
  } else {
    try {
      const report = findDuplicatePayroll(JSON.parse(readFileSync(path, "utf8")));
      console.log(JSON.stringify(report, null, 2));
      if (report.exact.length || report.possibleLegacy.length) process.exitCode = 2;
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
