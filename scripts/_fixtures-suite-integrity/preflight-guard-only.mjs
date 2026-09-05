// Pins the imprecision probe-suite-integrity.mjs documents and deliberately ACCEPTS, so
// that it stays a dated tested contract instead of drifting into an unexamined bug.
//
// The header at scripts/probe-suite-integrity.mjs (KNOWN IMPRECISION) says the
// conditional-exit alternative "cannot distinguish a check of the SUBJECT from an
// environment pre-flight guard such as `if (!existsSync(fixture)) process.exit(1)`, so a
// suite whose only conditional exit is a pre-flight guard reads as having assertions."
//
// This file IS that shape. The guard's exit is structurally adjacent to its condition, so
// requiring adjacency does not and must not change the answer: it still reads
// hasAssertions=true while verifying nothing about the fixture's contents. The auditor
// answers "can anything here fail the run", not "does it verify the right thing", and no
// static pattern can answer the second — the DIAGNOSTIC marker and verify-all's
// DIAGNOSTIC bucket are what cover the rest.
//
// If a future change ever makes this fixture read NO_ASSERTIONS, that is not a regression
// to revert blindly: it means someone found a way to tell a subject check from an
// environment guard, and the header comment, this fixture and the expected verdict should
// all be updated together.
//
// Expected verdict: VALID (hasAssertions=true, hasExitPath=true, hasSummary=true).

import { existsSync } from "node:fs";

const FIXTURE = "scripts/_fixtures-suite-integrity/compliant.mjs";

if (!existsSync(FIXTURE)) {
  console.error("FAIL: fixture missing");
  process.exit(1);
}

console.log("read the fixture path, checked nothing about its contents");
console.log("PASSED: 0 passed, 0 failed");
