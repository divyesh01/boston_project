// Probe: the emitted build's chunk graph — no cycles, nothing lazy on first paint.
//
//   node scripts/probe-build-chunks.mjs
//
// Reads dist/ only. It does not run a build: rollup's native binding is
// per-platform and absent whenever node_modules was installed for another OS
// (the same reason verify-harness.mjs and probe-import.mjs SKIP), so this suite
// grades the artifact that is actually going to be served instead of trying to
// produce one. If dist/ is absent it SKIPs rather than inventing a verdict.
//
// WHY THIS EXISTS. Two facts measured in the build dated 2026-08-23 (vite 6.4.3),
// neither of which any other gate can see — lint, typecheck and every other
// suite read source, and source looked perfectly correct in both cases:
//
//   1. index.html modulepreloaded pdf-vendor — 594,722 bytes of jspdf +
//      html2canvas — on EVERY page load: 34% of a 1,728,124-byte first-paint
//      payload, for a library no first paint uses. The cause was not a stray
//      import in src/. src/lib/pdfExport.js is the only static importer of
//      jspdf, and it is reached only from lazy routes. The entry chunk imported
//      exactly ONE binding from pdf-vendor, `_`, which is Vite's ~2 kB
//      __vitePreload helper: the helper had been assigned to the PDF chunk, and
//      because the entry lazy-loads every route it has to import the helper, so
//      the entire PDF library was dragged into the critical path with it.
//
//   2. query-vendor and ui-vendor imported each other — the "Circular chunk:
//      query-vendor -> ui-vendor -> query-vendor" build warning. react's own CJS
//      module had landed in ui-vendor (which exported requireReact) while
//      react/jsx-runtime had landed in query-vendor. react-vendor, chart-vendor
//      and data-vendor imported ui-vendor too, so no vendor chunk could be
//      cached independently of the icon library.
//
// One root cause behind both: `manualChunks` in its object form resolves each
// listed string to that package's ENTRY module and walks static dependencies
// from there, so it never claims (a) ids carrying ?commonjs-* suffixes, which is
// where a CJS package's real code lives, (b) secondary entry points such as
// react/jsx-runtime that no walk from react/index.js reaches, or (c) rollup's own
// virtual modules (\0commonjsHelpers.js, \0vite/preload-helper), which are not
// packages and cannot be named in that form at all. Everything the walk misses is
// placed by rollup's automatic algorithm, and where it lands is invisible until
// someone reads the emitted graph. That is what this file does.
//
// The assertions are graph properties and library-presence facts rather than byte
// budgets tuned to today's tree. There is exactly one size ceiling and it is a
// deliberately loose backstop; the reasoning for its value is at the assertion.

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const ASSETS = join(DIST, "assets");

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

console.log("=== PROBE: EMITTED CHUNK GRAPH ===\n");

// ── 0. SKIP when there is no build to grade ─────────────────────────────────
if (!existsSync(join(DIST, "index.html")) || !existsSync(ASSETS)) {
  console.log("SKIP: no dist/ to read — run `npm run build` first.");
  console.log("      Reported as SKIP rather than PASS: an artifact that does not");
  console.log("      exist cannot be shown to be free of the defects above.");
  process.exit(0);
}

// -- 0b. SKIP when the build predates the source that produced it ------------
// A stale artifact cannot answer the question this suite asks. dist/ is a
// build output, not source, and it is regenerated on the deploy host -- so a
// dist/ older than vite.config.js describes chunking that the current source
// no longer produces. Grading it would be wrong in BOTH directions: a red on a
// defect already fixed in source, or a green on one just introduced. Reported
// as SKIP and never as PASS, naming the newest input, so it cannot be mistaken
// for coverage. (Same reasoning as the SKIPs in verify-harness.mjs and
// probe-config-exposure.mjs -- see scripts/_verdict.mjs.)
const distStamp = statSync(join(DIST, "index.html")).mtimeMs;
const inputs = [join(ROOT, "vite.config.js"), join(ROOT, "package.json")];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else inputs.push(full);
  }
})(join(ROOT, "src"));
const newer = inputs
  .filter((f) => statSync(f).mtimeMs > distStamp)
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
if (newer.length) {
  console.log(`SKIP: dist/ is older than ${newer.length} of its ${inputs.length} inputs - run \`npm run build\`.`);
  console.log(`      Newest input: ${relative(ROOT, newer[0])}`);
  console.log("      Reported as SKIP rather than PASS or FAIL: a build that predates its");
  console.log("      own source says nothing about what that source emits today.");
  process.exit(0);
}

// ── 1. What the browser is told to fetch before anything renders ────────────
// Vite emits the entry as <script type="module" src> and every chunk the entry
// statically imports as <link rel="modulepreload">. That set IS the first-paint
// payload, which is why it is read from index.html rather than inferred.
const html = readFileSync(join(DIST, "index.html"), "utf8");
const entryHref = html.match(/<script[^>]+type="module"[^>]+src="([^"]+)"/)?.[1] ?? "";
const preloadHrefs = [...html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="([^"]+)"/g)]
  .map((m) => m[1]);

ok(entryHref.endsWith(".js"), "index.html declares a module entry script", `got ${JSON.stringify(entryHref)}`);
ok(preloadHrefs.length >= 2,
  "index.html declares modulepreload links (floor 2)",
  `found ${preloadHrefs.length}`);

