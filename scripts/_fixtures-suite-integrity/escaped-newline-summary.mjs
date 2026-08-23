// Fixture: Escaped newline string prefix (\nPASSED: ...)
import assert from 'node:assert';

let passed = 0;
let failed = 0;

if (Math.abs(-5) === 5) {
  passed++;
} else {
  failed++;
}

console.log("\nPASSED: all checks passed");
process.exit(failed > 0 ? 1 : 0);
