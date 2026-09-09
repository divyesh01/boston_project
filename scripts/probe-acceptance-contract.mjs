// scripts/probe-acceptance-contract.mjs — the discovered gate for the real-data
// acceptance harness.
//
// WHY A WRAPPER INSTEAD OF RENAMING. scripts/acceptance-harness.mjs predates
// the probe-/verify- convention and is a poor direct suite: it needs Vite SSR,
// ten gitignored REAL HotelKey exports (real hotel data must never be
// committed, so a fresh clone cannot run it), and several minutes of
// fake-indexeddb deletes. Sweeping it blindly would turn every constrained
// environment red for reasons that are not regressions. This probe states the
// acceptance contract the way verify-all can run it:
//
//   1. vite importable, else SKIP (same idiom as scripts/verify-harness.mjs);
//   2. all ten real-data CSVs present, else SKIP (same idiom as
//      probe-validation-gaps.mjs and verify-statistics.mjs — a missing
//      gitignored fixture is Not Run, never a pass and never a fail);
//   3. otherwise spawn the harness as a child with a hard outer budget,
//      assert exit 0 plus a PASSED verdict with zero failures, and propagate
//      any failure loudly.
//
// The default `npm run verify:all` fits this probe with no flags: the runner
// pins a 1600 s budget for this file (SUITE_TIMEOUT_S in scripts/verify-all.mjs,
// measured workload ~325-500 s on Windows under load) while every fast probe
// keeps the 240 s default and its hang detection. An explicit --timeout flag is
// still honoured exactly.
//
//   npm run verify:all -- --only probe-acceptance-contract
//
// Env passthrough: HARNESS_SKIP, HARNESS_TIMING and HARNESS_TIMEOUT_MS are
// honoured by the child; ACCEPTANCE_BUDGET_MS overrides this probe's own outer
// budget (default 1500000 ms, deliberately above the child's 1200000 ms default
// so the child's own watchdog — FAILED + exit 124 — fires first and the
// timeout here only catches a child that ignores even that).

import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HARNESS = path.join(ROOT, "scripts", "acceptance-harness.mjs");
const REPORT = path.join(ROOT, "scripts", "acceptance-report.json");

let pass = 0;
let fail = 0;
const failures = [];
function check(name, ok, detail = "") {
  if (ok) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    failures.push(detail ? `${name} — ${detail}` : name);
    console.log(`  FAIL  ${detail ? `${name} — ${detail}` : name}`);
  }
}

// The ten real exports the harness imports. Kept in sync with IMPORT_FILES in
// scripts/acceptance-harness.mjs by the assertion below that fails if the two
// lists disagree — a checklist comment alone would rot.
const REQUIRED_CSVS = [
  "Occupancy Summary midelboro.csv",
  "Source Summary (1).csv",
  "Gross Revenue Report midelboro.csv",
  "Payments Summary.csv",
  "Payments Summary (1).csv",
  "Payments Summary (2).csv",
  "Source Summary.csv",
  "Source Summary (2).csv",
  "Source Summary (3).csv",
  "Clerk Shift.csv",
];

// ── Pre-flight 1: vite ─────────────────────────────────────────────
try {
  await import("vite");
  check("vite is importable, so the SSR harness can boot", true);
} catch (e) {
  console.log(`SKIP: vite is unavailable in this environment (${e?.message?.split("\n")[0] || e}).`);
  console.log("      The acceptance harness loads the real app through Vite SSR; run where `npm install` was built for this platform.");
  process.exit(0);
}

// ── Pre-flight 2: real-data exports ────────────────────────────────
const missing = REQUIRED_CSVS.filter((f) => !existsSync(path.join(ROOT, "scripts", "data", f)));
if (missing.length) {
  console.log(`SKIP: ${missing.length} real-data HotelKey export(s) absent from scripts/data/ (gitignored by design):`);
  missing.slice(0, 4).forEach((f) => console.log(`        - ${f}`));
  if (missing.length > 4) console.log(`        …and ${missing.length - 4} more`);
  console.log("      Without the real exports the harness cannot state its contract; run where the exports exist.");
  process.exit(0);
}
check("all ten real-data exports present", true);

// ── Pre-flight 3: the CSV list has not drifted from the harness ────
const harnessSrc = await import("node:fs").then((fs) => fs.readFileSync(HARNESS, "utf8"));
const drift = REQUIRED_CSVS.filter((f) => !harnessSrc.includes(`'${f}'`));
check("wrapper CSV list matches the harness IMPORT_FILES", drift.length === 0, drift.join(", "));