const eagerHrefs = [entryHref, ...preloadHrefs];
const missing = eagerHrefs.filter((h) => !existsSync(join(DIST, h.replace(/^\//, ""))));
ok(missing.length === 0,
  "every file index.html asks for exists in dist/ (the build is complete, not partial)",
  missing.join(", "));

// ── 2. The chunk graph, read out of the emitted JS ──────────────────────────
// Both forms matter: `from"./x.js"` is a bindings import and `import"./x.js"` is
// the bare side-effect form rollup emits for hoisted transitive imports.
const jsFiles = readdirSync(ASSETS).filter((f) => f.endsWith(".js"));
const edges = new Map();
for (const f of jsFiles) {
  const text = readFileSync(join(ASSETS, f), "utf8");
  const deps = new Set();
  for (const re of [/\bfrom\s*["']\.\/([^"']+\.js)["']/g, /\bimport\s*["']\.\/([^"']+\.js)["']/g]) {
    for (const [, dep] of text.matchAll(re)) deps.add(dep);
  }
  edges.set(f, deps);
}
const edgeCount = [...edges.values()].reduce((n, s) => n + s.size, 0);
console.log(`  ${jsFiles.length} chunks, ${edgeCount} static chunk-to-chunk edges\n`);

ok(jsFiles.length >= 20, "found the emitted chunks (floor 20)", `found ${jsFiles.length}`);
ok(edgeCount >= 20, "the import parser is live (floor 20 edges)", `found ${edgeCount}`);

// ── 3. Cycle detection, self-tested first ───────────────────────────────────
// A cycle between chunks is legal ES modules and usually runs, because the
// bindings involved tend to be hoisted function declarations. It is not
// harmless: chunk A's filename is baked into chunk B and vice versa, so neither
// can be cached independently of the other, and the day a minifier turns one of
// those hoisted functions into a top-level const the cycle becomes a
// temporal-dead-zone error — a blank page with no message.
function findCycle(graph) {
  const state = new Map(); // 1 = on stack, 2 = done
  const stack = [];
  let found = null;
  function visit(node) {
    if (found) return;
    if (state.get(node) === 1) {
      found = [...stack.slice(stack.indexOf(node)), node].join(" -> ");
      return;
    }
    if (state.get(node) === 2) return;
    state.set(node, 1);
    stack.push(node);
    for (const dep of graph.get(node) ?? []) visit(dep);
    stack.pop();
    state.set(node, 2);
  }
  for (const node of graph.keys()) visit(node);
  return found;
}

// Prove the detector can answer both ways before its verdict on the real graph
// is worth anything. A detector that always returned null would make the
// assertion below pass while checking nothing.
const acyclic = new Map([["a", new Set(["b", "c"])], ["b", new Set(["c"])], ["c", new Set()]]);
const cyclic = new Map([["a", new Set(["b"])], ["b", new Set(["c"])], ["c", new Set(["a"])]]);
ok(findCycle(acyclic) === null, "the cycle detector reports no cycle on an acyclic fixture");
ok(typeof findCycle(cyclic) === "string", "the cycle detector finds a cycle on a cyclic fixture",
  `got ${findCycle(cyclic)}`);

const cycle = findCycle(edges);
ok(cycle === null, "no chunk imports another chunk that imports it back", cycle ?? "");

// ── 4. Nothing lazy in the first-paint path ─────────────────────────────────
// Marker strings, not chunk names: a chunk name proves nothing about what is
// inside it, and this defect was precisely a chunk whose name said "pdf" being
// pulled in for a 2 kB helper. jsPDF and html2canvas both write their own names
// into their output (measured 87 and 23 occurrences), so their presence in an
// eagerly fetched chunk is direct evidence the library ships on first paint.
const eagerFiles = eagerHrefs.map((h) => h.replace(/^\/assets\//, ""));
for (const marker of ["jsPDF", "html2canvas"]) {
  const guilty = eagerFiles.filter((f) => {
    const p = join(ASSETS, f);
    return existsSync(p) && readFileSync(p, "utf8").includes(marker);
  });
  ok(guilty.length === 0,
    `${marker} is not in any eagerly fetched chunk (it is only needed when a report is exported)`,
    guilty.join(", "));
}

// One size backstop. 1,300,000 is not a target anyone tuned: the measured
// first-paint payload was 1,728,124 bytes, of which 594,722 was the PDF chunk
// that did not belong there, leaving 1,133,402. The ceiling sits above that with
// room to grow, so it fails on a regression of the same magnitude rather than on
// ordinary drift. Raise it only with a measurement that says why.
const eagerBytes = eagerFiles.reduce((n, f) => {
  const p = join(ASSETS, f);
  return n + (existsSync(p) ? statSync(p).size : 0);
}, 0);
console.log(`\n  first-paint JS: ${eagerBytes.toLocaleString("en-US")} bytes across ${eagerFiles.length} chunks\n`);
ok(eagerBytes <= 1_300_000,
  "first-paint JS stays under the 1,300,000-byte backstop",
  `${eagerBytes.toLocaleString("en-US")} bytes`);

console.log("\n" + "=".repeat(72));
console.log(`${failed === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${failed} failed`);
if (failures.length) {
  console.log("\nFailures:");
  failures.forEach((f) => console.log("  x " + f));
}
console.log("=".repeat(72));
process.exit(failed > 0 ? 1 : 0);
