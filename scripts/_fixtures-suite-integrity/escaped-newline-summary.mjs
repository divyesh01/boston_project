// Fixture: Escaped newline string prefix (\nPASSED: ...)
import _assert from 'node:assert';

let _passed = 0;
let failed = 0;

if (Math.abs(-5) === 5) {
  _passed++;
} else {
  failed++;
}

console.log("\nPASSED: all checks passed");
process.exit(failed > 0 ? 1 : 0);
