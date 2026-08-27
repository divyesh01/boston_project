// Compliant test suite fixture
import _assert from 'node:assert';

let passed = 0;
let failed = 0;

function check(condition, name) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}`);
  }
}

check(1 + 1 === 2, 'arithmetic works');

if (failed === 0) {
  console.log(`PASSED: ${passed} passed, ${failed} failed`);
} else {
  console.log(`FAILED: ${passed} passed, ${failed} failed`);
}

process.exit(failed > 0 ? 1 : 0);
