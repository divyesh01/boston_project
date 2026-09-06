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

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
// CHANGED 2026-09-05 (F-075). This case read "a bare success banner with no counters
// is a pass", citing probe-db-mock-rls.mjs as a suite that "ends with this and has no
// counters at all". Measured against that suite's real output, the second clause is
// false — it prints
//
//   PASSED: 22 passed, 0 failed
//   ✅ PROBE PASSED: no db shim, no shim call sites, RLS operators canonical, ...
//
// so the counter line is what speaks for it and the banner is decoration. No suite in
// the tree (measured: 150 of 150) states its result with a glyph-prefixed banner
// ALONE, so accepting one as a verdict buys nothing and costs the exact false green
// section 3 exists to catch: "✅ PROBE PASSED" printed unconditionally is
// indistinguishable from a real pass, while a counter or an anchored PASSED/FAILED is
// not. A suite whose entire output is a banner must say so in a form the harness can
// hold it to.
status("a glyph-prefixed banner alone is not a verdict the harness will accept",
  { out: "✅ PROBE PASSED: no db shim, RLS operators canonical.", code: 0 }, "NO-VERDICT");
status("...and the same banner above a counter line is a pass, which is the real suite",
  { out: "PASSED: 22 passed, 0 failed\n✅ PROBE PASSED: no db shim, RLS canonical.", code: 0 },
  "PASS");

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
// CHANGED 2026-09-05 (F-074/F-075). This case expected PASS, which was the
// fallthrough written down as a contract: a process that exited 0 having stated no
// result at all counted as a verified suite. The summary expectations above are
// unchanged — the display still falls back the same way — only the verdict is no
// longer green. See section 10.
status("no output plus exit 0 states no result, so it is not a pass",
  { out: "", code: 0 }, "NO-VERDICT");

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

console.log("\n10. exit 0 with no verdict at all is not a pass");

// Measured 2026-09-05 — F-074. scripts/verify-statistics.mjs guards its 84
// assertions on a fixture that .gitignore keeps out of the repository
// (`:69 *.csv`), so in every fresh clone and in CI it takes its absent-fixture
// branch, prints the paragraph below and exits 0. The paragraph contains no
// verdict-shaped line, so `summaryLines` was empty, the display fell back to the
// LAST line — literally the instruction for how to make the suite run — and the
// ladder promoted it on its exit code. The sweep printed:
//
//   PASS  0.2s  verify-statistics.mjs  Set STATS_FILE=/path/to/... to run it
//   1 suite(s): 1 passed, ... 0 skipped, 0 diagnostic
//   All green.
//
// Two defects in one row, and this section pins the classifier half: the suite's
// own one-character slip (it printed "SKIP " where :134 requires "SKIP:") must not
// be the only thing standing between zero assertions and a green run.
const NO_FIXTURE =
  "SKIP verify-statistics: no statistics fixture found.\n" +
  "  Looked for: C:/repo/scripts/data/Hotel Statistics (1).csv\n" +
  "  Set STATS_FILE=/path/to/'Hotel Statistics.csv' or drop the file in scripts/data/ to run it.";

status("REGRESSION: a suite that exits 0 stating no result is not a pass",
  { out: NO_FIXTURE, code: 0 }, "NO-VERDICT");
summary("...and the display still shows its last line, so nothing is hidden",
  { out: NO_FIXTURE, code: 0 },
  "Set STATS_FILE=/path/to/'Hotel Statistics.csv' or drop the file in scripts/data/ to run it.");
// The one-character difference that separates an honest decline from a silent one.
// This pair is the whole finding: same intent, same exit code, opposite trust.
status("the same decline written to contract IS a skip",
  { out: "SKIP: verify-statistics — no statistics fixture found.", code: 0 }, "SKIP");
status("progress output with no verdict line is not a pass either",
  { out: "  ok   parsed 12 rows\n  ok   totals reconcile", code: 0 }, "NO-VERDICT");
