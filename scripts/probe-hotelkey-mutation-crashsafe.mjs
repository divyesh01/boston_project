#!/usr/bin/env node
/**
 * probe-hotelkey-mutation-crashsafe.mjs — proves scripts/probe-hotelkey-mutations.mjs
 * cannot leave a mutated production source on disk when a run dies mid-mutation.
 *
 * CONTRACT PROVED. Between the mutating write and the restore, the harness holds the
 * only pristine copy of a TRACKED file. Whatever leaves that window — a throw out of
 * the suite runner, a throw out of the restore itself, a Ctrl-C — the file must be back
 * byte-for-byte before the process ends, and the restore must not depend on a git
 * command that can fail for reasons unrelated to the mutation.
 *
 * WHY IT EXISTS. It already went wrong. A verify:all sweep hit its per-suite cap during
 * M11 and killed the harness, so src/lib/transactionNorm.js was left carrying M11's
 * replacement, which reclassifies every refund as a charge. 16 assertions in
 * verify-transactions.mjs and verify-coexistence.mjs then failed against that residue
 * rather than against their own subject.
 *
 * WHY SECTION A INJECTS A THROW AND NOT A SIGNAL. MEASURED on win32: a parent calling
 * child.kill("SIGTERM") or child.kill("SIGINT") terminates the child unconditionally —
 * no process.on(signal) listener and no 'exit' listener in the child runs — and
 * child.kill("SIGKILL") on a direct child also took down a grandchild it had spawned
 * via spawnSync. A signal sent from here therefore cannot distinguish a harness that
 * restores from one that does not: on this platform there is nothing left to observe.
 * A throw is the failure mode try/finally can actually answer, so the harness carries
 * one narrowly-gated test-only fault hook (HK_MUTATE_FAULT=after-write) and section A
 * fires it. The SIGINT/SIGTERM handlers in the harness are for a real console Ctrl-C
 * and for POSIX parents; they are not what this probe measures.
 *
 * WHY SECTION B USES NO HOOK. Section A cannot separate a correct fix from one plausible
 * incomplete fix: try/finally with `git checkout -- <path>` still inside the finally
 * satisfies every assertion in section A. Section B holds `.git/index.lock` for a whole
 * run. MEASURED in a throwaway repo this session: with that file present,
 * `git status --porcelain -- <path>` exits 0 and reports correctly, while
 * `git checkout -- <path>` exits 128 ("Unable to create ... index.lock: File exists")
 * and leaves the working-tree file mutated. So the harness's clean checks keep working
 * and only a git-based restore breaks. A byte write does not care.
 *
 * WHAT THESE TEN ASSERTIONS DO NOT SEPARATE, named so "10/10" is not read as more than it
 * is. The harness has three load-bearing properties and this file proves one — a throw in
 * the gap, restored without git. Two variants pass everything here:
 *   - deleting restoreAll() from the harness's signal-handler body. Nothing here fires it
 *     because nothing here can: by the measurement above, a parent-sent SIGINT/SIGTERM on
 *     win32 runs no handler in the child, so only a human Ctrl-C at a console exercises
 *     that path. NOT RUN, and unreachable from any parent-side test on this platform.
 *   - moving the harness's `inFlight.set` to after its `writeFileSync`. That ordering exists
 *     to survive a partial write, and nothing here produces one, so both orders look
 *     identical from outside. INFERRED from the write path, not measured.
 * Closing the second is a follow-up: a `before-write` hook value that reports inFlight.size
 * would separate it. Left out of this commit deliberately, to keep the diff to the one
 * property it proves.
 *
 * HAZARD, stated because this probe creates a git lock file. <repo>/.git/index.lock is
 * created with an exclusive flag, is never created over an existing one, and is released in
 * section B's own finally, again in the outer finally, and again from the SIGINT/SIGTERM
 * handlers below — so a console Ctrl-C, the one interruption neither finally can reach, no
 * longer leaves it behind. What remains is a SIGKILL or a power loss, which nothing can
 * catch: that leaves the lock on disk, and every git command needing the index (commit,
 * add, checkout) then fails until <repo>/.git/index.lock is deleted; git prints that
 * remedy itself.
 *
 * MUST NOT be discovered by scripts/verify-all.mjs. It spawns a harness that rewrites a
 * tracked source file, and that sweep enforces its per-suite timeout with
 * child.kill("SIGKILL") — the exact signal no handler can catch. It needs the same
 * EXCLUDE entry, and for the same written reason, as the harness it drives.
 *
 * Run: node scripts/probe-hotelkey-mutation-crashsafe.mjs
 *      and via `npm run mutate:all`, alongside map:mutate and hotelkey:mutate, once that
 *      script lists it — package.json is not this file's to edit, so the wiring is stated
 *      as the intent it is rather than as a fact about the current script.
 *
 * Exit 0 only when every assertion below holds and none is inconclusive.
 */
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = "src/lib/transactionNorm.js"; // M11's file — the one the sweep really corrupted
const HARNESS = "scripts/probe-hotelkey-mutations.mjs";
const LOCK = path.join(ROOT, ".git", "index.lock");
// Named, not inlined, because a kill this cap imposes has to be reported with the number
// that caused it — otherwise the residue it produces reads as the harness's fault.
const HARNESS_TIMEOUT_MS = 300000;
const at = (p) => path.join(ROOT, p);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const git = (args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });

