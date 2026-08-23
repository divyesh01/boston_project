// Probe: every internal import in src/ resolves to a real file, case-exactly.
//
//   node scripts/probe-startup.mjs
//
// Pure filesystem + text. No module is loaded, no DOM, no Dexie, no network.
//
// WHAT THIS FILE USED TO BE — and its own header was the worst part of it.
// Line 1 read "try to import every source module to find the one that crashes".
// It never imported anything. It walked src/, ran two scans, and threw both
// verdicts away:
//
//   * The import check was an EMPTY LOOP BODY. It harvested every specifier,
//     tested `if (imp.startsWith('.'))`, and the body of that `if` contained
//     nothing but the comment "relative import — not our concern here". Not one
//     specifier was ever checked against disk.
//   * The class=/className scan was real, but only console.log'd "WARN:" and
//     never failed.
//
// It ended with `console.log('Basic syntax scan complete')` and exited 0
// unconditionally, so `npm run verify:all` carried a suite whose headline claim
// (module loading) was fiction and whose two implemented halves could not fail.
// A header that overstates coverage is worse than no suite at all, because it
// answers "is import resolution covered?" with a confident yes.
//
// WHAT IT CHECKS NOW, and why each half earns its place:
//
//  1. RESOLUTION. Every relative and every "@/" specifier in src/ must name a
//     file that exists. An import of a deleted or renamed module is a blank
//     white screen at startup, and neither real gate catches it: eslint has no
//     import resolver configured, and `tsc -p jsconfig.json` reports unresolved
//     specifiers only for files inside its `include` — src/components/ui and
//     src/vite-plugins are excluded there. This walk excludes nothing.
//
//  2. CASE. Resolution runs against a Set of real filenames in their exact
//     case, NOT through existsSync. Windows and macOS are case-insensitive,
//     Linux is not, and Vercel builds on Linux — so `@/lib/Hotel` for a file
//     named hotel.js works on the owner's machine and breaks the production
//     build. existsSync cannot see that class of bug when run from Windows; a
//     Set lookup sees it from anywhere. Two self-tests below prove the resolver
//     really does reject a wrong-case target and a missing one, on whatever
//     platform is running it — a resolver that silently accepted everything
//     would let every assertion here pass while checking nothing, which is the
//     exact failure mode this file was rewritten to escape.
//
//  3. vi.mock SPECIFIERS. `vi.mock("@/lib/x")` is resolved too. A mock aimed at
//     a module that no longer exists does not error: vitest registers a factory
//     nothing ever requests, the real module loads instead, and the test goes on
//     passing while mocking nothing at all.
//
//  4. class= IN JSX. Kept from the original, now fails instead of warning.
//     React silently drops an unknown `class` attribute, so the styling simply
//     never appears and nothing in the console says why.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const posix = (p) => p.split("\\").join("/");

let pass = 0;
let failed = 0;
const failures = [];
function ok(cond, label, detail = "") {
  if (cond) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("=== PROBE: INTERNAL IMPORTS RESOLVE, CASE-EXACTLY ===\n");

// ── 1. Walk src/ once ────────────────────────────────────────────────────────
// `everyFile` is the resolution universe and holds EVERY file, not just source:
// `import "@/index.css"` is a real specifier that must resolve. `sourceFiles` is
// the narrower set that gets scanned for specifiers and for class=.
const everyFile = new Set();
const sourceFiles = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full);
      continue;
    }
    everyFile.add(posix(relative(ROOT, full)));
    if (/\.(jsx?|tsx?)$/.test(entry) && !entry.endsWith(".d.ts")) sourceFiles.push(full);
  }
})(join(ROOT, "src"));

console.log(`  ${sourceFiles.length} source files, ${everyFile.size} files total under src/\n`);

// Anti-vacuity floors, deliberately far below the measured 275 / 276. These are
// not expectations to keep in step with the tree — they exist so that a walk
// broken by a bad path or a changed extension filter reports zero and fails,
// rather than sailing through with nothing to check.
ok(sourceFiles.length >= 200, "the walk found the source tree (floor 200 files)",
  `found ${sourceFiles.length}`);
ok(everyFile.size >= sourceFiles.length,
  "the resolution universe is at least as large as the scanned set");

// ── 2. The "@/" mapping, read from the repo rather than assumed ──────────────
// This mapping is declared in THREE independent places and all three must agree
// or a specifier resolves in one toolchain and not another:
//   jsconfig.json      -> typecheck (tsc -p ./jsconfig.json)
//   vitest.config.js   -> the vitest suites
//   @base44/vite-plugin -> the dev server and the production build, as
//                          resolve.alias { "@/": "/src/" }
// The third lives in node_modules and is therefore NOT asserted here: pinning a
// gate to the internals of an installed package would turn any routine plugin
// bump into a red suite, which teaches people to ignore the suite. It is
// recorded in this comment so a future reader knows where the build's copy is.
const jsconfig = read("jsconfig.json");
const aliasTarget = jsconfig.match(/"@\/\*"\s*:\s*\[\s*"([^"]+)"/)?.[1] ?? "";
ok(aliasTarget === "./src/*",
  'jsconfig.json maps "@/*" to "./src/*" — the mapping this probe resolves against',
  `got ${JSON.stringify(aliasTarget)}`);

const vitestConfig = read("vitest.config.js");
ok(/"@":\s*path\.resolve\([^,)]+,\s*"\.\/src"\)/.test(vitestConfig),
  'vitest.config.js maps "@" to ./src as well, so a specifier cannot resolve under one gate and not the other');

