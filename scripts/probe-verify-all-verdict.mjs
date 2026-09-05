// scripts/probe-verify-all-verdict.mjs — regression suite for the verdict logic
// in scripts/_verdict.mjs, which decides whether every OTHER suite is reported green.
//
// WHY THIS EXISTS. verify-all.mjs is the gate the whole repo is judged by, and until
// 2026-08-23 the one thing it could not check was itself. Three shapes were measured
// misclassified on that date, all of them the same failure mode the runner's own
// header comment says it exists to prevent — a suite reported green while verifying
// nothing:
//
//   1. A console.assert-only suite. Node prints "Assertion failed: <msg>" to stderr
//      and leaves the exit code at 0. probe-csv-data-loss.mjs then printed
//      "✓ Probe confirmed: ... is fixed" unconditionally. Neither line matches a
//      failing-summary pattern, so the runner said PASS while two of four claims
//      were false. Detected now by reading the console.assert output directly.
//   2. The four DIAGNOSTIC printers (probe-active-vs-idle, probe-idle-polling,
//      probe-session-expiry, probe-startup) assert nothing and were counted in the
//      PASS bucket, so `npm run verify:all` printed an unqualified "All green."
//      over four suites' worth of coverage that does not exist.
//   3. A Node ExperimentalWarning emitted after the DIAGNOSTIC marker displaced it
//      as the reported summary, so the verdict column showed
//      "(Use `node --trace-warnings ...` to show where the warning was created)".
//
// The cases below are output shapes measured from real suites in this repo, not
// invented ones. The three regression guards are marked. Do NOT relax a case to
// make this green: each one encodes a runner behaviour that was wrong once.

import { classifySuiteRun } from "./_verdict.mjs";

let pass = 0;
let fail = 0;
const failures = [];