// Read the bytes ONCE, before anything else runs, and hand exactly these back in the
// finally at the bottom. This probe is the last line of defence: it must never be the
// thing that leaves residue, so it keeps its own pristine copy instead of trusting
// either the harness under test or git.
const originalBytes = readFileSync(at(TARGET));
const originalSha = sha(originalBytes);

const dirtyAtStart = git(["status", "--porcelain", "--", TARGET]).trim();
if (dirtyAtStart) {
  console.error(`ABORT: ${TARGET} is not clean at start:\n${dirtyAtStart}`);
  console.error("This probe spawns a harness that rewrites that file and compares the bytes");
  console.error("before and after. A dirty start makes every comparison below meaningless,");
  console.error("and the rescue write at the end would destroy the uncommitted edit.");
  // Same summary contract as the verdict line at the bottom: an abort is a FAILED
  // outcome and no caller should have to infer that from a porcelain dump.
  console.error(`FAILED: ${TARGET} was not clean before the proof started`);
  process.exit(2);
}

/** @type {{state:"PASS"|"FAIL"|"INCONCLUSIVE", id:string, label:string, detail:string}[]} */
const checks = [];
const T = (state, id, label, detail = "") => {
  checks.push({ state, id, label, detail });
  console.log(`  ${state.padEnd(12)} ${id}  ${label}${detail ? ` — ${detail}` : ""}`);
};

/**
 * Non-empty when this probe, and not the harness, is what ended a run: spawnSync's own
 * timeout kill, a spawn failure, or a signal delivered to this process. Every entry makes
 * the residue and the exit-code assertions INCONCLUSIVE about the harness rather than proof
 * of the defect — spawnSync enforces `timeout` with SIGTERM, and this file's own header
 * records that a signal is the one failure the harness gets no chance to answer on win32.
 * So a probe that killed its subject and then accused it of leaving residue would be
 * reporting its own impatience as the subject's bug.
 */
const killNotes = [];

/**
 * One harness run. `status` is null when spawnSync kills the child (its own timeout,
 * default signal SIGTERM) or fails to spawn it, so the caller must never read a null
 * status as "exited non-zero" — that is precisely the conflation this probe refuses to
 * make about its subject. Such a run is recorded in `killNotes` here, at the one place
 * that can see the signal and the elapsed time, rather than re-derived by each reader.
 */
