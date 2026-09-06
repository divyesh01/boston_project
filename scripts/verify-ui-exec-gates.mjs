// Verification harness for the ui-exec control primitives.
//
//   node scripts/verify-ui-exec-gates.mjs
//
// Pure text. No DOM, no Dexie, no build step — runs anywhere with zero install.
//
// WHY THIS FILE EXISTS. Four control primitives were added to
// src/components/ui-exec/ — Button.jsx, Input.jsx, Select.jsx and
// SegmentedControl.jsx — and adopted across Dashboard/Statistics/Transactions/
// Payroll. They depend on CSS tokens in src/index.css and on the global
// :focus-visible { outline: 2px solid var(--brand) } indicator.
//
// The two existing gates (scripts/probe-premium-surfaces.mjs and
// scripts/verify-motion.mjs) are string-level scanners — NEITHER compiles CSS.
// That leaves a set of escapes that compile to broken-but-silent output, none of
// which either gate catches for the four new primitives. This file closes them.
// It is a SEPARATE gate on purpose: adding to the existing files risks disturbing
// their proven 131 / 217 tallies, and this keeps the new coverage isolated and
// auditable. The existing gates continue to run and keep their own tallies.
//
// The five blind spots, all confirmed against this repo's tailwind 3.4.19:
//
//   (a) DEAD SHADOW. `shadow-[var(--x)]` (bare var, no `shadow:` type hint)
//       compiles to `--tw-shadow-color: var(--x)` and emits NO box-shadow at all
//       — the element renders flat, the build succeeds, nothing warns. The
//       hinted form `shadow-[shadow:var(--x)]` names the property and emits a
//       real box-shadow. FAILS on any file under src/ whose `shadow-[` is
//       immediately followed by `var(` or `--` instead of the `shadow:` hint.
//       Offset-first (`shadow-[0_6px_...]`) and hex-first forms are NOT flagged:
//       their first token is a valid type hint, so they DO emit box-shadow.
//
//   (b) transition-all IN A PRIMITIVE. transition-all animates layout too, so a
//       control that reflows slides. The existing gate bans it by name only in
//       Card/KpiCard; this extends the ban to ALL of src/components/ui-exec/.
//
//   (c) RAW HEX IN A NEW PRIMITIVE. A hex typed into a primitive becomes a hex on
//       every page that composes it — the exact sprawl the token set replaced.
//       The existing hex ban is hand-listed to Card/KpiCard/Sparkline/Badge and
//       does not cover the four new primitives. This adds them. Scope is the four
//       NAMED files, deliberately NOT the whole ui-exec/ directory: StatusBadge.jsx
//       carries raw hex tone tokens in code and RangePicker.jsx names legacy hexes
//       in comments — both pre-existing and out of scope for this change, and a
//       directory-wide ban would go red on them without touching a new primitive.
//
//   (d) SUPPRESSED FOCUS RING. `focus-visible:outline-none` / `focus:outline-none`
//       kills the global emerald outline the stock shadcn button suppresses. FAILS
//       if any file under src/components/ui-exec/ contains either exact form. A
//       bare `outline-none` (RangePicker.jsx pairs one with its own focus:border)
//       is intentionally NOT flagged — only the two focus-scoped suppressions are.
//
//   (e) CLIPPED FOCUS RING (informational only). outline-offset: 2px means an
//       ancestor with overflow-hidden can clip the focus ring of a flush control.
//       That is layout geometry a string gate cannot judge, so this is a WARNING
//       that prints overflow-hidden occurrences in the four adopted pages with
//       line numbers for a reviewer to check in a browser. It never fails.
//
// Comments are documentation, not code. Every scan strips comments first (same
// semantics as probe-premium-surfaces.mjs) so a file that EXPLAINS a defect — as
// three of the four primitives do for outline-none and the shadow hint — is not
// reported as carrying it.
//
// SELF-TEST HOOK. Setting UIEXEC_SELFTEST_FILE=<path-relative-to-repo-root> adds
// that one file to every scan set, so a fixture carrying the exact defects can be
// injected to prove each assertion goes red, then removed to prove it goes green
// again. The inline "detector sensitivity" assertions below additionally prove,
// on every normal run, that each detector fires on a known-bad string and stays
// quiet on the known-good form.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, sep } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SRC = join(ROOT, "src");
const UIEXEC = join(SRC, "components", "ui-exec");

const stripComments = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");

const relOf = (p) => p.slice(ROOT.length + 1).split(sep).join("/");

