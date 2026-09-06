// scripts/verify-all.mjs — run EVERY probe and verification suite in one command.
//
// WHY THIS EXISTS. This repo had ~60 probe/verify scripts and no way to run them
// together, so the only way to know the state of the codebase was to remember
// which files to invoke and how. That is how the following went unnoticed:
//
//   * verify-actioncenter.mjs crashed at section 3 on a TypeError, so sections 4-14
//     never executed at all. Their state was simply unknown.
//   * probe-csv-data-loss.mjs asserted with console.assert, which does not fail the
//     process, and ended by printing "✓ Probe confirmed: ... is fixed"
//     unconditionally. It reported success while two of its four claims were false.
//   * probe-adjustments.mjs imported a function that was not exported, and read a
//     CSV from an absolute path on a machine that no longer exists. It had never
//     run.
//   * probe-revenue-reconciliation.mjs was console.assert throughout, and was the
//     only evidence behind a tracker entry marked FIXED.
//
// A suite nobody runs is documentation, not verification. `npm run verify:all`
// makes the whole set cheap to run, and — critically — DISTINGUISHES a probe that
// failed from one that could not start. "Broken" is its own category here, because
// a probe that cannot load is the failure mode that hides most easily: it looks
// like a passing suite with one fewer line of output.
//
// Usage:
//   npm run verify:all                 all suites
//   npm run verify:all -- --filter audit     only names containing "audit"
//   npm run verify:all -- --list             list what would run, run nothing
//   npm run verify:all -- --bail             stop at the first failure
//   npm run verify:all -- --json             machine-readable summary
//   npm run verify:all -- --timeout 300      per-suite timeout in seconds
//   npm run verify:all -- --shard 2/7        run the 2nd of 7 slices of the list
//
// Use --shard, NOT a reduced --timeout, when a single command's wall clock is
// capped. Lowering the timeout does not shorten the run; it kills slow suites and
// reports them as TIMEOUT. See the comment above the shard block.
//
// Every run prints a `list <id> (<n> discovered)` fingerprint. When you add up shards,
// check that all of them printed the SAME id — otherwise they ran over different file
// sets and the total is not a total. See the comment above LIST_ID.
//
// Exit code is 0 only if every suite that ran passed.


import { readdirSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

// The verdict logic lives in _verdict.mjs so it can be regression-tested on its
// own — see the header of that file, and scripts/probe-verify-all-verdict.mjs.
import { BROKEN_SIGNATURES, classifySuiteRun } from "./_verdict.mjs";

const SCRIPTS_DIR = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = path.resolve(SCRIPTS_DIR, "..");

// ── Args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const FILTER = value("filter", null);
const TIMEOUT_S = Number(value("timeout", "240"));
const LIST_ONLY = flag("list");
const BAIL = flag("bail");
const AS_JSON = flag("json");

// ── Which files are suites ───────────────────────────────────────────────────
// Convention over configuration: probe-*.mjs, verify-*.mjs and test_*.mjs are suites.
// Anything else in scripts/ is tooling (generators, loaders, stubs) and is not run.
//
// `test_` was ADDED 2026-08-23. It is a third naming convention that predates the
// probe-/verify- one, and for as long as this runner has existed it silently excluded
// seven real suites — test_anomaly_detector, test_auditlog_immutability,
// test_bulletproof_auth, test_defect_5_probe, test_local_auth,
// test_realtime_revocation, test_validator — carrying several hundred assertions
// between them. Nothing was wrong with those files; the gate simply could not see
// them, so "all green" was quoted over a set that never included them. Note the
// underscore: these are test_foo.mjs, not test-foo.mjs, which is why no dash-based
// prefix ever caught them.
//
// EXCLUSIONS are listed with a reason, and each reason is a factual statement about
// the file — not a judgement. A suite must never be excluded merely because it is
// failing; that is the one thing this runner exists to surface.
const EXCLUDE = new Map([
  ["verify-all.mjs", "this runner"],
  ["verify-brain.mjs", "documentation gate, not a behaviour suite — run via npm run brain:verify"],
  ["verify-repo-map.mjs", "documentation gate, not a behaviour suite — run via npm run map:verify"],
  // Mutation harness for the gate above. It rewrites all four routing documents in
  // place and restores them; a suite killed by --timeout mid-mutation would leave a
  // tracked doc modified, so it is run deliberately (npm run map:mutate), never inside
  // an automated sweep.
  ["probe-repo-map-gate.mjs", "mutates tracked docs in place — run via npm run map:mutate"],
  // Mutation harness for the HotelKey regression net. Same write property as the entry
  // above, one layer deeper: it rewrites TRACKED PRODUCTION SOURCE in place — reportParsers.js,
  // transactionNorm.js, importValidation.js and parsers/transactions.js under src/lib/ — one
  // anchor at a time, then writes the exact original bytes back.
  //
  // That restore is now crash-safe against a throw: the pristine bytes are held in an inFlight
  // map, the entry is set BEFORE the mutating write, and a try/finally puts them back. It is
  // still excluded, because a finally is not reachable from the timer below. MEASURED on win32
  // this session: a parent calling child.kill() — SIGKILL, SIGTERM or SIGINT alike — ends the
  // child with no process.on(signal) listener, no 'exit' listener and no finally running, and a
  // SIGKILL of the direct child also took down a grandchild it had spawned via spawnSync (cause
  // UNKNOWN, and it contradicts the naive "TerminateProcess targets one PID" inference, so do
  // not reason from that story here). A sweep kill therefore still leaves the mutant on disk.
  //
  // The exclusion rests on that write property, not on the clock. --timeout is a default and
  // is overridable, so "too slow" would be a budget judgement — precisely what the rule above
  // forbids as a reason.
  //
  // It happened. A sweep hit its per-suite cap during M11 and killed the child with SIGKILL, so
  // the revert never ran: transactionNorm.js was left carrying M11's replacement, which
  // reclassifies refunds as charges. The 16 assertions that later read it in
  // verify-transactions.mjs and verify-coexistence.mjs failed against that residue rather than
  // against their own subject. Restoring the one file returned them to 115/0 and 23/0. A suite
  // that can leave the tree modified corrupts every suite scheduled after it, and that holds at
  // any budget.
  //
  // Three suite-shaped files under scripts/ write tracked files in place, and all three are
  // excluded here: the two mutation harnesses, and the crash-safety probe below that drives one
  // of them. Said that way on purpose — "discovered" is this file's word for the post-EXCLUDE
  // set, so an excluded suite is by definition not one. Nothing else found so far writes a
  // tracked file. Run the three deliberately — npm run mutate:all.
  //
  // The suite count printed here and the one printed by scripts/probe-suite-integrity.mjs
  // legitimately differ: that auditor keeps its own NOT_A_SUITE set and does not read this
  // map. It statically audits probe-hotelkey-mutations.mjs for the summary contract, an exit
  // path and non-vacuous assertions WITHOUT executing it, which is exactly what should still
  // happen here. Do not "reconcile" the two numbers by adding this file to NOT_A_SUITE: that
  // drops the static contract audit too, and silently.
  ["probe-hotelkey-mutations.mjs", "mutates tracked production source in place — run via npm run hotelkey:mutate"],
  // Crash-safety proof for the harness above. It inherits that harness's write property by
  // spawning it, so every word of the entry above applies to this file too, and it adds one of
  // its own: to prove the restore does not shell out to git, it holds <repo>/.git/index.lock for
  // the duration of a run. While that lock is held, git READERS still work — measured: `git
  // status --porcelain` exits 0 and reports correctly, which is why the probe's own clean checks
  // remain meaningful — but every git WRITER needing the index fails, repo-wide and not just in
  // this process: add, commit, checkout, and a pre-commit hook running in another shell alongside
  // it. That is the whole point of section B, and it is also its blast radius.
  //
  // The lock is created with an exclusive flag and never over an existing one (an already-present
  // lock is reported INCONCLUSIVE rather than clobbered), and it is released three ways: section
  // B's own finally, the outer finally, and the probe's SIGINT/SIGTERM handlers — so a console
  // Ctrl-C, the one interruption no finally reaches, no longer leaves it behind. What survives
  // none of that is a SIGKILL or a power loss, and the SIGKILL is exactly the kill the timer
  // below imposes. So this file is excluded for the same reason as the harness it drives: swept,
  // it can leave both a mutated tracked source and a stale index lock on disk.
  ["probe-hotelkey-mutation-crashsafe.mjs", "spawns the harness above, and holds .git/index.lock for a whole run — run via npm run hotelkey:crashsafe"],
]);
// NOT AN OMISSION: there is no entry above for probe-auth-hardening.mjs, and adding one would
// be a loss of security coverage rather than a tidy-up.
//
// Until 2026-09-05 this map held a seventh entry — `probe-auth-hardening-world.mjs`, described
// as a "fixture library imported by other probes" — and no file of that name has ever existed
// here. `EXCLUDE.has(f)` is only ever asked about names read off disk, so the entry excluded
// nothing, and --list filters by existence, so it was held but never printed: seven held, six
// shown. That is why it sat unnoticed. The phrase survives at scripts/probe-audit-list.mjs:8,
// where a probe once imported a `testWorld` symbol that probe-auth-hardening.mjs does not
// export and died on every invocation; whether that is where the "-world" came from is
// inferred, not established.
//
// The obvious cleanup is to point the entry at the file that does exist. MEASURED on a
// temporary copy, 2026-09-05: that takes the sweep from 150 suites / list 2b819cc2 to 149 /
// 4ebd928b, moves probe-auth-hardening.mjs into "not run" under that same false description,
// and EXITS 0. Nothing reports it. The file is 1,037 lines of assertions against the real
// serverless entry files in base44/functions/*/entry.js, and because eslint.config.js ignores
// base44/** it is the only automated check on the production auth path — its own header says
// so at scripts/probe-auth-hardening.mjs:8. "Fixing the typo" deletes that coverage in silence.
//
// So the entry is deleted rather than corrected, and the floor below makes a repeat loud.

const isSuite = (f) =>
  f.endsWith(".mjs") &&
  (f.startsWith("probe-") || f.startsWith("verify-") || f.startsWith("test_")) &&
  !f.startsWith("_") &&
  !EXCLUDE.has(f);

let suites = readdirSync(SCRIPTS_DIR).filter(isSuite).sort();

// ── Suite-list fingerprint ───────────────────────────────────────────────────
// ADDED 2026-08-20, after a measured near-miss. A sharded run is several separate
// invocations of this file, and each one re-reads the directory. That is only sound
// while the directory is STABLE: on 2026-08-20 a new suite (probe-audit-write-failure.mjs)
// was written at 11:39 while a 10-shard run was in progress, so the early shards
// partitioned 70 names and the later ones partitioned 71. Slice boundaries are computed
// from `suites.length`, so the shift silently moved suites across boundaries — one could
// have been run twice and another not at all, while every shard still reported "all
// green". The run's own arithmetic was the only clue (68 + 2 = 70, against 71 files).
//
// The fingerprint makes that detectable instead of invisible: it is over the FULL
// discovered list, before --filter and --shard narrow it, so every shard of one honest
// run prints the SAME id. Two shards showing different ids did not verify one file set,
// and the combined tally cannot be added up.
const discovered = [...suites];
const LIST_ID = createHash("sha256").update(discovered.join("\n")).digest("hex").slice(0, 8);
const listId = `list ${LIST_ID} (${discovered.length} discovered)`;

// ── Discovery floor ─────────────────────────────────────────────────────────
// ADDED 2026-09-05. A suite can leave this sweep three silent ways — a new EXCLUDE entry, a
// rename, or a deletion — and all three exit 0 today. See the note at the end of EXCLUDE for
// the measurement that prompted this. The floor names suites whose disappearance must FAIL the
// run instead of merely shrinking the count.
//
// Names, not a count. `discovered.length === 150` would fail on every honest addition, so it
// would be raised reflexively until it meant nothing, and it could never say WHICH suite went
// missing. Checked against the full discovered set, before --filter and --shard narrow it, so
// a deliberately narrowed run cannot false-fail.
//
// The bar for adding a name is high on purpose: a suite belongs here when it is the SOLE
// automated check on a production trust boundary. Keep it in step with MUST_REMAIN_AUDITED in
// scripts/probe-suite-integrity.mjs, which pins the same names into the static contract audit.
// The two walks are separate by design and each one needs its own floor: a file can be swept
// but unaudited, or audited but never run.
const MUST_DISCOVER = ["probe-auth-hardening.mjs"];
const undiscovered = MUST_DISCOVER.filter((f) => !discovered.includes(f));
if (undiscovered.length) {
  console.error(`Discovery floor violated: ${undiscovered.length} required suite(s) are not in the discovered set.`);
  for (const f of undiscovered) {
    const onDisk = existsSync(path.join(SCRIPTS_DIR, f));
    console.error(`  ${f} — ${onDisk ? "on disk, but EXCLUDE or the prefix test keeps it out of the run" : "not on disk"}`);
  }
  console.error("This is not count drift. Restore the suite, or — if it genuinely must stop running — remove it from MUST_DISCOVER in the same commit and record why.");
  process.exit(1);
}

if (FILTER) suites = suites.filter((f) => f.includes(FILTER));

// ── Sharding ────────────────────────────────────────────────────────────────
// ADDED 2026-08-20. `--shard 2/7` runs the second of seven consecutive slices.
//
// WHY THIS EXISTS, because the reason matters more than the feature: the suites run
// serially and the full set takes 12-25 minutes, but some environments cap a single
// command's wall clock (the Linux sandbox used by agents on this repo kills at ~178s
// and DISCARDS the output). The obvious workaround is to lower `--timeout` so the run
// fits — and that is a trap. It does not make the run shorter, it makes slow suites
// get killed and reported as TIMEOUT. On 2026-08-20 that produced a false finding of
// "7 broken suites" that was written into BRAIN.md; six of the seven pass in 9-22s
// each when given a real budget. Splitting the LIST is the correct axis to cut on;
// splitting the per-suite BUDGET fabricates failures.
//
// Slices are contiguous over the sorted list, so `1/n .. n/n` covers every suite
// exactly once with no overlap and no gap. Exit codes are per-shard: a green shard
// means only that shard is green, which the summary states explicitly.
const SHARD = value("shard", null);
let shardLabel = "";
if (SHARD) {
  const m = /^(\d+)\/(\d+)$/.exec(SHARD);
  if (!m) {
    console.error(`--shard expects i/n, e.g. --shard 2/7 (got ${JSON.stringify(SHARD)}).`);
    process.exit(1);
  }
  const i = Number(m[1]);
  const n = Number(m[2]);
  if (n < 1 || i < 1 || i > n) {
    console.error(`--shard ${SHARD} is out of range: need 1 <= i <= n and n >= 1.`);
    process.exit(1);
  }
  // Ceil, so the last shard is the short one and no suite is ever dropped by
  // rounding. The trailing shard CAN come out empty — with 71 suites and n=10 the
  // slice size is 8, shards 1-8 take 8 each, shard 9 takes the remaining 7, and
  // shard 10 has nothing left. That is handled explicitly below rather than being
  // reported as a pass over zero suites.
  const size = Math.ceil(suites.length / n);
  const total = suites.length;
  suites = suites.slice((i - 1) * size, i * size);
  shardLabel = ` [shard ${i}/${n} of ${total}]`;
  if (!suites.length) {
    // A shard past the end is not an error worth failing a CI matrix over, but it
    // must not look like a pass either.
    console.log(`shard ${i}/${n} is empty (${total} suite(s) fit in ${i - 1} shard(s) of ${size}). Nothing to run.`);
    process.exit(0);
  }
}

if (!suites.length) {
  console.error(`No suites matched${FILTER ? ` --filter ${FILTER}` : ""}.`);
  process.exit(1);
}

if (LIST_ONLY) {
  console.log(`${suites.length} suite(s)${shardLabel} — ${listId}:`);
  suites.forEach((s) => console.log(`  ${s}`));
  const skipped = [...EXCLUDE.entries()].filter(([f]) => existsSync(path.join(SCRIPTS_DIR, f)));
  if (skipped.length) {
    console.log(`\nnot run (${skipped.length}):`);
    skipped.forEach(([f, why]) => console.log(`  ${f} — ${why}`));
  }
  process.exit(0);
}

// ── Running one suite ────────────────────────────────────────────────────────
// Every suite is launched through scripts/_loader-boot.mjs, which resolves the '@/'
// alias and extensionless imports the src/ modules use. Suites that don't need it
// are unaffected; suites that do would otherwise die at import with
// ERR_MODULE_NOT_FOUND, which is exactly the "broken, not failing" case above.
const BOOT_PATH = path.join(SCRIPTS_DIR, "_loader-boot.mjs");
const useBoot = existsSync(BOOT_PATH);
const BOOT = useBoot ? "./scripts/_loader-boot.mjs" : null;

function runSuite(file) {
  return new Promise((resolve) => {
    const suitePath = path.join("scripts", file);
    const args = useBoot ? ["--import", BOOT, suitePath] : [suitePath];
    const started = Date.now();
    const child = spawn(process.execPath, args, {
  cwd: REPO_ROOT,
  env: {
    ...process.env,
    VITE_SKIP_DEP_SCAN: '1',
    VITE_TEST: '1',
    NODE_ENV: 'production',
    VITE_USE_LOCAL_AUTH: 'true',
  }
});

    let out = "";
    let killed = false;
    const cap = (chunk) => {
      out += chunk;
      // Keep memory bounded on a chatty suite while preserving the tail, which is
      // where the summary line lives.
      if (out.length > 400_000) out = out.slice(-200_000);
    };
    child.stdout.on("data", cap);
    child.stderr.on("data", cap);

    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, TIMEOUT_S * 1000);

    child.on("close", (code) => {
      clearTimeout(timer);
      const ms = Date.now() - started;

      // Every judgement about what this output MEANS lives in _verdict.mjs, which
      // scripts/probe-verify-all-verdict.mjs holds to 64 measured assertions over the
      // output shapes real suites in this repo have actually produced.
      const { status, summary, partial } = classifySuiteRun({ out, code, killed });

      resolve({
        file,
        code,
        ms,
        killed,
        broken: status === "BROKEN",
        lyingExitCode: status === "BAD-EXIT",
        skipped: status === "SKIP",
        diagnostic: status === "DIAGNOSTIC",
        // Sections this suite declined while still stating a verdict. A whole-suite
        // decline is the SKIP status instead, and carries an empty array.
        partial,
        status,
        summary,
        output: out,
      });
    });
  });
}

