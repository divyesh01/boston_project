#!/usr/bin/env node
// Mutation harness for the HotelKey regression net.
//
// A regression suite that cannot distinguish the correct parser from a plausibly
// broken one is decoration. This script reintroduces one real defect at a time
// into the production sources, runs the two fixture suites, and asserts that the
// suites FAIL. A mutation that survives is reported as SURVIVED — that is a hole
// in the net, not a success.
//
// Every mutation is applied by exact string replacement and undone by writing back the
// exact bytes that were read before it, so the tree is byte-identical afterwards; the
// script refuses to start unless the files it mutates are clean, and verifies cleanliness
// again at the end.
//
// The restore runs in a `finally` and retries once; if a file is still stuck after that the
// run ABORTS instead of judging the next mutation against the residue. On Windows that
// `finally` is what actually protects these files: the SIGINT/SIGTERM handlers below also
// restore whatever is in flight before exiting non-zero, but their measured reach — recorded
// where they are registered — is narrower than naming the pair implies, so they are not the
// cover here. That is not hypothetical: a sweep killed this harness during M11 and left
// src/lib/transactionNorm.js reclassifying every refund as a charge, and 16 assertions in two
// later suites then failed against the residue instead of against their own subject.
// scripts/probe-hotelkey-mutation-crashsafe.mjs proves the `finally` is reachable and that
// the restore does not depend on git.
//
//   node scripts/probe-hotelkey-mutations.mjs          # all mutations
//   node scripts/probe-hotelkey-mutations.mjs --only M3
//
// Exit code 0 only when every mutation was killed and the tree is restored.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const PARSERS = "src/lib/reportParsers.js";
const TXN_NORM = "src/lib/transactionNorm.js";
// Destination of the transaction-scanner extraction (splitTransactionSections,
// hashTransactionFile, scanTransactions). Listed as a candidate for M7 and M8
// BEFORE the code moves: the anchor is resolved across the candidate list, so the
// net follows the family across the move instead of reporting STALE the moment it
// lands. Does not exist yet, and a candidate that does not exist is inert.
const TXN_DEST = "src/lib/parsers/transactions.js";
const SCAN_SUITE = "src/lib/hotelKeyParserFixtures.test.js";
const IMPORT_SUITE = "src/lib/hotelKeyImportFixtures.test.js";

/**
 * @typedef {object} Mutation
 * @property {string} id
 * @property {string} behaviour  one of the seven behaviours the net must protect
 * @property {string[]} where    candidate files; `find` must occur exactly once
 *                               across all of them that exist, and the one file
 *                               holding that occurrence is the one mutated
 * @property {string} find       exact source text, must occur exactly once
 * @property {string} replace
 * @property {string[]} suites
 */

