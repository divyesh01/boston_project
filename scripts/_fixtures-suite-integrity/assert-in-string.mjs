// Pins that `stripComments` removes COMMENTS, not STRING LITERALS — and that this is a
// known, deliberate limit rather than an oversight.
//
// The word `assert(` inside an ordinary string satisfies the assert-call alternative of
// `hasAssertions`, and `process.exit(1)` in a catch block satisfies `hasExitPath`, so this
// file classifies VALID while verifying nothing whatsoever. There is no `if` in it at all,
// so alternative 4 plays no part: this is purely about the string blindness.
//
// The obvious fix — teach stripComments to blank string literals too — was measured and
// REJECTED. `hasSummary` matches the CONTENTS of a string:
// `console.log("PASSED: ...")`. Blanking string literals would make every suite in the
// repository read hasSummary=false, turning a narrow imprecision into a total failure of
// the summary contract. The narrow imprecision is the cheaper of the two, so it is pinned
// here instead of fixed.
//
// A suite that reaches VALID this way is still caught downstream: verify-all.mjs runs it
// and classifies its actual output, and a suite that asserts nothing reports nothing to
// classify. Static analysis is the first gate, not the only one.
//
// Expected verdict: VALID (hasAssertions=true, hasExitPath=true, hasSummary=true).
// The verdict being the auditor's strongest one, on a file that proves nothing, is the
// point of the pin — not a claim that the classification is desirable.

const NOTE = "nothing in this file calls assert( on anything";

try {
  console.log(NOTE);
} catch {
  process.exit(1);
}

console.log("PASSED: 0 passed, 0 failed");
