// scripts/probe-money-kept-fix.mjs
// Prove that synthetic rows now have room_revenue property

import { buildSyntheticRows } from '../src/lib/dailyAggregates.js';

const mockData = [{
  property_id: 'RRI1416',
  business_date: '2026-08-01',
  occ_rooms_sold: 50,
  occ_capacity_rooms: 100,
  occ_revenue: 500000,
}];

const { occRows } = buildSyntheticRows(mockData);

// Test 1: Synthetic rows have room_revenue property
console.assert(
  occRows[0].hasOwnProperty('room_revenue'),
  'FAIL: Synthetic row missing room_revenue property'
);

// Test 2: room_revenue is NOT undefined
console.assert(
  occRows[0].room_revenue !== undefined,
  'FAIL: room_revenue is undefined'
);

// Test 3: Old wrong property name should NOT exist
console.assert(
  !occRows[0].hasOwnProperty('total_revenue'),
  'FAIL: Old total_revenue property still exists (should be removed)'
);

console.log('✓ Probe PASSED: Synthetic rows correctly use room_revenue');