function runHarness(label, env) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [HARNESS, "--only", "M11"], {
    cwd: ROOT,
    encoding: "utf8",
    env,
    timeout: HARNESS_TIMEOUT_MS,
  });
  const ms = Date.now() - started;
  if (r.status === null || r.signal) {
    killNotes.push(
      r.error && r.error.code === "ETIMEDOUT"
        ? `${label}'s harness run was killed by THIS PROBE's own ${(HARNESS_TIMEOUT_MS / 1000).toFixed(0)}s timeout` +
          ` (${r.signal ?? "SIGTERM"}) after ${(ms / 1000).toFixed(1)}s`
        : r.error
          ? `${label}'s harness run never completed: ${r.error.message}`
          : `${label}'s harness run did not exit on its own` +
            ` (signal=${r.signal ?? "none"}, status=${r.status ?? "null"}) after ${(ms / 1000).toFixed(1)}s`,
    );
  }
  return {
    code: r.status,
    signal: r.signal,
    error: r.error ? r.error.message : "",
    out: `${r.stdout || ""}${r.stderr || ""}`,
    ms,
  };
}

let lockHeld = false;
/** Idempotent: called by section B's own finally, by the outer finally, and by the signal
 * handlers below — the only three paths that can leave this process holding the lock. */
function releaseLock() {
  if (!lockHeld) return;
  try {
    unlinkSync(LOCK);
    lockHeld = false;
  } catch (err) {
    console.error(`\nCOULD NOT RELEASE THE GIT LOCK THIS PROBE CREATED: ${err.message}`);
    console.error(`Delete it by hand or every git command needing the index will fail:\n  ${LOCK}`);
  }
}

/**
 * The one rescue path, shared by the outer `finally` and by the signal handlers, because a
 * Ctrl-C can land while the mutant is on disk and deserves exactly the treatment a throw
 * gets. Returns true only when it had to put the pristine bytes back.
 *
 * NON-DESTRUCTIVE BY CONSTRUCTION. All this function knows is "these bytes differ from the
 * ones I read ~30s ago", and TARGET is tracked production source in a repo with concurrent
 * agents and concurrent workstreams, so the divergence could be somebody's deliberate edit
 * rather than the harness's mutant. 7c2cd47's BRAIN section 46.6 rejected a design partly
 * because "a blind `git checkout` would destroy a developer's intentional post-crash
 * edits"; a blind write of remembered bytes destroys the same edit by the same reasoning.
 * So the divergent bytes are copied out FIRST, to the OS temp dir — outside the working
 * tree, where the copy cannot appear in `git status` — and the path is printed so the
 * operator can diff it. If that copy cannot be written, nothing is overwritten at all:
 * losing an unknown edit is worse than leaving a mutant on disk that the message names.
 */
function rescuePristine() {
  const now = readFileSync(at(TARGET));
  if (sha(now) === originalSha) return false;

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const residue = path.join(tmpdir(), `${path.basename(TARGET)}.residue-${stamp}-${process.pid}`);
  try {
    // "wx": never write through an existing file. A name collision means another process
    // owns that path, and the safe answer to that is the refusal below, not a clobber.
    writeFileSync(residue, now, { flag: "wx" });
  } catch (err) {
    console.error(`\nREFUSED TO OVERWRITE ${TARGET}. Its ${now.length} on-disk bytes (sha256=${sha(now).slice(0, 16)})`);
    console.error(`differ from the pristine copy, and the scratch copy that would have preserved them could`);
    console.error(`not be written: ${err.message}`);
    console.error(`  wanted to write: ${residue}`);
    console.error(`${TARGET} is LEFT EXACTLY AS IT IS ON DISK. Diff it, keep whatever is yours, restore the rest.`);
    console.error(`FAILED: refused to overwrite the divergent on-disk bytes of ${TARGET} — no scratch copy could be saved, so nothing was destroyed`);
    process.exit(2);
  }

  writeFileSync(at(TARGET), originalBytes);
  console.error(`\nRESCUED: rewrote ${TARGET} from the pristine copy this probe took before the run`);
  console.error(`(${now.length} bytes sha256=${sha(now).slice(0, 16)} -> ${originalBytes.length} bytes sha256=${originalSha.slice(0, 16)}).`);
  console.error("The bytes that were on disk were saved OUTSIDE the repo first, so nothing is lost — diff them:");
  console.error(`  ${residue}`);
  if (killNotes.length) {
    console.error("That residue followed a kill THIS PROBE imposed, not a failure the harness was free to");
    console.error("answer, so it is INCONCLUSIVE about the harness's restore and is not proof of the");
    console.error(`defect: ${killNotes.join("; ")}.`);
  } else {
    console.error("The harness left a mutated tracked source on disk. That is the defect this proves.");
  }
  return true;
}