// The floor is deliberately narrow. Every other state must still win, or a new
// bucket would swallow the ones that already work.
status("a non-zero exit with no verdict stays an ordinary failure, not NO-VERDICT",
  { out: "  ok   a\n  ok   b", code: 1 }, "FAIL");
status("a killed suite with no verdict is still a timeout",
  { out: "  ok   a", code: null, killed: true }, "TIMEOUT");
status("a declared DIAGNOSTIC still outranks the floor",
  { out: "reads config\nDIAGNOSTIC: no assertions (informational output only)", code: 0 },
  "DIAGNOSTIC");
status("a broken import with no verdict is still BROKEN",
  { out: "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'x'", code: 1 }, "BROKEN");
// A trimmed "  PASS  <check>" progress line DOES match SUMMARY_LINE (lines are
// trimmed before the anchor is applied), so a suite mid-run has stated something
// verdict-shaped and the floor must not fire on it.
status("a suite whose only verdict-shaped line is a PASS progress line is unaffected",
  { out: "  PASS  a\n  ok   b", code: 0 }, "PASS");

console.log("\n11. a suite that declined PART of its work (F-077/F-078)");

// WHY. SKIP was a whole-suite word, and the classifier had no way to say
// "it ran, and some of it didn't". So both halves of a partial run were reported
// wrongly, in opposite directions, and the repository contained live examples of
// each — measured 2026-09-05 across all 150 discovered suites:
//
//   F-078, the loud half. probe-validation-gaps.mjs:259 prints an indented
//   "  SKIP: fixture not found at ..." for ONE of its sections and then runs and
//   reports the rest ("PASSED: 56 passed, 0 failed"). Lines are trimmed before
//   /^SKIP:/i is applied (_verdict.mjs:50), so `skipped` fired on a section-scoped
//   line and the whole suite was reported SKIP — 56 real assertions filed as zero
//   coverage. On a fresh clone that is the ONLY shape this suite has, because the
//   fixture it wants is a *.csv .gitignore keeps out of the repo.
//
//   F-077, the silent half. probe-sri-integrity.mjs:160,:170 and
//   verify-coexistence.mjs:129 print "  SKIP  <why>" / "SKIP statistics half:" —
//   no colon in the anchored position — which matches nothing at all. Those suites
//   reported unqualified green with sections that never ran.
//
// The discriminator is a fact about the run, not a promise the suite makes: a suite
// that stated a verdict RAN, so its SKIP lines can only be section-scoped. One that
// stated no verdict declined as a whole. That is why no new "PARTIAL:" token was
// introduced — a second token is a second thing for an author to get wrong, and the
// six honest whole-suite declines in this repo (probe-build-chunks:72,:100,
// probe-config-exposure:99,:131, verify-harness:74, verify-statistics:69) all
// terminate before printing a counter, so the rule reclassifies none of them.
function partial(label, run, expected) {
  eq(label, JSON.stringify(classifySuiteRun(run).partial ?? null), JSON.stringify(expected));
}

// The measured probe-validation-gaps.mjs shape, verbatim in structure.
const PART_RUN =
  "  SKIP: fixture not found at C:/repo/scripts/data/Occupancy Summary midelboro.csv\n" +
  "  PASS  rejects a row with no date\n" +
  "PASSED: 56 passed, 0 failed";

status("REGRESSION: a suite that declined one section and passed the rest is a PASS",
  { out: PART_RUN, code: 0 }, "PASS");
partial("...and the section it declined is carried, not swallowed",
  { out: PART_RUN, code: 0 },
  ["SKIP: fixture not found at C:/repo/scripts/data/Occupancy Summary midelboro.csv"]);
summary("...and its own counter is what the reader is shown",
  { out: PART_RUN, code: 0 }, "PASSED: 56 passed, 0 failed");