/** @type {Mutation[]} */
const MUTATIONS = [
  {
    id: "M1",
    behaviour: "property assignment",
    where: [PARSERS],
    find: '    property_id: meta.propertyId || "",',
    replace: '    property_id: "",',
    suites: [IMPORT_SUITE],
  },
  {
    id: "M2",
    behaviour: "property assignment (stamp-before-key ordering)",
    where: [PARSERS],
    find: "    const rows = assignDedupeKeys((scanResult.rowsToImport || []).map((r) => addMetaFn(r)));",
    replace: "    const rows = assignDedupeKeys(scanResult.rowsToImport || []).map((r) => addMetaFn(r));",
    suites: [IMPORT_SUITE],
  },
  {
    id: "M3",
    behaviour: "property isolation (file-hash guard scope)",
    where: [PARSERS],
    find: "      const priorFile = await db.entities.TransactionLine.filter({\n        file_hash: fileHash,\n        property_id: restMeta.propertyId || \"\",\n      });",
    replace: "      const priorFile = await db.entities.TransactionLine.filter({\n        file_hash: fileHash,\n      });",
    suites: [IMPORT_SUITE],
  },
  {
    id: "M4",
    behaviour: "dedupe (occurrence index)",
    where: [TXN_NORM],
    find: "    occurrence,\n  ].join(\"|\");",
    replace: "  ].join(\"|\");",
    suites: [SCAN_SUITE, IMPORT_SUITE],
  },
  {
    id: "M5",
    behaviour: "property gate (whitespace is not a property)",
    where: [PARSERS],
    find: '  if (typeof propertyId !== "string" || propertyId.trim() === "") {',
    replace: '  if (typeof propertyId !== "string" || propertyId === "") {',
    suites: [IMPORT_SUITE],
  },
  {
    id: "M6",
    behaviour: "validation gate",
    where: [PARSERS],
    find: "  if (validation && !validation.ok && !forceImport) {",
    replace: "  if (false && validation && !validation.ok && !forceImport) {",
    suites: [IMPORT_SUITE],
  },
  {
    id: "M7",
    behaviour: "stacked sections (widest section with rows wins)",
    // Anchor lives in scanTransactions, which extraction 2 moves to TXN_DEST.
    where: [PARSERS, TXN_DEST],
    find: "  let best = null;\n  for (const s of sections) {",
    replace: "  let best = null;\n  for (const s of sections.slice().reverse()) {",
    suites: [SCAN_SUITE],
  },
  {
    id: "M8",
    behaviour: "repeated headers (a second header row is data, not a header)",
    // Anchor lives in splitTransactionSections, which moves to TXN_DEST too.
    where: [PARSERS, TXN_DEST],
    find: "    if (current.headers) current.rows.push(row);",
    replace: "    if (current.headers) { if (!looksLikeHeader) current.rows.push(row); }",
    suites: [SCAN_SUITE],
  },
  {
    id: "M9",
    behaviour: "revenue + dates (trailer absorption)",
    where: [TXN_NORM],
    find: "export function isTrailerRow(mapped) {",
    replace: "export function isTrailerRow(mapped) {\n  return false;\n  // eslint-disable-next-line no-unreachable",
    suites: [SCAN_SUITE],
  },
  {
    id: "M10",
    behaviour: "malformed money (unparseable is not silently zero-clean)",
    where: ["src/lib/importValidation.js"],
    find: '    coercions.push({ field, raw: text, kind: "unparseable" });',
    replace: "    return;",
    suites: [SCAN_SUITE],
  },
  {
    // Added after an adversarial review pointed out that the revenue assertions
    // read `ledger_side`, a field production assigns here — and that NO mutation
    // touched the assignment. The suite's own comment calls this "the single most
    // expensive contract in the file", so leaving it unmutated meant the most
    // expensive contract was the least proven. Collapsing the refund branch is
    // the plausible wrong fix: every row becomes a charge, and revenue silently
    // doubles from 287.50 to 575.00 while every row count stays correct.
    id: "M11",
    behaviour: "revenue (the refund branch of the ledger-side classifier)",
    where: [TXN_NORM],
    find: '  out.ledger_side = type === "REFUND" ? LEDGER_SIDE_PAYMENT : LEDGER_SIDE_CHARGE;',
    replace: "  out.ledger_side = LEDGER_SIDE_CHARGE;",
    suites: [SCAN_SUITE],
  },
];

