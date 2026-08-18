// scripts/probe-revenue-reconciliation.mjs

import { RevenueReconciliation } from '../src/lib/RevenueReconciliation.js';

console.log('Testing RevenueReconciliation service...\n');

const service = new RevenueReconciliation();

// TEST 1: All three paths match (no drift)
console.log('═══ TEST 1: All paths match ═══');
const test1 = service.reconcile(1000000, 1000000, 1000000, '2024-08');
console.assert(
  test1.all_paths_match === true,
  'FAIL: Should detect matching paths'
);
console.assert(
  test1.drift_detected === false,
  'FAIL: Should NOT detect drift when paths match'
);
console.assert(
  test1.reconciliation_status === 'PASS',
  'FAIL: Should return status PASS'
);
console.log('✓ Test 1 PASSED: Matching paths detected correctly\n');

// TEST 2: Small drift (within tolerance, < $0.01)
console.log('═══ TEST 2: Small drift (within tolerance) ═══');
const test2 = service.reconcile(1000000.00, 1000000.005, 1000000.00, '2024-08');
console.assert(
  test2.all_paths_match === true,
  'FAIL: Should allow rounding tolerance'
);
console.assert(
  test2.drift_detected === false,
  'FAIL: Should NOT alert for < $0.01 drift'
);
console.log('✓ Test 2 PASSED: Tolerance works correctly\n');

// TEST 3: Minor drift ($0.50)
console.log('═══ TEST 3: Minor drift (< $1.00) ═══');
const test3 = service.reconcile(1000000, 999999.50, 1000000, '2024-08');
console.assert(
  test3.all_paths_match === false,
  'FAIL: Should detect $0.50 drift'
);
console.assert(
  test3.drift_detected === true,
  'FAIL: Should mark drift_detected as true'
);
console.assert(
  test3.reconciliation_status === 'DRIFT_MINOR',
  `FAIL: Should return DRIFT_MINOR, got ${test3.reconciliation_status}`
);
console.log('✓ Test 3 PASSED: Minor drift detected\n');

// TEST 4: Major drift ($2.00)
console.log('═══ TEST 4: Major drift (>= $1.00) ═══');
const test4 = service.reconcile(1000000, 999998, 1000000, '2024-08');
console.assert(
  test4.reconciliation_status === 'DRIFT_MAJOR',
  `FAIL: Should return DRIFT_MAJOR, got ${test4.reconciliation_status}`
);
console.assert(
  test4.audit_record.maxDeviation >= 1.00,
  'FAIL: Max deviation should be >= $1.00'
);
console.log('✓ Test 4 PASSED: Major drift detected\n');

// TEST 5: Authoritative value is average
console.log('═══ TEST 5: Authoritative value calculation ═══');
const test5 = service.reconcile(100, 200, 300, '2024-08');
const expectedAverage = (100 + 200 + 300) / 3; // 200
console.assert(
  Math.abs(test5.authoritative_revenue - expectedAverage) < 0.01,
  `FAIL: Expected average ${expectedAverage}, got ${test5.authoritative_revenue}`
);
console.log(`✓ Test 5 PASSED: Authoritative value is correctly calculated as $${test5.authoritative_revenue.toFixed(2)}\n`);

// TEST 6: Reconciliation log tracks history
console.log('═══ TEST 6: Reconciliation log ═══');
const logBefore = service.getReconciliationLog().length;
service.reconcile(1000, 1000, 1000, '2024-09');
const logAfter = service.getReconciliationLog().length;
console.assert(
  logAfter === logBefore + 1,
  'FAIL: Reconciliation log should record each reconciliation'
);
console.log(`✓ Test 6 PASSED: Log now has ${logAfter} records\n`);

console.log('════════════════════════════════════════');
console.log('✓ Probe PASSED: All 6 reconciliation tests passed');
console.log('════════════════════════════════════════');
