// Recreate the checked-in synthetic XLSX inputs with the original parser version.
// No customer workbook or HotelKey export is used here.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx');
const { unzipSync, zipSync, strFromU8, strToU8 } = require('fflate');
if (XLSX.version !== '0.18.5') throw new Error('These fixed input bytes must be generated with xlsx 0.18.5');

const destination = fileURLToPath(new URL('./data/synthetic-xlsx/', import.meta.url));
mkdirSync(destination, { recursive: true });

const grid = [
  ['Date', 'Total Sold Rooms', 'Total Rooms', 'Room Revenue', 'Notes', 'Formula Value', 'Text Formula'],
  [new Date('2026-01-01T12:00:00Z'), 50, 100, 1234.56, '', 1234.56, '=SUM(1,1)'],
  [new Date('2026-01-02T12:00:00Z'), 0, 100, 0, 'Merged note', null, ''],
];
const sheet = XLSX.utils.aoa_to_sheet(grid, { cellDates: true });
sheet.F2 = { t: 'n', f: 'D2*1', v: 1234.56 };
sheet['!merges'] = [{ s: { r: 2, c: 4 }, e: { r: 2, c: 5 } }];
const book = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(book, sheet, 'Report');
const normal = new Uint8Array(XLSX.write(book, { type: 'array', bookType: 'xlsx' }));
writeFileSync(path.join(destination, 'normal.xlsx'), normal);

const multi = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(multi, sheet, 'Report');
XLSX.utils.book_append_sheet(multi, XLSX.utils.aoa_to_sheet([['Extra'], ['synthetic']]), 'Extra');
writeFileSync(path.join(destination, 'multiple-sheets.xlsx'),
  new Uint8Array(XLSX.write(multi, { type: 'array', bookType: 'xlsx' })));

function rewriteSheet(bytes, transform) {
  const entries = unzipSync(bytes);
  const key = 'xl/worksheets/sheet1.xml';
  const original = strFromU8(entries[key]);
  const updated = transform(original);
  if (updated === original) throw new Error('Synthetic XML transform made no change');
  entries[key] = strToU8(updated);
  return zipSync(entries, { level: 6 });
}

writeFileSync(path.join(destination, 'pollution-shaped.xlsx'), rewriteSheet(normal,
  (xml) => xml.replace(/<worksheet\b/, '<worksheet __proto__="pollution-sentinel" constructor="synthetic" prototype="synthetic"')));
writeFileSync(path.join(destination, 'redos-shaped.xlsx'), rewriteSheet(normal,
  (xml) => xml.replace('</worksheet>', `<synthetic ${'x='.repeat(160)}!></worksheet>`)));
writeFileSync(path.join(destination, 'compressed-stress.xlsx'), rewriteSheet(normal,
  (xml) => xml.replace('</worksheet>', `<!--${'A'.repeat(1_000_000)}--></worksheet>`)));
writeFileSync(path.join(destination, 'malformed.xlsx'), strToU8('Synthetic invalid XLSX fixture'));

console.log('Generated six synthetic XLSX fixtures.');