// The six whole-suite declines must be untouched by the tightening. Both real
// shapes, including the multi-line paragraph verify-statistics.mjs:69 now prints.
status("GUARD: a whole-suite decline that states no verdict is still SKIP",
  { out: "SKIP: no dist/ to read — run `npm run build` first.\n" +
         "      Reported as SKIP rather than PASS: an artifact that does not exist\n" +
         "      cannot be shown to be free of the defects above.", code: 0 }, "SKIP");
partial("...and it reports no declined SECTIONS, because the whole suite declined",
  { out: "SKIP: no dist/ to read — run `npm run build` first.", code: 0 }, []);
status("GUARD: the multi-line fixture decline is still a whole-suite SKIP",
  { out: "SKIP: verify-statistics — no statistics fixture found, so none of its 84 checks ran.\n" +
         "  Looked for: C:/repo/scripts/data/Hotel Statistics (1).csv\n" +
         "  The file is git-ignored on purpose (real guest data).", code: 0 }, "SKIP");

// The DIAGNOSTIC marker is inside SUMMARY_LINE (_verdict.mjs:38-39) for a display
// reason, but "I assert nothing" is the opposite of stating a verdict. If the
// discriminator counted it, this pair — a real shape, verify-harness.mjs's vite
// decline landing next to a diagnostic printer's marker — would have been demoted
// from SKIP to "ran, with a declined section", which is false twice over. Section 6
// pins the ranking; these two pin the reason the ranking survives the tightening.
status("GUARD: SKIP + DIAGNOSTIC is still a whole-suite SKIP, not a partial",
  { out: "SKIP: vite unavailable\nDIAGNOSTIC: no assertions (informational output only)", code: 0 },
  "SKIP");
partial("...and a diagnostic marker does not turn its decline into a section",
  { out: "SKIP: vite unavailable\nDIAGNOSTIC: no assertions (informational output only)", code: 0 },
  []);

// The colon is load-bearing in both directions. This is the F-077 mechanism kept
// visible: fixing the three suites was necessary precisely BECAUSE the classifier
// cannot infer intent from prose.
status("a decline written without the colon is invisible, and the suite reads green",
  { out: "  SKIP  node_modules/vite not installed\nPASSED: 3 passed, 0 failed", code: 0 }, "PASS");
partial("...and nothing is reported as declined, which is why those suites were edited",
  { out: "  SKIP  node_modules/vite not installed\nPASSED: 3 passed, 0 failed", code: 0 }, []);

// Two sections declining in one run: probe-sri-integrity.mjs's real shape once its
// two lines are written to contract. Order is the order the reader saw them.
partial("every declined section is listed, in the order printed",
  { out: "  SKIP: node_modules/vite not installed — upstream hazard not inspected\n" +
         "  SKIP: dist/index.html not present — run `npm run build` to gate the artifact too\n" +
         "PASSED: 21 passed, 0 failed", code: 0 },
  ["SKIP: node_modules/vite not installed — upstream hazard not inspected",
   "SKIP: dist/index.html not present — run `npm run build` to gate the artifact too"]);

// A decline must never soften a result. The suite failed; that it also skipped a
// section is extra information, not mitigation.
status("a declined section does not launder a failing run",
  { out: "  SKIP: half of it\nFAILED: 1 passed, 2 failed", code: 1 }, "FAIL");
partial("...and the failing run still names what it skipped",
  { out: "  SKIP: half of it\nFAILED: 1 passed, 2 failed", code: 1 }, ["SKIP: half of it"]);

// A suite with no declines at all must not grow an empty caveat.
partial("an ordinary green suite reports no declined sections",
  { out: "PASSED: 115 passed, 0 failed", code: 0 }, []);

console.log("\n12. verify-all discovery and --only must select the intended suites (F-080/F-082)");