// ── Run them ─────────────────────────────────────────────────────────────────
// Serially and deliberately: several suites are CPU-bound, and running them in
// parallel in this environment starved them badly enough that they produced no
// output at all — which would have been reported as BROKEN.
const results = [];
const label = { PASS: "PASS   ", FAIL: "FAIL   ", BROKEN: "BROKEN ", TIMEOUT: "TIMEOUT", "BAD-EXIT": "BADEXIT", SKIP: "SKIP   ", DIAGNOSTIC: "DIAG   ", "NO-VERDICT": "NO-VERD" };

if (!AS_JSON) console.log(`Running ${suites.length} suite(s)${shardLabel}, ${TIMEOUT_S}s timeout each — ${listId}\n`);

for (const file of suites) {
  const r = await runSuite(file);
  results.push(r);
  if (!AS_JSON) {
    const secs = (r.ms / 1000).toFixed(1).padStart(5);
    console.log(`${label[r.status]} ${secs}s  ${file.padEnd(42)} ${r.summary.slice(0, 90)}`);
  }
  if (BAIL && r.status !== "PASS" && r.status !== "SKIP") break;
}

// ── Report ───────────────────────────────────────────────────────────────────
const by = (s) => results.filter((r) => r.status === s);
const passed = by("PASS");
const failed = by("FAIL");
const broken = by("BROKEN");
const timedOut = by("TIMEOUT");
const badExit = by("BAD-EXIT");
const skipped = by("SKIP");
// Not in notPassing: a diagnostic exits 0 and has broken no contract. It is kept
// out of `passed` for the opposite reason — it verified nothing, so counting it
// green overstates coverage by one suite per printer.
const diagnostics = by("DIAGNOSTIC");
// Exit 0 with no verdict line at all. NOT a caveat bucket like SKIP and DIAGNOSTIC:
// those are declared, this one is undeclared, so nothing about the run is known. See
// the NO-VERDICT note in _verdict.mjs — it is counted as not-green on purpose.
const noVerdict = by("NO-VERDICT");
// PARTIAL COVERAGE. Orthogonal to the buckets above rather than a bucket of its own:
// these suites RAN and stated a verdict, and separately declined one or more sections.
// Keeping it orthogonal is deliberate — a partial pass is still a pass and must not be
// lifted out of `passed` (that would understate coverage the way the DIAGNOSTIC fix
// once had to correct for overstating it), but "green" cannot be printed unqualified
// over a section that never executed. See the PARTIAL COVERAGE note in _verdict.mjs.
const partials = results.filter((r) => r.partial?.length);
const passedPartial = passed.filter((r) => r.partial?.length);
const notPassing = [...failed, ...broken, ...timedOut, ...badExit, ...noVerdict];

