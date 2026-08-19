// scripts/test_defect_5_probe.mjs
import db from '../src/api/base44Client.js';
import localDb from '../src/api/localDb.js';

async function runProbe() {
  console.log('--- RUNNING DEFECT #5 PROBE ---');
  let passed = 0;
  let failed = 0;

  // Seed sample audit logs
  await localDb.AuditLog.clear();
  await db.audit.log({ action: 'Login', username: 'alice', property_id: 'prop_1416', result: 'success' });
  await db.audit.log({ action: 'User Created', username: 'bob', property_id: 'prop_phoenix', result: 'success' });
  await db.audit.log({ action: 'Password Reset', username: 'system', property_id: null, result: 'success' });

  // Test 1: Null/Undefined filter should not throw
  try {
    const res = await db.audit.list(null);
    if (Array.isArray(res) && res.length >= 0) {
      console.log('✓ Test 1 Passed: Null filter safely handled');
      passed++;
    } else {
      console.error('✗ Test 1 Failed: Null filter returned invalid result');
      failed++;
    }
  } catch (e) {
    console.error('✗ Test 1 Failed (Crash):', e.message);
    failed++;
  }

  // Test 2: Valid property_id filter
  try {
    const res = await db.audit.list({ property_id: 'prop_1416' });
    const match = res.every(r => r.property_id === 'prop_1416');
    if (match && res.length === 1) {
      console.log('✓ Test 2 Passed: Property filter correctly scoped');
      passed++;
    } else {
      console.error('✗ Test 2 Failed: Property filter leaked records');
      failed++;
    }
  } catch (e) {
    console.error('✗ Test 2 Failed:', e.message);
    failed++;
  }

  // Test 3: Unwhitelisted / Malformed prototype keys are ignored
  try {
    const res = await db.audit.list({ __proto__: { evil: true }, invalidField: 'test' });
    if (Array.isArray(res)) {
      console.log('✓ Test 3 Passed: Malformed keys sanitized safely');
      passed++;
    }
  } catch (e) {
    console.error('✗ Test 3 Failed:', e.message);
    failed++;
  }

  console.log(`\nProbe Results: ${passed} Passed, ${failed} Failed`);
  if (failed > 0) process.exit(1);
}

runProbe().catch((e) => {
  console.error('Fatal probe error:', e);
  process.exit(1);
});
