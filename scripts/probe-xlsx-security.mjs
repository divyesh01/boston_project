// Fixed synthetic workbook bytes let us compare the business parser before and
// after upgrading SheetJS without regenerating inputs with the new dependency.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { scanReport } from '../src/lib/reportParsers.js';

const fixture = (name) => readFileSync(fileURLToPath(new URL(`./data/synthetic-xlsx/${name}`, import.meta.url)));
const baselinePath = fileURLToPath(new URL('./data/synthetic-xlsx/baseline.json', import.meta.url));
let passed = 0;
let failed = 0;

async function check(label, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${label}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL  ${label}: ${error.message}`);
  }
}

const normalBytes = fixture('normal.xlsx');
const normalBook = XLSX.read(normalBytes, { type: 'array', cellDates: true });
const normalSheet = normalBook.Sheets[normalBook.SheetNames[0]];
const normalCsv = XLSX.utils.sheet_to_csv(normalSheet, { dateNF: 'yyyy-mm-dd' });
const normalScan = await scanReport('occupancy', '', {
  propertyId: 'P_A', sourceFile: 'synthetic-normal.xlsx', rawBytes: normalBytes,
});
const actual = {
  csv: normalCsv,
  formula: { f: normalSheet.F2?.f, v: normalSheet.F2?.v },
  textFormula: normalSheet.G2?.v,
  merges: normalSheet['!merges'],
  rowsToImport: normalScan.rowsToImport,
  validationOk: normalScan.validation?.ok,
};

if (process.argv.includes('--record-baseline')) {
  writeFileSync(baselinePath, `${JSON.stringify(actual, null, 2)}\n`);
  console.log(`Recorded parser baseline using xlsx ${XLSX.version}`);
} else {
  await check('valid HotelKey-shaped workbook preserves the recorded business parser output', () => {
    assert.deepEqual(actual, JSON.parse(readFileSync(baselinePath, 'utf8')));
  });
}

await check('blank cells, dates, numbers, formula value, formula text and merge survive the workbook path', () => {
  assert.equal(normalBook.SheetNames.length, 1);
  assert.equal(normalSheet.F2.f, 'D2*1');
  assert.equal(normalSheet.F2.v, 1234.56);
  assert.equal(normalSheet.G2.v, '=SUM(1,1)');
  assert.equal(normalSheet['!merges']?.length, 1);
  assert.equal(normalScan.rowsToImport.length, 2);
  assert.equal(normalScan.rowsToImport[0].date, '2026-01-01');
  assert.equal(normalScan.rowsToImport[0].room_revenue, 1234.56);
  assert.equal(normalScan.rowsToImport[1].rooms_sold, 0);
});

await check('multiple sheets are rejected instead of silently dropping a report', async () => {
  await assert.rejects(scanReport('occupancy', '', {
    propertyId: 'P_A', sourceFile: 'synthetic-multiple.xlsx', rawBytes: fixture('multiple-sheets.xlsx'),
  }), /single-sheet report/);
});

await check('malformed workbook is rejected', async () => {
  await assert.rejects(scanReport('occupancy', '', {
    propertyId: 'P_A', sourceFile: 'synthetic-malformed.xlsx', rawBytes: fixture('malformed.xlsx'),
  }), /Invalid XLSX workbook signature/);
});

await check('oversized workbook is rejected before parsing', async () => {
  await assert.rejects(scanReport('occupancy', '', {
    propertyId: 'P_A', sourceFile: 'synthetic-oversized.xlsx', rawBytes: new Uint8Array(50 * 1024 * 1024 + 1),
  }), /Workbook exceeds import size limit/);
});

await check('compressed workbook expands safely within the bounded fixture', () => {
  const stressBytes = fixture('compressed-stress.xlsx');
  assert(stressBytes.byteLength < normalBytes.byteLength);
  const stressBook = XLSX.read(stressBytes, { type: 'array', cellDates: true });
  assert.equal(XLSX.utils.sheet_to_csv(stressBook.Sheets[stressBook.SheetNames[0]], { dateNF: 'yyyy-mm-dd' }), normalCsv);
});

await check('prototype-shaped XML attributes cannot pollute global object prototypes', () => {
  const before = Object.getOwnPropertyNames(Object.prototype);
  XLSX.read(fixture('pollution-shaped.xlsx'), { type: 'array', cellDates: true });
  assert.deepEqual(Object.getOwnPropertyNames(Object.prototype), before);
  assert.equal(Object.prototype.pollutionSentinel, undefined);
});

await check('bounded malformed XML tag cannot hang workbook parsing', () => {
  const started = performance.now();
  try { XLSX.read(fixture('redos-shaped.xlsx'), { type: 'array', cellDates: true }); } catch { /* rejection is safe */ }
  assert(performance.now() - started < 5000, 'bounded malformed workbook took over 5 seconds');
});

console.log(`\nprobe-xlsx-security: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log('PASSED: synthetic XLSX parser and security fixture contract completed.');
process.exit(0);