// ── 3. The resolver ─────────────────────────────────────────────────────────
// Extension order mirrors what a bundler tries. Directory imports fall back to
// an index file. Membership is tested against the exact-case Set, which is what
// makes this platform-independent.
const EXTENSIONS = [
  "", ".js", ".jsx", ".ts", ".tsx", ".json", ".css",
  "/index.js", "/index.jsx", "/index.ts", "/index.tsx",
];

function resolveInternal(fromFile, specifier) {
  let base;
  if (specifier.startsWith(".")) {
    base = posix(relative(ROOT, resolve(dirname(fromFile), specifier)));
  } else if (specifier.startsWith("@/")) {
    base = `src/${specifier.slice(2)}`;
  } else {
    return "external"; // bare package specifier — node_modules' problem, not ours
  }
  return EXTENSIONS.map((ext) => base + ext).find((cand) => everyFile.has(cand)) ?? null;
}

// Four patterns rather than one. A single combined regex missed multi-line
// import clauses (`import {\n a\n} from "@/x"`) because the character class
// excluding newlines never reached the `from`, which silently dropped ~50
// specifiers from an earlier draft of this file. Anchoring on `from` instead
// covers static imports and re-exports whatever the line breaks look like.
const PATTERNS = [
  /\bfrom\s*["']([^"'\n]+)["']/g,          // import … from "x" / export … from "x"
  /\bimport\s*\(\s*["']([^"'\n]+)["']/g,   // await import("x")
  /^\s*import\s+["']([^"'\n]+)["']/gm,     // import "x"  (side effect, e.g. index.css)
  /\bvi\.mock\(\s*["']([^"'\n]+)["']/g,    // vi.mock("x") — see header note 3
];

// ── 4. Self-tests: prove the resolver can FAIL before trusting that it passes ─
// Picked from the real tree at runtime rather than hardcoded, so this cannot
// rot into testing a filename that no longer exists.
const witness = sourceFiles
  .map((f) => posix(relative(ROOT, f)))
  .find((f) => f.startsWith("src/lib/") && /\/[a-z][a-zA-Z]*\.js$/.test(f));
ok(Boolean(witness), "found a lower-case witness module in src/lib to self-test the resolver with",
  `got ${witness}`);
if (witness) {
  const spec = `@/${witness.slice("src/".length).replace(/\.js$/, "")}`;
  ok(resolveInternal(join(ROOT, "src/App.jsx"), spec) === witness,
    `the resolver resolves a known-good specifier (${spec})`);
  const shouted = spec.replace(/[^/]+$/, (m) => m.toUpperCase());
  ok(resolveInternal(join(ROOT, "src/App.jsx"), shouted) === null,
    `the resolver REJECTS the same specifier in the wrong case (${shouted}) — case-sensitivity is live on this platform`,
    "a case-insensitive resolver would make every assertion below vacuous");
  ok(resolveInternal(join(ROOT, "src/App.jsx"), "@/lib/__definitely_not_a_module__") === null,
    "the resolver REJECTS a specifier with no file behind it");
}

// ── 5. Resolve everything ────────────────────────────────────────────────────
const unresolved = [];
const classAttr = [];
let checked = 0;
let mockSpecifiers = 0;
const sawAlias = new Set();      // files the resolver actually read an "@/" out of
const containsAlias = new Set(); // files that merely contain the substring

for (const file of sourceFiles) {
  const text = readFileSync(file, "utf8");
  const rel = posix(relative(ROOT, file));

  if (text.includes('"@/') || text.includes("'@/")) containsAlias.add(rel);

  for (let i = 0; i < PATTERNS.length; i++) {
    PATTERNS[i].lastIndex = 0;
    for (const [, specifier] of text.matchAll(PATTERNS[i])) {
      const hit = resolveInternal(file, specifier);
      if (hit === "external") continue;
      checked++;
      if (specifier.startsWith("@/")) {
        sawAlias.add(rel);
        if (i === 3) mockSpecifiers++;
      }
      if (hit === null) unresolved.push(`${rel} -> ${specifier}`);
    }
  }

  // class= where className was meant. A line carrying both is fine (a ternary
  // building a className value can legitimately contain the substring).
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (/\bclass\s*=\s*["']/.test(lines[i]) && !/className/.test(lines[i])) {
      classAttr.push(`${rel}:${i + 1}`);
    }
  }
}

console.log(`  ${checked} internal specifiers checked (${mockSpecifiers} of them vi.mock targets)\n`);

// The control that cannot rot as the tree grows: every file containing an
// alias-shaped quoted string must be a file the resolver actually pulled a
// specifier out of. If a pattern breaks, `checked` collapses while
// `containsAlias` does not, and this fails — whatever the absolute counts are.
// It is also what caught the missing vi.mock pattern: two test files carried
// "@/" only inside vi.mock calls, so the sets differed by exactly those two.
const blind = [...containsAlias].filter((f) => !sawAlias.has(f));
ok(blind.length === 0,
  "every file containing an alias-shaped string is a file the resolver read a specifier from (no pattern blind spot)",
  blind.join(", "));
ok(checked >= 500, "the resolver is live (floor 500 internal specifiers)", `checked ${checked}`);
ok(mockSpecifiers > 0, "vi.mock specifiers are among those resolved", `found ${mockSpecifiers}`);

ok(unresolved.length === 0,
  "every internal import in src/ resolves to a file that exists, in its exact case",
  unresolved.join(" | "));
ok(classAttr.length === 0,
  "no JSX uses class= where className was meant (React drops it silently and the styling just never applies)",
  classAttr.join(", "));

console.log("\n" + "=".repeat(72));
console.log(`${failed === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${failed} failed`);
if (failures.length) {
  console.log("\nFailures:");
  failures.forEach((f) => console.log("  x " + f));
}
console.log("=".repeat(72));
process.exit(failed > 0 ? 1 : 0);
