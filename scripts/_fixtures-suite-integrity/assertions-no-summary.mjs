// Assertions and exit path, but no column-0 PASSED:/FAILED: summary
import _assert from 'node:assert';

let failed = 0;
if (Math.max(1, 2) !== 2) {
  console.error('Test failed');
  failed++;
}

console.log('? All tests passed without standard summary');
process.exit(failed > 0 ? 1 : 0);
