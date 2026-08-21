// Probe for CSV data loss in rowsToObjects (src/lib/csvParser.js).
//
// A row can carry MORE cells than the header row has names, and a header row can
// repeat a name. Both happen in real PMS exports. Naive `obj[header[i]] = cell`
// silently drops data in both cases: the duplicate overwrites the first value, and
// the extra cells fall off the end. On a financial import, a dropped cell is a
// dropped dollar figure, and nothing tells the owner.
//
// THIS PROBE USED TO BE UNABLE TO FAIL. Every assertion was a `console.assert`,
// which writes "Assertion failed" to stderr and then carries on: the process still
// exited 0, and the last line printed "✓ Probe confirmed: CSV data loss defect is
// fixed" whether or not it was. Rewritten with a real counter and a non-zero exit,
// so this file now means what it says. (Same defect class as the old
// scripts/probe-revenue-reconciliation.mjs — worth grepping for `console.assert`
// before trusting any probe in this repo.)
//
// Run: node scripts/probe-csv-data-loss.mjs

import { rowsToObjects } from '../src/lib/csvParser.js';

let pass = 0;
let fail = 0;
const T = (name, cond, detail = '') => {
  let ok = false;
  let thrown = '';
  try {
    ok = typeof cond === 'function' ? !!cond() : !!cond;
  } catch (err) {
    thrown = ` threw ${err?.name}: ${err?.message}`;
  }
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ''}${thrown}`); }
};

// ── 1. Duplicate header names and a row longer than the header ───────────────
console.log('\n=== 1. Duplicate headers + trailing cell with no header ===');
{
  const rows = [
    ['Total', 'Total', 'Name'],
    ['100', '200', 'John', 'ExtraData'],
  ];
  const obj = rowsToObjects(rows)[0];
  console.log(`    -> ${JSON.stringify(obj)}`);

  T('the first "Total" keeps its own value', obj.Total === '100', `Total=${obj.Total}`);
  // The suffix is the 1-BASED COLUMN NUMBER, so the key records where the value
  // came from. NOTE: the previous version of this probe asserted `Total_1` and
  // `_col_3`. Those names were never the shipped contract — they were guesses that
  // no one noticed were wrong, because console.assert let the probe exit 0.
  T('the second "Total" is preserved under its column number', obj.Total_2 === '200',
    `Total_2=${obj.Total_2} keys=${Object.keys(obj).join(',')}`);
  T('a cell past the end of the header is preserved', obj._extra_4 === 'ExtraData',
    `_extra_4=${obj._extra_4} keys=${Object.keys(obj).join(',')}`);
  T('no cell was dropped (4 cells in, 4 keys out)', Object.keys(obj).length === 4,
    `keys=${Object.keys(obj).join(',')}`);
  // The point of the whole exercise: every input value must still be findable.
  T('every input value survives somewhere in the output',
    ['100', '200', 'John', 'ExtraData'].every((v) => Object.values(obj).includes(v)),
    JSON.stringify(obj));
}

// ── 2. Three-way duplicate, to prove the suffix scheme keeps counting ───────
console.log('\n=== 2. The same header three times ===');
{
  const rows = [
    ['Amount', 'Amount', 'Amount'],
    ['1.00', '2.00', '3.00'],
  ];
  const obj = rowsToObjects(rows)[0];
  console.log(`    -> ${JSON.stringify(obj)}`);
  T('three duplicate columns produce three distinct keys', Object.keys(obj).length === 3,
    `keys=${Object.keys(obj).join(',')}`);
  T('all three values survive',
    ['1.00', '2.00', '3.00'].every((v) => Object.values(obj).includes(v)), JSON.stringify(obj));
  T('no value is silently summed or coerced',
    Object.values(obj).every((v) => typeof v === 'string'), JSON.stringify(obj));
}

// ── 3. A short row must not invent values ───────────────────────────────────
// The converse failure: padding a short row with a wrong default is as bad as
// dropping a cell. A missing cell must read as empty/absent, never as '0'.
console.log('\n=== 3. A row SHORTER than the header ===');
{
  const rows = [
    ['A', 'B', 'C'],
    ['1'],
  ];
  const obj = rowsToObjects(rows)[0];
  console.log(`    -> ${JSON.stringify(obj)}`);
  T('the present cell is read', obj.A === '1', `A=${obj.A}`);
  T('absent cells are not fabricated as 0',
    obj.B !== '0' && obj.C !== '0', JSON.stringify(obj));
  T('absent cells are empty or undefined',
    (obj.B === '' || obj.B === undefined) && (obj.C === '' || obj.C === undefined),
    JSON.stringify(obj));
}

// ── 4. Blank header cells must not collide with each other ──────────────────
console.log('\n=== 4. Blank header names ===');
{
  const rows = [
    ['Date', '', ''],
    ['2026-01-01', 'x', 'y'],
  ];
  const obj = rowsToObjects(rows)[0];
  console.log(`    -> ${JSON.stringify(obj)}`);
  T('both unnamed columns survive separately',
    Object.values(obj).includes('x') && Object.values(obj).includes('y'), JSON.stringify(obj));
  T('nothing was lost to a shared empty-string key', Object.keys(obj).length === 3,
    `keys=${Object.keys(obj).join(',')}`);
}

// ── 5. Whitespace-only differences must not be treated as distinct headers ──
// 'Total' and 'Total ' name the same column in every export this project reads;
// if they were kept apart, downstream lookups by 'Total' would miss half the data.
console.log('\n=== 5. Headers differing only by surrounding whitespace ===');
{
  const rows = [
    ['Total', ' Total'],
    ['10', '20'],
  ];
  const obj = rowsToObjects(rows)[0];
  console.log(`    -> ${JSON.stringify(obj)}`);
  T('both values are still reachable', Object.values(obj).includes('10') && Object.values(obj).includes('20'),
    JSON.stringify(obj));
  T('two columns in, two keys out', Object.keys(obj).length === 2, `keys=${Object.keys(obj).join(',')}`);
}

// ── 6. A `__proto__` column must not vanish (hostile-input data loss) ────────
// Found 2026-08-20. With a plain `{}` accumulator, `obj["__proto__"] = "500.00"`
// sets the prototype rather than storing a value, and a string prototype is
// silently ignored — so the whole column disappeared with no key, no value and no
// error. Two such columns produced `{}`. CSV import is hostile input here and
// silent row loss is forbidden, so this is a data-integrity bug, not a curiosity.
console.log('\n=== 6. A column literally named __proto__ ===');
{
  const rows = [
    ['Date', '__proto__', 'Amount'],
    ['2026-01-01', 'MUST_SURVIVE', '42'],
  ];
  const obj = rowsToObjects(rows)[0];
  console.log(`    -> keys=${JSON.stringify(Object.keys(obj))} values=${JSON.stringify(Object.values(obj))}`);
  T('the __proto__ column is a real own property', Object.keys(obj).includes('__proto__'),
    `keys=${Object.keys(obj).join(',')}`);
  T('its value survives', Object.values(obj).includes('MUST_SURVIVE'), JSON.stringify(Object.values(obj)));
  T('the neighbouring columns are untouched', obj.Date === '2026-01-01' && obj.Amount === '42',
    JSON.stringify(Object.values(obj)));
  T('all three cells are present', Object.keys(obj).length === 3, `keys=${Object.keys(obj).join(',')}`);
  T('nothing was written to Object.prototype',
    // eslint-disable-next-line no-prototype-builtins
    ({}).MUST_SURVIVE === undefined && Object.prototype.MUST_SURVIVE === undefined);

  // Two of them: previously this produced {} — both cells lost.
  const dup = rowsToObjects([['__proto__', '__proto__'], ['a', 'b']])[0];
  console.log(`    dup -> keys=${JSON.stringify(Object.keys(dup))} values=${JSON.stringify(Object.values(dup))}`);
  T('two __proto__ columns both survive', Object.keys(dup).length === 2,
    `keys=${Object.keys(dup).join(',')}`);
  T('and keep their distinct values',
    Object.values(dup).includes('a') && Object.values(dup).includes('b'),
    JSON.stringify(Object.values(dup)));

  // Same class of key, same requirement.
  const ctor = rowsToObjects([['constructor', 'prototype'], ['c1', 'p1']])[0];
  T('"constructor" and "prototype" columns survive too',
    Object.values(ctor).includes('c1') && Object.values(ctor).includes('p1'),
    JSON.stringify(Object.values(ctor)));

  // The rows must still be usable by ordinary consumers after the prototype change.
  T('the row still round-trips through JSON',
    JSON.parse(JSON.stringify(obj)).Amount === '42', JSON.stringify(obj));
  T('the row still spreads into a normal object', { ...obj }.Amount === '42');
  T('Object.entries still enumerates every cell', Object.entries(obj).length === 3);
}

console.log(`\n${fail === 0 ? 'PASSED' : 'FAILED'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
