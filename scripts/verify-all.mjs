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
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

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
// Convention over configuration: probe-*.mjs and verify-*.mjs are suites. Anything
// else in scripts/ is tooling (generators, loaders, stubs) and is not run.
//
// EXCLUSIONS are listed with a reason, and each reason is a factual statement about
// the file — not a judgement. A suite must never be excluded merely because it is
// failing; that is the one thing this runner exists to surface.
const EXCLUDE = new Map([
  ["verify-all.mjs", "this runner"],
  ["verify-brain.mjs", "documentation gate, not a behaviour suite — run via npm run brain:verify"],
  // Library, not a suite: it exports a fixture builder for other probes to import
  // and has no assertions of its own.
  ["probe-auth-hardening-world.mjs", "fixture library imported by other probes"],
]);

const isSuite = (f) =>
  f.endsWith(".mjs") &&
  (f.startsWith("probe-") || f.startsWith("verify-")) &&
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

// Signatures of a suite that could not start, as opposed to one that ran and
// failed. Kept explicit so a new import-time failure mode has to be added here
// deliberately rather than being quietly counted as a normal test failure.
const BROKEN_SIGNATURES = [
  /ERR_MODULE_NOT_FOUND/,
  /does not provide an export named/,
  /Cannot find module/,
  /ERR_UNSUPPORTED_DIR_IMPORT/,
  /SyntaxError/,
  /ENOENT: no such file or directory/,
];

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
      const broken = !killed && code !== 0 && BROKEN_SIGNATURES.some((re) => re.test(out));

      // Prefer the suite's own summary line for the one-line report.
      const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
      const summary =
        lines.filter((l) => /^(PASS|FAIL|PASSED|FAILED)\b|passed,\s*\d+\s*failed|all scenarios correct/i.test(l)).pop()
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
      const counted =
        summary.match(/(\d+)\s*(?:check\(s\)\s*)?failed/i) ||
        summary.match(/\bFAIL(?:ED)?[:\s]+(\d+)\b/i);
      const claimsFailure = counted
        ? Number(counted[1]) > 0
        : /^\s*(FAIL|FAILED)\b/i.test(summary);
      const lyingExitCode = code === 0 && claimsFailure;

      // A suite may legitimately decline to run: verify-harness.mjs and
      // probe-import.mjs need vite (whose rollup native binding is absent when
      // node_modules was installed for another platform), and
      // probe-config-exposure.mjs needs a live dev server. Reporting those as
      // FAIL trains the reader to ignore red, and reporting them as PASS claims
      // coverage that does not exist. They print a line starting with "SKIP:" and
      // exit 0; this is the only way to be counted as skipped.
      const skipLine = lines.find((l) => /^SKIP:/i.test(l));
      const skipped = code === 0 && !!skipLine;

      resolve({
        file,
        code,
        ms,
        killed,
        broken,
        lyingExitCode,
        skipped,
        status: killed ? "TIMEOUT"
          : broken ? "BROKEN"
          : lyingExitCode ? "BAD-EXIT"
          : skipped ? "SKIP"
          : code === 0 ? "PASS"
          : "FAIL",
        summary: skipped ? skipLine : summary,
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
const label = { PASS: "PASS   ", FAIL: "FAIL   ", BROKEN: "BROKEN ", TIMEOUT: "TIMEOUT", "BAD-EXIT": "BADEXIT", SKIP: "SKIP   " };

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
const notPassing = [...failed, ...broken, ...timedOut, ...badExit];

// Every result must land in exactly one bucket. Computed here, outside the report
// branch, because it also decides the exit code: a tally that does not add up is a
// broken runner, and a broken runner reporting 0 is the worst outcome this script
// has — it is the same class of defect as the console.assert probes that printed a
// success line unconditionally.
const bucketed = passed.length + failed.length + broken.length + timedOut.length + badExit.length + skipped.length;

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
    suites: results.map(({ output, ...rest }) => rest),
  }, null, 2));
} else {
  console.log(`\n${"─".repeat(78)}`);
  console.log(`${results.length} suite(s)${shardLabel}: ${passed.length} passed, ${failed.length} failed, ${broken.length} broken, ${timedOut.length} timed out, ${badExit.length} bad exit code, ${skipped.length} skipped`);

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
  console.log(notPassing.length ? `\nNOT GREEN.` : `\nAll green.`);
}

process.exit(notPassing.length || bucketed !== results.length ? 1 : 0);
