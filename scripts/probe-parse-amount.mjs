// Probe: parseAmount() sign handling on real PMS negative-number conventions.
//
// parseAmount feeds every money value on import (reportParsers.js:230 sets
// TransactionLine.amount from it), and paymentNorm.js:74 documents the contract as
// "parseAmount preserves the sign, including accounting parentheses".
//
// It read the sign off the RAW string before stripping the currency symbol, so a
// leading "$" hid the sign that followed it. "$-50.00" and "$(50.00)" both parsed
// as +50 — an imported refund became a charge of the same size, which is the worst
// possible direction for a money bug to fail in.
//
// Run: node scripts/probe-parse-amount.mjs

import { register } from "node:module";
register(new URL("./resolve-alias.mjs", import.meta.url));

const { parseAmount } = await import("../src/lib/csvParser.js");

let pass = 0, fail = 0;
const eq = (input, expected) => {
  const got = parseAmount(input);
  const ok = expected === null ? got === null : Object.is(got, expected);
  if (ok) { pass++; console.log(`  PASS  ${JSON.stringify(input)} -> ${got}`); }
  else { fail++; console.log(`  FAIL  ${JSON.stringify(input)} -> ${got}, expected ${expected}`); }
};

console.log("\n=== Positive forms (must be unchanged) ===");
eq("50", 50);
eq("50.00", 50);
eq("$50.00", 50);
eq("$1,234.56", 1234.56);
eq(" $1,234.56 ", 1234.56);
eq("0", 0);
eq("0.00", 0);
eq("+50.00", 50);

console.log("\n=== Leading minus (was already correct) ===");
eq("-50.00", -50);
eq("-$50.00", -50);
eq("-1,234.56", -1234.56);

console.log("\n=== Accounting parentheses ===");
eq("(50.00)", -50);
eq("($50.00)", -50);
eq("(1,234.56)", -1234.56);

console.log("\n=== Currency symbol BEFORE the sign — the defect ===");
// A refund exported as "$-50.00" must not import as a +50 charge.
eq("$-50.00", -50);
eq("$-1,234.56", -1234.56);
eq("$(50.00)", -50);
eq("$ -50.00", -50);

console.log("\n=== Trailing minus (older PMS/ledger exports) ===");
eq("50.00-", -50);
eq("$50.00-", -50);

console.log("\n=== Nothing numeric -> null, never 0 ===");
// null and 0 must stay distinguishable: importValidation.js:87 treats null as
// "nothing numeric was found", and a silent 0 would import as a real amount.
eq(null, null);
eq(undefined, null);
eq("", null);
eq("   ", null);
eq("-", null);
eq("$", null);
eq("N/A", null);
eq("--", null);

console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
