// scripts/probe-suite-integrity.mjs
// Static analysis gate for test/probe suites.
// Enforces summary contract, exit path, and assertions without vacuous matching.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(SCRIPTS_DIR, '_fixtures-suite-integrity');

// Suite discovery. MUST stay in step with `isSuite` in scripts/verify-all.mjs — a file
// this auditor cannot see is a file whose summary contract nobody enforces, and a file
// verify-all cannot see is a file nobody runs. `test_` (underscore, not dash) was added
// 2026-08-23: seven long-standing suites used that older convention and were invisible
// to both walks. Defined once because the predicate was duplicated at two call sites
// below and the two copies are exactly the kind of thing that drifts apart.
const SUITE_PREFIXES = ['probe-', 'verify-', 'test_'];
const NOT_A_SUITE = new Set([
  'verify-all.mjs',              // the runner
  'verify-brain.mjs',            // documentation gate
  'probe-suite-integrity.mjs',   // this file
]);
// Deliberately absent: probe-auth-hardening.mjs. Until 2026-09-05 this set held
// 'probe-auth-hardening-world.mjs' — a file that has never existed — labelled a fixture
// library. Pointing that name at the real file drops 1,037 lines of production-auth assertions
// out of the audited set: MEASURED 2026-09-05 on a temporary copy, "Total suites checked" went
// 153 -> 152, the name disappeared from the report entirely, and the audit still printed
// PASSED and exited 0. The full reasoning is recorded once, at the end of EXCLUDE in
// scripts/verify-all.mjs. MUST_REMAIN_AUDITED in runTreeAudit() is what makes a repeat loud.
const isSuiteFile = (f) =>
  f.endsWith('.mjs') && SUITE_PREFIXES.some((p) => f.startsWith(p)) && !NOT_A_SUITE.has(f);

export function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^\\:])\/\/.*$/gm, '$1');
}

