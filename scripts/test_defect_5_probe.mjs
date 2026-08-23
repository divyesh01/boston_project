// scripts/test_defect_5_probe.mjs
//
// Run: node --import ./scripts/_loader-boot.mjs scripts/test_defect_5_probe.mjs
//
// WHY THE IMPORTS BELOW ARE DYNAMIC. This file used to open with two STATIC imports
// of base44Client and localDb, and every run died before the first assertion with
//
//     DexieError [DatabaseClosedError]: MissingAPIError IndexedDB API missing
//
// Static imports are hoisted: the whole module graph is evaluated before any
// top-level statement in this file runs, so Dexie initialised while `indexedDB` was
// still undefined and latched a closed database. `_loader-boot.mjs` does NOT install
// fake-indexeddb — it installs the DOM shims and the `@/` resolver only — so a
// Dexie-touching suite has to bootstrap the storage API itself, before it reaches
// for the db. That is why all 26 Dexie suites in this directory open with the three
// lines below and import the app dynamically afterwards. The loader's own header
// records the identical trap for its alias resolver: "register() ... is too late for
// hoisted static imports."
await import('fake-indexeddb/auto');
globalThis.crypto ??= (await import('node:crypto')).webcrypto;

const localDb = (await import('@/api/localDb')).default;
const db = (await import('@/api/base44Client')).default;

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
  //
  // REGRESSION GATE for the handleLocalAuditList fix (src/api/base44Client.js).
  // Measured 2026-08-23, before the fix: three rows are seeded with property_id
  // ["prop_1416", "prop_phoenix", null] and db.audit.list({ property_id:
  // 'prop_1416' }) returned ALL THREE, because the shim honoured `filter.action`
  // and dropped every other key.
  //
  // The divergence was in the LOCAL-DEV shim, never in production:
  // base44/functions/audit_list/entry.js spreads the caller's filter into the
  // datastore query, derives the allowed scope from the authenticated actor, and
  // refuses out-of-scope ids with 403; src/main.jsx refuses to boot if
  // PROD && VITE_USE_LOCAL_AUTH === 'true', so the shim could not serve a real
  // user. It was a dev/prod parity defect of the kind the architecture notes call
  // A4 — NOT a live cross-property leak. Do not re-report it as one.
  //
  // It mattered because _loader-boot.mjs sets VITE_USE_LOCAL_AUTH=true, so EVERY
  // suite in this directory that touches db.audit.list was asserting against a
  // mock that ignored filters. Keep this assertion strict: if it goes red again,
  // the shim has stopped honouring the contract its own server function documents,
  // and harness coverage of the audit read path is worthless again.
  try {
    const res = await db.audit.list({ property_id: 'prop_1416' });
    const match = res.every(r => r.property_id === 'prop_1416');
    if (match && res.length === 1) {
      console.log('✓ Test 2 Passed: Property filter correctly scoped');
      passed++;
    } else {
      console.error(
        `✗ Test 2 Failed: property_id filter ignored — asked for prop_1416, got ${res.length} row(s) ` +
        `[${res.map((r) => String(r.property_id)).join(', ')}]. ` +
        'Root cause: handleLocalAuditList in src/api/base44Client.js honours only filter.action. ' +
        'Production (base44/functions/audit_list/entry.js) is correct; this is the local shim.',
      );
      failed++;
    }
  } catch (e) {
    console.error('✗ Test 2 Failed:', e.message);
    failed++;
  }

  // Test 3: an unknown field fails closed, and a `__proto__` key pollutes nothing.
  //
  // This used to assert `Array.isArray(res)` and nothing else, which made it the
  // weakest gate in the file: a change that ignored unrecognized filter keys and
  // returned the whole table would still have returned an array, so all five tests
  // stayed green while the shim leaked every row. Returning an array is not the
  // property under test — failing closed is.
  //
  // Measured 2026-08-23 against the shipped shim:
  //   Object.keys({ __proto__: { evil: true }, invalidField: 'test' }) === ['invalidField']
  // because `__proto__:` in an object literal is a SETTER, not an own property. So the
  // prototype-pollution half of this test is real but silent — the filter carries one
  // own key, and the assertion that matters is that the unknown key matches nothing.
  // Three rows are seeded and none has an `invalidField`, so the correct answer is 0.
  // Same principle as Test 5: an input the code does not understand must narrow to
  // nothing, never widen to everything.
  try {
    const res = await db.audit.list({ __proto__: { evil: true }, invalidField: 'test' });
    const polluted = ({}).evil !== undefined || Object.prototype.evil !== undefined;
    if (Array.isArray(res) && res.length === 0 && !polluted) {
      console.log('✓ Test 3 Passed: unknown field failed closed, no prototype pollution');
      passed++;
    } else if (!Array.isArray(res)) {
      // Without this branch the check could neither pass nor fail: a non-array
      // return incremented no counter, so the assertion silently evaporated and
      // the tally below reported two tests where three had been attempted.
      console.error(`✗ Test 3 Failed: expected an array, got ${typeof res}`);
      failed++;
    } else if (polluted) {
      console.error('✗ Test 3 Failed: Object.prototype was polluted by a __proto__ filter key');
      failed++;
    } else {
      console.error(
        `✗ Test 3 Failed: unknown field "invalidField" returned ${res.length} row(s) ` +
        `[${res.map((r) => String(r.property_id)).join(', ')}] — an unrecognized filter key must ` +
        'match nothing. Root cause to check: auditRowMatchesFilter in src/api/base44Client.js ' +
        'skipping keys it does not recognize instead of comparing them.',
      );
      failed++;
    }
  } catch (e) {
    console.error('✗ Test 3 Failed:', e.message);
    failed++;
  }

  // Test 4: { $in: [...] } is honoured, not treated as an opaque object.
  //
  // This shape is not hypothetical: propertyFilterFor() in
  // base44/functions/audit_list/entry.js emits { $in: [...] } whenever a
  // restricted actor's scope spans more than one property, so the shim has to
  // understand it or the two paths disagree again the moment a multi-property
  // admin exists.
  try {
    const res = await db.audit.list({ property_id: { $in: ['prop_1416', 'prop_phoenix'] } });
    const ids = res.map((r) => String(r.property_id)).sort();
    if (res.length === 2 && ids[0] === 'prop_1416' && ids[1] === 'prop_phoenix') {
      console.log('✓ Test 4 Passed: $in filter matched exactly the listed properties');
      passed++;
    } else {
      console.error(`✗ Test 4 Failed: $in returned ${res.length} row(s) [${ids.join(', ')}], expected prop_1416 + prop_phoenix`);
      failed++;
    }
  } catch (e) {
    console.error('✗ Test 4 Failed:', e.message);
    failed++;
  }

  // Test 5: an unsupported operator matches NOTHING (fails closed).
  //
  // The server answers { $ne: ... } with a 400, so no rows reach the caller
  // there either. What must never happen is the old behaviour — an unrecognized
  // operator being ignored and the full table returned. Returning every audit
  // row for a filter the code did not understand is the exact defect this probe
  // exists to catch, so assert on 0 rows rather than on a throw.
  try {
    const res = await db.audit.list({ property_id: { $ne: 'prop_1416' } });
    if (Array.isArray(res) && res.length === 0) {
      console.log('✓ Test 5 Passed: unsupported operator matched nothing');
      passed++;
    } else {
      console.error(`✗ Test 5 Failed: unsupported operator returned ${res.length} row(s) — it must fail closed, not fall back to unfiltered`);
      failed++;
    }
  } catch (e) {
    console.error('✗ Test 5 Failed:', e.message);
    failed++;
  }

  // House summary contract (see scripts/probe-suite-integrity.mjs): one machine
  // readable verdict line so scripts/verify-all.mjs can report counts instead of
  // inferring a result from the exit code alone.
  console.log(`\n${failed === 0 ? 'PASSED' : 'FAILED'}: ${passed} passed, ${failed} failed`);
  // Exit explicitly instead of letting the event loop drain. fake-indexeddb and
  // the SDK's pending request keep handles open, so on the first all-green run
  // this file printed its verdict and then hung until killed (measured rc=124 at
  // a 60s timeout). While Test 2 was red the `process.exit(1)` masked it. A suite
  // that never returns is one verify-all must report as a bad exit no matter what
  // it proved, so the exit has to cover the passing path too.
  process.exit(failed > 0 ? 1 : 0);
}

runProbe().catch((e) => {
  console.error('Fatal probe error:', e);
  process.exit(1);
});
