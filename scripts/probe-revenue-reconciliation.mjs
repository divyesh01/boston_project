// scripts/probe-revenue-reconciliation.mjs
//
// Guards src/lib/RevenueReconciliation.js.
//
// ─────────────────────────────────────────────────────────────────────────────
// REWRITTEN 2026-08-19. Two things were wrong with the previous version:
// ─────────────────────────────────────────────────────────────────────────────
//
//   1. THE PROBE COULD NOT FAIL. Every check was `console.assert(...)`, which in
//      Node prints to stderr and CARRIES ON — it does not throw and does not set
//      an exit code. Each assert was followed unconditionally by
//      `console.log('✓ Test N PASSED')` and the file ended with
//      '✓ Probe PASSED: All 6 reconciliation tests passed'. So the probe printed
//      six ticks and exited 0 no matter what the service did. It was the sole
//      evidence behind "known problem #5: revenue paths don't match — FIXED",
//      and it was decorative. Now: a real counter, real comparisons, and
//      `process.exit(1)` on any failure.
//
//   2. TEST 5 PINNED THE DEFECT AS THE SPEC. It asserted
//      `authoritative_revenue === (100 + 200 + 300) / 3`, i.e. it required the
//      service to report the MEAN of three revenue ledgers as authoritative.
//      That is the behaviour that turned a broken statistics leg into a 33.6%
//      understatement of revenue in production (see probe-financial-invariant.mjs
//      for the measured figures). Test 5 is therefore DELIBERATELY REVERSED
//      below: it now asserts the mean is NOT returned, and that the figure comes
//      from the highest-precedence available path instead.
//
//      Rewriting a passing test needs justification, so here it is explicitly:
//      the test encoded a requirement that no stakeholder ever asked for and that
//      makes the headline revenue figure untraceable to any document. Averaging
//      also fails safe in the wrong direction — a path that breaks and returns 0
//      silently lowers the reported figure instead of raising an error. Section 5
//      of this probe now pins that specific scenario.
//
// Run: node scripts/probe-revenue-reconciliation.mjs

import { RevenueReconciliation, PATH_PRECEDENCE, RECON_STATUS } from '../src/lib/RevenueReconciliation.js';

