// probe-clerk-persistence-helper-portable.mjs
// Portable regression probe for the PRODUCTION-exported getClerkGroupPersistence
// helper. Loads the real helper out of a source file by esbuild transformSync
// (JSX -> CJS) + Node VM with all imported modules stubbed. No helper logic is
// copied; the tested function is the one the component runs.
//
// Eventual repo location: scripts/probe-clerk-persistence-helper.mjs
// (defaults resolve relative to scripts/.. -> repo root, repo src/pages/Employees.jsx).
//
// Usage (preapply candidate proof, from this OWN folder):
//   node probe-clerk-persistence-helper-portable.mjs \
//     --repo <repository-root> \
//     --source Employees.persistence-candidate.jsx
// Usage (eventual in-repo default, no flags):
//   node scripts/probe-clerk-persistence-helper.mjs

import path from "node:path";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--repo" || a === "--source") {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) {
        fail(`missing value for ${a}`);
      }
      out[a.slice(2)] = v;
      i += 1;
    } else if (a === "--help" || a === "-h") {
      console.log(
        "usage: probe-clerk-persistence-helper-portable.mjs " +
          "[--repo <repoRoot>] [--source <employeesSourceFile>]"
      );
      process.exit(0);
    } else {
      fail(`unknown argument: ${a}`);
    }
  }
  return out;
}

function fail(msg) {
  console.error(`[FAIL] ${msg}`);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));

// scriptDir/.. is the repo root once this file lives in scripts/.
const REPO = path.resolve(args.repo || path.join(__dirname, ".."));
const CANDIDATE = path.resolve(
  args.source || path.join(REPO, "src", "pages", "Employees.jsx")
);
const REPO_PACKAGE_JSON = path.join(REPO, "package.json");

function resolveEsbuild() {
  if (!fs.existsSync(REPO_PACKAGE_JSON)) {
    fail(`repo package.json not found: ${REPO_PACKAGE_JSON}`);
  }
  try {
    const mod = createRequire(REPO_PACKAGE_JSON)("esbuild");
    if (mod && typeof mod.transformSync === "function") return mod;
    fail("resolved esbuild has no transformSync");
  } catch (e) {
    fail(
      `esbuild unavailable from supplied repo package.json (${REPO_PACKAGE_JSON}): ${
        e && e.message
      }`
    );
  }
  return null;
}

function loadProductionHelper() {
  if (!fs.existsSync(CANDIDATE)) {
    fail(`source not found: ${CANDIDATE}`);
  }
  const source = fs.readFileSync(CANDIDATE, "utf8");

  const esbuild = resolveEsbuild();

  let cjs;
  try {
    cjs = esbuild.transformSync(source, {
      loader: "jsx",
      format: "cjs",
      target: "node22",
      jsx: "transform",
      sourcemap: false,
    }).code;
  } catch (e) {
    fail(`esbuild transformSync failed: ${e && e.message}`);
  }

  // Stub every module the source imports. None of the component-level
  // bindings are invoked by getClerkGroupPersistence, so inert stubs are
  // sufficient and no real React/DOM runtime is required.
  const stubFor = (id) => {
    const anyProp = () => anyProp;
    const stub = new Proxy(
      function stubFn() {},
      {
        get(_t, prop) {
          if (prop === "default") return stub;
          if (prop === "__esModule") return true;
          if (prop === Symbol.toPrimitive) return () => `[stub:${id}]`;
          if (prop === "toString") return () => `[stub:${id}]`;
          return anyProp;
        },
        apply() {
          return stub;
        },
        construct() {
          return stub;
        },
      }
    );
    return stub;
  };

  const moduleCache = new Map();
  const wrappedRequire = (id) => {
    // Never resolve real app modules; always stub. Keeps the run free of any
    // dependency install / auth / config surface.
    if (!moduleCache.has(id)) moduleCache.set(id, stubFor(id));
    return moduleCache.get(id);
  };

  const mod = { exports: {} };
  const context = vm.createContext({
    module: mod,
    exports: mod.exports,
    require: wrappedRequire,
    __dirname: path.dirname(CANDIDATE),
    __filename: CANDIDATE,
    console,
    process,
    Buffer,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    global: undefined,
    globalThis: undefined,
    window: undefined,
    document: undefined,
    navigator: undefined,
    crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000000" },
    fetch: undefined,
    URL,
  });

  try {
    vm.runInContext(cjs, context, { filename: CANDIDATE });
  } catch (e) {
    fail(`VM evaluation of transformed source failed: ${e && e.message}`);
  }

  const fn =
    mod.exports && typeof mod.exports.getClerkGroupPersistence === "function"
      ? mod.exports.getClerkGroupPersistence
      : typeof context.getClerkGroupPersistence === "function"
        ? context.getClerkGroupPersistence
        : null;

  if (!fn) {
    fail("production export getClerkGroupPersistence not found after transform");
  }
  return fn;
}

