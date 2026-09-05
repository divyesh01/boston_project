// THE EVASION this fixture exists to catch. Measured 2026-09-05.
//
// `hasAssertions` alternative 4 in probe-suite-integrity.mjs used to be two INDEPENDENT
// existence tests over the whole file — "is there an `if` anywhere" AND "is there a
// non-zero exit anywhere" — with no structural relationship required between them. This
// file satisfies both and verifies nothing at all:
//
//   the `if`   -> an argv convenience check that only changes logging
//   the exit   -> inside a `bail()` helper that is never called
//
// It has a summary line, so under the loose rule it classified VALID: the auditor's
// strongest verdict, awarded to a file where no input can ever fail the run. That is the
// exact false-green this whole probe exists to prevent, sitting inside the probe itself.
//
// Expected verdict: NO_ASSERTIONS (hasAssertions=false, hasExitPath=true, hasSummary=true).
// hasExitPath is correctly true — the process CAN exit non-zero if anything ever calls
// bail(). "Can exit" and "can fail on its subject" are different questions and this
// fixture pins the difference from the other side to conditional-exit-assertion.mjs.

const args = process.argv.slice(2);
if (args.includes("--verbose")) {
  console.log("verbose mode");
}

function bail(msg) {
  console.error(msg);
  process.exit(1);
}

const rows = [1, 2, 3];
console.log(`scanned ${rows.length} rows`);
console.log("PASSED: 0 passed, 0 failed");