// A real console Ctrl-C reaches neither finally in this file, and it used to leave
// <repo>/.git/index.lock behind — after which every git add / commit / checkout in this repo
// fails until somebody deletes that file by hand — and could leave the harness's mutant on
// disk as well. Both handlers therefore do the whole cleanup: release the lock, then run the
// same non-destructive rescue the outer finally runs, then exit non-zero, because a run that
// was interrupted proved nothing. The abort is recorded in `killNotes` BEFORE the rescue, so
// a mutant caught mid-flight is reported as this probe's interruption rather than as the
// harness's failure to restore.
//
// Reach, stated the same way the harness states it, because a handler nobody can fire is
// only worth keeping if it is not mistaken for cover. MEASURED on win32: a parent calling
// child.kill("SIGTERM") or child.kill("SIGINT") terminates this process outright and NEITHER
// handler runs. So SIGINT here is live for a real console Ctrl-C, SIGTERM is inert on win32
// and live on POSIX, and a SIGKILL is caught by nothing — that last one is the exposure the
// HAZARD note at the top of this file names.
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  process.on(signal, () => {
    killNotes.push(`this probe itself received ${signal} and aborted mid-run`);
    releaseLock();
    rescuePristine();
    console.error(`\nFAILED: ${signal} received — this proof aborted before finishing and is evidence about nothing; the git lock it created was released and ${TARGET} matches its pristine bytes on disk`);
    process.exit(code);
  });
}

function sectionA() {
  console.log("--- A. a throw between the mutating write and the restore (HK_MUTATE_FAULT=after-write) ---");
  const a = runHarness("section A", { ...process.env, HK_MUTATE_FAULT: "after-write" });
  console.log(`  harness exit=${a.code} signal=${a.signal ?? "none"} ${(a.ms / 1000).toFixed(1)}s${a.error ? ` spawn-error=${a.error}` : ""}`);

  // Measure the tree BEFORE the outer finally can rescue it: the rescue is the failure
  // path of A2, so reading after it would read the rescue instead of the harness.
  const bytes = readFileSync(at(TARGET));
  const porcelain = git(["status", "--porcelain", "--", TARGET]).trim();

  T(a.code !== null && a.code !== 0 ? "PASS" : "FAIL", "A1",
    "harness exited non-zero by itself (not killed, not a spawn failure)",
    `exit=${a.code} signal=${a.signal ?? "none"}`);
  T(sha(bytes) === originalSha ? "PASS" : "FAIL", "A2",
    `${TARGET} is byte-identical to the bytes read before the run`,
    `${bytes.length} bytes sha256=${sha(bytes).slice(0, 16)} vs ${originalBytes.length} bytes sha256=${originalSha.slice(0, 16)}`);
  T(porcelain === "" ? "PASS" : "FAIL", "A3",
    "git also reports the file clean",
    porcelain === "" ? "porcelain empty" : JSON.stringify(porcelain));

  // A4/A5 are the non-vacuity pair, and they are needed because A2 and A3 pass for the
  // wrong reason on their own: a harness that threw BEFORE the write, or that ignored
  // the env var and never faulted at all, also ends with a pristine file. A4 says the
  // fault fired on M11's real target. A5 says the content the harness had just handed to
  // writeFileSync was NOT the pristine content — that write returned before the throw
  // was constructed, so non-pristine bytes provably reached the disk — and that the
  // harness's idea of pristine matches the bytes THIS process read independently, so the
  // two shas cannot be agreeing with each other while both drift from the file.
  const marker = /HK_MUTATE_FAULT after-write: (\S+) rewritten \((\d+) bytes, sha256=([0-9a-f]{64})\); pristine sha256=([0-9a-f]{64})/.exec(a.out);
  T(marker && marker[1] === TARGET ? "PASS" : "FAIL", "A4",
    "the harness reported the injected fault against M11's target",
    marker ? `target=${marker[1]}` : "no HK_MUTATE_FAULT marker in stdout/stderr");
  const wrote = marker ? marker[3] : "";
  const claimedPristine = marker ? marker[4] : "";
  T(marker && wrote !== originalSha && claimedPristine === originalSha ? "PASS" : "FAIL", "A5",
    "the mutant really was on disk: written bytes differ from pristine, and the harness's pristine sha matches this probe's own read",
    marker
      ? `wrote ${marker[2]} bytes sha256=${wrote.slice(0, 16)}, harness pristine=${claimedPristine.slice(0, 16)}, probe pristine=${originalSha.slice(0, 16)}`
      : "no marker to read");

  if (!marker || a.code === null) {
    console.log(`\n  harness output (last 20 lines):\n${a.out.trim().split("\n").slice(-20).map((l) => `    ${l}`).join("\n")}`);
  }
}

