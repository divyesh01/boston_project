// Probe: the /manual-entry importer against the inputs the naive parser corrupted.
//
// ManualEntry.jsx parsed uploaded files with text.split("\n") + line.split(",")
// and matched headers with a bare indexOf. Every failure below was silent: the
// grid filled with shifted columns or zeros and the page said nothing, then
// handleSave wrote it straight to real entities.
//
// Run: node scripts/probe-manual-entry-import.mjs

import { register } from "node:module";
register(new URL("./resolve-alias.mjs", import.meta.url));

const { parseManualEntryCsv, parseManualEntryPaste } = await import("../src/lib/manualEntryImport.js");

let pass = 0, fail = 0;
const T = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`); }
};

// The Source/Channel report: a text field sits between the date and the numbers,
// which is exactly where a comma inside a quoted value does its damage.
const SOURCE_FIELDS = [
  { key: "date", label: "Date", type: "date" },
  { key: "source", label: "Source", type: "text" },
  { key: "code", label: "Code", type: "text" },
  { key: "net_revenue", label: "Revenue", type: "number" },
  { key: "stays", label: "Stays", type: "number" },
  { key: "adr", label: "ADR", type: "number" },
];

// The parser this replaced, copied verbatim from ManualEntry.jsx:279-287 before the
// fix. Kept here so the defect is reproduced rather than merely described: section 0
// shows the corruption it produced on the very inputs the sections below now pass.
function legacyParse(text, fields) {
  const lines = text.split("\n").filter((l) => l.trim());
  if (!lines.length) return [];
  const headers = lines[0].split(",").map((h) => h.trim().replace(/"/g, ""));
  return lines.slice(1).map((line) => {
    const cells = line.split(",").map((c) => c.trim().replace(/"/g, ""));
    const row = {};
    fields.forEach((f) => {
      const idx = headers.indexOf(f.key);
      row[f.key] = idx >= 0 ? cells[idx] : (f.type === "number" ? 0 : "");
    });
    return row;
  });
}

console.log("\n=== 0. Reproduction: what the old parser did with the same input ===");
{
  const quoted = 'date,source,code,net_revenue,stays,adr\n2026-03-01,"Smith, John",WI,1500.00,3,500\n';
  const old = legacyParse(quoted, SOURCE_FIELDS)[0];
  // "Smith, John" became two cells, so every column after it slid left by one.
  T("OLD: quoted comma shifted the columns", old.code === "John" && old.net_revenue === "WI",
    JSON.stringify(old));
  T("OLD: revenue was lost entirely", old.adr === "3", `adr=${old.adr}`);

  const bom = '﻿date,source,code,net_revenue,stays,adr\n2026-03-01,WALKIN,WI,100,1,100\n';
  const oldBom = legacyParse(bom, SOURCE_FIELDS)[0];
  // Correction to an earlier note in LAUNCH_READINESS_CHECKLIST.md: a BOM did NOT
  // break the upload path. String.prototype.trim() removes U+FEFF (the spec counts
  // ZWNBSP as whitespace), and the legacy code trimmed every header. Asserted here so
  // the false claim cannot be reintroduced from the checklist history.
  T("OLD: a BOM did NOT break the upload path (trim removes U+FEFF)", oldBom.date === "2026-03-01",
    `date=${JSON.stringify(oldBom.date)}`);
  // The paste path is where it bit: no trim, so the BOM stayed glued to cell 1.
  T("OLD: paste path kept the BOM in the first cell",
    "﻿2026-03-01\tEXPEDIA".split("\t")[0] !== "2026-03-01");

  const crlf = 'date,source,code,net_revenue,stays,adr\r\n2026-03-01,EXPEDIA,EX,100,1,100\r\n';
  const oldCrlf = legacyParse(crlf, SOURCE_FIELDS)[0];
  // Not a defect in the upload path: the legacy code trimmed every cell, so the CR
  // came off. It WAS a defect in the paste path, which did not trim — recorded below.
  T("OLD: upload path did strip CR (trim covered it)", oldCrlf.adr === "100", JSON.stringify(oldCrlf.adr));

  // handlePaste's loop, verbatim: split("\n") then split("\t"), no trim anywhere.
  const pastedCrlf = "2026-03-01\tEXPEDIA\tEX\t100\t1\t100\r\n";
  const legacyPasteCells = pastedCrlf.split("\n").filter((l) => l.trim())[0].split("\t");
  T("OLD: paste path left a CR on the last cell", legacyPasteCells[5] === "100\r",
    JSON.stringify(legacyPasteCells[5]));

  const torn = 'date,source,code,net_revenue,stays,adr\n2026-03-01,"Walk\nIn",WI,100,1,100\n';
  T("OLD: a quoted newline tore one row into two", legacyParse(torn, SOURCE_FIELDS).length === 2,
    `rows=${legacyParse(torn, SOURCE_FIELDS).length}`);

  const wrongFile = 'employee,hours,rate\nJane,40,20\n';
  const oldWrong = legacyParse(wrongFile, SOURCE_FIELDS)[0];
  // The worst case: a file for the wrong report imported as a full row of zeros.
  T("OLD: the wrong file imported as a row of zeros",
    oldWrong.net_revenue === 0 && oldWrong.stays === 0 && oldWrong.adr === 0, JSON.stringify(oldWrong));
}

console.log("\n=== 1. A quoted comma must not shift the columns ===");
{
  const csv = 'date,source,code,net_revenue,stays,adr\n2026-03-01,"Smith, John",WI,1500.00,3,500\n';
  const { rows, error } = parseManualEntryCsv(csv, SOURCE_FIELDS);
  T("no error", error === null, String(error));
  T("source keeps its comma", rows[0]?.source === "Smith, John", JSON.stringify(rows[0]));
  T("code did not absorb the tail", rows[0]?.code === "WI", `code=${rows[0]?.code}`);
  T("revenue landed in revenue", rows[0]?.net_revenue === 1500, `net_revenue=${rows[0]?.net_revenue}`);
  T("stays landed in stays", rows[0]?.stays === 3, `stays=${rows[0]?.stays}`);
  T("adr landed in adr", rows[0]?.adr === 500, `adr=${rows[0]?.adr}`);
}

console.log("\n=== 2. A quoted newline must not tear one row into two ===");
{
  const csv = 'date,source,code,net_revenue,stays,adr\n2026-03-01,"Walk\nIn",WI,100,1,100\n';
  const { rows } = parseManualEntryCsv(csv, SOURCE_FIELDS);
  T("one row, not two", rows.length === 1, `got ${rows.length}`);
  T("revenue intact", rows[0]?.net_revenue === 100, `net_revenue=${rows[0]?.net_revenue}`);
}

console.log("\n=== 3. CRLF must not leave \\r in a text cell ===");
{
  const csv = 'date,source,code,net_revenue,stays,adr\r\n2026-03-01,EXPEDIA,EX,100,1,100\r\n';
  const { rows } = parseManualEntryCsv(csv, SOURCE_FIELDS);
  T("source has no trailing CR", rows[0]?.source === "EXPEDIA", JSON.stringify(rows[0]?.source));
  T("last column has no trailing CR", rows[0]?.adr === 100, `adr=${rows[0]?.adr}`);
}

console.log("\n=== 4. A BOM must not orphan the first column ===");
{
  const csv = '﻿date,source,code,net_revenue,stays,adr\n2026-03-01,WALKIN,WI,100,1,100\n';
  const { rows, unmatched } = parseManualEntryCsv(csv, SOURCE_FIELDS);
  // The old parser produced headers[0] === "﻿date", indexOf("date") === -1, and
  // the date column silently became 0 — a row with no date at all.
  T("date column still matched", rows[0]?.date === "2026-03-01", `date=${rows[0]?.date}`);
  T("nothing reported as unmatched", unmatched.length === 0, `unmatched=${unmatched}`);
}

console.log("\n=== 5. A missing column is reported, never silently zeroed ===");
{
  const csv = 'date,source,code\n2026-03-01,EXPEDIA,EX\n';
  const { rows, warnings, error } = parseManualEntryCsv(csv, SOURCE_FIELDS);
  T("still imports what it can", error === null && rows.length === 1, String(error));
  T("missing number is blank, not 0", rows[0]?.net_revenue === "", `net_revenue=${JSON.stringify(rows[0]?.net_revenue)}`);
  T("the user is told which columns are blank",
    warnings.some((w) => /no matching column/i.test(w) && /Revenue/.test(w)),
    JSON.stringify(warnings));
}

console.log("\n=== 6. A file for the wrong report is refused, not imported as zeros ===");
{
  const csv = 'employee,hours,rate\nJane,40,20\n';
  const { rows, error } = parseManualEntryCsv(csv, SOURCE_FIELDS);
  T("nothing imported", rows.length === 0, `got ${rows.length} rows`);
  T("the refusal explains itself", /do not|none of the columns/i.test(String(error)), String(error));
}

console.log("\n=== 7. Headers match by label as well as by key ===");
{
  const csv = 'Date,Source,Code,Revenue,Stays,ADR\n2026-03-01,EXPEDIA,EX,100,1,100\n';
  const { rows, unmatched, error } = parseManualEntryCsv(csv, SOURCE_FIELDS);
  T("visible labels are accepted", error === null && unmatched.length === 0, `${error} unmatched=${unmatched}`);
  T("values still land correctly", rows[0]?.net_revenue === 100, JSON.stringify(rows[0]));
}

console.log("\n=== 8. Currency, thousands separators and signs are read ===");
{
  const csv = 'date,source,code,net_revenue,stays,adr\n2026-03-01,EXPEDIA,EX,"$1,234.56",3,$99.00\n';
  const { rows } = parseManualEntryCsv(csv, SOURCE_FIELDS);
  // The old path handed "$1,234.56" to Number() at save time, got NaN, and
  // refused the whole save with "Revenue must be a number".
  T('"$1,234.56" reads as 1234.56', rows[0]?.net_revenue === 1234.56, `net_revenue=${rows[0]?.net_revenue}`);
  T('"$99.00" reads as 99', rows[0]?.adr === 99, `adr=${rows[0]?.adr}`);
}

console.log("\n=== 9. Non-ISO dates normalise; junk dates are flagged ===");
{
  const csv = 'date,source,code,net_revenue,stays,adr\n04/01/2026,EXPEDIA,EX,100,1,100\n';
  const { rows } = parseManualEntryCsv(csv, SOURCE_FIELDS);
  T('"04/01/2026" -> ISO', rows[0]?.date === "2026-04-01", `date=${rows[0]?.date}`);

  const bad = 'date,source,code,net_revenue,stays,adr\nnot a date,EXPEDIA,EX,100,1,100\n';
  const r2 = parseManualEntryCsv(bad, SOURCE_FIELDS);
  T("an unreadable date is warned about",
    r2.warnings.some((w) => /not a recognisable date/i.test(w)), JSON.stringify(r2.warnings));
}

console.log("\n=== 10. A non-numeric amount is warned about, not imported as 0 ===");
{
  const csv = 'date,source,code,net_revenue,stays,adr\n2026-03-01,EXPEDIA,EX,N/A,1,100\n';
  const { rows, warnings } = parseManualEntryCsv(csv, SOURCE_FIELDS);
  T("the bad cell is blank, not 0", rows[0]?.net_revenue === "", `net_revenue=${JSON.stringify(rows[0]?.net_revenue)}`);
  T("and it is named with its row number",
    warnings.some((w) => /^Row 2:/.test(w) && /N\/A/.test(w)), JSON.stringify(warnings));
}

console.log("\n=== 11. Empty and header-only files say so ===");
{
  T("empty file", /no readable rows/i.test(String(parseManualEntryCsv("", SOURCE_FIELDS).error)));
  T("whitespace only", /no readable rows/i.test(String(parseManualEntryCsv("\n\n  \n", SOURCE_FIELDS).error)));
  const hdrOnly = parseManualEntryCsv("date,source,code,net_revenue,stays,adr\n", SOURCE_FIELDS);
  T("header with no data rows", /no data rows/i.test(String(hdrOnly.error)), String(hdrOnly.error));
}

console.log("\n=== 12. Blank lines and trailing newlines do not create empty rows ===");
{
  const csv = 'date,source,code,net_revenue,stays,adr\n2026-03-01,EXPEDIA,EX,100,1,100\n\n\n2026-03-02,WALKIN,WI,200,2,100\n\n';
  const { rows } = parseManualEntryCsv(csv, SOURCE_FIELDS);
  T("exactly two rows", rows.length === 2, `got ${rows.length}: ${JSON.stringify(rows.map((r) => r.date))}`);
}

console.log("\n=== 13. A duplicated header does not overwrite the visible column ===");
{
  const csv = 'date,source,code,net_revenue,stays,adr,net_revenue\n2026-03-01,EXPEDIA,EX,100,1,100,999999\n';
  const { rows } = parseManualEntryCsv(csv, SOURCE_FIELDS);
  T("the first matching column wins", rows[0]?.net_revenue === 100, `net_revenue=${rows[0]?.net_revenue}`);
}

console.log("\n=== 14. Extra columns are reported, not silently dropped ===");
{
  const csv = 'date,source,code,net_revenue,stays,adr,notes\n2026-03-01,EXPEDIA,EX,100,1,100,hello\n';
  const { warnings } = parseManualEntryCsv(csv, SOURCE_FIELDS);
  T("the ignored column is named", warnings.some((w) => /Ignored column/i.test(w) && /notes/.test(w)), JSON.stringify(warnings));
}

console.log("\n=== 15. Paste: CRLF from Excel leaves no \\r, header row is skipped ===");
{
  const pasted = "Date\tSource\tCode\tRevenue\tStays\tADR\r\n2026-03-01\tEXPEDIA\tEX\t100\t1\t100\r\n";
  const { rows, warnings, error } = parseManualEntryPaste(pasted, SOURCE_FIELDS);
  T("one data row", error === null && rows.length === 1, `${error} rows=${rows.length}`);
  T("header row skipped", warnings.some((w) => /header row/i.test(w)), JSON.stringify(warnings));
  T("no trailing CR on the text cell", rows[0]?.source === "EXPEDIA", JSON.stringify(rows[0]?.source));
  T("no trailing CR on the last number", rows[0]?.adr === 100, `adr=${rows[0]?.adr}`);
}

console.log("\n=== 16. Paste: a headerless block stays positional ===");
{
  const pasted = "2026-03-01\tEXPEDIA\tEX\t100\t1\t100";
  const { rows, warnings } = parseManualEntryPaste(pasted, SOURCE_FIELDS);
  T("the first row is data, not a header", rows.length === 1 && rows[0].date === "2026-03-01", JSON.stringify(rows));
  T("no header warning", !warnings.some((w) => /header row/i.test(w)), JSON.stringify(warnings));
}

console.log("\n=== 17. A partially-numeric cell is warned about, not silently truncated ===");
{
  // parseAmount is parseFloat-based: "12abc" -> 12, "1.2.3" -> 1.2, "12%" -> 12.
  // Before the fix these imported silently (a partial read the user never saw),
  // violating the module's "nothing is silently defaulted" contract.
  const csv = 'date,source,code,net_revenue,stays,adr\n2026-03-01,EXPEDIA,EX,12abc,1,100\n';
  const { rows, warnings } = parseManualEntryCsv(csv, SOURCE_FIELDS);
  T('"12abc" is NOT truncated to 12', rows[0]?.net_revenue !== 12, `net_revenue=${JSON.stringify(rows[0]?.net_revenue)}`);
  T('"12abc" cell is blanked', rows[0]?.net_revenue === "", `net_revenue=${JSON.stringify(rows[0]?.net_revenue)}`);
  T('"12abc" is named as not-a-number', warnings.some((w) => /^Row 2:/.test(w) && /12abc/.test(w)), JSON.stringify(warnings));

  const csv2 = 'date,source,code,net_revenue,stays,adr\n2026-03-01,EXPEDIA,EX,1.2.3,1,100\n';
  const r2 = parseManualEntryCsv(csv2, SOURCE_FIELDS);
  T('"1.2.3" is not read as 1.2', r2.rows[0]?.net_revenue === "", `net_revenue=${JSON.stringify(r2.rows[0]?.net_revenue)}`);

  // Legitimate numeric forms must still pass unharmed (no false rejections).
  const csv3 = 'date,source,code,net_revenue,stays,adr\n2026-03-01,EXPEDIA,EX,"(1,234.50)",.5,1234.\n';
  const r3 = parseManualEntryCsv(csv3, SOURCE_FIELDS);
  T('"(1,234.50)" still reads as -1234.5', r3.rows[0]?.net_revenue === -1234.5, `net_revenue=${JSON.stringify(r3.rows[0]?.net_revenue)}`);
  T('".5" still reads as 0.5', r3.rows[0]?.stays === 0.5, `stays=${JSON.stringify(r3.rows[0]?.stays)}`);
  T('"1234." still reads as 1234', r3.rows[0]?.adr === 1234, `adr=${JSON.stringify(r3.rows[0]?.adr)}`);
}

console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