/** @param {string[]} args */
function git(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

/** @param {string[]} files */
function assertClean(files, when) {
  // MEASURED: `git status --porcelain --` with an EMPTY pathspec list is not a
  // no-op, it reports the WHOLE tree — an untracked scratch file anywhere would
  // abort a run that touches no production file at all. The set is empty only when
  // nothing resolved, i.e. nothing will be written, so there is nothing to protect.
  if (!files.length) return;
  const dirty = git(["status", "--porcelain", "--", ...files]).trim();
  if (dirty) {
    console.error(`\nABORT: ${when} these files are not clean:\n${dirty}`);
    console.error("This harness rewrites production sources and puts the exact bytes back.");
    console.error("Commit or stash your changes to them first.");
    // Same summary contract as the verdict line at the end of this file: an abort is
    // a FAILED outcome, and verify-all.mjs must not have to infer that from the tail
    // of a git-porcelain dump.
    console.error(`FAILED: ${when.replace(/,$/, "")} the files this harness mutates were not clean`);
    process.exit(2);
  }
}

/**
 * Resolve one mutation's anchor to exactly ONE file on disk.
 *
 * The candidate list is EXPLICIT, never a directory scan: a harness whose reach is
 * a function of what happens to be on disk absorbs the very event it exists to
 * detect. Each candidate is checked in its own line ending, because the anchors are
 * authored with \n while this repo is checked out with CRLF (core.autocrlf=true) —
 * and two candidates can disagree, so one globally-derived EOL would silently miss.
 *
 * @param {Mutation} m
 * @returns {{path:string, eol:string}|{stale:string}}
 */
function resolveAnchor(m) {
  /** @type {{path:string, eol:string, hits:number}[]} */
  const found = [];
  for (const cand of m.where) {
    let text;
    try {
      text = readFileSync(cand, "utf8");
    } catch (e) {
      // A destination that does not exist YET is inert, not an error: that is what
      // lets the net be extended before the code moves into it.
      if (e.code === "ENOENT") continue;
      throw e;
    }
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const find = m.find.split("\n").join(eol);
    found.push({ path: cand, eol, hits: text.split(find).length - 1 });
  }

  const total = found.reduce((n, c) => n + c.hits, 0);
  if (total === 0) {
    return { stale: `anchor absent from all candidates (${m.where.join(", ")}) — the source moved` };
  }
  if (total > 1) {
    const spread = found.filter((c) => c.hits > 0).map((c) => `${c.path} x${c.hits}`).join(", ");
    return { stale: `anchor found ${total}x across candidates (${spread}) (expected exactly 1) — ambiguous` };
  }
  const hit = found.find((c) => c.hits === 1);
  return { path: hit.path, eol: hit.eol };
}

/** @param {string[]} suites */
function runSuites(suites) {
  const r = spawnSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["vitest", "run", ...suites, "--reporter=dot"],
    {
      encoding: "utf8",
      shell: process.platform === "win32",
      // NODE_ENV is PINNED for the child, not inherited, and that is the whole
      // reason this harness used to be green standalone and red inside the sweep.
      //
      // MEASURED 2026-09-03. This exact command exits 0 with 51/51 from a shell.
      // Add NODE_ENV=production to the environment and nothing else, and it exits
      // 1: eleven `(client)` warnings that node:fs / node:path / node:url /
      // node:crypto "have been externalized for browser compatibility" — imported
      // by both fixture suites and by src/test-setup.js — then
      // `Error: No such built-in module: node:`, and both suites FAIL. Under
      // jsdom + production Vite resolves these files through its browser
      // environment, where the Node builtins the fixtures use to read the corpus
      // off disk become throwing stubs. The three VITE_* vars the sweep also sets
      // are harmless: measured 0 externalizations and 51/51 with all three and no
      // NODE_ENV.
      //
      // verify-all.mjs's runSuite() spawns every suite with NODE_ENV:'production',
      // so the probe inherited it and forwarded it here, and its own green-baseline
      // precondition then failed before a single mutation ran.
      //
      // Set rather than deleted: vitest sets NODE_ENV=test itself only when nothing
      // else has, and on Windows env names are case-insensitive while a spread copy
      // of process.env is not — deleting one spelling can leave another behind.
      env: { ...process.env, NODE_ENV: "test" },
    },
  );
  return { code: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
}

const only = process.argv.includes("--only")
  ? process.argv[process.argv.indexOf("--only") + 1]
  : null;
const selected = only ? MUTATIONS.filter((m) => m.id === only) : MUTATIONS;
if (!selected.length) {
  console.error(`No mutation matches --only ${only}`);
  process.exit(2);
}

/** @type {{id:string, behaviour:string, verdict:string, detail:string, names:string[]}[]} */
const results = [];

// Resolve every selected anchor BEFORE anything else runs. Two reasons for the
// order: the clean check can only reserve files once it knows which ones will
// actually be written, and a stale net is worth reporting without first spending a
// minute on a baseline that cannot change the verdict.
/** @type {{m:Mutation, path:string, eol:string}[]} */
const plan = [];
for (const m of selected) {
  const r = resolveAnchor(m);
  if ("stale" in r) {
    // Contributes no path to the clean check and is never written or reverted.
    results.push({ id: m.id, behaviour: m.behaviour, verdict: "STALE", detail: r.stale });
    console.log(`${m.id} ${"STALE".padEnd(8)} ${r.stale}`);
    continue;
  }
  plan.push({ m, path: r.path, eol: r.eol });
}

// Only the files this run will really write. Built from `plan`, not from
// MUTATIONS: reserving all eleven files' worth of cleanliness under --only made a
// single-mutation run abort over an unrelated edit it was never going to touch.
const touched = [...new Set(plan.map((p) => p.path))];
assertClean(touched, "before starting,");

// ── Crash safety ─────────────────────────────────────────────────────────────
// Read the originals ONCE, as raw bytes, and hand exactly those bytes back on restore.
// These are TRACKED production sources, so the restore must be byte-for-byte, and a utf8
// decode/re-encode round trip is not the identity function: any byte that is not valid
// UTF-8 comes back as U+FFFD. With core.autocrlf=true a file's on-disk line endings are a
// property of the checkout, never something this harness may re-decide. The decoded copy
// exists only to locate and apply an anchor.
const originalBytes = new Map(touched.map((f) => [f, readFileSync(f)]));
const originalText = new Map([...originalBytes].map(([f, b]) => [f, b.toString("utf8")]));
// A string is hashed as utf8, which is exactly what writeFileSync writes for a string, so
// the same helper covers "what I am about to write" and "what is on disk now".
const sha = (data) => createHash("sha256").update(data).digest("hex");

/**
 * The one place that knows which sources are mutated on disk right now: path → the exact
 * original bytes. `withMutation`'s `finally` and the signal handlers both restore from
 * here, so no code path can mutate a file that another path will not put back.
 *
 * An entry is added BEFORE the mutating write (a write that throws part-way through still
 * needs restoring) and removed only once the original bytes are back on disk, which makes
 * a second restore a no-op instead of a second write of stale content.
 */
const inFlight = new Map();

/** Puts every in-flight source back byte-for-byte. Returns the ones it could not. */
function restoreAll() {
  const stuck = [];
  for (const [file, bytes] of [...inFlight]) {
    try {
      writeFileSync(file, bytes);
      inFlight.delete(file);
    } catch (err) {
      // Keep going: one locked file must not strand the others. The entry stays in
      // `inFlight`, so the immediate second attempt in `withMutation`'s `finally` and the
      // signal handlers below both retry it — and if it is STILL stuck after that, the
      // mutation loop aborts rather than measuring the next mutation against the residue.
      stuck.push(`${file}: ${err.message}`);
    }
  }
  return stuck;
}

const reportStuck = (stuck) => {
  if (stuck.length) console.error(`RESTORE FAILED — tracked sources left mutated: ${stuck.join("; ")}`);
};

/**
 * Mutates one source, runs its suites, and restores byte-for-byte whatever happens next.
 *
 * The restore WRITES THE REMEMBERED BYTES; it deliberately no longer runs
 * `git checkout -- <path>`, and the difference is not cosmetic:
 *   1. a byte write needs no .git/index.lock. With a lock held, the checkout's
 *      execFileSync THROWS — stranding the mutant at the exact moment the harness was
 *      trying to remove it;
 *   2. `git checkout -- <path>` restores from the INDEX, which is not the working-tree
 *      snapshot this harness actually captured;
 *   3. under core.autocrlf=true a checkout re-applies the EOL filters instead of handing
 *      back the bytes that were read.
 *
 * HK_MUTATE_FAULT is a test-only fault hook. Exactly one value is recognised,
 * "after-write"; any other value, including an empty one, is ignored. It exists solely so
 * scripts/probe-hotelkey-mutation-crashsafe.mjs can prove this `finally` is reachable, and
 * it has to be a throw rather than a signal because MEASURED on win32 a parent calling
 * child.kill("SIGTERM") or child.kill("SIGINT") terminates this process unconditionally —
 * neither handler below runs — so a signal-based proof cannot observe a restore here at all.
 */
function withMutation(target, mutated, suites) {
  try {
    inFlight.set(target, originalBytes.get(target));
    writeFileSync(target, mutated);
    if (process.env.HK_MUTATE_FAULT === "after-write") {
      throw new Error(
        `HK_MUTATE_FAULT after-write: ${target} rewritten` +
          ` (${Buffer.byteLength(mutated, "utf8")} bytes, sha256=${sha(mutated)});` +
          ` pristine sha256=${sha(originalBytes.get(target))}; throwing before the suites run`,
      );
    }
    return runSuites(suites);
  } finally {
    // One immediate retry before reporting. On win32 a transient hold from a file indexer
    // or an AV scanner is a real thing, and a second write costs nothing next to the cost
    // of leaving a deliberately-broken production source on disk.
    //
    // Deliberately NO `process.exit` here: this `finally` can be unwinding an exception
    // that is still propagating, and exiting from it would swallow that exception's
    // message — the run would die with a restore complaint and no cause. The abort lives
    // at the end of the mutation loop instead, after this mutation's verdict is printed.
    let stuck = restoreAll();
    if (stuck.length) stuck = restoreAll();
    reportStuck(stuck);
  }
}

// A Ctrl-C, or a SIGTERM from a parent that has given up, used to land between the mutate
// and the revert and leave a deliberately-broken production source on disk. Registering a
// listener also suppresses Node's default death, so the exit is explicit and non-zero: the
// run did not finish, and no caller may read it as green. spawnSync blocks the loop, so a
// signal that arrives during a suite run is delivered when that child returns — the file is
// still in `inFlight` at that moment either way.
//
// Registered with their reach stated, because a handler nobody can fire is only worth
// keeping if it is not mistaken for cover. MEASURED on win32 this session: a parent calling
// child.kill("SIGTERM") or child.kill("SIGINT") terminates this process outright and
// NEITHER handler runs, and child.kill("SIGKILL") on this process also took down a
// grandchild it had spawned via spawnSync. So SIGINT here is live for a real console
// Ctrl-C, SIGTERM is inert on win32 and live on POSIX, and `finally` above is what actually
// protects these files on Windows.
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  process.on(signal, () => {
    const pending = inFlight.size;
    const stuck = restoreAll();
    console.error(`\n${signal} received — restored ${pending - stuck.length}/${pending} mutated file(s), aborting`);
    reportStuck(stuck);
    process.exit(code);
  });
}

