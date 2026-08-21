// scripts/probe-money-kept-fix.mjs
// Prove that buildSyntheticRows emits `room_revenue`, and emits the right numbers.
//
// ─────────────────────────────────────────────────────────────────────────────
// REWRITTEN 2026-08-20. THIS SUITE HAD NEVER ONCE REPORTED A RESULT.
//
// It carried two independent defects, and the second one hid the first:
//
// 1. HANG. It ended after `console.log('✓ Probe PASSED')` with no `process.exit`.
//    Importing `src/lib/dailyAggregates.js` pulls in the entity proxy and the Base44
//    client, which open handles and start retrying a request that cannot resolve in
//    node (`[Base44 SDK Error] undefined: Invalid URL`, repeating). Those handles keep
//    the event loop alive, so the process never exited on its own. Measured before
//    this rewrite: killed by `timeout 170`, EXIT=124, after printing its own success
//    line at ~2s. In `npm run verify:all` it could therefore only ever be TIMEOUT —
//    never PASS, never FAIL. A suite that cannot finish is a suite that reports
//    nothing, which is why verify-all.mjs treats TIMEOUT as its own outcome.
//
//    `buildSyntheticRows` is a pure function and touches none of that graph, so the
//    fix is an explicit exit, taken SYNCHRONOUSLY after the assertions. Synchronous
//    matters: a pending SDK rejection landing between the last check and the exit
//    would abort node with a non-zero code that had nothing to do with the
//    assertions, and a suite that fails for unrelated reasons gets ignored.
//
// 2. IT COULD NOT FAIL. All three checks were `console.assert`, which prints to
//    stderr and returns — it does not throw and does not set an exit code. So the
//    file printed `✓ Probe PASSED` unconditionally, on the same run as any failure.
//    That is failure mode #2 in BRAIN_TROUBLESHOOTING.md section 22.
//
// BEST OUTCOME NOTE: the original also only asserted that `room_revenue` EXISTS and
// is not undefined — never that it holds the right amount. A field can be present,
// correctly named, and wrong; `hasOwnProperty` would still pass. The values are the
// point, so they are checked exactly, in integer cents. Two guard cases from the
// function's own contract are checked too: an all-zero aggregate must produce no row
// at all, and zero capacity must not yield Infinity or NaN.
//
// Run: node --import ./scripts/_loader-boot.mjs scripts/probe-money-kept-fix.mjs
// ─────────────────────────────────────────────────────────────────────────────

import { buildSyntheticRows } from '../src/lib/dailyAggregates.js';

let pass = 0;
let fail = 0;
const failures = [];

function ok(label, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  PASS ${label}`);
  } else {
    fail++;
    failures.push(label);
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
// JSON.stringify(NaN) and JSON.stringify(Infinity) are both the string "null", so
// reporting through it turns a caught NaN into "got null, expected 0" — which reads
// like a broken assertion instead of a caught defect. Non-finite numbers are half of
// what this probe checks, so they are rendered as themselves.
function show(v) {
  if (typeof v === 'number' && !Number.isFinite(v)) return String(v);
  return JSON.stringify(v);
}
const eq = (label, actual, expected) =>
  ok(label, actual === expected, `got ${show(actual)}, expected ${show(expected)}`);

// 50 of 100 rooms sold for 500000 cents ($5,000.00): occupancy 0.5, ADR 10000c
// ($100.00), RevPAR 5000c ($50.00). Amounts stay in cents end to end.
const mockData = [{
  property_id: 'RRI1416',
  business_date: '2026-08-01',
  occ_rooms_sold: 50,
  occ_capacity_rooms: 100,
  occ_revenue: 500000,
}];

const { occRows } = buildSyntheticRows(mockData);

console.log('\n=== buildSyntheticRows: the occupancy row it hands to the money math ===');

// Guard first. Every check below reads occRows[0], and `undefined?.x` is undefined,
// which would make the negative assertions pass on an empty array.
ok('one occupancy row was produced', occRows.length === 1, `length=${occRows.length}`);

if (occRows.length === 1) {
  const r = occRows[0];

  // The rename this file was created for. MoneyKept sums `room_revenue`; while the
  // synthetic rows carried `total_revenue`, gross came back $0 from cached data.
  ok('the row carries room_revenue', Object.prototype.hasOwnProperty.call(r, 'room_revenue'));
  ok('the old name total_revenue is gone',
    !Object.prototype.hasOwnProperty.call(r, 'total_revenue'),
    'a row carrying both names lets two callers disagree about which is authoritative');

  // Presence is not correctness.
  eq('room_revenue is the aggregate revenue, unscaled', r.room_revenue, 500000);
  eq('rooms_sold passes through', r.rooms_sold, 50);
  eq('total_rooms passes through', r.total_rooms, 100);
  eq('occupancy = sold / capacity', r.occupancy, 0.5);
  eq('adr = revenue / sold (cents)', r.adr, 10000);
  eq('revpar = revenue / capacity (cents)', r.revpar, 5000);
  eq('the property scope is preserved', r.property_id, 'RRI1416');
  eq('business_date is truncated to a plain date', r.date, '2026-08-01');
}

// An aggregate with nothing in it must not become a row. Without this guard the
// dashboard would show a day the hotel has no data for as a real zero-revenue day,
// which is a different claim from "not imported yet".
console.log('\n=== the guards on the row-emitting condition ===');
const empty = buildSyntheticRows([{ property_id: 'RRI1416', business_date: '2026-08-02' }]);
eq('an aggregate with no occupancy figures emits no row', empty.occRows.length, 0);

// Zero capacity is real: a property with no rooms configured yet. 500000/0 is
// Infinity, and Infinity in a revenue average poisons every total downstream.
const noCap = buildSyntheticRows([{
  property_id: 'RRI1416', business_date: '2026-08-03', occ_revenue: 500000, occ_rooms_sold: 0, occ_capacity_rooms: 0,
}]);
ok('zero capacity still emits the row (the revenue is real)', noCap.occRows.length === 1);
if (noCap.occRows.length === 1) {
  const z = noCap.occRows[0];
  eq('...with occupancy 0, not NaN', z.occupancy, 0);
  eq('...with adr 0, not NaN', z.adr, 0);
  eq('...with revpar 0, not Infinity', z.revpar, 0);
  ok('...and every numeric field is finite',
    [z.occupancy, z.adr, z.revpar, z.room_revenue].every(Number.isFinite));
}

console.log(`\n${fail === 0 ? 'PASSED' : 'FAILED'}: ${pass} passed, ${fail} failed`);
if (fail) console.log(`Failures:\n  - ${failures.join('\n  - ')}`);

// SYNCHRONOUS, and last. See defect 1 in the header — without this the imported
// module graph's open handles keep node alive and this suite reports nothing at all.
process.exit(fail > 0 ? 1 : 0);
