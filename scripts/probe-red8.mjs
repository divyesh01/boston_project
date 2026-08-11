// Probe for RED-8: constantTimeEqual timing leak via early return on length mismatch
// Measures whether comparing strings of different lengths leaks timing info

import { constantTimeEqual } from '@/lib/security';

let pass = 0, fail = 0;
const T = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`); }
};

console.log("\n=== RED-8: constantTimeEqual Timing Leak ===\n");

// Functional correctness tests
T("Equal strings return true", constantTimeEqual("abc", "abc") === true);
T("Different strings same length return false", constantTimeEqual("abc", "xyz") === false);
T("Different length strings return false", constantTimeEqual("abc", "ab") === false);
T("Empty strings return true", constantTimeEqual("", "") === true);
T("Empty vs non-empty returns false", constantTimeEqual("", "a") === false);
T("Single char equal returns true", constantTimeEqual("a", "a") === true);
T("Single char unequal returns false", constantTimeEqual("a", "b") === false);
T("Long equal strings return true", constantTimeEqual("a".repeat(1000), "a".repeat(1000)) === true);
T("Long diff-length returns false", constantTimeEqual("a".repeat(1000), "a".repeat(999)) === false);

// Timing test: compare duration of same-length vs different-length comparisons
// A leaky implementation returns early on length mismatch (faster)
// A safe implementation always iterates (similar time regardless of length match)
function timeCall(fn, iterations) {
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) fn();
  return Number(process.hrtime.bigint() - start);
}

const ITER = 500000;

// Time comparisons where lengths MATCH (must iterate full length)
const sameLenTime = timeCall(() => constantTimeEqual("abcdefghijklmnop", "abcdefghijklmnop"), ITER);

// Time comparisons where lengths DIFFER (leaky impl returns early)
const diffLenShort = timeCall(() => constantTimeEqual("abcdefghijklmnop", "abc"), ITER);
const diffLenLong = timeCall(() => constantTimeEqual("abc", "abcdefghijklmnop"), ITER);

console.log(`\n  Timing (${ITER} iterations each):`);
console.log(`    Same length (16 chars):  ${sameLenTime / 1e6} ms`);
console.log(`    Diff length (16 vs 3):   ${diffLenShort / 1e6} ms`);
console.log(`    Diff length (3 vs 16):   ${diffLenLong / 1e6} ms`);

const ratioShort = sameLenTime / diffLenShort;
const ratioLong = sameLenTime / diffLenLong;

console.log(`\n  Ratio (same-length / diff-length):`);
console.log(`    vs short: ${ratioShort.toFixed(2)}x`);
console.log(`    vs long:  ${ratioLong.toFixed(2)}x`);

// A leaky impl will have ratio >> 1 (diff-length is much faster due to early return)
// A safe impl will have ratio ~1 (always iterates)
T("No significant timing leak (short diff)", ratioShort < 2.0, `ratio=${ratioShort.toFixed(2)}x — diff-length was ${(1/ratioShort).toFixed(1)}x faster`);
T("No significant timing leak (long diff)", ratioLong < 2.0, `ratio=${ratioLong.toFixed(2)}x — diff-length was ${(1/ratioLong).toFixed(1)}x faster`);

console.log(`\n=== RED-8 Result: ${pass} passed, ${fail} failed ===\n`);