// The unmutated baseline has to be green, or every "killed" below is meaningless.
process.stdout.write("baseline (no mutation) ... ");
const baseline = runSuites([SCAN_SUITE, IMPORT_SUITE]);
if (baseline.code !== 0) {
  console.error("FAILED\n");
  console.error(baseline.out.split("\n").slice(-30).join("\n"));
  console.error("\nABORT: the suites must pass before mutation results mean anything.");
  console.error(`FAILED: baseline suites red (exit ${baseline.code}) — 0 mutations run`);
  process.exit(2);
}
const baseTests = /Tests\s+(\d+) passed/.exec(baseline.out)?.[1] ?? "?";
console.log(`green (${baseTests} tests)\n`);

for (const { m, path: target, eol } of plan) {
  const before = originalText.get(target);
  // `eol` comes from the resolve pass, which detected it on the file that actually
  // holds the anchor. Re-deriving it here from where[0] would be wrong the moment
  // the anchor resolves in a later candidate.
  const find = m.find.split("\n").join(eol);
  const replace = m.replace.split("\n").join(eol);

  // Printed before the mutating write, so nothing at all sits between that write and the
  // fault hook's throw. Same stdout as when it sat after the write: nothing else prints
  // in between, and this line is now on screen whatever the mutation does next.
  process.stdout.write(`${m.id} ${target} running ... `);
  const run = withMutation(target, before.replace(find, replace), m.suites);

  // Re-read from disk as BYTES and compare digests, not decoded text: this is THE
  // assertion that the restore was byte-for-byte, so comparing anything other than the
  // real file bytes would be comparing a normalisation of them. It is a different
  // instrument from the `assertClean` below — this one knows what was read at 00:00, git
  // knows what is committed — and a RESIDUE verdict needs both.
  const afterBytes = readFileSync(target);
  const restored = sha(afterBytes) === sha(originalBytes.get(target));
  // Anchor on vitest's "Tests" summary line. A bare /(\d+) failed/ matches the
  // "Test Files" line first and reports a FILE count as a test count.
  const failed = /^\s*Tests\s+(\d+) failed/m.exec(run.out);
  const names = [...run.out.matchAll(/^\s*(?:×|✕|FAIL)\s+(.+?)\s*$/gm)].map((x) => x[1]);
  const verdict = !restored ? "RESIDUE" : run.code !== 0 ? "KILLED" : "SURVIVED";
  const detail = !restored
    // Both numbers are real byte counts now that the comparison is over bytes; the
    // message always said "bytes" while the old string compare counted characters.
    ? `revert did not restore ${target} (${originalBytes.get(target).length} -> ${afterBytes.length} bytes;` +
      ` git porcelain: ${JSON.stringify(git(["status", "--porcelain", "--", target]).trim())})`
    : run.code !== 0
      ? `${failed?.[1] ?? "?"} test(s) failed — the net caught it`
      : "suites still passed — THE NET HAS A HOLE HERE";
  results.push({ id: m.id, behaviour: m.behaviour, verdict, detail, names });
  console.log(`${verdict.padEnd(8)} ${detail}`);
  // Which assertion caught it. A mutation filed under one behaviour but killed
  // only by an unrelated test is an incidental kill, not proof of that behaviour.
  for (const n of names.slice(0, 4)) console.log(`${" ".repeat(13)}↳ ${n}`);

  // A restore that failed twice is where this loop STOPS. Anything after this point would
  // measure its KILLED/SURVIVED verdict against a tree that still carries THIS mutation —
  // one layer in from the exact conflation this harness exists to prevent, and the reason
  // it is checked here rather than left to `assertClean` at the end: by then the wrong
  // verdicts are already printed and indistinguishable from real ones.
  //
  // Placed after the verdict is pushed and printed, so the RESIDUE row is on screen and in
  // the report data before the exit, and outside `withMutation`'s `finally`, so a
  // propagating exception has already carried its own message out.
  if (inFlight.size) {
    const skipped = selected.length - results.length;
    console.error(`\nABORT: ${inFlight.size} tracked source(s) are still mutated on disk after two restore attempts:`);
    for (const f of inFlight.keys()) console.error(`  ${f}`);
    console.error("Diff each one before restoring it — `git diff -- <file>` — because a blind revert would");
    console.error("also discard any edit that is genuinely yours.");
    console.error(`Skipping ${skipped} remaining mutation(s): a verdict measured against this residue would be`);
    console.error("measuring the residue and not its own subject.");
    console.error(`FAILED: restore failed after ${m.id} — ${inFlight.size} tracked source(s) left mutated, ${skipped} mutation(s) skipped`);
    process.exit(2);
  }
}