// Every result must land in exactly one bucket. Computed here, outside the report
// branch, because it also decides the exit code: a tally that does not add up is a
// broken runner, and a broken runner reporting 0 is the worst outcome this script
// has — it is the same class of defect as the console.assert probes that printed a
// success line unconditionally.
const bucketed = passed.length + failed.length + broken.length + timedOut.length + badExit.length + skipped.length + diagnostics.length + noVerdict.length;

if (AS_JSON) {
  console.log(JSON.stringify({
    listId: LIST_ID,
    discovered: discovered.length,
    shard: SHARD || null,
    total: results.length,
    passed: passed.length,
    failed: failed.length,
    broken: broken.length,
    timedOut: timedOut.length,
    badExit: badExit.length,
    skipped: skipped.length,
    diagnostics: diagnostics.length,
    noVerdict: noVerdict.length,
    partialCoverage: partials.length,
    suites: results.map(({ output: _output, ...rest }) => rest),
  }, null, 2));
} else {
  console.log(`\n${"─".repeat(78)}`);
  console.log(`${results.length} suite(s)${shardLabel}: ${passed.length} passed${passedPartial.length ? ` (${passedPartial.length} with declined sections)` : ""}, ${failed.length} failed, ${broken.length} broken, ${timedOut.length} timed out, ${badExit.length} bad exit code, ${noVerdict.length} stated no verdict, ${skipped.length} skipped, ${diagnostics.length} diagnostic (asserted nothing)`);

  // The fingerprint belongs NEXT TO the tally, not only in the header.
  //
  // It was printed once at the top of the run and then again only under --list, so a
  // reader scrolling to the summary saw a count with nothing to check it against. On
  // 2026-08-21 a report paired "list 8d7fd854 (78 discovered)" with "80 suite(s)" —
  // two numbers that cannot both describe one run — and the discrepancy survived
  // being read by three people because the two figures were 80 lines apart. Whatever
  // produced it (a stale --list, or two probe files added mid-session), the tally is
  // the place where a mismatch has to be visible, because the tally is the thing
  // people quote.
  //
  // --shard, --filter and --bail all narrow the run on purpose, so only an
  // unnarrowed run is expected to account for every discovered suite.
  const narrowed = Boolean(SHARD || FILTER || BAIL);
  const ranAll = results.length === discovered.length;
  console.log(
    ranAll
      ? `${listId} — every discovered suite ran`
      : narrowed
        ? `${listId} — narrowed run, not the full set`
        : `${listId} — MISMATCH: ${discovered.length} discovered but ${results.length} ran. This tally does not cover the discovered set.`
  );

  // The buckets are derived from one array, so this can only fire if a status is
  // added to runSuite without a matching bucket here — at which point suites would
  // silently vanish from the tally while the run still exited 0.
  if (bucketed !== results.length) {
    console.log(`ACCOUNTING BUG: buckets sum to ${bucketed} but ${results.length} suite(s) ran — ${results.length - bucketed} unaccounted for. Fix the bucket list before trusting any number above.`);
  }

  if (shardLabel) {
    // A green shard is not a green run, and a report that says "all passed" after one
    // shard is the same lie this runner exists to prevent.
    console.log(`This is ONE SHARD. The other shards are unverified by this run.`);
    // Adding up shards is only valid when every shard saw the same file set. Print the
    // id next to the instruction so the check is in front of whoever does the adding.
    console.log(`Before summing shards, confirm every shard printed ${listId} — a different id means a different file set.`);
  }

  if (skipped.length) {
    // Printed even when everything is green: a skip is missing coverage, and the
    // reader has to know which guarantees this run did NOT check.
    console.log(`\nSKIPPED — declined to run, so they verified nothing here:`);
    skipped.forEach((r) => console.log(`  ${r.file} — ${r.summary}`));
  }

  if (diagnostics.length) {
    // Printed even when everything is green, for the same reason as SKIPPED: these
    // suites ran to completion and checked nothing, so their green is not coverage.
    console.log(`\nDIAGNOSTIC — ran, asserted nothing, so they verified nothing:`);
    diagnostics.forEach((r) => console.log(`  ${r.file} — ${r.summary}`));
  }

  if (partials.length) {
    // Printed even when everything is green, for the same reason as SKIPPED and
    // DIAGNOSTIC — and it is the shape those two sections could not express. Before
    // 2026-09-05 a suite that ran 56 checks and declined one section was filed under
    // SKIPPED in its entirety (probe-validation-gaps.mjs, whose fixture .gitignore
    // keeps out of the repo, so that is its only shape in a fresh clone), while three
    // suites whose decline lines were missing the colon reported unqualified green.
    // Name the file, then the sections, because a partial pass is a pass with a hole
    // in it and the hole is what the reader needs.
    console.log(`\nPARTIAL COVERAGE — ran and reported, but these sections declined:`);
    for (const r of partials) {
      console.log(`  ${r.file}`);
      r.partial.forEach((l) => console.log(`    │ ${l}`));
    }
  }

  if (broken.length) {
    // Print the ERROR, not just which signature matched.
    //
    // This used to print `${file} — ${why[0]}`, where why[0] was the matched
    // signature text. For a template like /ENOENT: no such file or directory/ that
    // renders as literally "ENOENT: no such file or directory" — no path, no
    // importer, no stack. On 2026-08-21 a run reported seven BROKEN suites and the
    // report contained nothing that could distinguish a missing fixture from a
    // half-installed node_modules from a bad cwd, so the next step had to be
    // guesswork. A broken suite's output is short by definition, so there is no
    // reason to withhold it.
    //
    // The line is located in OUTPUT order rather than signature order. The old
    // BROKEN_SIGNATURES.map(...).find(Boolean) returned whichever signature sits
    // earliest in that array, which is not necessarily the error that killed the
    // process — with both a SyntaxError and an ERR_MODULE_NOT_FOUND present it
    // reported the module error because it is listed first.
    console.log(`\nBROKEN — these could not start, so they verified NOTHING:`);
    for (const r of broken) {
      const lines = r.output.split("\n").map((l) => l.trimEnd());
      const at = lines.findIndex((l) => BROKEN_SIGNATURES.some((re) => re.test(l)));
      console.log(`  ${r.file}`);
      const show = at === -1
        // A signature can match across a line break, in which case there is no
        // single culprit line to point at; the tail is where the throw lands.
        ? lines.filter(Boolean).slice(-6)
        : lines.slice(at, at + 6).filter(Boolean);
      show.forEach((l) => console.log(`    │ ${l}`));
    }
  }
  if (badExit.length) {
    console.log(`\nBAD EXIT CODE — printed a failure but exited 0 (a probe that cannot fail):`);
    badExit.forEach((r) => console.log(`  ${r.file} — ${r.summary}`));
  }
  if (noVerdict.length) {
    // The summary shown here is the suite's LAST line, which is all there was to
    // show — that is the point. F-074's row read `PASS  verify-statistics.mjs  Set
    // STATS_FILE=... to run it`: the evidence that the suite verified nothing was
    // printed inside a green row for weeks. Name the remedy, because the reader of
    // this section is usually the person who just wrote the suite.
    console.log(`\nNO VERDICT — exited 0 without stating a result, so nothing about them is known:`);
    noVerdict.forEach((r) => console.log(`  ${r.file} — last line was: ${r.summary}`));
    console.log(`  Fix in the suite: print its own PASSED/FAILED summary, or declare "SKIP: <why>", or "DIAGNOSTIC: no assertions".`);
  }
  if (timedOut.length) {
    console.log(`\nTIMED OUT after ${TIMEOUT_S}s:`);
    timedOut.forEach((r) => console.log(`  ${r.file}`));
  }
  if (failed.length) {
    console.log(`\nFAILED:`);
    failed.forEach((r) => console.log(`  ${r.file} — ${r.summary}`));
    console.log(`\nFirst failing suite's output (${failed[0].file}):`);
    console.log(failed[0].output.split("\n").map((l) => `  │ ${l}`).join("\n"));
  }
  // "All green." on its own overclaimed: before 2026-08-23 the four DIAGNOSTIC
  // printers sat in the PASS bucket, so a run with zero assertions in four suites
  // still printed an unqualified all-clear. Say what green does not cover.
  //
  // Each caveat carries its OWN predicate, changed 2026-09-05 when partial coverage
  // joined the list. The sentence used to end "— that many suites verified nothing
  // here", one shared tail for two items that happened to mean the same thing. A
  // suite that ran 56 checks and declined one section verified plenty, so that tail
  // would have been false of it, and a false qualifier is worse than none: it invites
  // the reader to discount the whole line.
  const caveats = [
    skipped.length ? `${skipped.length} declined to run` : null,
    diagnostics.length ? `${diagnostics.length} asserted nothing` : null,
    partials.length ? `${partials.length} left a section unrun` : null,
  ].filter(Boolean);
  console.log(
    notPassing.length
      ? `\nNOT GREEN.`
      : caveats.length
        ? `\nAll green, except: ${caveats.join("; ")} — green does not cover those.`
        : `\nAll green.`
  );
}

process.exit(notPassing.length || bucketed !== results.length ? 1 : 0);
