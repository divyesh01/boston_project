// Pins that an `else` branch is a conditional failure path too.
//
// `if (ok) { ... } else { process.exit(1) }` fails the run on exactly the inputs the
// condition rejects — it is the same assertion as `if (!ok) process.exit(1)`, written the
// other way round. The structural tightening of hasAssertions alternative 4 therefore
// scans else bodies as well as if bodies, and this fixture is why that is a tested
// capability rather than an untested line of code.
//
// Nothing here counts and there is no assert call, so hasAssertions comes from
// alternative 4 ALONE. Drop the else-body scan and this fixture flips to NO_ASSERTIONS.
//
// Expected verdict: VALID (hasAssertions=true, hasExitPath=true, hasSummary=true).

const cents = [100, 250, 75];
const total = cents.reduce((a, b) => a + b, 0);

if (total === 425) {
  console.log(`total=${total}`);
} else {
  console.error(`FAIL: expected 425, got ${total}`);
  process.exit(1);
}

console.log("PASSED: 1 passed, 0 failed");