const getClerkGroupPersistence = loadProductionHelper();

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (e) {
    console.error(`[FAIL] ${name}`);
    console.error(`       ${e && e.message}`);
    process.exit(1);
  }
}

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    console.error(`[FAIL] ${name}`);
    console.error(`       actual   = ${a}`);
    console.error(`       expected = ${b}`);
    process.exit(1);
  }
}

function group(over) {
  return Object.assign(
    {
      reviewKey: "R1",
      key: "k1",
      clerk: "Clerk",
      property_id: "p1",
      records: [],
    },
    over
  );
}

const rec = (over) =>
  Object.assign(
    {
      id: "id_1",
      review_status: "PENDING",
      resolution_notes: null,
    },
    over
  );

// 1. empty unsigned
check("empty unsigned", () => {
  const s = group({ records: [] });
  const r = getClerkGroupPersistence(s, {});
  eq("empty unsigned result", r, { isSigned: false, displayNotes: "", allResolved: false });
});

// 2. mixed reviewed/pending unsigned
check("mixed reviewed/pending unsigned", () => {
  const s = group({
    records: [
      rec({ id: "a", review_status: "RESOLVED", resolution_notes: "done a" }),
      rec({ id: "b", review_status: "PENDING" }),
    ],
  });
  const r = getClerkGroupPersistence(s, {});
  eq("mixed unsigned result", r, {
    isSigned: false,
    displayNotes: "done a",
    allResolved: false,
  });
});

// 3. all RESOLVED signed
check("all RESOLVED signed", () => {
  const s = group({
    records: [
      rec({ id: "a", review_status: "RESOLVED", resolution_notes: "n-a" }),
      rec({ id: "b", review_status: "RESOLVED", resolution_notes: "n-b" }),
    ],
  });
  const r = getClerkGroupPersistence(s, {});
  eq("all resolved result", r, {
    isSigned: true,
    displayNotes: "n-a | n-b",
    allResolved: true,
  });
});

// 4. new PENDING added to previous reviewed group -> unsigned
check("newPending added to previous reviewed group unsigned", () => {
  const s = group({
    records: [
      rec({ id: "a", review_status: "RESOLVED", resolution_notes: "n-a" }),
      rec({ id: "b", review_status: "RESOLVED", resolution_notes: "n-b" }),
      rec({ id: "c", review_status: "PENDING" }),
    ],
  });
  const r = getClerkGroupPersistence(s, {});
  eq("new pending result", r, {
    isSigned: false,
    displayNotes: "n-a | n-b",
    allResolved: false,
  });
});

// 5. notes sorted by record id; identical output under input reorder
check("notes sorted by record id and same output under input reorder", () => {
  const fwd = group({
    records: [
      rec({ id: "id_10", review_status: "RESOLVED", resolution_notes: "note-10" }),
      rec({ id: "id_2", review_status: "RESOLVED", resolution_notes: "note-2" }),
      rec({ id: "id_1", review_status: "RESOLVED", resolution_notes: "note-1" }),
    ],
  });
  const rev = group({
    records: [...fwd.records].reverse(),
  });
  const a = getClerkGroupPersistence(fwd, {});
  const b = getClerkGroupPersistence(rev, {});
  eq("id sorted notes", a.displayNotes, "note-1 | note-10 | note-2");
  eq("reorder invariant", a, b);
});

