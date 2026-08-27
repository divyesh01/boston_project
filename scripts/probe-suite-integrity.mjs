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
  'probe-auth-hardening-world.mjs', // fixture library imported by other probes
  'probe-suite-integrity.mjs',   // this file
]);
const isSuiteFile = (f) =>
  f.endsWith('.mjs') && SUITE_PREFIXES.some((p) => f.startsWith(p)) && !NOT_A_SUITE.has(f);

export function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^\\:])\/\/.*$/gm, '$1');
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
  // KNOWN IMPRECISION, accepted deliberately: the conditional-exit alternative cannot
  // distinguish a check of the SUBJECT from an environment pre-flight guard such as
  // `if (!existsSync(fixture)) process.exit(1)`, so a suite whose only conditional exit
  // is a pre-flight guard reads as having assertions. This predicate answers "can
  // anything here fail the run", not "does it verify the right thing" — no static
  // pattern can answer the second. The `DIAGNOSTIC: no assertions` marker and
  // verify-all's DIAGNOSTIC bucket (scripts/_verdict.mjs) are what cover the rest.
  const hasAssertions = (
    /\b(?:assert(?:\.[a-zA-Z0-9_]+)?\s*\(|console\.assert\s*\(|expect\s*\(|check\s*\(|T\s*\(|test\s*\(|it\s*\()/m.test(noComments) ||
    /\b(?:passed|failed|pass|fail)\s*(?:\+\+|\+=\s*\d+)/m.test(noComments) ||
    /if\s*\([^)]*\)\s*\{[^}]*(?:failed\+\+|fail\+\+|throw\s+new\s+Error)/m.test(noComments) ||
    (/\bif\s*\(/m.test(noComments) &&
      /\bprocess\.exit\s*\(\s*[1-9]|\bprocess\.exitCode\s*=\s*[1-9]/m.test(noComments))
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

async function runSelfTest() {
  console.log('=== SUITE INTEGRITY PROBE: SELF-TEST MODE ===');
  console.log(`Evaluating fixture corpus in: ${FIXTURES_DIR}\n`);

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
    'diagnostic-marker.mjs': { verdict: 'DIAGNOSTIC', hasAssertions: false, hasExitPath: false, hasSummary: false, isDiagnostic: true },
    'unclassified.mjs': { verdict: 'UNCLASSIFIED', hasAssertions: false, hasExitPath: false, hasSummary: false, isDiagnostic: false },
  };

  let passed = 0;
  let failed = 0;

  for (const [filename, expected] of Object.entries(expectedVerdicts)) {
    const fixturePath = path.join(FIXTURES_DIR, filename);
    if (!fs.existsSync(fixturePath)) {
      console.log(`  FAIL  Missing fixture: ${filename}`);
      failed++;
      continue;
    }

    const raw = fs.readFileSync(fixturePath, 'utf8');
    const result = classifySuite(fixturePath, raw);

    const verdictMatch = result.verdict === expected.verdict;
    const summaryMatch = result.hasSummary === expected.hasSummary;
    const exitMatch = result.hasExitPath === expected.hasExitPath;
    const assertionsMatch = result.hasAssertions === expected.hasAssertions;
    const diagnosticMatch = result.isDiagnostic === expected.isDiagnostic;

    const allMatch = verdictMatch && summaryMatch && exitMatch && assertionsMatch && diagnosticMatch;

    if (allMatch) {
      passed++;
      console.log(`  PASS  ${filename} -> verdict=${result.verdict} (summary=${result.hasSummary}, exit=${result.hasExitPath}, assertions=${result.hasAssertions}, diag=${result.isDiagnostic})`);
    } else {
      failed++;
      console.log(`  FAIL  ${filename} -> expected ${JSON.stringify(expected)} but got ${JSON.stringify(result)}`);
    }
  }

  console.log('');
  if (failed === 0) {
    console.log(`PASSED: ${passed} passed, ${failed} failed`);
  } else {
    console.log(`FAILED: ${passed} passed, ${failed} failed`);
  }

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