let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, label, detail = "") {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("=".repeat(72));
console.log("UI-EXEC CONTROL PRIMITIVES — verification");
console.log("=".repeat(72));

// ── Detectors ────────────────────────────────────────────────────────────────
// A bare var() or -- as the FIRST token after `shadow-[` is the dead-shadow bug.
// The hinted form `shadow-[shadow:...`, an offset-first `shadow-[0_...`, and a
// hex-first `shadow-[#...` all begin with a valid type hint and DO emit a shadow.
const BAD_SHADOW = /shadow-\[\s*(?:var\(|--)/;
const TRANSITION_ALL = /transition-all/;
const HEX = /#[0-9a-fA-F]{3,8}\b/;
const OUTLINE_NONE = /focus-visible:outline-none|focus:outline-none/;

// ── Detector sensitivity (always-on mutation proof) ──────────────────────────
// Each detector is exercised against a known-bad and a known-good literal every
// run, so a check that has been silently defanged (e.g. a regex edited to never
// match) fails HERE instead of passing vacuously over clean files.
console.log("\n  Detector sensitivity:");
ok(BAD_SHADOW.test("shadow-[var(--elev-1)]"), "(a) detector flags bare-var shadow-[var(--x)]");
ok(BAD_SHADOW.test("shadow-[--elev-1]"), "(a) detector flags shadow-[--token]");
ok(!BAD_SHADOW.test("shadow-[shadow:var(--elev-2)]"), "(a) detector allows hinted shadow-[shadow:var(--x)]");
ok(!BAD_SHADOW.test("shadow-[0_6px_18px_rgba(0,0,0,0.3)]"), "(a) detector allows offset-first shadow-[0_...]");
ok(!BAD_SHADOW.test("shadow-[#00E096]"), "(a) detector allows hex-first shadow-[#...] (still emits a shadow)");
ok(TRANSITION_ALL.test("transition-all"), "(b) detector flags transition-all");
ok(!TRANSITION_ALL.test("transition-[background-color,box-shadow,color]"), "(b) detector allows enumerated transition-[...]");
ok(HEX.test("text-[#00E096]"), "(c) detector flags a raw #hex");
ok(!HEX.test("text-[var(--brand)]"), "(c) detector allows a var() token");
ok(OUTLINE_NONE.test("focus-visible:outline-none"), "(d) detector flags focus-visible:outline-none");
ok(OUTLINE_NONE.test("focus:outline-none"), "(d) detector flags focus:outline-none");
ok(!OUTLINE_NONE.test("outline-none transition-colors"), "(d) detector does NOT flag a bare outline-none (RangePicker keeps its own)");

// ── File collection ──────────────────────────────────────────────────────────
function walk(dir, exts, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules") walk(p, exts, acc);
    } else if (exts.some((x) => e.name.endsWith(x))) {
      acc.push(p);
    }
  }
  return acc;
}

// Optional injected fixture (self-test hook). Added to BOTH scan sets so a single
// fixture can exercise every check at once.
const FIXTURE = process.env.UIEXEC_SELFTEST_FILE
  ? join(ROOT, process.env.UIEXEC_SELFTEST_FILE)
  : null;
if (FIXTURE) {
  if (existsSync(FIXTURE)) console.log(`\n  [self-test] injecting fixture: ${relOf(FIXTURE)}`);
  else console.log(`\n  [self-test] WARNING: UIEXEC_SELFTEST_FILE not found: ${relOf(FIXTURE)}`);
}

const srcFiles = walk(SRC, [".jsx", ".tsx", ".js", ".ts", ".css"]);
if (FIXTURE && existsSync(FIXTURE) && !srcFiles.includes(FIXTURE)) srcFiles.push(FIXTURE);

const uiExecFiles = walk(UIEXEC, [".jsx", ".tsx", ".js", ".ts"]);
if (FIXTURE && existsSync(FIXTURE) && !uiExecFiles.includes(FIXTURE)) uiExecFiles.push(FIXTURE);

// The four new primitives this change introduced. Hex ban is scoped here.
// FOUR_NAMED is the list WITHOUT the optional injected fixture, so the existence
// assertion in (c) below judges only the four files that must always be there.
const FOUR_NAMED = ["Button.jsx", "Input.jsx", "Select.jsx", "SegmentedControl.jsx"]
  .map((n) => join(UIEXEC, n));
const FOUR = [...FOUR_NAMED];
if (FIXTURE && existsSync(FIXTURE) && !FOUR.includes(FIXTURE)) FOUR.push(FIXTURE);

const readStripped = (p) => stripComments(readFileSync(p, "utf8"));

// ── (a) Dead shadow across all of src/ ───────────────────────────────────────
{
  const offenders = [];
  for (const f of srcFiles) {
    if (BAD_SHADOW.test(readStripped(f))) offenders.push(relOf(f));
  }
  ok(offenders.length === 0,
    "(a) no file under src/ uses shadow-[var(...)] / shadow-[--...] without the `shadow:` type hint " +
    "(that form emits --tw-shadow-color and NO box-shadow)",
    offenders.join(", "));
  console.log(`\n  (a) scanned ${srcFiles.length} files under src/ for dead-shadow forms`);
}

// ── (b) transition-all anywhere in ui-exec ───────────────────────────────────
{
  const offenders = [];
  for (const f of uiExecFiles) {
    if (TRANSITION_ALL.test(readStripped(f))) offenders.push(relOf(f));
  }
  ok(offenders.length === 0,
    "(b) no file under src/components/ui-exec/ uses transition-all (it animates layout; enumerate properties)",
    offenders.join(", "));
  console.log(`  (b) scanned ${uiExecFiles.length} files under ui-exec/ for transition-all`);
}

// ── (c) raw hex in the four new primitives ───────────────────────────────────
{
  const offenders = [];
  for (const f of FOUR) {
    if (!existsSync(f)) continue;
    const hits = [...readStripped(f).matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
    if (hits.length) offenders.push(`${relOf(f)} [${hits.join(", ")}]`);
  }
  ok(offenders.length === 0,
    "(c) none of Button/Input/Select/SegmentedControl carries a raw hex colour (tokens only)",
    offenders.join("; "));
  // The `if (!existsSync(f)) continue;` above keeps the aggregate assertion alive
  // over a silently smaller set: rename Button.jsx and "(c) none of Button/Input/
  // Select/SegmentedControl carries a raw hex colour" still passes, having read
  // three files. The count printed on the next line was the only trace, and a
  // printed number nobody diffs is not a gate — so the count is now asserted.
  // All four paths are tracked, which makes absence a broken checkout or a rename
  // that must update FOUR_NAMED, not an optional configuration; a skip line would
  // let that rename drop a primitive out of the hex ban for good. FIXTURE is
  // excluded because it is genuinely optional (see :146) — that one may be absent.
  const missingPrimitives = FOUR_NAMED.filter((f) => !existsSync(f));
  ok(missingPrimitives.length === 0,
    "(c) all four named ui-exec primitives exist (a missing one shrinks the hex scan without changing the verdict)",
    missingPrimitives.map(relOf).join(", "));
  console.log(`  (c) scanned ${FOUR.filter(existsSync).length} named primitives for raw hex`);
}

// ── (d) suppressed focus ring anywhere in ui-exec ────────────────────────────
{
  const offenders = [];
  for (const f of uiExecFiles) {
    if (OUTLINE_NONE.test(readStripped(f))) offenders.push(relOf(f));
  }
  ok(offenders.length === 0,
    "(d) no ui-exec primitive uses focus-visible:outline-none / focus:outline-none " +
    "(that suppresses the global emerald focus ring)",
    offenders.join(", "));
  console.log(`  (d) scanned ${uiExecFiles.length} files under ui-exec/ for focus-ring suppression`);
}

// ── (e) INFORMATIONAL: overflow-hidden in the four adopted pages ─────────────
// outline-offset: 2px lets an ancestor with overflow-hidden clip the focus ring
// of a control flush to its edge. This is layout geometry a string gate cannot
// judge, so this is a documented WARNING with line numbers — never a failure.
{
  const PAGES = ["Dashboard.jsx", "Statistics.jsx", "Transactions.jsx", "Payroll.jsx"]
    .map((n) => join(SRC, "pages", n));
  console.log("\n  (e) WARNING — overflow-hidden in adopted pages (may clip a flush control's focus ring;");
  console.log("      verify in a browser that focusable controls are not flush against a clipped ancestor):");
  let total = 0;
  for (const p of PAGES) {
    if (!existsSync(p)) { console.log(`      ${relOf(p)}: (not found)`); continue; }
    const lines = readFileSync(p, "utf8").split("\n");
    const hits = [];
    lines.forEach((l, i) => { if (l.includes("overflow-hidden")) hits.push(i + 1); });
    total += hits.length;
    console.log(`      ${relOf(p)}: ${hits.length ? hits.map((n) => `L${n}`).join(", ") : "none"}`);
  }
  console.log(`      total overflow-hidden occurrences across the four pages: ${total} (informational, non-failing)`);
}

console.log("\n" + "=".repeat(72));
console.log(`PASS ${pass}   FAIL ${fail}`);
if (failures.length) {
  console.log("\nFailures:");
  failures.slice(0, 40).forEach((f) => console.log("  ✗ " + f));
  if (failures.length > 40) console.log(`  ... and ${failures.length - 40} more`);
}
console.log("=".repeat(72));
console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