/** A non-zero exit, in either of the two idioms this repo's suites use. */
const EXIT_NONZERO = /\bprocess\.exit\s*\(\s*[1-9]|\bprocess\.exitCode\s*=\s*[1-9]/m;

/**
 * Every statement governed by an `if (...)` in `src` — its body, and any `else` body
 * attached to it — returned as source substrings.
 *
 * WHY A SCANNER AND NOT A REGEX. This exists so `hasAssertions` can ask whether a
 * non-zero exit belongs to a conditional, rather than merely whether both appear
 * somewhere in the same file. Every character-class spelling of that question is wrong
 * on code this repository actually contains, and both spellings were tried and rejected
 * against real fixtures before this was written:
 *
 *   `if\s*\([^)]*\)`      breaks on a call inside the condition. `[^)]*` stops at the `)`
 *                         closing `startsWith("__Host-")`, so conditional-exit-assertion.mjs
 *                         stops matching and a genuine assertion reads as none.
 *   `\{[^{}]*process\.exit` breaks on a nested block. nested-block-exit.mjs puts a
 *                         `for (...) { ... }` between the condition and the exit.
 *
 * A bounded character window (`[\s\S]{0,400}?`) reopens the same hole in fuzzier form:
 * it re-admits an exit that merely happens to sit near an unrelated `if`.
 *
 * KNOWN LIMIT, stated rather than hidden: `stripComments` removes comments, not string
 * literals, so a string containing an unbalanced `(`, `)`, `{` or `}` can skew the scan
 * for the rest of the file. Blanking string literals is not available as a fix — the
 * summary patterns above match on string CONTENTS (`console.log("PASSED: ...")`), so
 * blanking them would make every suite in the repository read hasSummary=false.
 * scripts/_fixtures-suite-integrity/assert-in-string.mjs pins that trade.
 */
export function conditionalBodies(src) {
  const bodies = [];
  const skipSpace = (i) => {
    let j = i;
    while (j < src.length && /\s/.test(src[j])) j += 1;
    return j;
  };
  // The index of the delimiter closing the one at `i`, or -1 if it never closes.
  const balanced = (i, open, close) => {
    let depth = 0;
    for (let j = i; j < src.length; j += 1) {
      if (src[j] === open) depth += 1;
      else if (src[j] === close) {
        depth -= 1;
        if (depth === 0) return j;
      }
    }
    return -1;
  };
  // The statement beginning at `i`: a braced block, or everything up to its `;` for the
  // brace-less `if (bad) process.exit(1);` form.
  const statement = (i) => {
    const start = skipSpace(i);
    if (src[start] === '{') {
      const close = balanced(start, '{', '}');
      const end = close < 0 ? src.length : close + 1;
      return { text: src.slice(start, end), end };
    }
    const semi = src.indexOf(';', start);
    const end = semi < 0 ? Math.min(src.length, start + 200) : semi + 1;
    return { text: src.slice(start, end), end };
  };

  const re = /\bif\s*\(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const condEnd = balanced(m.index + m[0].length - 1, '(', ')');
    if (condEnd < 0) continue;
    const body = statement(condEnd + 1);
    bodies.push(body.text);
    // An `else` body is a conditional failure path too: `if (ok) {...} else process.exit(1)`
    // fails on exactly the inputs the condition rejects. `else if` is skipped because this
    // loop reaches that `if (` on its own and reads its real body.
    const after = skipSpace(body.end);
    if (src.startsWith('else', after) && !/\w/.test(src[after + 4] ?? '')) {
      const rest = skipSpace(after + 4);
      if (!src.startsWith('if', rest)) bodies.push(statement(rest).text);
    }
  }
  return bodies;
}

export function classifySuite(filePath, rawContent) {
  const noComments = stripComments(rawContent);

  // Diagnostic marker: console.log/info printing literal beginning with DIAGNOSTIC: no assertions
  const isDiagnostic = /console\.(?:log|info)\s*\(\s*[`'"]\s*DIAGNOSTIC:\s*no assertions/m.test(noComments);

  // Summary contract:
  // (a) Literal PASSED: or FAILED:
  // (b) Ternary: ${... ? "PASSED" : "FAILED"} or ${... ? "FAILED" : "PASSED"}
  // Must be anchored at start of printed line in console.log/error/info
  const ternaryToken = '\\$\\{\\s*[^}]*\\?\\s*["\'`](?:PASSED|FAILED)["\'`]\\s*:\\s*["\'`](?:FAILED|PASSED)["\'`]\\s*\\}';
  const tokenPattern = `(?:PASSED:|FAILED:|${ternaryToken}:?)`;

  const summaryPattern = new RegExp(`console\\.(?:log|error|info)\\s*\\(\\s*[\`'"](?:\\\\[rn]|\\s)*${tokenPattern}`, 'm');
  const multiLineSummaryPattern = new RegExp(`console\\.(?:log|error|info)\\s*\\(\\s*[\`'"][\\s\\S]*?[\\r\\n]+(?:\\\\[rn]|\\s)*${tokenPattern}`, 'm');

  const hasSummary = summaryPattern.test(noComments) || multiLineSummaryPattern.test(noComments);

  // Exit path: any construct that can leave the process with a non-zero status.
  //
  // MEASURED 2026-08-23. The three narrow patterns this replaces produced false
  // NO_EXIT_PATH verdicts against suites that provably DO fail. Each was copied to
  // scripts/_mutant-*.mjs with one forced failing assertion and each exited 1:
  //   probe-config-exposure.mjs   process.exitCode = fail === 0 ? 0 : 1  -> rc=1
  //   probe-hotel.mjs             process.exitCode = 1 inside if (fail>0) -> rc=1
  //   verify-import-rollback.mjs  process.exit(failures.length ? 1 : 0)  -> rc=1
  //
  // `process.exitCode =` is not a lesser idiom. probe-config-exposure documents at
  // length why it MUST use it: process.exit() tears down in-flight fetch keep-alive
  // sockets and aborts the process on Windows + Node 26. An auditor that recognises
  // only process.exit() therefore pushes suites toward the form that crashes.
  const hasExitPath = (
    /\bprocess\.exit\s*\(\s*[1-9]/m.test(noComments) ||
    // process.exit(<expr>) where the expression can evaluate non-zero. The identifier
    // class must admit member and index access: `process.exit(failures.length ? 1 : 0)`
    // is the exact shape the old `[a-zA-Z0-9_]+` class could not reach, because it
    // stopped at the `.`.
    /\bprocess\.exit\s*\(\s*[A-Za-z_$][\w$]*(?:\s*[.[][^\n)]*?)?\s*(?:>|<|\?|!==?|===?)/m.test(noComments) ||
    // process.exitCode = a non-zero literal, an identifier/member expression, or a
    // conditional. Matched POSITIVELY, not as `\s*(?!0\s*;)`: a negative lookahead
    // placed after `\s*` is evaded by backtracking the `\s*` to zero width, so the
    // lookahead gets applied to the SPACE and trivially succeeds. That first attempt
    // read `process.exitCode = 0;` as a fail path, and the exitcode-zero-only fixture
    // caught it on the very first run — which is the whole reason that fixture exists.
    /\bprocess\.exitCode\s*=\s*(?:[1-9]|[A-Za-z_$][\w$.]*|[^;\n]*\?)/m.test(noComments) ||
    /if\s*\([^)]*(?:fail|err|error|failures)[^)]*\)\s*(?:\{[^}]*)?process\.exit/i.test(noComments) ||
    /catch\s*\([^)]*\)\s*\{[^}]*process\.exit/m.test(noComments)
  );

  // Real assertions: an assert/expect-style call, a failure COUNTER, or a conditional
  // that can fail the run.
  //
  // MEASURED 2026-08-23. `\+\+` alone missed every suite that counts with `pass += 1`
  // (probe-hotel, probe-capacity-per-day, probe-upload-guard), and no alternative
  // reached suites whose only assertion is `if (bad) process.exit(1)`
  // (probe-csrf-host-prefix, probe-csvParser-data-loss). All five were mutated and all
  // five exited 1, so all five were false NO_ASSERTIONS/UNCLASSIFIED verdicts.
  //
  // MEASURED 2026-09-05, and the reason alternative 4 now scans instead of testing two
  // independent existence patterns. It used to read:
  //
  //   /\bif\s*\(/.test(src) && /process\.exit\(\s*[1-9]|process\.exitCode\s*=\s*[1-9]/.test(src)
  //
  // — an `if` ANYWHERE and a non-zero exit ANYWHERE, with no relationship required
  // between them. A file with an argv convenience check and an uncalled `bail()` helper
  // satisfies both while nothing in it can ever fail; with a summary line it scored VALID,
  // the auditor's strongest verdict. That false green is pinned by
  // _fixtures-suite-integrity/unrelated-if-and-exit.mjs, and the fix is to require the
  // exit to sit inside the conditional's own body (see conditionalBodies above).
  //
  // The tightening is free, measured over the whole corpus on the same date: across the
  // 153 discovered suites it produces 0 verdict flips, because every one of them is
  // already matched by alternatives 1-3 — not one suite depends on alternative 4 at all.
  // The five suites the 2026-08-23 note names all match alternative 2 today (`pass++` /
  // `pass += 1`), so the loose form was buying nothing while carrying its evasion. The
  // capability stays anyway: a conditional exit is the most primitive real assertion
  // there is, and a future suite may legitimately assert only that way.
  //
  // KNOWN IMPRECISION, accepted deliberately: the conditional-exit alternative cannot
  // distinguish a check of the SUBJECT from an environment pre-flight guard such as
  // `if (!existsSync(fixture)) process.exit(1)`, so a suite whose only conditional exit
  // is a pre-flight guard reads as having assertions. This predicate answers "can
  // anything here fail the run", not "does it verify the right thing" — no static
  // pattern can answer the second. The `DIAGNOSTIC: no assertions` marker and
  // verify-all's DIAGNOSTIC bucket (scripts/_verdict.mjs) are what cover the rest.
  // _fixtures-suite-integrity/preflight-guard-only.mjs pins it as a tested contract so it
  // stays a decision instead of drifting into an unexamined bug.
  const hasAssertions = (
    /\b(?:assert(?:\.[a-zA-Z0-9_]+)?\s*\(|console\.assert\s*\(|expect\s*\(|check\s*\(|T\s*\(|test\s*\(|it\s*\()/m.test(noComments) ||
    /\b(?:passed|failed|pass|fail)\s*(?:\+\+|\+=\s*\d+)/m.test(noComments) ||
    /if\s*\([^)]*\)\s*\{[^}]*(?:failed\+\+|fail\+\+|throw\s+new\s+Error)/m.test(noComments) ||
    conditionalBodies(noComments).some((body) => EXIT_NONZERO.test(body))
  );

  let verdict;
  if (isDiagnostic) {
    verdict = 'DIAGNOSTIC';
  } else if (hasAssertions && hasExitPath && hasSummary) {
    verdict = 'VALID';
  } else if (hasAssertions && hasExitPath && !hasSummary) {
    verdict = 'NO_SUMMARY';
  } else if (hasAssertions && !hasExitPath) {
    verdict = 'NO_EXIT_PATH';
  } else if (!hasAssertions && hasSummary) {
    verdict = 'NO_ASSERTIONS';
  } else {
    verdict = 'UNCLASSIFIED';
  }

  return {
    filePath,
    hasAssertions,
    hasExitPath,
    hasSummary,
    isDiagnostic,
    verdict,
  };
}

/**
 * The classifier's oracle: run classifySuite against every fixture in
 * _fixtures-suite-integrity/ and compare all five fields to the expectation recorded here.
 *
 * Pure on purpose — prints nothing, exits nothing — so the same comparison serves both
 * `--self-test` and the repository audit's pre-flight. Before 2026-09-05 this logic was
 * welded to the printing and the process.exit inside runSelfTest, and since nothing in the
 * repository ever passed `--self-test` (not package.json, not verify-all.mjs, not a hook,
 * not a workflow), the corpus that decides whether classifySuite is correct was never
 * executed by any gate — F-071.
 *
 * @returns {{passed: number, failed: number, results: Array<{filename: string, expected: object|null, actual: object|null, ok: boolean, why: string|null}>}}
 */
export function evaluateFixtureCorpus() {
  const expectedVerdicts = {
    'compliant.mjs': { verdict: 'VALID', hasAssertions: true, hasExitPath: true, hasSummary: true, isDiagnostic: false },
    'ternary-summary.mjs': { verdict: 'VALID', hasAssertions: true, hasExitPath: true, hasSummary: true, isDiagnostic: false },
    'escaped-newline-summary.mjs': { verdict: 'VALID', hasAssertions: true, hasExitPath: true, hasSummary: true, isDiagnostic: false },
    'escaped-newline-template.mjs': { verdict: 'VALID', hasAssertions: true, hasExitPath: true, hasSummary: true, isDiagnostic: false },
    'assertions-no-summary.mjs': { verdict: 'NO_SUMMARY', hasAssertions: true, hasExitPath: true, hasSummary: false, isDiagnostic: false },
    'banner-summary.mjs': { verdict: 'NO_SUMMARY', hasAssertions: true, hasExitPath: true, hasSummary: false, isDiagnostic: false },
    'comment-only-fail.mjs': { verdict: 'NO_SUMMARY', hasAssertions: true, hasExitPath: true, hasSummary: false, isDiagnostic: false },
    'assertions-no-exit.mjs': { verdict: 'NO_EXIT_PATH', hasAssertions: true, hasExitPath: false, hasSummary: false, isDiagnostic: false },
    // Added 2026-08-23 with the widened exit-path and counter patterns. Each of these
    // encodes an idiom a shipped suite really uses and the auditor used to miss; the
    // zero-only one is the negative that stops the widening becoming vacuous.
    'exitcode-nonzero.mjs': { verdict: 'VALID', hasAssertions: true, hasExitPath: true, hasSummary: true, isDiagnostic: false },
    'exitcode-zero-only.mjs': { verdict: 'NO_EXIT_PATH', hasAssertions: true, hasExitPath: false, hasSummary: true, isDiagnostic: false },
    'exit-member-ternary.mjs': { verdict: 'VALID', hasAssertions: true, hasExitPath: true, hasSummary: true, isDiagnostic: false },
    'plusequals-counter.mjs': { verdict: 'VALID', hasAssertions: true, hasExitPath: true, hasSummary: true, isDiagnostic: false },
    'conditional-exit-assertion.mjs': { verdict: 'NO_SUMMARY', hasAssertions: true, hasExitPath: true, hasSummary: false, isDiagnostic: false },
    // Added 2026-09-05 with the structural tightening of hasAssertions alternative 4. The
    // first is the evasion the tightening exists to catch — an `if` and a non-zero exit
    // with no relationship to each other, which the two-independent-existence-tests form
    // scored VALID. The next three are the legitimate shapes that must survive it: one
    // whose exit sits behind nested condition parens AND a nested block (the two things a
    // character-class regex cannot cross), one whose exit is in the `else` branch, and one
    // that is a bare environment pre-flight guard and reads as an assertion by the
    // documented imprecision. The last pins string blindness in stripComments and involves
    // no conditional at all.
    'unrelated-if-and-exit.mjs': { verdict: 'NO_ASSERTIONS', hasAssertions: false, hasExitPath: true, hasSummary: true, isDiagnostic: false },
    'nested-block-exit.mjs': { verdict: 'VALID', hasAssertions: true, hasExitPath: true, hasSummary: true, isDiagnostic: false },
    'else-branch-exit.mjs': { verdict: 'VALID', hasAssertions: true, hasExitPath: true, hasSummary: true, isDiagnostic: false },
    'preflight-guard-only.mjs': { verdict: 'VALID', hasAssertions: true, hasExitPath: true, hasSummary: true, isDiagnostic: false },
    'assert-in-string.mjs': { verdict: 'VALID', hasAssertions: true, hasExitPath: true, hasSummary: true, isDiagnostic: false },
    'diagnostic-marker.mjs': { verdict: 'DIAGNOSTIC', hasAssertions: false, hasExitPath: false, hasSummary: false, isDiagnostic: true },
    'unclassified.mjs': { verdict: 'UNCLASSIFIED', hasAssertions: false, hasExitPath: false, hasSummary: false, isDiagnostic: false },
  };

  const FIELDS = ['verdict', 'hasAssertions', 'hasExitPath', 'hasSummary', 'isDiagnostic'];
  const results = [];

  for (const [filename, expected] of Object.entries(expectedVerdicts)) {
    const fixturePath = path.join(FIXTURES_DIR, filename);
    if (!fs.existsSync(fixturePath)) {
      results.push({ filename, expected, actual: null, ok: false, why: 'missing fixture file' });
      continue;
    }

    const actual = classifySuite(fixturePath, fs.readFileSync(fixturePath, 'utf8'));
    const ok = FIELDS.every((k) => actual[k] === expected[k]);
    results.push({ filename, expected, actual, ok, why: ok ? null : 'classification differs from the recorded expectation' });
  }

  // The reverse direction, and the same class of gap as F-071 itself: a fixture that
  // exists on disk but that nothing compares against is an UNVERIFIED fixture. Someone
  // adds a case, forgets the table entry, and the corpus silently stops covering it while
  // still reporting all green.
  for (const filename of fs.readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.mjs')).sort()) {
    if (!(filename in expectedVerdicts)) {
      results.push({ filename, expected: null, actual: null, ok: false, why: 'fixture has no entry in the expected-verdict table' });
    }
  }

  return {
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };
}

async function runSelfTest() {
  console.log('=== SUITE INTEGRITY PROBE: SELF-TEST MODE ===');
  console.log(`Evaluating fixture corpus in: ${FIXTURES_DIR}\n`);

  const { passed, failed, results } = evaluateFixtureCorpus();

  for (const r of results) {
    if (r.ok) {
      console.log(`  PASS  ${r.filename} -> verdict=${r.actual.verdict} (summary=${r.actual.hasSummary}, exit=${r.actual.hasExitPath}, assertions=${r.actual.hasAssertions}, diag=${r.actual.isDiagnostic})`);
    } else if (!r.actual) {
      console.log(`  FAIL  ${r.filename} -> ${r.why}`);
    } else {
      console.log(`  FAIL  ${r.filename} -> expected ${JSON.stringify(r.expected)} but got ${JSON.stringify(r.actual)}`);
    }
  }

  console.log('');
  console.log(`${failed === 0 ? 'PASSED' : 'FAILED'}: ${passed} passed, ${failed} failed`);

  process.exit(failed > 0 ? 1 : 0);
}

async function runCrossCheck() {
  console.log('=== SUITE INTEGRITY PROBE: CROSS-CHECK MODE ===');
  console.log('Executing statically flagged NO_SUMMARY suites to detect false positives...\n');

  const files = fs.readdirSync(SCRIPTS_DIR)
    .filter(isSuiteFile)
    .sort();

  const flagged = [];
  for (const f of files) {
    const fullPath = path.join(SCRIPTS_DIR, f);
    const raw = fs.readFileSync(fullPath, 'utf8');
    const res = classifySuite(fullPath, raw);
    if (res.verdict === 'NO_SUMMARY') {
      flagged.push(f);
    }
  }

  console.log(`Statically flagged suites (NO_SUMMARY): ${flagged.length}\n`);

  const falsePositives = [];
  const timeouts = [];
  let completed = 0;

  for (const f of flagged) {
    const fullPath = path.join(SCRIPTS_DIR, f);
    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        ['--import', './scripts/_loader-boot.mjs', fullPath],
        { timeout: 60000 }
      );
      completed++;
      const runtimeMatches = /^(?:PASSED|FAILED):/m.test(stdout);
      if (runtimeMatches) {
        console.log(`  STATIC FALSE POSITIVE: ${f}`);
        console.log(`    Matched stdout line: ${stdout.match(/^(?:PASSED|FAILED):.*/m)?.[0]}`);
        falsePositives.push(f);
      } else {
        console.log(`  PASS (confirmed NO_SUMMARY): ${f}`);
      }
    } catch (err) {
      if (err.killed && err.signal === 'SIGTERM') {
        console.log(`  TIMEOUT (inconclusive): ${f}`);
        timeouts.push(f);
      } else {
        completed++;
        const out = (err.stdout || '') + (err.stderr || '');
        const runtimeMatches = /^(?:PASSED|FAILED):/m.test(out);
        if (runtimeMatches) {
          console.log(`  STATIC FALSE POSITIVE (non-zero run): ${f}`);
          falsePositives.push(f);
        } else {
          console.log(`  PASS (confirmed NO_SUMMARY on non-zero exit): ${f}`);
        }
      }
    }
  }

  console.log('\n--------------------------------------------------------------------------------');
  console.log('Cross-Check Results:');
  console.log(`  Flagged suites evaluated: ${completed}`);
  console.log(`  Timeouts (inconclusive): ${timeouts.length}`);
  console.log(`  Static False Positives: ${falsePositives.length}`);
  console.log('--------------------------------------------------------------------------------\n');

  if (falsePositives.length > 0) {
    console.log(`FAILED: Found ${falsePositives.length} static false positive(s):`);
    for (const fp of falsePositives) {
      console.log(`  - ${fp}`);
    }
    process.exit(1);
  } else {
    console.log(`PASSED: 0 static false positives found across ${completed} flagged suites.`);
    process.exit(0);
  }
}

async function runTreeAudit() {
  console.log('=== SUITE INTEGRITY PROBE: REPOSITORY AUDIT ===');

  // Pre-flight: prove the classifier still classifies correctly BEFORE letting it judge
  // 153 suites. This is the audit path verify-all.mjs actually runs (bare, no flags), so
  // it is the only place the fixture corpus can be reached by a gate. Fixing F-071 here
  // rather than by adding a package script keeps verify-all's discovery contract
  // untouched — and probe-suite-integrity.mjs must NOT be added to any NOT_A_SUITE set,
  // which verify-all.mjs:128-133 forbids outright.
  //
  // The success line is deliberately NOT summary-shaped: scripts/_verdict.mjs treats any
  // line matching /^(PASS|FAIL|PASSED|FAILED)\b|passed,\s*\d+\s*failed/i as a summary and
  // reports the LAST one, so a second `PASSED: n passed, 0 failed` here would shadow the
  // audit's own verdict. The failure line is summary-shaped on purpose: `^FAILED\b` makes
  // _verdict.mjs read failure regardless of the trailing parenthetical.
  const oracle = evaluateFixtureCorpus();
  if (oracle.failed > 0) {
    console.log('Classifier oracle FAILED — the auditor cannot be trusted to audit:\n');
    for (const r of oracle.results.filter((x) => !x.ok)) {
      console.log(`  FAIL  ${r.filename} -> ${r.why}`);
      if (r.actual) {
        console.log(`          expected ${JSON.stringify(r.expected)}`);
        console.log(`          got      ${JSON.stringify(r.actual)}`);
      }
    }
    console.log('');
    console.log(`FAILED: ${oracle.passed} passed, ${oracle.failed} failed (classifier oracle)`);
    process.exit(1);
  }
  console.log(`Classifier oracle: ${oracle.passed}/${oracle.results.length} fixtures classified as specified.`);

  // Second pre-flight: the suites this audit must never quietly stop covering. Same shape as
  // the discovery floor in scripts/verify-all.mjs — names, not a count — but it guards the
  // STATIC walk (isSuiteFile), which is a different question. A file can be swept and yet
  // unaudited, so nobody enforces its summary contract; or audited and yet never run. Each
  // walk therefore carries its own floor, and NOT_A_SUITE above says why this name is on it.
  const MUST_REMAIN_AUDITED = ['probe-auth-hardening.mjs'];
  const unaudited = MUST_REMAIN_AUDITED
    .map((f) => ({ f, onDisk: fs.existsSync(path.join(SCRIPTS_DIR, f)) }))
    .filter(({ f, onDisk }) => !onDisk || !isSuiteFile(f));
  if (unaudited.length > 0) {
    console.log('Audit floor violated — a suite that must stay covered is not in the audited set:\n');
    for (const { f, onDisk } of unaudited) {
      console.log(`  FAIL  ${f} -> ${onDisk ? 'on disk, but NOT_A_SUITE or the prefix test excludes it' : 'not on disk'}`);
    }
    console.log('');
    console.log(`FAILED: 0 passed, ${unaudited.length} failed (audit floor)`);
    process.exit(1);
  }
  // Count, not a ratio: `n/n` off one expression is a display that can never disagree with
  // itself, which is the vacuity this whole audit exists to find. A bare count still shows an
  // emptied floor as `0 required suite(s)`.
  console.log(`Audit floor: ${MUST_REMAIN_AUDITED.length} required suite(s) still audited.`);

  console.log(`Scanning suites in: ${SCRIPTS_DIR}\n`);

  const files = fs.readdirSync(SCRIPTS_DIR)
    .filter(isSuiteFile)
    .sort();

  console.log(`Discovered ${files.length} suites.\n`);
  console.log(`${'Suite Name'.padEnd(38)} | Assert | Exit | Summ | Diag | Verdict`);
  console.log('-'.repeat(80));

  const results = [];
  const violators = [];

  for (const f of files) {
    const fullPath = path.join(SCRIPTS_DIR, f);
    const raw = fs.readFileSync(fullPath, 'utf8');
    const res = classifySuite(fullPath, raw);
    results.push({ name: f, ...res });

    const isOk = res.verdict === 'VALID' || res.verdict === 'DIAGNOSTIC';
    if (!isOk) {
      violators.push({ name: f, ...res });
    }

    const assertStr = res.hasAssertions ? 'YES ' : 'NO  ';
    const exitStr = res.hasExitPath ? 'YES ' : 'NO  ';
    const summStr = res.hasSummary ? 'YES ' : 'NO  ';
    const diagStr = res.isDiagnostic ? 'YES ' : 'NO  ';
    console.log(`${f.padEnd(38)} | ${assertStr}   | ${exitStr} | ${summStr} | ${diagStr} | ${res.verdict}`);
  }

  console.log('-'.repeat(80));
  console.log(`\nAudit Summary:`);
  console.log(`  Total suites checked: ${files.length}`);
  console.log(`  Compliant (VALID or DIAGNOSTIC): ${files.length - violators.length}`);
  console.log(`  Contract violators: ${violators.length}\n`);

  if (violators.length > 0) {
    console.log(`Contract Violations Found (${violators.length} suites):`);
    for (const v of violators) {
      console.log(`  - ${v.name}: verdict=${v.verdict} (hasAssertions=${v.hasAssertions}, hasExitPath=${v.hasExitPath}, hasSummary=${v.hasSummary})`);
    }
    console.log('');
    console.log(`FAILED: ${files.length - violators.length} passed, ${violators.length} failed`);
    process.exit(1);
  } else {
    console.log(`PASSED: ${files.length} passed, 0 failed`);
    process.exit(0);
  }
}

const args = process.argv.slice(2);
if (args.includes('--self-test')) {
  runSelfTest();
} else if (args.includes('--cross-check')) {
  runCrossCheck();
} else {
  runTreeAudit();
}