function sectionB() {
  console.log("\n--- B. the restore must not depend on git (.git/index.lock held for the whole run) ---");
  if (existsSync(LOCK)) {
    // Not a failure of the subject, and not a pass either: another git process may own
    // this lock, and clobbering it would be a worse bug than the one under test.
    T("INCONCLUSIVE", "B0", ".git/index.lock already existed — refusing to touch it", LOCK);
    return;
  }

  // "wx" = create exclusively, throw if it appeared between the check above and here.
  // Split across three statements, and the flag set the instant the file exists on disk:
  // with `closeSync(openSync(LOCK, "wx"))` as one expression, a throw out of closeSync
  // leaves the lock file created and `lockHeld` false, so neither finally removes it. That
  // is the mirror image of the ordering discipline the harness under test applies when it
  // records a mutation before writing it.
  const fd = openSync(LOCK, "wx");
  lockHeld = true;
  closeSync(fd);
  let b;
  try {
    // HK_MUTATE_FAULT is SET to an unrecognised value rather than deleted: on Windows
    // env names are case-insensitive while a spread copy of process.env is not, so
    // deleting one spelling can leave another behind. Only "after-write" is recognised.
    b = runHarness("section B", { ...process.env, HK_MUTATE_FAULT: "" });
  } finally {
    releaseLock();
  }
  console.log(`  harness exit=${b.code} signal=${b.signal ?? "none"} ${(b.ms / 1000).toFixed(1)}s${b.error ? ` spawn-error=${b.error}` : ""}`);

  const bytes = readFileSync(at(TARGET));
  const porcelain = git(["status", "--porcelain", "--", TARGET]).trim();
  // The mutation-report row, `${id.padEnd(4)} ${verdict.padEnd(9)} ${behaviour}`, not the
  // in-progress line: the row is only printed after the restore and the denominator
  // check, so matching it also proves the run reached the end rather than dying midway.
  const killed = /^M11\s+KILLED\s/m.test(b.out);

  T(!lockHeld ? "PASS" : "FAIL", "B1", "the lock this probe created was released", LOCK);
  // B2 is section B's non-vacuity assertion and it needs no hook: a KILLED verdict for
  // M11 means the fixture suite that covers it FAILED while the mutant was in place,
  // which cannot happen unless the mutant was genuinely live on disk during the vitest
  // run. So B2 and B4 together say "the mutant was applied, and it did not stay".
  T(killed ? "PASS" : "FAIL", "B2",
    "the harness still reported M11 KILLED with the index locked (the mutant was live on disk)",
    killed ? "verdict line found" : "no KILLED verdict for M11");
  T(b.code === 0 ? "PASS" : "FAIL", "B3",
    "the harness completed with exit 0 despite the locked index (its restore never shells out to git)",
    `exit=${b.code}`);
  T(sha(bytes) === originalSha ? "PASS" : "FAIL", "B4",
    `${TARGET} is byte-identical to the bytes read before the run`,
    `${bytes.length} bytes sha256=${sha(bytes).slice(0, 16)} vs ${originalBytes.length} bytes sha256=${originalSha.slice(0, 16)}`);
  T(porcelain === "" ? "PASS" : "FAIL", "B5",
    "git also reports the file clean",
    porcelain === "" ? "porcelain empty" : JSON.stringify(porcelain));

  if (b.code !== 0 || !killed) {
    console.log(`\n  harness output (last 20 lines):\n${b.out.trim().split("\n").slice(-20).map((l) => `    ${l}`).join("\n")}`);
  }
}

