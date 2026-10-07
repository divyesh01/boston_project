import assert from 'node:assert/strict';
import { manifestScopeMatches } from '../src/lib/manifestScopeGuard.js';

const CANONICAL = 'prop_323fac7c80b03425da718ad219f90f50';
const ALIAS = 'prop_fixture_a';
const r10Manifest = { server_property_id: CANONICAL, property_aliases: [ALIAS] };

let passed = 0;
let failed = 0;

function run(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    failed += 1;
    console.error(`FAIL: ${name} :: ${err.message}`);
  }
}

// 1: canonical direct match valid
run('canonical direct match valid', () => {
  assert.equal(manifestScopeMatches(r10Manifest, CANONICAL), true);
});

// 2: string alias valid
run('string alias valid', () => {
  assert.equal(manifestScopeMatches(r10Manifest, ALIAS), true);
});

// 3: numeric typed alias valid (number 3 published, number 3 requested)
run('numeric typed alias valid', () => {
  assert.equal(manifestScopeMatches({ server_property_id: CANONICAL, property_aliases: [3] }, 3), true);
});

// 4: string "3" valid when published as string
run('string "3" valid when published', () => {
  assert.equal(manifestScopeMatches({ server_property_id: CANONICAL, property_aliases: [3, '3'] }, '3'), true);
});

// 5: foreign canonical denied
run('foreign canonical denied', () => {
  assert.equal(manifestScopeMatches(r10Manifest, 'prop_foreign_canonical_0000000000000000'), false);
});

// 6: foreign alias denied
run('foreign alias denied', () => {
  assert.equal(manifestScopeMatches({ server_property_id: CANONICAL, property_aliases: [ALIAS] }, 'prop_foreign_alias'), false);
});

// 7: missing aliases field denied for alias request
run('missing aliases field denied', () => {
  assert.equal(manifestScopeMatches({ server_property_id: CANONICAL }, ALIAS), false);
});

// 8: empty / null aliases denied for alias request
run('empty or null aliases denied', () => {
  assert.equal(manifestScopeMatches({ server_property_id: CANONICAL, property_aliases: [] }, ALIAS), false);
  assert.equal(manifestScopeMatches({ server_property_id: CANONICAL, property_aliases: null }, ALIAS), false);
});

// 9: empty-string canonical denied
run('empty canonical denied', () => {
  assert.equal(manifestScopeMatches({ server_property_id: '', property_aliases: [ALIAS] }, ALIAS), false);
});

// 10: missing / null-manifest / numeric canonical denied (fails closed)
run('malformed canonical fails closed', () => {
  assert.equal(manifestScopeMatches({ property_aliases: [ALIAS] }, ALIAS), false);
  assert.equal(manifestScopeMatches(null, ALIAS), false);
  assert.equal(manifestScopeMatches({ server_property_id: 42, property_aliases: [42] }, 42), false);
});

// 11: strict typed mismatch 3 vs "3" denied without coercion
run('strict typed 3 vs "3" denied', () => {
  assert.equal(manifestScopeMatches({ server_property_id: CANONICAL, property_aliases: [3] }, '3'), false);
  assert.equal(manifestScopeMatches({ server_property_id: CANONICAL, property_aliases: ['3'] }, 3), false);
});

// 12: unpublished / ambiguous alias denied
run('unpublished alias denied', () => {
  assert.equal(manifestScopeMatches({ server_property_id: CANONICAL, property_aliases: ['prop_a'] }, 'prop_ambiguous'), false);
});

// 13: falsy requested id helper returns false (helper-only; no guard skip claim)
run('falsy requested id helper false', () => {
  const scoped = { server_property_id: 'prop_foreign', property_aliases: [] };
  assert.equal(manifestScopeMatches(scoped, ''), false);
  assert.equal(manifestScopeMatches(scoped, undefined), false);
  assert.equal(manifestScopeMatches(scoped, null), false);
  assert.equal(manifestScopeMatches(scoped, 0), false);
});

console.log(`PASSED: ${passed} / FAILED: ${failed}`);
if (failed > 0) process.exit(1);
