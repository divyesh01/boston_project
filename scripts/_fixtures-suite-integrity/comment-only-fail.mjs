// This file mentions FAIL in a comment only:
// FAIL if something went wrong
// It has assertions and an exit path, but NO real summary
import _assert from 'node:assert';

let failed = 0;
if (2 * 2 !== 4) {
  failed++;
}
process.exit(failed > 0 ? 1 : 0);