assertClean(touched, "after finishing,");

// Pin the denominator. Every selected mutation must have produced exactly one
// verdict — one STALE from the resolve pass or one from the loop. A future edit
// that `continue`s without pushing a result would shrink the divisor below instead
// of failing, which silently converts a mutation that never ran into a passing run.
if (results.length !== selected.length) {
  const missing = selected.filter((m) => !results.some((r) => r.id === m.id)).map((m) => m.id);
  console.error(`\nABORT: ${results.length} verdict(s) for ${selected.length} selected mutation(s)` +
    `${missing.length ? ` — no verdict for ${missing.join(", ")}` : ""}.`);
  console.error(`FAILED: ${results.length}/${selected.length} selected mutations produced a verdict — the harness dropped one`);
  process.exit(2);
}

console.log("\n─── mutation report ───");
for (const r of results) {
  console.log(`${r.id.padEnd(4)} ${r.verdict.padEnd(9)} ${r.behaviour}`);
}
const bad = results.filter((r) => r.verdict !== "KILLED");
const killed = results.length - bad.length;
console.log(`\n${killed}/${results.length} mutations killed`);
if (bad.length) {
  console.log(`NOT KILLED: ${bad.map((r) => `${r.id} (${r.verdict})`).join(", ")}`);
} else {
  console.log("Every mutation was caught and every mutated file was restored byte-for-byte.");
}

// Verdict line for the summary contract in scripts/probe-suite-integrity.mjs: the
// printed line must open with the PASS / FAIL token. Written as a ternary so one
// line is honest for both outcomes — a suite that prints the pass token
// unconditionally satisfies the auditor and tells a sweep nothing. Without it this
// file audited as NO_SUMMARY (hasAssertions=YES, hasExitPath=YES): the count line
// above carries the numbers but not the token, so verify-all.mjs's one-line report
// fell back to whatever this file printed last.
//
// "not killed", not "survived": bad also holds STALE (a mutation anchor that no
// longer matches the source) and RESIDUE (a revert that did not restore the file),
// and neither of those is a surviving mutant.
console.log(`${bad.length ? "FAILED" : "PASSED"}: ${killed}/${results.length} mutations killed, ${bad.length} not killed`);
process.exit(bad.length ? 1 : 0);