console.log("=== hotelkey mutation harness: crash-safety proof ===");
console.log(`target   ${TARGET}  ${originalBytes.length} bytes  sha256=${originalSha.slice(0, 16)}`);
console.log(`harness  node ${HARNESS} --only M11\n`);

let rescued = false;
try {
  sectionA();
  sectionB();
} catch (err) {
  // A throw from the proof itself must still produce a verdict line, or a caller reads
  // "no output" and cannot tell a broken probe from a green one.
  T("FAIL", "X0", "the proof itself threw before finishing", err && err.message ? err.message : String(err));
} finally {
  releaseLock();
  rescued = rescuePristine();
}

const failed = checks.filter((c) => c.state === "FAIL");
const inconclusive = checks.filter((c) => c.state === "INCONCLUSIVE");
const passed = checks.length - failed.length - inconclusive.length;
console.log(`\n${passed}/${checks.length} assertions passed, ${failed.length} failed, ${inconclusive.length} inconclusive`);
if (failed.length) console.log(`FAILING: ${failed.map((c) => c.id).join(", ")}`);
// Printed whether or not there was residue, because the exit-code assertions are the other
// thing a kill invalidates: A1 reads "exited non-zero by itself" and B3 reads "exit 0", and
// a run this probe killed fails both for a reason that says nothing about the restore.
if (killNotes.length) {
  console.log(`INCONCLUSIVE RUN: ${killNotes.join("; ")}.`);
  console.log("A run this probe ended cannot answer whether the harness restores. The FAIL rows above");
  console.log("that read an exit code, and any residue, followed that kill and are not proof of the defect.");
}
if (rescued) {
  console.log(killNotes.length
    ? "RESIDUE: a mutant was on disk after a kill this probe imposed — INCONCLUSIVE, not proof of the defect."
    : "RESIDUE: the harness left the mutant on disk and this probe had to put it back.");
}

// An inconclusive assertion is counted as not-proven, never as green: the whole point of
// this file is that the contract was verified on this machine, in this run. `killNotes` is in
// the gate too, so a probe-imposed kill exits non-zero structurally rather than only as a
// side effect of A1/B3 happening to fail.
const ok = failed.length === 0 && inconclusive.length === 0 && !rescued && killNotes.length === 0;
const residuePhrase = !rescued
  ? "none"
  : killNotes.length
    ? "PRESENT AFTER A KILL THIS PROBE IMPOSED (INCONCLUSIVE)"
    : "LEFT BY THE HARNESS";
// Verdict line for the summary contract in scripts/probe-suite-integrity.mjs: the printed
// line must open with the PASS / FAIL token. Written as a ternary so one line is honest
// for both outcomes — a suite that prints the pass token unconditionally satisfies the
// auditor and tells a sweep nothing.
console.log(`${ok ? "PASSED" : "FAILED"}: ${passed}/${checks.length} crash-safety assertions passed, ${failed.length} failed, ${inconclusive.length} inconclusive, residue ${residuePhrase}`);
process.exit(ok ? 0 : 1);