let pass = 0, fail = 0;
const T = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ''}`); }
};

// The reconciler warns on drift by design, and several sections below induce
// drift on purpose. Silence the expected noise so a real error still stands out.
const realWarn = console.warn, realError = console.error;
console.warn = () => {}; console.error = () => {};
const restoreConsole = () => { console.warn = realWarn; console.error = realError; };

const svc = () => new RevenueReconciliation();

console.log('\n=== 1. All paths agree ===');
{
  const r = svc().reconcile(1000000, 1000000, 1000000, '2026-08');
  T('all_paths_match is true', r.all_paths_match === true);
  T('drift_detected is false', r.drift_detected === false);
  T('status is PASS', r.reconciliation_status === RECON_STATUS.PASS, `got ${r.reconciliation_status}`);
  T('authoritative figure is the agreed figure', r.authoritative_revenue === 1000000, `got ${r.authoritative_revenue}`);
}

console.log('\n=== 2. Rounding tolerance is exactly one cent ===');
{
  // Half a cent apart: inside tolerance.
  const r = svc().reconcile(1000000.00, 1000000.005, 1000000.00, '2026-08');
  T('a half-cent difference is within tolerance', r.all_paths_match === true);

  // Exactly one cent: the boundary must be inclusive, or every real dataset
  // trips a false alarm on legitimate rounding.
  const b = svc().reconcile(1000000.00, 1000000.01, 1000000.00, '2026-08');
  T('exactly $0.01 is within tolerance (inclusive boundary)', b.all_paths_match === true,
    `status=${b.reconciliation_status} maxDeviation=${b.audit_record.maxDeviation}`);

  // Two cents: outside.
  const c = svc().reconcile(1000000.00, 1000000.02, 1000000.00, '2026-08');
  T('$0.02 is outside tolerance', c.drift_detected === true, `status=${c.reconciliation_status}`);
}

console.log('\n=== 3. Drift severity ===');
{
  const minor = svc().reconcile(1000000, 999999.50, 1000000, '2026-08');
  T('a $0.50 gap is DRIFT_MINOR', minor.reconciliation_status === RECON_STATUS.DRIFT_MINOR, `got ${minor.reconciliation_status}`);
  T('drift_detected is true', minor.drift_detected === true);

  const major = svc().reconcile(1000000, 999998, 1000000, '2026-08');
  T('a $2.00 gap is DRIFT_MAJOR', major.reconciliation_status === RECON_STATUS.DRIFT_MAJOR, `got ${major.reconciliation_status}`);
  T('maxDeviation is reported as $2.00', major.audit_record.maxDeviation === 2, `got ${major.audit_record.maxDeviation}`);

  // The $1.00 boundary belongs to MAJOR, not MINOR.
  const edge = svc().reconcile(1000000, 999999, 1000000, '2026-08');
  T('exactly $1.00 is DRIFT_MAJOR', edge.reconciliation_status === RECON_STATUS.DRIFT_MAJOR, `got ${edge.reconciliation_status}`);
}

console.log('\n=== 4. Integer-cent comparison, not float epsilon ===');
{
  // 0.1 + 0.2 !== 0.3 in binary floating point. A reconciler that compares with
  // float subtraction reports phantom drift on figures that are equal to the cent.
  const a = 0.1 + 0.2;          // 0.30000000000000004
  const r = svc().reconcile(a, 0.3, 0.3, '2026-08');
  T('0.1+0.2 reconciles against 0.3 with no phantom drift', r.all_paths_match === true,
    `maxDeviation=${r.audit_record.maxDeviation}`);

  // And a real one-cent gap on large figures must still be caught, so the above
  // is tolerance working rather than the comparison being blunt.
  const b = svc().reconcile(1020598.17, 1020598.19, 1020598.17, '2026-08');
  T('a real $0.02 gap on seven-figure revenue is still caught', b.drift_detected === true,
    `status=${b.reconciliation_status}`);
}

console.log('\n=== 5. The authoritative figure is a real path, NEVER the mean ===');
console.log('    (this section deliberately reverses the old Test 5 — see the header)');
{
  const r = svc().reconcile(100, 200, 300, '2026-08');
  const mean = (100 + 200 + 300) / 3;
  T('the mean of the three paths is NOT returned', r.authoritative_revenue !== mean,
    `returned ${r.authoritative_revenue}, mean would be ${mean}`);
  T('the figure is one of the supplied paths', [100, 200, 300].includes(r.authoritative_revenue),
    `got ${r.authoritative_revenue}`);
  T('precedence picks the statistics path', r.authoritative_revenue === 100, `got ${r.authoritative_revenue}`);
  T('the result names which path it came from', r.authoritative_path === 'statistics_analytics',
    `got ${r.authoritative_path}`);
  T('and it reports drift, because 100/200/300 genuinely disagree', r.drift_detected === true);

  T('precedence order is statistics > transactions > occupancy',
    PATH_PRECEDENCE[0] === 'statistics_analytics' && PATH_PRECEDENCE[1] === 'transaction_analytics' && PATH_PRECEDENCE[2] === 'occupancy_day',
    PATH_PRECEDENCE.join(' > '));
}

console.log('\n=== 6. A broken path must not silently lower the reported revenue ===');
{
  // The production incident: the statistics leg read $0.00 because of a
  // lowercase section name, and the mean of (0, 1020598.17, 1011258.67) is
  // $677,285.61 — reported as revenue, 33.6% low, with no error raised.
  const r = svc().reconcile(0, 1020598.17, 1011258.67, '2026-ytd');
  const oldMean = (0 + 1020598.17 + 1011258.67) / 3;
  T('the 33.6%-low mean is not returned', Math.abs(r.authoritative_revenue - oldMean) > 1,
    `got ${r.authoritative_revenue}, the old mean was ${oldMean.toFixed(2)}`);
  T('a $0.00 path alongside real revenue is flagged as suspect',
    r.suspect_zero_paths.includes('statistics_analytics'), JSON.stringify(r.suspect_zero_paths));
  T('drift is reported loudly', r.reconciliation_status === RECON_STATUS.DRIFT_MAJOR, `got ${r.reconciliation_status}`);
  T('the drift report says the zero is likely a broken derivation',
    /broken derivation/.test(r.drift_details), r.drift_details);
}

console.log('\n=== 7. Missing is not zero ===');
{
  // null means "could not compute". Counting it as $0 both fabricates drift and,
  // under the old averaging, understated revenue by a third.
  const r = svc().reconcile(null, 1020598.17, 1011258.67, '2026-ytd', { statisticsRoomRevenue: null });
  T('a null path is listed as missing', r.missing_paths.includes('statistics_analytics'), JSON.stringify(r.missing_paths));
  T('a null path is not treated as $0.00', !r.suspect_zero_paths.includes('statistics_analytics'));
  T('authority falls through to the transaction ledger', r.authoritative_path === 'transaction_analytics', `got ${r.authoritative_path}`);
  T('the figure is the transaction total, undiluted', r.authoritative_revenue === 1020598.17, `got ${r.authoritative_revenue}`);
  T('the report states the path was excluded rather than zeroed',
    /NOT AVAILABLE/.test(r.drift_details), r.drift_details);

  const none = svc().reconcile(null, null, null, '2026-ytd');
  T('no paths at all is NO_DATA, not PASS', none.reconciliation_status === RECON_STATUS.NO_DATA, `got ${none.reconciliation_status}`);
  T('no paths at all does not claim the paths match', none.all_paths_match === false);
  T('no paths at all has no authoritative path', none.authoritative_path === null, `got ${none.authoritative_path}`);
}

console.log('\n=== 8. Room scope vs total scope, compared like with like ===');
{
  // The real decomposition: room 1,011,258.67 + ancillary 9,339.50 = 1,020,598.17.
  const TOTAL = 1020598.17, ROOM = 1011258.67;

  // Without the room baseline, the ancillary total is misreported as drift.
  const naive = svc().reconcile(TOTAL, TOTAL, ROOM, '2026-ytd');
  T('without a room baseline the ancillary sum looks like drift', naive.drift_detected === true);
  T('and the report warns the comparison is scope-mismatched',
    /ROOM revenue only/.test(naive.drift_details), naive.drift_details);
  T('occupancy_scope is reported as total', naive.occupancy_scope === 'total', `got ${naive.occupancy_scope}`);

  // With it, all three agree.
  const fixed = svc().reconcile(TOTAL, TOTAL, ROOM, '2026-ytd', { statisticsRoomRevenue: ROOM });
  T('with the room baseline all three paths agree', fixed.all_paths_match === true,
    `status=${fixed.reconciliation_status} detail=${fixed.drift_details}`);
  T('occupancy_scope is reported as room', fixed.occupancy_scope === 'room', `got ${fixed.occupancy_scope}`);
  T('the authoritative figure is the TOTAL, not the room subtotal', fixed.authoritative_revenue === TOTAL, `got ${fixed.authoritative_revenue}`);

  // A genuine room-revenue discrepancy must still be caught.
  const drifted = svc().reconcile(TOTAL, TOTAL, ROOM - 5, '2026-ytd', { statisticsRoomRevenue: ROOM });
  T('a genuine $5.00 room-revenue gap is still caught', drifted.reconciliation_status === RECON_STATUS.DRIFT_MAJOR, `got ${drifted.reconciliation_status}`);

  // The room-only path must never become the authoritative TOTAL, even when it
  // is the only path present — that would understate revenue by the ancillary sum.
  const roomOnly = svc().reconcile(null, null, ROOM, '2026-ytd', { statisticsRoomRevenue: ROOM });
  T('a room-only path never stands in as the total', roomOnly.authoritative_path === null, `got ${roomOnly.authoritative_path}`);
}

console.log('\n=== 9. Owner-facing report quality ===');
{
  // A zero baseline must not print NaN% or Infinity% at an owner.
  const r = svc().reconcile(0, 0, 0, '2026-08');
  T('an all-zero period is a clean PASS', r.reconciliation_status === RECON_STATUS.PASS, `got ${r.reconciliation_status}`);
  T('no NaN or Infinity reaches the drift report', !/NaN|Infinity/.test(r.drift_details), r.drift_details);
  T('percentDeviation is null rather than NaN when the baseline is zero',
    r.audit_record.deviations.every((d) => d.percentDeviation === null),
    JSON.stringify(r.audit_record.deviations.map((d) => d.percentDeviation)));

  const drift = svc().reconcile(1020598.17, 1000000, 1011258.67, '2026-ytd', { statisticsRoomRevenue: 1011258.67 });
  T('drift figures are formatted as money, not raw floats', /\$1,020,598\.17/.test(drift.drift_details), drift.drift_details);
  T('every path in the report says which scope it was measured on', /\[total\]/.test(drift.drift_details) && /\[room\]/.test(drift.drift_details), drift.drift_details);
}

console.log('\n=== 10. Audit log ===');
{
  const s = svc();
  const before = s.getReconciliationLog().length;
  s.reconcile(1000, 1000, 1000, '2026-09');
  T('each reconciliation is recorded', s.getReconciliationLog().length === before + 1);
  const rec = s.getReconciliationLog(1)[0];
  T('the record names the authoritative path', rec.authoritativePath === 'statistics_analytics');
  T('the record keeps the raw inputs for audit', rec.paths.statistics_analytics === 1000);
  T('the record is timestamped', typeof rec.timestamp === 'string' && rec.timestamp.length > 0);
  T('the record carries the date range', rec.dateRange === '2026-09');
}

restoreConsole();
console.log(`\n${fail === 0 ? 'PASSED' : 'FAILED'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
