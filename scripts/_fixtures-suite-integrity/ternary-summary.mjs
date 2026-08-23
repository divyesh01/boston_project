// Fixture: Ternary-computed summary token
import assert from 'node:assert';

let pass = 0;
let fail = 0;

if (1 + 1 === 2) {
  pass++;
} else {
  fail++;
}

console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
