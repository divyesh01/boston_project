// Probe for RED-6: CSV parser lone \r line endings
// Tests whether parseCsvText correctly handles Classic Mac OS \r line endings

import { parseCsvText } from '@/lib/csvParser';

let pass = 0, fail = 0;
const T = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`); }
};

console.log("\n=== RED-6: CSV Parser Lone \\r Line Endings ===\n");

// Test 1: Standard \n line endings (should work)
const csvN = "Date,Amount\n2026-01-01,100.00\n2026-01-02,200.00";
const rowsN = parseCsvText(csvT(csvN));
T("\\n line endings produce 3 rows", rowsN.length === 3, `got ${rowsN.length}`);
T("\\n: row 0 is header", rowsN[0].join("|") === "Date|Amount", `got "${rowsN[0].join("|")}"`);
T("\\n: row 1 is data", rowsN[1].join("|") === "2026-01-01|100.00", `got "${rowsN[1].join("|")}"`);

// Test 2: Windows \r\n line endings (should work)
const csvRN = "Date,Amount\r\n2026-01-01,100.00\r\n2026-01-02,200.00";
const rowsRN = parseCsvText(csvT(csvRN));
T("\\r\\n line endings produce 3 rows", rowsRN.length === 3, `got ${rowsRN.length}`);
T("\\r\\n: row 0 is header", rowsRN[0].join("|") === "Date|Amount", `got "${rowsRN[0].join("|")}"`);
T("\\r\\n: row 1 is data", rowsRN[1].join("|") === "2026-01-01|100.00", `got "${rowsRN[1].join("|")}"`);

// Test 3: Classic Mac OS lone \r line endings (THE BUG)
const csvR = "Date,Amount\r2026-01-01,100.00\r2026-01-02,200.00";
const rowsR = parseCsvText(csvT(csvR));
T("Lone \\r line endings produce 3 rows", rowsR.length === 3, `got ${rowsR.length}`);
T("Lone \\r: row 0 is header", rowsR[0].join("|") === "Date|Amount", `got "${rowsR[0].join("|")}"`);
T("Lone \\r: row 1 is data", rowsR[1].join("|") === "2026-01-01|100.00", `got "${rowsR[1].join("|")}"`);
T("Lone \\r: row 2 is data", rowsR[2].join("|") === "2026-01-02|200.00", `got "${rowsR[2].join("|")}"`);

// Test 4: Mixed line endings in same file
const csvMixed = "Date,Amount\r\n2026-01-01,100.00\r2026-01-02,200.00\n2026-01-03,300.00";
const rowsMixed = parseCsvText(csvT(csvMixed));
T("Mixed line endings produce 4 rows", rowsMixed.length === 4, `got ${rowsMixed.length}`);
T("Mixed: row 3 is data", rowsMixed[3].join("|") === "2026-01-03|300.00", `got "${rowsMixed[3].join("|")}"`);

// Test 5: Lone \r inside quoted field should NOT split rows
const csvQuoted = 'Date,Note\r2026-01-01,"Line1\rLine2"';
const rowsQuoted = parseCsvText(csvT(csvQuoted));
T("Lone \\r inside quoted field stays in one row", rowsQuoted.length === 2, `got ${rowsQuoted.length}`);
T("Quoted \\r preserved in field", rowsQuoted[1][1] === "Line1\rLine2", `got "${rowsQuoted[1][1]}"`);

// Test 6: Real-world-like CSV with lone \r
const csvReal = "Transaction Date,Description,Amount\r2026-01-01,Room Charge,150.00\r2026-01-02,Restaurant,45.50\r2026-01-03,Minibar,12.75";
const rowsReal = parseCsvText(csvT(csvReal));
T("Real-world lone \\r CSV: 4 rows", rowsReal.length === 4, `got ${rowsReal.length}`);
T("Real-world: correct amount in row 2", rowsReal[2][2] === "45.50", `got "${rowsReal[2][2]}"`);

function csvT(s) { return s; }

if (fail === 0) {
  console.log(`PASSED: ${pass} passed, ${fail} failed`);
} else {
  console.log(`FAILED: ${pass} passed, ${fail} failed`);
}

process.exit(fail > 0 ? 1 : 0);

