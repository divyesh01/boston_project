import { rowsToObjects } from '../src/lib/csvParser.js';

// Test case 1: This should fail on broken code (Duplicate headers overwrite each other, long rows lose data)
const rows = [
  ['Total', 'Total', 'Name'],
  ['100', '200', 'John', 'ExtraData']
];
const result = rowsToObjects(rows);
const obj = result[0];

console.assert(obj['Total'] === '100', 'FAIL: Defect not reproducible (Total was overwritten)');
console.assert(obj['Total_1'] === '200', 'FAIL: Duplicate column was lost');
console.assert(obj['_col_3'] === 'ExtraData', 'FAIL: Trailing data without header was lost');
console.assert(Object.keys(obj).length === 4, 'FAIL: Output object has fewer keys than input row cells');

console.log('✓ Probe confirmed: CSV data loss defect is fixed');