// ── Run the harness as a budgeted child ────────────────────────────
const BUDGET_MS = Number(process.env.ACCEPTANCE_BUDGET_MS || "") || 1_500_000;
// A verdict must come from THIS run: remove any report a previous run left
// behind, so a child that dies before writing cannot inherit a stale green.
try { rmSync(REPORT, { force: true }); } catch { /* already gone */ }
// The runner advertises the kill budget it will apply to THIS probe as
// VERIFY_ALL_SUITE_TIMEOUT_S (pinned to 1600 s for this file in
// SUITE_TIMEOUT_S in scripts/verify-all.mjs). Refuse to start when that outer
// budget is smaller than this probe's own outer timer: otherwise a healthy
// child is SIGKILLed mid-run and the gate reports TIMEOUT for a workload that
// never had a chance. A bare run (no env) keeps the probe's own budget.
const RUNNER_BUDGET_S = Number(process.env.VERIFY_ALL_SUITE_TIMEOUT_S || "");
if (RUNNER_BUDGET_S) {
  check(
    `runner budget (${RUNNER_BUDGET_S}s) covers the probe outer budget (${Math.ceil(BUDGET_MS / 1000)}s)`,
    RUNNER_BUDGET_S >= Math.ceil(BUDGET_MS / 1000),
    "raise the SUITE_TIMEOUT_S entry in verify-all.mjs; do not shrink this probe to fit a smaller kill timer",
  );
  if (fail > 0) {
    console.log(`\nFAILED: ${pass} passed, ${fail} failed`);
    process.exit(1);
  }
} else {
  console.log("  (runner budget not advertised — bare run; the probe's own outer budget applies)");
}
console.log(`\nSpawning acceptance-harness.mjs with a ${(BUDGET_MS / 1000).toFixed(0)}s outer budget…`);
const t0 = Date.now();
const r = spawnSync(process.execPath, [HARNESS], {
  cwd: ROOT,
  encoding: "utf8",
  timeout: BUDGET_MS,
  maxBuffer: 64 * 1024 * 1024,
  env: {
    ...process.env,
    VITE_SKIP_DEP_SCAN: "1",
    VITE_TEST: "1",
    NODE_ENV: "production",
    VITE_USE_LOCAL_AUTH: "true",
  },
});
const secs = ((Date.now() - t0) / 1000).toFixed(1);
// Child stdout AND stderr are read for the verdict, because a crash prints to
// stderr. NOTE (2026-09-09 classification, no fix): one green run carried a
// single stderr line, "WebSocket server error: Port 24678 is already in use",
// which no file in this repository can emit (repo-wide grep: zero hits in
// src/, scripts/ and backend/; nothing on the harness path binds a fixed
// port — Vite runs middlewareMode, the harness spawns no children). It
// appeared once during heavy concurrent-agent activity on the shared box;
// three subsequent full harness runs stayed green. It cannot affect the
// verdict: BROKEN signatures do not match it and the PASSED/FAILED counts
// decide independently of stderr. Documented here so the next sighting is
// recognised as external noise; do not build port logic around it.
const out = `${r.stdout || ""}\n${r.stderr || ""}`;

if (r.error && r.error.code === "ETIMEDOUT") {
  check(`harness completed within budget (ran ${secs}s)`, false, `spawn timed out at ${(BUDGET_MS / 1000).toFixed(0)}s and the child was killed`);
} else {
  check(`harness completed within budget (ran ${secs}s)`, true);
}

const verdict = out.match(/^(?:PASSED|FAILED):\s*(\d+)\s*passed,\s*(\d+)\s*failed/m);
check("harness printed a PASSED:/FAILED: verdict line", Boolean(verdict), "no summary line — the run states nothing");
if (verdict) {
  const [, okCount, failCount] = verdict;
  check("verdict line opens with PASSED (not FAILED)", verdict[0].startsWith("PASSED"), verdict[0].slice(0, 80));
  check("verdict reports zero failures", Number(failCount) === 0, `${okCount} passed, ${failCount} failed`);
}
check("harness exited 0", r.status === 0, `exit=${r.status} signal=${r.signal || "none"}${r.error ? ` spawn-error=${r.error.code}` : ""}`);

// The report file is gitignored, so this asserts the run's side effect, not a
// tracked artifact. A passing run that wrote no report proved nothing durable.
check("acceptance-report.json was written", existsSync(REPORT), "run exited without writing its report");
if (existsSync(REPORT)) {
  try {
    const report = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(REPORT, "utf8")));
    // total > 0, not a fixed floor: HARNESS_SKIP legitimately narrows a run
    // (sections are stateful; skipping is for slow sandboxes), and a narrowed
    // green run is still green — the skips are declared in the output, never
    // silent. A verdict over zero checks would be vacuous, so that fails.
    check(
      "report summary agrees with the verdict (0 failed, non-vacuous)",
      report?.summary?.failed === 0 && report?.summary?.total > 0,
      JSON.stringify(report?.summary || null),
    );
  } catch (e) {
    check("acceptance-report.json parses as JSON", false, e?.message || String(e));
  }
}

// Declared narrows are informational, like verify-all's PARTIAL COVERAGE: a
// skipped section verified nothing, and the reader must know which.
const skippedSections = (r.stdout || "").split("\n").filter((l) => l.includes("skipped via HARNESS_SKIP"));
if (skippedSections.length) {
  console.log(`\nNARROWED RUN — ${skippedSections.length} section(s) declined via HARNESS_SKIP (verified nothing here):`);
  skippedSections.forEach((l) => console.log(`  ${l.trim()}`));
}

console.log(`\n${"─".repeat(70)}`);
console.log(`probe-acceptance-contract: ${pass} passed, ${fail} failed (harness ran ${secs}s)`);
if (fail > 0) {
  console.log(`\nFAILED: ${pass} passed, ${fail} failed`);
  console.log("\nFailures:");
  failures.forEach((f) => console.log(`  · ${f}`));
  const tail = (r.stdout || "").trim().split("\n").slice(-12).join("\n");
  if (tail) console.log(`\nHarness tail:\n${tail.split("\n").map((l) => `  │ ${l}`).join("\n")}`);
  process.exit(1);
}
console.log(`\nPASSED: ${pass} passed, 0 failed`);
process.exit(0);
