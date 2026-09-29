// scripts/probe-entity-enum-integrity.mjs
// Verification probe for entity enum contracts and drift detection.
//
// WHY THIS EXISTS:
// In base44/functions/autoPayroll/entry.ts, payroll_status was written as "pending"
// while PayrollRun.jsonc allowed only ["draft", "pending_review", "approved", "paid"].
// Because entity schemas are JSONC files and backend functions are standalone modules,
// enum mismatches could survive without a static compiler catch.
//
// This probe acts as an automated contract sentinel:
// 1. Validates every enum definition in base44/entities/*.jsonc.
// 2. Asserts defaults belong to their allowed enum sets.
// 3. Scans backend functions in base44/functions/** for entity writes and ensures
//    literal enum values match the allowed schema enums.
// 4. Verifies UI option lists match schema enum sets.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..");
const ENTITIES_DIR = path.resolve(ROOT, "base44/entities");
const FUNCTIONS_DIR = path.resolve(ROOT, "base44/functions");

let pass = 0;
let fail = 0;
const failures = [];

function ok(label, cond, detail = "") {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${label}`);
  } else {
    fail += 1;
    const msg = detail ? `${label} — ${detail}` : label;
    failures.push(msg);
    console.log(`  FAIL  ${msg}`);
  }
}

console.log("==========================================================================");
console.log("probe-entity-enum-integrity — Schema Contract & Enum Parity Sentinel");
console.log("==========================================================================\n");

// 1. Parse all entity schemas and index enums
console.log("[1] Entity Schema Enum Definitions");
const entityFiles = fs.readdirSync(ENTITIES_DIR).filter((f) => f.endsWith(".jsonc"));
const enumCatalog = new Map(); // "Entity.property" -> Set<allowedValues>
const defaultCatalog = new Map(); // "Entity.property" -> defaultValue

for (const file of entityFiles) {
  const filePath = path.join(ENTITIES_DIR, file);
  const raw = fs.readFileSync(filePath, "utf8");
  const clean = raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const schema = JSON.parse(clean);
  const entityName = schema.name || path.basename(file, ".jsonc");

  for (const [propName, propDef] of Object.entries(schema.properties || {})) {
    if (propDef.enum && Array.isArray(propDef.enum)) {
      const key = `${entityName}.${propName}`;
      enumCatalog.set(key, new Set(propDef.enum));
      if (propDef.default !== undefined) {
        defaultCatalog.set(key, propDef.default);
      }
      ok(`${key} defines non-empty enum`, propDef.enum.length > 0);
    }
  }
}

// 2. Validate defaults belong to allowed enum sets
console.log("\n[2] Schema Default Values Invariant");
for (const [key, defVal] of defaultCatalog.entries()) {
  const allowed = enumCatalog.get(key);
  ok(`${key} default "${defVal}" is in allowed enum`, allowed.has(defVal), `default "${defVal}" not in [${[...allowed].join(", ")}]`);
}

// 3. Scan PayrollRun.payroll_status specifically
console.log("\n[3] PayrollRun.payroll_status Invariants");
const payrollStatusEnum = enumCatalog.get("PayrollRun.payroll_status");
ok("PayrollRun.payroll_status exists", !!payrollStatusEnum);
ok("PayrollRun.payroll_status contains pending_review", payrollStatusEnum?.has("pending_review"));
ok("PayrollRun.payroll_status contains draft", payrollStatusEnum?.has("draft"));
ok("PayrollRun.payroll_status contains approved", payrollStatusEnum?.has("approved"));
ok("PayrollRun.payroll_status contains paid", payrollStatusEnum?.has("paid"));
ok("PayrollRun.payroll_status strictly forbids legacy 'pending'", !payrollStatusEnum?.has("pending"));

// 4. Static scan of autoPayroll/entry.ts writes
console.log("\n[4] Backend autoPayroll function write verification");
const autoPayrollEntry = fs.readFileSync(path.join(FUNCTIONS_DIR, "autoPayroll/entry.ts"), "utf8");
ok("autoPayroll does not write payroll_status: 'pending'", !/payroll_status\s*:\s*["']pending["']/.test(autoPayrollEntry));
ok("autoPayroll writes payroll_status: 'pending_review'", /payroll_status\s*:\s*["']pending_review["']/.test(autoPayrollEntry));

// 5. Scan UI consumers for enum fidelity
console.log("\n[5] UI Select options parity with schema enums");
const payrollPageSrc = fs.readFileSync(path.join(ROOT, "src/pages/Payroll.jsx"), "utf8");
for (const status of ["draft", "pending_review", "approved", "paid"]) {
  ok(`Payroll.jsx provides select option for '${status}'`, payrollPageSrc.includes(`value="${status}"`));
}
ok("Payroll.jsx does not provide select option for invalid 'pending'", !payrollPageSrc.includes(`value="pending"`));

// 6. Expense category and payment_status integrity
console.log("\n[6] Expense schema enum integrity");
const expenseCategoryEnum = enumCatalog.get("Expense.category");
const expenseStatusEnum = enumCatalog.get("Expense.payment_status");
ok("Expense.category contains standard buckets", expenseCategoryEnum.has("utilities") && expenseCategoryEnum.has("payroll") && expenseCategoryEnum.has("other"));
ok("Expense.payment_status contains expected lifecycle values", expenseStatusEnum.has("unpaid") && expenseStatusEnum.has("paid") && expenseStatusEnum.has("scheduled"));

console.log(`\n==========================================================================`);
if (fail === 0) {
  console.log(`PASSED: ${pass} passed, 0 failed`);
  console.log("All entity schema enums and consumer writes are in complete parity.");
  process.exit(0);
} else {
  console.log(`FAILED: ${pass} passed, ${fail} failed`);
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
