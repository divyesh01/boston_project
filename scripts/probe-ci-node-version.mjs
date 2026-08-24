// Probe: the Node version CI installs must be one the dependency tree accepts.
//
// THE DEFECT. `.github/workflows/security.yml` pinned `node-version: '20'`. Every
// run of "Security and Quality Assurance" from 2026-08-13 to 2026-08-24 failed at
// the "Run Tests" step — 32 consecutive non-successful runs — and it read like a
// code problem, so it was treated as one. It was not. jsdom@30 loads undici@8 at
// import time (`jsdom/lib/api.js:12` -> `undici/index.js:179` -> `new CacheStorage`
// at `cachestorage.js:20`), undici@8 requires Node >=22.19.0 for
// `webidl.util.markAsUncloneable`, and on Node 20 that symbol does not exist. So
// the constructor throws while the module graph is still loading, EVERY test file
// fails to start, and vitest prints "Test Files  no tests / Errors  36 errors" and
// exits 1. Reproduced on node 20.20.2 — exactly what `node-version: '20'` resolves
// to — off-mount in a throwaway prefix. Not one test had ever executed in CI.
//
// THE ROOT CAUSE, one layer up: `package.json` declared no `engines` field at all,
// so nothing in the repo stated the floor and nothing objected to the pin. npm's
// `engines` is advisory (`npm ci` prints EBADENGINE and continues), which is why
// this probe exists rather than relying on the installer to enforce it.
//
// WHAT THIS PROBE DEFENDS. Two things, in this order:
//
//   1. `package.json` `engines.node` describes EXACTLY the set of Node versions the
//      whole dependency tree accepts. Section 3 checks that as an equivalence over
//      a grid of real Node versions: for each one, `engines` must agree with the
//      verdict of all `engines.node` declarations in `package-lock.json`. Raise any
//      dependency's floor and this fails, which is correct — the pin then needs a
//      human decision, not a silent drift.
//   2. The CI pin resolves to a version inside that set (section 4), and in
//      particular is not Node 20 and not an odd, non-LTS major (section 5).
//
// The odd majors matter. jsdom (`^22.22.2 || ^24.15.0 || >=26.0.0`) and nanoid
// (`^22 || ^24 || >=26`) deliberately skip them, so a floating range or a
// `node-version-file` that resolves to "newest satisfying" would land on 25.x and
// break jsdom again in a way that looks brand new. Section 5 nails that shut.
//
// WHY THE RANGE CHECKER IS HAND-WRITTEN. `semver` is only a transitive dependency
// here, not declared in `package.json`, so importing it would make this probe
// depend on hoisting luck. Reading `package-lock.json` instead of `node_modules`
// also means the probe needs no install and behaves identically on Windows and
// Linux. The risk of a hand-written checker is that it is silently wrong and every
// later assertion passes vacuously — the exact failure mode BRAIN.md's second
// CAUTION block warns about — so section 1 validates the checker against
// hand-computed cases INCLUDING the awkward real forms in this lockfile
// (`>= 0.4`, `>=v12.22.7`, `6.* || 8.* || >= 10.*`, and `>=16 || 14 >=14.17`,
// which is an AND clause nested inside an alternative). If section 1 fails the
// probe exits immediately instead of reporting on a broken instrument.
//
// Run: node scripts/probe-ci-node-version.mjs      (no loader, no node_modules)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let pass = 0;
let fail = 0;
const failures = [];

