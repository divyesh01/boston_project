// Fixture: Banner-style summary without PASSED:/FAILED: token
import assert from 'node:assert';

let pass = 0;
let fail = 0;

if (Math.sqrt(16) === 4) {
  pass++;
} else {
  fail++;
}

console.log(`\n${"=".repeat(62)}\n  ${pass} passed, ${fail} failed\n${"=".repeat(62)}`);
process.exit(fail ? 1 : 0);
