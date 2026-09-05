// scripts/_verdict.mjs — the verdict logic for scripts/verify-all.mjs.
//
// WHY THIS IS ITS OWN FILE. This code decides whether a suite is reported as
// green. It was inline in verify-all.mjs, where nothing could test it: the
// runner discovers `probe-*.mjs` / `verify-*.mjs` in its own directory, so a
// fixture suite cannot be handed to it without joining the real suite list and
// changing the run's fingerprint. The classifier that gates every other suite
// was therefore the one piece of the harness with no fail path of its own.
//
// Leading `_` keeps this file out of BOTH discovery walks (verify-all.mjs's
// `isSuite` and probe-suite-integrity.mjs's audit), so extracting it does not
// change any suite count. Its regression suite is scripts/probe-verify-all-verdict.mjs.

// Signatures of a suite that could not start, as opposed to one that ran and
// failed. Kept explicit so a new import-time failure mode has to be added here
// deliberately rather than being quietly counted as a normal test failure.
export const BROKEN_SIGNATURES = [
  /ERR_MODULE_NOT_FOUND/,
  /does not provide an export named/,
  /Cannot find module/,
  /ERR_UNSUPPORTED_DIR_IMPORT/,
  /SyntaxError/,
  /ENOENT: no such file or directory/,
];

// A suite that asserts nothing declares it, at column 0, with this exact marker.
// It is not a pass: it verified no behaviour. See the DIAGNOSTIC branch below.
const DIAGNOSTIC_MARKER = /^DIAGNOSTIC:\s*no assertions\b/i;

// Node's console.assert prints "Assertion failed" / "Assertion failed: <msg>"
// to stderr and does NOT set a non-zero exit code. See the CONSOLE.ASSERT note.
const CONSOLE_ASSERT_FAILURE = /^Assertion failed\b/i;

// Lines a suite prints as its verdict. The first alternative is anchored because
// an unanchored /\bPASS\b/ matches every "  PASS  <check name>" progress line;
// the others are deliberately unanchored so that a glyph-prefixed summary
// ("✓ Probe FAILED: 1 failed") is still located.
const SUMMARY_LINE =
  /^(PASS|FAIL|PASSED|FAILED)\b|passed,\s*\d+\s*failed|all scenarios correct|^DIAGNOSTIC:\s*no assertions\b/i;

/**
 * Classify one finished suite process.
 *
 * @param {{ out: string, code: number|null, killed?: boolean }} run
 * @returns {{ status: "TIMEOUT"|"BROKEN"|"BAD-EXIT"|"SKIP"|"DIAGNOSTIC"|"PASS"|"FAIL", summary: string }}
 */