// `--only` was documented in the troubleshooting ledger but not parsed by the
// runner. Every spelling therefore fell through to an ordinary full --list, and
// even a typo exited 0 after listing every suite. Use --list for the selection
// contract so this regression test can never recursively execute child suites.
const VERIFY_ALL = fileURLToPath(new URL("./verify-all.mjs", import.meta.url));
const runList = (...args) => spawnSync(process.execPath, [VERIFY_ALL, "--list", ...args], {
  encoding: "utf8",
});
const selectedSuites = (stdout) => {
  const beforeExcluded = stdout.split(/\r?\nnot run \(/)[0];
  return beforeExcluded.split(/\r?\n/)
    .map((line) => /^  ((?:probe-|verify-|test_).+\.mjs)$/.exec(line)?.[1])
    .filter(Boolean);
};
const TARGET = "probe-active-vs-idle.mjs";
const STEM = TARGET.replace(/\.mjs$/, "");

const baselineList = runList();
eq("GUARD: default --list still exits 0", baselineList.status, 0);
const baselineSuites = selectedSuites(baselineList.stdout);
eq("GUARD: default --list discovers more than the targeted suite", baselineSuites.length > 1, true);
const baselineListId = /list ([0-9a-f]{8}) \((\d+) discovered\)/.exec(baselineList.stdout)?.[0];
eq("GUARD: default --list states its full-list identity", Boolean(baselineListId), true);

// `test_` is the oldest of the three supported suite-name conventions. It cannot
// share the runner's predicate here: comparing a predicate with itself would make
// the oracle circular. Derive the expected names independently from the directory,
// then compare them with the runner's black-box --list. This grows automatically
// when an honest test_ suite is added and never pins the repository's total count.
const expectedTestUnderscoreSuites = readdirSync(fileURLToPath(new URL(".", import.meta.url)))
  .filter((file) => /^test_.+\.mjs$/.test(file))
  .sort();
eq("GUARD: the test_ convention is non-vacuous in this repository", expectedTestUnderscoreSuites.length > 0, true);
const missingTestUnderscoreSuites = expectedTestUnderscoreSuites.filter((file) => !baselineSuites.includes(file));
eq("REGRESSION: verify-all discovers every test_ suite present on disk", JSON.stringify(missingTestUnderscoreSuites), "[]");

for (const [label, args] of [
  ["exact filename", ["--only", TARGET]],
  ["extensionless basename", ["--only", STEM]],
  ["scripts/ prefix", ["--only", `scripts/${TARGET}`]],
  ["Windows scripts\\ prefix", ["--only", `scripts\\${TARGET}`]],
  ["equals form", [`--only=${TARGET}`]],
]) {
  const result = runList(...args);
  eq(`${label} exits 0`, result.status, 0);
  eq(`${label} selects exactly the requested suite`, JSON.stringify(selectedSuites(result.stdout)), JSON.stringify([TARGET]));
  eq(`${label} discloses targeted mode`, result.stdout.includes(`[only ${TARGET}]`), true);
  eq(`${label} preserves the full-list identity`, result.stdout.includes(baselineListId), true);
}

for (const [label, args, message] of [
  ["nonexistent target", ["--only", "probe-does-not-exist.mjs"], /not (?:a )?discovered suite/i],
  ["substring target", ["--only", "probe-active"], /not (?:a )?discovered suite/i],
  ["traversal", ["--only", `../scripts/${TARGET}`], /invalid --only target/i],
  ["absolute path", ["--only", `C:\\tmp\\${TARGET}`], /invalid --only target/i],
  ["missing value", ["--only"], /--only requires/i],
  ["flag theft", ["--only", "--json"], /--only requires/i],
  ["repeated flag", ["--only", TARGET, "--only", TARGET], /only.*once/i],
  ["filter conflict", ["--only", TARGET, "--filter", "active"], /cannot combine --only/i],
  ["shard conflict", ["--only", TARGET, "--shard", "1\/2"], /cannot combine --only/i],
  ["excluded runner", ["--only", "verify-all.mjs"], /excluded/i],
]) {
  const result = runList(...args);
  eq(`${label} exits non-zero`, result.status === 0, false);
  eq(`${label} explains the rejection on stderr`, message.test(result.stderr), true);
}

const jsonRun = spawnSync(process.execPath, [VERIFY_ALL, "--only", "probe-ci-node-version", "--json", "--timeout", "30"], {
  encoding: "utf8",
});
eq("targeted JSON run exits 0", jsonRun.status, 0);
const targetedJson = JSON.parse(jsonRun.stdout);
eq("targeted JSON names its mode", targetedJson.mode, "only");
eq("targeted JSON declares that it is partial", targetedJson.isPartialRun, true);
eq("targeted JSON preserves what the caller requested", targetedJson.targetRequested, "probe-ci-node-version");
eq("targeted JSON names the canonical match", targetedJson.targetMatched, "probe-ci-node-version.mjs");
eq("targeted JSON counts one selected suite", targetedJson.selectedTotal, 1);
eq("targeted JSON counts one executed suite", targetedJson.total, 1);
eq("targeted JSON keeps the full discovery identity", targetedJson.fullSuiteListId, baselineListId?.split(" ")[1]);

console.log("\n13. value-taking runner flags must fail closed (F-083)");

for (const [label, args, flagName] of [
  ["filter missing value", ["--filter"], "--filter"],
  ["filter empty value", ["--filter", ""], "--filter"],
  ["filter flag theft", ["--filter", "--shard", "1/2"], "--filter"],
  ["shard missing value", ["--shard"], "--shard"],
  ["shard empty value", ["--shard", ""], "--shard"],
  ["shard flag theft", ["--shard", "--filter", "active"], "--shard"],
  ["timeout missing value", ["--timeout"], "--timeout"],
  ["timeout empty value", ["--timeout", ""], "--timeout"],
  ["timeout flag theft", ["--timeout", "--filter", "active"], "--timeout"],
  ["timeout non-number", ["--timeout", "nope"], "--timeout"],
  ["timeout zero", ["--timeout", "0"], "--timeout"],
  ["timeout negative", ["--timeout", "-1"], "--timeout"],
  ["timeout infinite", ["--timeout", "Infinity"], "--timeout"],
  ["timeout overflow", ["--timeout", "2147484"], "--timeout"],
]) {
  const result = runList(...args);
  eq(`${label} exits non-zero`, result.status === 0, false);
  eq(`${label} names the invalid option`, result.stderr.includes(flagName), true);
  eq(`${label} aborts before listing suites`, selectedSuites(result.stdout).length, 0);
}

const equalsFilter = runList("--filter=active-vs-idle");
eq("filter equals form exits 0", equalsFilter.status, 0);
eq("filter equals form narrows instead of running everything", JSON.stringify(selectedSuites(equalsFilter.stdout)), JSON.stringify([TARGET]));
const equalsShard = runList(`--shard=1/${baselineSuites.length}`);
eq("shard equals form exits 0", equalsShard.status, 0);
eq("shard equals form narrows instead of running everything", selectedSuites(equalsShard.stdout).length, 1);
const equalsTimeout = runList("--timeout=30");
eq("timeout equals form exits 0", equalsTimeout.status, 0);
eq("timeout equals form preserves the planned suite set", selectedSuites(equalsTimeout.stdout).length, baselineSuites.length);
const duplicateFilter = runList("--filter", "does-not-exist", "--filter", "active-vs-idle");
eq("a later filter value overrides an earlier wrapper default", duplicateFilter.status, 0);
eq("the last filter value decides the selection", JSON.stringify(selectedSuites(duplicateFilter.stdout)), JSON.stringify([TARGET]));

const postList = runList();
eq("GUARD: targeted attempts do not mutate default --list output", postList.stdout, baselineList.stdout);

console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("\nFailures:");
  failures.forEach((f) => console.log(`  - ${f}`));
}
process.exit(fail > 0 ? 1 : 0);
