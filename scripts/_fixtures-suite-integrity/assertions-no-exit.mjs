// Assertions present but no non-zero process.exit path
import assert from 'node:assert';

console.assert(1 === 1, 'basic check');
// Note: no process.exit() call here