// 6. duplicated note collapses to the single distinct value
check("same duplicated note collapsed", () => {
  const s = group({
    records: [
      rec({ id: "a", review_status: "RESOLVED", resolution_notes: "same note" }),
      rec({ id: "b", review_status: "RESOLVED", resolution_notes: "same note" }),
      rec({ id: "c", review_status: "RESOLVED", resolution_notes: "same note" }),
    ],
  });
  const r = getClerkGroupPersistence(s, {});
  eq("duplicated note collapsed", r.displayNotes, "same note");
});

// 7. no local draft falls back to persisted notes
check("no draft falls back to persisted notes", () => {
  const s = group({
    reviewKey: "R7",
    records: [rec({ id: "a", review_status: "RESOLVED", resolution_notes: "persisted-7" })],
  });
  const r = getClerkGroupPersistence(s, {});
  eq("persisted fallback", r.displayNotes, "persisted-7");
});

// 8. explicit empty local draft overrides persisted notes
check("explicit empty localdraft overrides persisted", () => {
  const s = group({
    reviewKey: "R8",
    records: [rec({ id: "a", review_status: "RESOLVED", resolution_notes: "persisted-8" })],
  });
  const r = getClerkGroupPersistence(s, { R8: "" });
  eq("empty draft override", r.displayNotes, "");
});

// 9. nonempty local draft survives a same-reviewKey persisted-notes refetch
check("nonempty localdraft preserved across same key persisted-note refetch", () => {
  const drafts = { R9: "typed draft" };
  const before = group({
    reviewKey: "R9",
    records: [rec({ id: "a", review_status: "RESOLVED", resolution_notes: "old persisted" })],
  });
  const after = group({
    reviewKey: "R9",
    records: [rec({ id: "a", review_status: "RESOLVED", resolution_notes: "refetched persisted" })],
  });
  eq("draft before refetch", getClerkGroupPersistence(before, drafts).displayNotes, "typed draft");
  eq("draft after refetch", getClerkGroupPersistence(after, drafts).displayNotes, "typed draft");
});

// 10. different property/date reviewKeys never borrow a prior draft or badge
check("different property/date reviewKeys do not borrow prior draft/badge", () => {
  const drafts = { R10_A: "draft for A" };
  const signedA = group({
    reviewKey: "R10_A",
    key: "propA|2026-10-01",
    records: [rec({ id: "a", review_status: "RESOLVED", resolution_notes: "A notes" })],
  });
  const pendingB = group({
    reviewKey: "R10_B",
    key: "propB|2026-10-02",
    records: [rec({ id: "b", review_status: "PENDING" })],
  });

  const ra = getClerkGroupPersistence(signedA, drafts);
  eq("A draft applied", ra.displayNotes, "draft for A");
  eq("A badge signed", ra.isSigned, true);

  const rb = getClerkGroupPersistence(pendingB, drafts);
  eq("B ignores A draft", rb.displayNotes, "");
  eq("B badge unsigned", rb.isSigned, false);
  eq("B allResolved", rb.allResolved, false);
});

// 10b. no cross-borrow of a signed badge when only another key is signed
check("signed badge of one reviewKey never leaks to another reviewKey", () => {
  const signed = group({
    reviewKey: "RK_SIGNED",
    records: [rec({ id: "a", review_status: "RESOLVED", resolution_notes: "signed" })],
  });
  const pending = group({
    reviewKey: "RK_PENDING",
    records: [rec({ id: "z", review_status: "PENDING" })],
  });
  eq("signed stays signed", getClerkGroupPersistence(signed, {}).isSigned, true);
  eq("pending stays unsigned", getClerkGroupPersistence(pending, {}).isSigned, false);
});

console.log(`probe-clerk-persistence-helper: ${passed} cases passed`);
console.log(`PASSED: probe-clerk-persistence-helper — ${passed} passed, 0 failed`);
console.log(`source = ${CANDIDATE}`);
console.log(`repo   = ${REPO}`);