function ok(label, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  PASS ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    failures.push(label);
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function eq(label, actual, expected) {
  ok(label, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

// ─── the range checker ────────────────────────────────────────────────────────
// Supports every comparator form present in this lockfile plus the obvious
// neighbours (`<`, `<=`, `>`, `~`). Anything it does not recognise THROWS, so a
// future dependency that ships a hyphen range or a prerelease tag breaks this
// probe loudly instead of being quietly treated as satisfied.

function parseVer(s) {
  const m = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?$/.exec(String(s).trim());
  if (!m) return null;
  const wild = (t) => t === undefined || t === "x" || t === "X" || t === "*";
  return {
    major: wild(m[1]) ? null : Number(m[1]),
    minor: wild(m[2]) ? null : Number(m[2]),
    patch: wild(m[3]) ? null : Number(m[3]),
  };
}

const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const lowerBound = (v) => [v.major ?? 0, v.minor ?? 0, v.patch ?? 0];

// The exclusive upper bound implied by a PARTIAL or wildcard version: "10.*" and
// "10" both mean [10.0.0, 11.0.0); a fully specified version implies none.
const upperExclusive = (v) => {
  if (v.major === null) return null;
  if (v.minor === null) return [v.major + 1, 0, 0];
  if (v.patch === null) return [v.major, v.minor + 1, 0];
  return null;
};

// Caret: changes that do not modify the left-most NON-ZERO element.
const caretUpper = (v) => {
  if (v.major === null) return null;
  if (v.major > 0) return [v.major + 1, 0, 0];
  if (v.minor === null) return [1, 0, 0];
  if (v.minor > 0) return [0, v.minor + 1, 0];
  if (v.patch === null) return [0, 1, 0];
  return [0, 0, v.patch + 1];
};

const tildeUpper = (v) => {
  if (v.major === null) return null;
  if (v.minor === null) return [v.major + 1, 0, 0];
  return [v.major, v.minor + 1, 0];
};

function comparator(token) {
  if (token === "*" || token === "x" || token === "X") return () => true;
  const m = /^(>=|<=|>|<|=|\^|~)?(.+)$/.exec(token);
  const op = m ? m[1] || "" : null;
  const v = m ? parseVer(m[2]) : null;
  if (!v) throw new Error(`unsupported comparator: ${JSON.stringify(token)}`);
  const L = lowerBound(v);
  const U = upperExclusive(v);
  switch (op) {
    case ">=": return (t) => cmp(t, L) >= 0;
    // ">1.x" means ">=2.0.0": every 1.x is excluded, not just 1.0.0.
    case ">": return U ? (t) => cmp(t, U) >= 0 : (t) => cmp(t, L) > 0;
    case "<=": return U ? (t) => cmp(t, U) < 0 : (t) => cmp(t, L) <= 0;
    case "<": return (t) => cmp(t, L) < 0;
    case "^": {
      const C = caretUpper(v);
      return (t) => cmp(t, L) >= 0 && (C === null || cmp(t, C) < 0);
    }
    case "~": {
      const T = tildeUpper(v);
      return (t) => cmp(t, L) >= 0 && (T === null || cmp(t, T) < 0);
    }
    case "=":
    case "": return U ? (t) => cmp(t, L) >= 0 && cmp(t, U) < 0 : (t) => cmp(t, L) === 0;
    default: throw new Error(`unsupported operator: ${op}`);
  }
}

function satisfies(version, range) {
  const t = parseVer(version);
  if (!t || t.major === null || t.minor === null || t.patch === null) {
    throw new Error(`a concrete x.y.z version is required, got ${JSON.stringify(version)}`);
  }
  const triple = [t.major, t.minor, t.patch];
  // Collapse ">= 0.4" to ">=0.4" BEFORE splitting on whitespace, or the operator
  // and its version become two separate AND clauses and the range inverts.
  const norm = String(range).trim().replace(/([<>]=?|[~^]|=)\s+/g, "$1");
  if (norm === "" || norm === "*") return true;
  return norm
    .split("||")
    .some((alt) => alt.trim().split(/\s+/).filter(Boolean).map(comparator).every((f) => f(triple)));
}

// ═══ 1. The instrument, before anything is measured with it ═══════════════════
console.log("\n=== 1. the range checker validates itself ===");
{
  // Every expectation below is hand-computed. The real lockfile ranges are marked.
  const cases = [
    // package.json engines — the fix, and its exact boundaries.
    ["22.22.2", "^22.22.2 || ^24.15.0 || >=26.0.0", true],
    ["22.22.1", "^22.22.2 || ^24.15.0 || >=26.0.0", false],
    ["22.19.0", "^22.22.2 || ^24.15.0 || >=26.0.0", false],
    ["23.11.1", "^22.22.2 || ^24.15.0 || >=26.0.0", false],
    ["24.14.0", "^22.22.2 || ^24.15.0 || >=26.0.0", false],
    ["24.15.0", "^22.22.2 || ^24.15.0 || >=26.0.0", true],
    ["25.5.0", "^22.22.2 || ^24.15.0 || >=26.0.0", false],
    ["26.0.0", "^22.22.2 || ^24.15.0 || >=26.0.0", true],
    ["27.1.0", "^22.22.2 || ^24.15.0 || >=26.0.0", true],
    // undici (real) — the package that actually threw.
    ["20.20.2", ">=22.19.0", false],
    ["22.19.0", ">=22.19.0", true],
    // lru-cache (real): a bare major is a RANGE, not an equality.
    ["20.20.2", "20 || >=22", true],
    ["21.7.3", "20 || >=22", false],
    ["22.0.0", "20 || >=22", true],
    // @noble/hashes (real): a space after the operator.
    ["20.19.0", ">= 20.19.0", true],
    ["20.18.9", ">= 20.19.0", false],
    // saxes (real): a leading "v".
    ["12.22.7", ">=v12.22.7", true],
    ["12.22.6", ">=v12.22.7", false],
    // @napi-rs/lzma (real): partial carets, and the only range that admits 25.x.
    ["22.20.0", "^22.20 || ^24.12 || >=25", true],
    ["22.19.0", "^22.20 || ^24.12 || >=25", false],
    ["23.11.1", "^22.20 || ^24.12 || >=25", false],
    ["25.5.0", "^22.20 || ^24.12 || >=25", true],
    // get-caller-file (real): ".*" wildcards, one behind an operator with a space.
    ["10.0.0", "6.* || 8.* || >= 10.*", true],
    ["7.0.0", "6.* || 8.* || >= 10.*", false],
    ["6.17.1", "6.* || 8.* || >= 10.*", true],
    // sucrase (real): "14 >=14.17" is one alternative with TWO ANDed comparators.
    // A checker that splits only on "||" reads this as ">=14.17" and lets 15.0.0
    // through; a checker that splits only on whitespace reads "14" as an OR and
    // lets 14.16.0 through. Both are wrong; both are caught here.
    ["14.17.0", ">=16 || 14 >=14.17", true],
    ["14.16.0", ">=16 || 14 >=14.17", false],
    ["15.0.0", ">=16 || 14 >=14.17", false],
    ["16.0.0", ">=16 || 14 >=14.17", true],
    // core-js (real): "*".
    ["0.4.0", "*", true],
    // array-buffer-byte-length (real): the most common range in the lockfile.
    ["0.3.0", ">= 0.4", false],
    ["22.0.0", ">= 0.4", true],
    // eslint (real): the caret's lower bound is the patch, not the minor.
    ["22.0.0", "^18.18.0 || ^20.9.0 || >=21.1.0", true],
    ["21.0.0", "^18.18.0 || ^20.9.0 || >=21.1.0", false],
    ["21.1.0", "^18.18.0 || ^20.9.0 || >=21.1.0", true],
    // vitest and vite (real) — both admit 20.x, which is why 20 looked plausible.
    ["23.0.0", "^20.0.0 || ^22.0.0 || >=24.0.0", false],
    ["20.0.0", "^18.0.0 || ^20.0.0 || >=22.0.0", true],
    // whatwg-url (real).
    ["22.14.0", "^22.14.0 || >=24.0.0", true],
    ["22.13.9", "^22.14.0 || >=24.0.0", false],
  ];

  let wrong = 0;
  for (const [v, range, want] of cases) {
    let got;
    try {
      got = satisfies(v, range);
    } catch (e) {
      got = `THREW: ${e.message}`;
    }
    if (got !== want) {
      wrong++;
      console.log(`  FAIL   checker case: ${v} vs ${JSON.stringify(range)} — got ${got}, want ${want}`);
    }
  }
  eq(`all ${cases.length} hand-computed range cases agree`, wrong, 0);

  // Non-vacuity: a checker stuck on `true` would pass a subset of the above, so
  // assert both verdicts are actually produced.
  ok("the checker returns both verdicts",
    cases.some(([, , w]) => w === true) && cases.some(([, , w]) => w === false),
    `${cases.filter((c) => c[2]).length} true / ${cases.filter((c) => !c[2]).length} false`);

  // An unrecognised form must throw, never default to satisfied.
  for (const bad of ["1.2.3 - 2.3.4", ">=22.0.0-nightly", "latest", "^"]) {
    let threw = false;
    try {
      satisfies("24.15.0", bad);
    } catch {
      threw = true;
    }
    ok(`unsupported range ${JSON.stringify(bad)} throws rather than passing`, threw);
  }
  // And a non-concrete version to test is a programming error, not a pass.
  {
    let threw = false;
    try {
      satisfies("24", ">=22.0.0");
    } catch {
      threw = true;
    }
    ok("a partial version under test throws", threw, "the caller must resolve the pin first");
  }

  if (fail > 0) {
    // Reporting on a broken instrument is worse than not reporting.
    console.log("\nThe range checker itself is wrong. Every later section would be");
    console.log("meaningless, so this probe stops here.");
    console.log(`\nFAILED: ${pass} passed, ${fail} failed`);
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
}

// ═══ 2. package.json must state the floor at all ══════════════════════════════
console.log("\n=== 2. package.json engines.node ===");
const pkg = JSON.parse(read("package.json"));
const ENGINES = pkg.engines?.node;
{
  ok("package.json declares engines.node",
    typeof ENGINES === "string" && ENGINES.length > 0,
    "its absence is the root cause: nothing stated the floor, so CI's pin went unchallenged");
  if (typeof ENGINES !== "string") {
    console.log(`\nFAILED: ${pass} passed, ${fail} failed`);
    process.exit(1);
  }
  console.log(`  engines.node = ${JSON.stringify(ENGINES)}`);
  let parsed = true;
  try {
    satisfies("24.15.0", ENGINES);
  } catch (e) {
    parsed = false;
    console.log(`  (${e.message})`);
  }
  ok("engines.node parses as a range this probe understands", parsed);
}

// ═══ 3. engines.node must equal what the dependency tree accepts ══════════════
console.log("\n=== 3. equivalence with every engines.node in package-lock.json ===");
const LOCK_RANGES = [];
{
  const lock = JSON.parse(read("package-lock.json"));
  eq("the lockfile is v3, which carries engines metadata (so no install is needed)",
    lock.lockfileVersion, 3);
  for (const [name, meta] of Object.entries(lock.packages || {})) {
    if (meta && typeof meta.engines?.node === "string") {
      LOCK_RANGES.push([name.replace(/^node_modules\//, ""), meta.engines.node]);
    }
  }
  ok("the lockfile yields a substantial set of declarations",
    LOCK_RANGES.length > 300,
    `${LOCK_RANGES.length} declarations (428 when this probe was written)`);

  // Every range must be one the checker understands, or the verdicts below are
  // partial. This is where a newly added dependency with exotic syntax surfaces.
  const unparseable = [];
  for (const [name, range] of LOCK_RANGES) {
    try {
      satisfies("24.15.0", range);
    } catch {
      unparseable.push(`${name} ${JSON.stringify(range)}`);
    }
  }
  eq("every declared range is understood by the checker", unparseable.length, 0);
  if (unparseable.length) unparseable.slice(0, 10).forEach((u) => console.log(`      ${u}`));

  const treeAccepts = (v) => LOCK_RANGES.filter(([, r]) => !satisfies(v, r));

  // Real Node releases spanning 18 -> 27, chosen to sit either side of every
  // boundary any dependency declares.
  const GRID = [
    "18.20.8", "20.0.0", "20.19.0", "20.20.2", "21.7.3",
    "22.0.0", "22.13.0", "22.19.0", "22.22.1", "22.22.2", "22.23.2",
    "23.0.0", "23.11.1",
    "24.0.0", "24.12.0", "24.14.0", "24.15.0", "24.20.0",
    "25.0.0", "25.5.0", "26.0.0", "27.1.0",
  ];

  let accepted = 0;
  let rejected = 0;
  for (const v of GRID) {
    const violations = treeAccepts(v);
    const declared = satisfies(v, ENGINES);
    if (violations.length === 0) accepted++;
    else rejected++;
    ok(`${v.padEnd(8)} engines says ${declared ? "YES" : "no "}, tree says ${violations.length === 0 ? "YES" : `no (${violations.length} violated)`}`,
      declared === (violations.length === 0),
      violations.length && violations.length <= 3
        ? violations.map(([n, r]) => `${n} ${JSON.stringify(r)}`).join("; ")
        : "");
  }

  // A grid that rejected everything would make the equivalence trivially true.
  ok("the grid straddles the boundary in both directions",
    accepted >= 4 && rejected >= 10,
    `${accepted} accepted / ${rejected} rejected`);

  // Name the binding constraints, so a reader of a failure knows who moved.
  const binding = LOCK_RANGES.filter(([, r]) => !satisfies("24.14.0", r) || !satisfies("25.5.0", r));
  console.log(`  binding constraints: ${binding.map(([n, r]) => `${n} ${JSON.stringify(r)}`).join("  |  ") || "(none)"}`);
}

// ═══ 4. The CI pin must resolve inside that set ═══════════════════════════════
console.log("\n=== 4. .github/workflows/security.yml node-version ===");
const WORKFLOW = read(".github/workflows/security.yml");
let PIN_MAJOR = null;
{
  // Strip whole-line comments first: this file documents the old '20' pin on
  // purpose, and a naive match would read the explanation as the setting.
  const live = WORKFLOW.replace(/^\s*#.*$/gm, "");

  const pins = [...live.matchAll(/^\s*node-version:\s*['"]?([^'"\s#]+)['"]?/gm)].map((m) => m[1]);
  eq("exactly one node-version is set", pins.length, 1);
  ok("no node-version-file is used",
    !/node-version-file/.test(live),
    "a version file resolving to \"newest satisfying\" would land on an odd major");

  if (pins.length === 1) {
    const pin = pins[0];
    console.log(`  node-version: ${JSON.stringify(pin)}`);
    const v = parseVer(pin);
    ok("the pin is a version this probe can resolve", v !== null && v.major !== null, pin);

    if (v && v.major !== null) {
      PIN_MAJOR = v.major;
      // actions/setup-node installs the NEWEST release matching the pin, so a
      // bare major must be judged by its newest conceivable patch, not by x.0.0.
      const resolved = v.minor === null
        ? `${v.major}.9999.9999`
        : `${v.major}.${v.minor}.${v.patch ?? 9999}`;
      console.log(`  setup-node will install the newest match; judging as ${resolved}`);

      ok("the version CI installs satisfies package.json engines",
        satisfies(resolved, ENGINES), `${resolved} vs ${ENGINES}`);

      const violations = LOCK_RANGES.filter(([, r]) => !satisfies(resolved, r));
      eq("…and violates none of the tree's declarations", violations.length, 0);
      if (violations.length) {
        violations.slice(0, 8).forEach(([n, r]) => console.log(`      ${n} ${JSON.stringify(r)}`));
      }

      // Guard the other direction too: the floor inside the pinned major must be
      // a version that actually exists, i.e. the pin cannot be a major whose
      // only acceptable releases are hypothetical.
      ok("the pinned major has a released floor inside the accepted set",
        satisfies(`${v.major}.9999.9999`, ENGINES),
        "if this fails, the pinned major is not supported at all");
    }
  }
}

// ═══ 5. The defect's own fingerprint ══════════════════════════════════════════
console.log("\n=== 5. fingerprint: Node 20 and the odd majors stay out ===");
{
  eq("Node 20 is NOT accepted by engines", satisfies("20.20.2", ENGINES), false);
  const twenty = LOCK_RANGES.filter(([, r]) => !satisfies("20.20.2", r));
  ok("…and the tree rejects it too",
    twenty.length > 0,
    `${twenty.length} declarations exclude 20.20.2, incl. ${twenty.slice(0, 3).map(([n]) => n).join(", ")}`);
  ok("the undici floor that produced the crash is still in the tree",
    LOCK_RANGES.some(([n, r]) => n === "undici" && !satisfies("20.20.2", r)),
    "markAsUncloneable is absent on 20; this is the exact symbol that threw");

  ok("CI does not pin Node 20", PIN_MAJOR !== 20, `pin major = ${PIN_MAJOR}`);

  for (const odd of [21, 23, 25]) {
    eq(`Node ${odd}.x is excluded by engines`, satisfies(`${odd}.9999.9999`, ENGINES), false);
    ok(`…and CI does not pin ${odd}`, PIN_MAJOR !== odd);
  }
  ok("the pinned major is even and >= 22",
    PIN_MAJOR !== null && PIN_MAJOR >= 22 && PIN_MAJOR % 2 === 0,
    `pin major = ${PIN_MAJOR}`);
}

// ═══ 6. The job must still actually run the gates ═════════════════════════════
console.log("\n=== 6. the workflow still runs what it claims ===");
{
  const live = WORKFLOW.replace(/^\s*#.*$/gm, "");
  for (const [label, re] of [
    ["installs with npm ci", /run:\s*npm ci\b/],
    ["runs the lint gate", /run:\s*npm run lint\b/],
    ["runs the typecheck gate via the npm script", /run:\s*npm run typecheck\b/],
    ["runs the tests", /run:\s*npm test\b/],
    ["runs the audit gate", /run:\s*npm run audit:gate\b/],
    ["verifies the production build", /run:\s*npm run build\b/],
  ]) {
    ok(label, re.test(live));
  }
  ok("the typecheck step is not a bare tsc",
    !/npx\s+tsc/.test(live),
    "there is no root tsconfig.json; bare tsc prints help and exits 1 while checking nothing");
  ok("no step is allowed to fail silently",
    !/continue-on-error/.test(live),
    "a green job that skipped a failing step is the same defect in a new costume");
  ok("the build step still declares the standalone flags",
    /VITE_USE_LOCAL_AUTH:\s*'true'/.test(live) && /VITE_STANDALONE_LOCAL:\s*'true'/.test(live),
    "without both, envGuardPlugin.js fails the production build");
}

console.log("\n" + "─".repeat(70));
console.log(`PASS ${pass}   FAIL ${fail}`);
if (fail > 0) {
  console.log(`\nFAILED: ${pass} passed, ${fail} failed`);
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
console.log(`\nPASSED: ${pass} passed, 0 failed`);
process.exit(0);
