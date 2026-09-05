// The legitimate conditional-exit assertion the tightening must NOT break, shaped
// specifically to kill the naive implementations of it.
//
// A character-class adjacency regex — `if\s*\([^)]*\)\s*(?:\{[^{}]*)?process\.exit` — is
// the obvious way to require that the exit belongs to the conditional, and it is wrong
// twice over on this file:
//
//   [^)]*   cannot cross the `)` that closes `r.cents !== "number")` inside the condition,
//           so the condition never finishes matching;
//   [^{}]*  cannot cross the `{ ... }` of the nested for-loop body, so the exit is
//           unreachable even if the condition did match.
//
// Both failures point the same way: they would flip this file to hasAssertions=false and
// call a suite that genuinely fails on bad input NO_ASSERTIONS. That is why the auditor
// scans balanced parens and braces instead of using a character class. The first draft of
// the tightening was rejected against conditional-exit-assertion.mjs for exactly the first
// reason; this fixture adds the second so the mistake cannot come back in the other form.
//
// Nothing here counts, and there is no assert call: hasAssertions comes from alternative 4
// ALONE, which is what makes this a real test of it.
//
// Expected verdict: VALID (hasAssertions=true, hasExitPath=true, hasSummary=true).

const rows = [{ cents: 100 }, { cents: 250 }];

if (rows.length !== 2 || rows.some((r) => typeof r.cents !== "number")) {
  for (const r of rows) {
    console.error(`  bad row: ${JSON.stringify(r)}`);
  }
  process.exit(1);
}

let total = 0;
for (const r of rows) {
  total += r.cents;
}

console.log(`total=${total}`);
console.log("PASSED: 1 passed, 0 failed");