function eq(label, actual, expected) {
  if (actual === expected) {
    pass += 1;
  } else {
    fail += 1;
    failures.push(`${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    console.log(`  FAIL  ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function status(label, run, expected) {
  eq(label, classifySuiteRun(run).status, expected);
}

function summary(label, run, expected) {
  eq(label, classifySuiteRun(run).summary, expected);
}

// A Node warning tail is routine in this repo: every suite touching localStorage
// emits it, and it arrives AFTER the suite's own final line.
const NODE_WARN =
  "(node:1234) ExperimentalWarning: localStorage is not available because --localstorage-file was not provided.\n" +
  "(Use `node --trace-warnings ...` to show where the warning was created)";

console.log("1. the house summary form");

status("PASSED: n passed, 0 failed + exit 0 is a pass",
  { out: "PASSED: 115 passed, 0 failed", code: 0 }, "PASS");
status("FAILED: n passed, m failed + exit 1 is a fail",
  { out: "FAILED: 113 passed, 2 failed", code: 1 }, "FAIL");
status("FAILED summary + exit 0 is a bad exit code",
  { out: "FAILED: 113 passed, 2 failed", code: 0 }, "BAD-EXIT");
status("a failing summary behind a glyph is still caught",
  { out: "✓ Probe FAILED: 1 failed", code: 0 }, "BAD-EXIT");

console.log("\n2. summary forms that predate the house form (must not be broken)");

// verify-donut-labels and verify-motion printed this for months. A bare /\bFAIL\b/
// test reports these healthy suites as failures; the numeric count has to win.
status("REGRESSION: 'PASS 728   FAIL 0' is a pass, not a failure claim",
  { out: "PASS 728   FAIL 0", code: 0 }, "PASS");
status("'PASS 726   FAIL 2' + exit 0 is a bad exit code",
  { out: "PASS 726   FAIL 2", code: 0 }, "BAD-EXIT");
// verify-actioncenter.mjs has no pass counter and prints exactly these two forms.
status("verify-actioncenter's 'PASS: all scenarios correct' is a pass",
  { out: "PASS: all scenarios correct", code: 0 }, "PASS");
status("verify-actioncenter's 'FAIL: n check(s) failed' + exit 0 is a bad exit code",
  { out: "FAIL: 2 check(s) failed", code: 0 }, "BAD-EXIT");
// probe-db-mock-rls.mjs ends with this and has no counters at all.
status("a bare success banner with no counters is a pass",
  { out: "✅ PROBE PASSED: no db shim, RLS operators canonical.", code: 0 }, "PASS");

console.log("\n3. console.assert cannot fail a process — the trap this runner exists for");

status("REGRESSION: 'Assertion failed' + unconditional success banner + exit 0 is a bad exit code",
  {
    out: "Assertion failed: revenue reconciles\n✓ Probe confirmed: csvParser data loss is fixed",
    code: 0,
  },
  "BAD-EXIT");
status("a bare 'Assertion failed' with no message is still caught",
  { out: "Assertion failed\ndone", code: 0 }, "BAD-EXIT");
status("'Assertion failed' plus a non-zero exit is an ordinary failure",
  { out: "Assertion failed: nope", code: 1 }, "FAIL");
// The word has to be at the start of a line: a suite that talks ABOUT the trap in
// its own output must not be flagged for it.
status("prose mentioning the phrase mid-line is not a failure claim",
  { out: "note: an Assertion failed line would be caught here\nPASSED: 3 passed, 0 failed", code: 0 },
  "PASS");

console.log("\n4. suites that ran but verified nothing");

status("REGRESSION: the DIAGNOSTIC marker is not a pass",
  { out: "reads config\nDIAGNOSTIC: no assertions (informational output only)", code: 0 },
  "DIAGNOSTIC");
status("a diagnostic that exits non-zero has broken its contract and is a fail",
  { out: "DIAGNOSTIC: no assertions (informational output only)", code: 1 }, "FAIL");
status("SKIP: still outranks DIAGNOSTIC when a suite prints both",
  { out: "SKIP: vite unavailable\nDIAGNOSTIC: no assertions (informational output only)", code: 0 },
  "SKIP");
status("a declined suite is a skip, not a pass",
  { out: "SKIP: needs a live dev server", code: 0 }, "SKIP");

console.log("\n5. a trailing Node warning must not become the verdict");

summary("REGRESSION: the DIAGNOSTIC marker survives a warning tail",
  { out: "DIAGNOSTIC: no assertions (informational output only)\n" + NODE_WARN, code: 0 },
  "DIAGNOSTIC: no assertions (informational output only)");
status("...and is still classified DIAGNOSTIC",
  { out: "DIAGNOSTIC: no assertions (informational output only)\n" + NODE_WARN, code: 0 },
  "DIAGNOSTIC");
summary("the house summary survives a warning tail",
  { out: "PASSED: 12 passed, 0 failed\n" + NODE_WARN, code: 0 },
  "PASSED: 12 passed, 0 failed");
status("a failing summary is still caught behind a warning tail",
  { out: "FAILED: 10 passed, 2 failed\n" + NODE_WARN, code: 0 }, "BAD-EXIT");

console.log("\n6. could not start, versus ran and failed");

status("ERR_MODULE_NOT_FOUND is broken, not failed",
  { out: "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@/lib'", code: 1 }, "BROKEN");
status("a missing export is broken",
  { out: "SyntaxError: The requested module does not provide an export named 'calculatePay'", code: 1 },
  "BROKEN");
status("a missing fixture file is broken",
  { out: "Error: ENOENT: no such file or directory, open 'fixtures/x.csv'", code: 1 }, "BROKEN");
// A killed process is a timeout regardless of what it managed to print first —
// including a partial success line, which is the shape that produced a false
// "7 broken suites" finding on 2026-08-20.
status("REGRESSION: a killed suite is a timeout, never a pass",
  { out: "PASSED: 40 passed, 0 failed", code: null, killed: true }, "TIMEOUT");
status("a killed suite is a timeout, not broken, even with a broken signature present",
  { out: "Cannot find module 'x'", code: null, killed: true }, "TIMEOUT");

console.log("\n7. progress lines must never be mistaken for the verdict");

// Nearly every suite prints "  PASS  <check name>" per assertion. An unanchored
// keyword test picks the last one of those as the summary and loses the real total.
summary("the final house summary wins over hundreds of PASS progress lines",
  { out: "  PASS  a\n  PASS  b\n  PASS  c\nPASSED: 3 passed, 0 failed", code: 0 },
  "PASSED: 3 passed, 0 failed");
summary("a suite with no summary at all falls back to its last line",
  { out: "  ok   a\n  ok   b", code: 0 }, "ok   b");
summary("no output at all is reported as such",
  { out: "", code: 0 }, "(no output)");
status("no output plus exit 0 is still only a pass by exit code",
  { out: "", code: 0 }, "PASS");

console.log("\n8. a zero count must not overrule an explicit FAILED verdict");

// Measured 2026-09-05. `summaryClaimsFailure` consulted the numeric count FIRST and
// the keyword only when no count was present. That is right for "PASS 728   FAIL 0"
// (section 2) — but a suite whose pre-flight guard fails runs zero checks and prints
// "FAILED: 0 passed, 0 failed". The count is 0, so it satisfied the count rule, the
// keyword branch was never reached, and the run was classified PASS. A line that
// OPENS with FAIL/FAILED is the suite's own verdict and outranks its counters; a line
// that opens with PASS is not, which is why "PASS 728   FAIL 0" stays a pass.
status("REGRESSION: 'FAILED: 0 passed, 0 failed' + exit 0 is a bad exit code, not a pass",
  { out: "FAILED: 0 passed, 0 failed", code: 0 }, "BAD-EXIT");
status("a bare 'FAILED' verdict with no counters at all is caught",
  { out: "checking\nFAILED", code: 0 }, "BAD-EXIT");
status("...and the same shape with a non-zero exit is an ordinary failure",
  { out: "FAILED: 0 passed, 0 failed", code: 1 }, "FAIL");
// The section-2 guard restated from the other side: the count still decides whenever
// the line does not open with the failing keyword.
status("REGRESSION: 'PASS 728   FAIL 0' is still a pass under the keyword override",
  { out: "PASS 728   FAIL 0", code: 0 }, "PASS");
status("a glyph-prefixed zero-count summary is still a pass",
  { out: "✓ PASSED: 0 passed, 0 failed", code: 0 }, "PASS");

console.log("\n9. a failure announced before the final summary must not be discarded");

// Measured 2026-09-05. The reported summary is the LAST line matching SUMMARY_LINE
// (`.pop()`), and the failure test read only that one line. Every multi-summary suite
// in scripts/ today exits immediately after printing a failing section summary — this
// was latent, not live — but that discipline is a convention, not a contract, and the
// classifier is what 149 suites are judged by. A positive failure count anywhere in a
// summary line now claims failure. Only a COUNT does: an indented "  FAIL  <name>"
// progress line carries no number and must stay invisible here, or every suite that
// demonstrates a negative case would turn red.
status("REGRESSION: a failing section summary before a passing final summary is caught",
  { out: "=== 1 ===\nFAILED: 3 passed, 2 failed\n=== 2 ===\nPASSED: 5 passed, 0 failed", code: 0 },
  "BAD-EXIT");
status("...and is an ordinary failure when the exit code agrees",
  { out: "FAILED: 3 passed, 2 failed\nPASSED: 5 passed, 0 failed", code: 1 }, "FAIL");
summary("the LAST summary is still what gets reported, so the display is unchanged",
  { out: "FAILED: 3 passed, 2 failed\nPASSED: 5 passed, 0 failed", code: 0 },
  "PASSED: 5 passed, 0 failed");
status("REGRESSION: countless '  FAIL  <name>' progress lines are not failure claims",
  { out: "  PASS  a\n  FAIL  b was expected to be rejected\n  PASS  c\nPASSED: 3 passed, 0 failed", code: 0 },
  "PASS");
status("an earlier zero-count section summary does not manufacture a failure",
  { out: "PASSED: 2 passed, 0 failed\nPASSED: 5 passed, 0 failed", code: 0 }, "PASS");

console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("\nFailures:");
  failures.forEach((f) => console.log(`  - ${f}`));
}
process.exit(fail > 0 ? 1 : 0);