export function classifySuiteRun({ out, code, killed = false }) {
  const broken = !killed && code !== 0 && BROKEN_SIGNATURES.some((re) => re.test(out));

  const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);

  // Prefer the suite's own summary line for the one-line report.
  //
  // The DIAGNOSTIC marker is in SUMMARY_LINE for a measured reason: without it
  // the marker is only reported by the `lines[lines.length - 1]` fallback, so a
  // suite that emits a Node warning after its marker — ExperimentalWarning for
  // localStorage is routine in this repo — reports
  // "(Use `node --trace-warnings ...` to show where the warning was created)"
  // as its verdict. The runner then shows a warning where the reader looks for
  // a result.
  const summaryLines = lines.filter((l) => SUMMARY_LINE.test(l));

  const summary =
    summaryLines[summaryLines.length - 1]
    || lines[lines.length - 1]
    || "(no output)";

  // A suite that prints a failing summary but exits 0 is itself a defect — the
  // console.assert trap. Catch it here so it can never pass unnoticed again.
  //
  // The COUNT matters, not the word. Several suites end with
  // "PASS 728   FAIL 0", and a bare /\bFAIL\b/ test reports those healthy
  // suites as broken. A runner that cries wolf gets ignored, which costs more
  // than the check saves — so a numeric count wins over the keyword whenever
  // one is present, and the keyword only decides when there is no number.
  //
  // ...with one exception, measured 2026-09-05: a line that OPENS with
  // FAIL/FAILED is the suite's own verdict, and it outranks its own counters. A
  // pre-flight guard that fails runs zero checks and prints
  // "FAILED: 0 passed, 0 failed"; the count rule was satisfied by that 0, the
  // keyword branch was never reached, and the run was classified PASS. The
  // asymmetry is what keeps "PASS 728   FAIL 0" green: that line opens with
  // PASS, so only its counters speak for it.
  const failureCount = (line) => {
    const m =
      line.match(/(\d+)\s*(?:check\(s\)\s*)?failed/i) ||
      line.match(/\bFAIL(?:ED)?[:\s]+(\d+)\b/i);
    return m ? Number(m[1]) : null;
  };

  // EVERY summary line is read for a positive count, not just the reported one.
  // The report is still the LAST one (`summary` above), because that is what a
  // reader wants to see — but a suite that announces "FAILED: 3 passed, 2
  // failed" for section 1 and "PASSED: 5 passed, 0 failed" for section 2, then
  // exits 0, had its section-1 failure discarded by the `.pop()`. Measured
  // 2026-09-05: every multi-summary suite in scripts/ exits immediately after
  // printing a failing section summary, so this was latent rather than live —
  // but that discipline is a convention, not a contract, and this classifier is
  // what all 149 discovered suites are judged by.
  //
  // Only a COUNT is read across lines. Nearly every suite prints indented
  // "  FAIL  <check name>" progress lines — including the ones that
  // deliberately demonstrate a rejected input — and those carry no number, so
  // they stay invisible here. Applying the keyword rule across every line
  // instead would turn those suites red for doing their job.
  const summaryClaimsFailure =
    /^\s*(FAIL|FAILED)\b/i.test(summary)
    || (failureCount(summary) ?? 0) > 0
    || summaryLines.some((l) => (failureCount(l) ?? 0) > 0);

  // CONSOLE.ASSERT. The summary line alone cannot catch the exact trap named in
  // this runner's header comment. probe-csv-data-loss.mjs asserted with
  // console.assert — which prints "Assertion failed: <msg>" to stderr and leaves
  // the exit code at 0 — and then printed "✓ Probe confirmed: ... is fixed"
  // unconditionally. Neither line matches a failing-summary pattern, so the run
  // was reported PASS while two of its four claims were false. Reading the
  // console.assert output directly is what makes that shape detectable, rather
  // than trusting a suite to describe its own failure.
  //
  // Measured 2026-08-23: zero suites emit this string on a green run, and zero
  // live console.assert calls remain in scripts/ (the five grep hits are all in
  // comments), so this rule flags nothing that is currently healthy.
  const assertionFailed = lines.some((l) => CONSOLE_ASSERT_FAILURE.test(l));

  const lyingExitCode = code === 0 && (summaryClaimsFailure || assertionFailed);

  // A suite may legitimately decline to run: verify-harness.mjs and
  // probe-import.mjs need vite (whose rollup native binding is absent when
  // node_modules was installed for another platform), and
  // probe-config-exposure.mjs needs a live dev server. Reporting those as
  // FAIL trains the reader to ignore red, and reporting them as PASS claims
  // coverage that does not exist. They print a line starting with "SKIP:" and
  // exit 0; this is the only way to be counted as skipped.
  const skipLine = lines.find((l) => /^SKIP:/i.test(l));
  const skipped = code === 0 && !!skipLine;

  // DIAGNOSTIC. Four suites (probe-active-vs-idle, probe-idle-polling,
  // probe-session-expiry, probe-startup) print state for a human to read and
  // assert nothing. Before 2026-08-23 they were counted in the PASS bucket and
  // the run said "All green." — four suites' worth of coverage that does not
  // exist. Same reasoning as SKIP: name it, and keep it out of the pass count.
  // A diagnostic that exits non-zero has broken its own contract and falls
  // through to FAIL.
  const diagnostic = code === 0 && lines.some((l) => DIAGNOSTIC_MARKER.test(l));

  const status = killed ? "TIMEOUT"
    : broken ? "BROKEN"
    : lyingExitCode ? "BAD-EXIT"
    : skipped ? "SKIP"
    : diagnostic ? "DIAGNOSTIC"
    : code === 0 ? "PASS"
    : "FAIL";

  return { status, summary: skipped ? skipLine : summary };
}
