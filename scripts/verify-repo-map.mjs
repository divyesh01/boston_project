#!/usr/bin/env node
/**
 * verify-repo-map.mjs — anti-rot gate for the AI routing layer.
 *
 * Parses the fixed-schema Markdown tables in docs/AI_REPO_GUIDE.md,
 * docs/TEST_MATRIX.md and docs/MODULE_CONTRACTS.md and fails when the map no
 * longer matches the tree. It also checks the surviving table in PROJECT_MAP.md
 * (check C9), because a verified routing layer on an unverified map still rots.
 * The Markdown files stay the source of truth and stay hand-editable: nothing here
 * generates or rewrites them.
 *
 * Tables are located by their exact header row, so the documents may contain any
 * number of other tables without confusing the parser.
 *
 * Run:   npm run map:verify
 * Prove: npm run map:mutate   (asserts every check below can still fail)
 * Gate:  .git/hooks/pre-commit (alongside verify-brain.mjs)
 *
 * Deliberately excluded from scripts/verify-all.mjs — it is a documentation
 * gate, not a behaviour suite, mirroring the existing verify-brain.mjs entry.
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rel = (p) => p.split(path.sep).join("/");
const abs = (p) => path.join(ROOT, p);

const GUIDE = "docs/AI_REPO_GUIDE.md";
const MATRIX = "docs/TEST_MATRIX.md";
const CONTRACTS = "docs/MODULE_CONTRACTS.md";
const PROJECT_MAP = "PROJECT_MAP.md";
const PROTECTED_DOC = "PROTECTED_FILES.md";

/** The ten subsystems the routing layer must answer for. Owner-defined. */
const REQUIRED_AREAS = [
  "HotelKey import",
  "Revenue/KPIs",
  "Transactions",
  "Property isolation",
  "Business sync",
  "Auth",
  "IndexedDB",
  "Payroll",
  "Payments/refunds",
  "Deployment",
];

const SCHEMAS = {
  guide: { doc: GUIDE, cols: ["Area", "Read first", "Proves it", "Gate", "Never touch"] },
  matrix: { doc: MATRIX, cols: ["Area", "Suite", "Kind", "Command"] },
  contracts: { doc: CONTRACTS, cols: ["Module", "Invariant", "Risk", "Area"] },
};

const RISKS = new Set(["PROTECTED", "HIGH", "NORMAL"]);
const KINDS = new Set(["vitest", "probe", "verify", "gate"]);

const failures = [];
const fail = (check, msg) => failures.push({ check, msg });
let checked = 0;

/* ---------------------------------------------------------------- parsing -- */

const splitRow = (line) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());

const normHeader = (c) => c.replace(/\*/g, "").trim().toLowerCase();

/**
 * Find every table in `text` whose header row matches `cols` (order-sensitive,
 * case- and emphasis-insensitive) and return its data rows.
 */
function tablesWithHeader(text, cols) {
  const lines = text.split(/\r?\n/);
  const want = cols.map(normHeader);
  const rows = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].trim().startsWith("|")) continue;
    const head = splitRow(lines[i]).map(normHeader);
    if (head.length !== want.length || head.some((h, k) => h !== want[k])) continue;
    // A GitHub table requires a --- delimiter row immediately after the header.
    if (!/^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? "")) continue;
    for (let j = i + 2; j < lines.length && lines[j].trim().startsWith("|"); j += 1) {
      const cells = splitRow(lines[j]);
      if (cells.length !== want.length) {
        fail("C6-shape", `${cols[0]} table row ${j + 1} has ${cells.length} cells, expected ${want.length}`);
        continue;
      }
      rows.push({ cells, line: j + 1 });
    }
    i += 1;
  }
  return rows;
}

/** Every `backticked` token in a cell. */
const ticks = (cell) => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim());

/** Strip bold/italics so an Area key reads the same however it is emphasised. */
const key = (cell) => cell.replace(/\*\*/g, "").replace(/^_|_$/g, "").trim();

/** `src/lib/decimal.js#sumCents` -> { file, symbol } */
function splitRef(token) {
  const hash = token.indexOf("#");
  if (hash === -1) return { file: token, symbol: null };
  return { file: token.slice(0, hash), symbol: token.slice(hash + 1) };
}

/* ------------------------------------------------------------- resolution -- */

/**
 * A backticked token that denotes a repo path.
 *
 * Three shapes, all present in this repo:
 *   · an extension we ship            src/lib/decimal.js, wrangler.jsonc
 *   · a directory                     migrations-production/
 *   · an extension-less config file   public/_headers, .gitattributes
 *
 * The third arm matters: Cloudflare's `_headers` carries the live security
 * headers, and an extension-only rule skipped it silently — the map could point
 * an agent at a deleted file and the gate would stay green.
 *
 * The first arm also accepts a `:NNN` line suffix so C2b can reject it. Without
 * that, `src/pages/Payroll.jsx:153` looked like prose, was skipped entirely, and
 * the very citation style this gate exists to ban went unchecked — proven by a
 * mutation that survived until this arm was added.
 */
const looksLikePath = (t) =>
  /^[\w.@][\w./@-]*\.(js|jsx|mjs|json|jsonc|sql|md|csv|css|html)(#.+|:\d+)?$/.test(t) ||
  /\/$/.test(t) ||
  /(^|\/)_[\w.-]+$/.test(t) ||
  /^\.[\w-]+$/.test(t);

const fileCache = new Map();
function readRepo(p) {
  if (!fileCache.has(p)) {
    fileCache.set(p, existsSync(abs(p)) && statSync(abs(p)).isFile() ? readFileSync(abs(p), "utf8") : null);
  }
  return fileCache.get(p);
}

const pathExists = (p) => (p.endsWith("/") ? existsSync(abs(p)) : readRepo(p) !== null);

/**
 * Is `symbol` exported from `file`? Covers the export forms this repo actually
 * uses: `export function f`, `export const f`, `export class C`,
 * `export { a, b as c }`, `export default`, and `const X = ...; export { X }`.
 * Also accepts a plain top-level declaration re-exported later in the file.
 */
function exportsSymbol(file, symbol) {
  const src = readRepo(file);
  if (src === null) return false;
  if (symbol === "default") return /\bexport\s+default\b/.test(src);
  const s = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const direct = new RegExp(
    `\\bexport\\s+(?:async\\s+)?(?:function\\*?|class|const|let|var)\\s+${s}\\b`,
  );
  if (direct.test(src)) return true;
  // export { a, b as sumCents } / export { sumCents } from "./x"
  for (const m of src.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(",")) {
      const nameAs = part.trim().split(/\s+as\s+/);
      const exported = (nameAs[1] ?? nameAs[0] ?? "").trim();
      if (exported === symbol) return true;
    }
  }
  return false;
}

/** Does `command` resolve to something runnable in this repo? */
function commandResolves(command, pkgScripts) {
  const npm = /^npm run ([\w:-]+)/.exec(command);
  if (npm) return Object.hasOwn(pkgScripts, npm[1]);
  const node = /(?:^|\s)(scripts\/[\w.-]+\.mjs)/.exec(command);
  if (node) return pathExists(node[1]);
  const vitest = /vitest run\s+(\S+)/.exec(command);
  if (vitest) return pathExists(vitest[1]);
  const wrangler = /^npx wrangler /.test(command);
  return wrangler;
}

/**
 * Every module a suite reaches for: static `from "x"`, dynamic `import("x")`,
 * `vi.mock("x")`, and bare path strings (probes read source files directly).
 * Both quote styles — an earlier double-quote-only scan wrongly reported four
 * single-quoted test files as importing nothing.
 */
function suiteReferences(suitePath) {
  const src = readRepo(suitePath);
  if (src === null) return new Set();
  const out = new Set();
  for (const m of src.matchAll(/["'`]([^"'`\n]+)["'`]/g)) {
    const raw = m[1].trim();
    if (!raw) continue;
    out.add(raw);
    // "@/lib/reportParsers" and "./transactionNorm" both denote a src/ module.
    if (raw.startsWith("@/")) out.add(`src/${raw.slice(2)}`);
    else if (raw.startsWith("./") || raw.startsWith("../")) {
      out.add(rel(path.normalize(path.join(path.dirname(suitePath), raw))));
    }
  }
  return out;
}

/** Does the suite reference this module, with or without its extension? */
function suiteCovers(refs, moduleFile) {
  const noExt = moduleFile.replace(/\.(jsx?|mjs)$/, "");
  const base = path.basename(moduleFile);
  const baseNoExt = base.replace(/\.(jsx?|mjs)$/, "");
  for (const r of refs) {
    const rNoExt = r.replace(/\.(jsx?|mjs)$/, "");
    if (r === moduleFile || rNoExt === noExt) return true;
    if (rNoExt.endsWith(`/${baseNoExt}`) && noExt.endsWith(rNoExt.replace(/^@\//, "src/"))) return true;
    if (r === base) return true;
  }
  return false;
}

/** Paths PROTECTED_FILES.md locks. That document is the single source of truth. */
function loadProtected() {
  const src = readRepo(PROTECTED_DOC);
  if (src === null) {
    fail("C5", `${PROTECTED_DOC} is missing — the PROTECTED label cannot be verified`);
    return new Set();
  }
  const out = new Set();
  for (const t of [...src.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim())) {
    if (looksLikePath(t) && !t.includes(" ")) out.add(t);
  }
  return out;
}

/* ------------------------------------------------------------------ checks -- */

const pkg = JSON.parse(readFileSync(abs("package.json"), "utf8"));
const PROTECTED = loadProtected();

for (const { doc } of Object.values(SCHEMAS)) {
  if (readRepo(doc) === null) fail("C0", `${doc} does not exist`);
}
if (failures.length) bail();

const guideRows = tablesWithHeader(readRepo(GUIDE), SCHEMAS.guide.cols);
const matrixRows = tablesWithHeader(readRepo(MATRIX), SCHEMAS.matrix.cols);
const contractRows = tablesWithHeader(readRepo(CONTRACTS), SCHEMAS.contracts.cols);

for (const [name, rows] of [["guide", guideRows], ["matrix", matrixRows], ["contracts", contractRows]]) {
  if (rows.length === 0) {
    fail("C0", `${SCHEMAS[name].doc} has no table with header | ${SCHEMAS[name].cols.join(" | ")} |`);
  }
}
if (failures.length) bail();

/** C1/C2 — every backticked path in every parsed cell resolves; #symbols exist. */
function checkRefs(where, cell, opts = {}) {
  const found = [];
  for (const token of ticks(cell)) {
    if (/^[a-z]+ [\w:@/. -]+$/.test(token) && !looksLikePath(token)) continue; // a command, not a path
    if (!looksLikePath(token)) continue;
    const { file, symbol } = splitRef(token);
    checked += 1;
    if (/:\d+$/.test(file)) {
      fail("C2b", `${where}: \`${token}\` cites a line number — cite \`file#symbol\` instead`);
      continue;
    }
    if (!pathExists(file)) {
      fail("C1", `${where}: \`${file}\` does not exist`);
      continue;
    }
    if (symbol && !exportsSymbol(file, symbol)) {
      fail("C2", `${where}: \`${file}\` does not export \`${symbol}\``);
      continue;
    }
    if (opts.mustBeSuite && !/(\.test\.(js|jsx)|^scripts\/(probe|verify)-[\w.-]+\.mjs)$/.test(file)) {
      fail("C3", `${where}: \`${file}\` is not a test or probe file`);
    }
    found.push({ token, file, symbol });
  }
  return found;
}

/* --- the routing table ----------------------------------------------------- */

const areas = new Map(); // Area -> { read[], proves[], gate, avoid[] }

for (const { cells, line } of guideRows) {
  const [areaCell, readCell, provesCell, gateCell, avoidCell] = cells;
  const area = key(areaCell);
  const at = `${GUIDE}:${line}`;
  if (!area) {
    fail("C6", `${at}: empty Area key`);
    continue;
  }
  if (areas.has(area)) {
    fail("C7", `${at}: duplicate Area key "${area}" (also at ${GUIDE}:${areas.get(area).line})`);
    continue;
  }
  const read = checkRefs(`${at} [Read first]`, readCell);
  const proves = checkRefs(`${at} [Proves it]`, provesCell, { mustBeSuite: true });
  const avoid = checkRefs(`${at} [Never touch]`, avoidCell);
  const gate = ticks(gateCell)[0] ?? "";

  if (read.length === 0) fail("C6", `${at}: "${area}" names no file to read`);
  if (read.length > 5) fail("C6", `${at}: "${area}" lists ${read.length} files to read — the contract is 3-5`);
  if (proves.length === 0) fail("C6", `${at}: "${area}" names no test that proves it`);
  if (!gate) fail("C6", `${at}: "${area}" names no verification gate`);
  else if (!commandResolves(gate, pkg.scripts)) fail("C4", `${at}: gate \`${gate}\` does not resolve to a runnable script`);

  // C5 — a protected file may be referenced, but never as a file you go and edit.
  for (const r of read) {
    if (PROTECTED.has(r.file) && !avoid.some((a) => a.file === r.file)) {
      fail("C5", `${at}: \`${r.file}\` is in ${PROTECTED_DOC} but "${area}" lists it under Read first without also listing it under Never touch`);
    }
  }
  areas.set(area, { read, proves, avoid, gate, line });
}

for (const a of REQUIRED_AREAS) {
  if (!areas.has(a)) fail("C6", `${GUIDE}: required area "${a}" is missing from the routing table`);
}

/** C7 — one owning area per module: two areas must not both claim the same file. */
const owner = new Map();
for (const [area, row] of areas) {
  for (const r of row.read) {
    if (owner.has(r.file) && owner.get(r.file) !== area) {
      fail("C7", `conflicting mapping: \`${r.file}\` is listed under Read first by both "${owner.get(r.file)}" and "${area}"`);
    } else owner.set(r.file, area);
  }
}

/** C8 — the named proof must actually reach the named module. */
for (const [area, row] of areas) {
  const linked = row.proves.some((s) => {
    const refs = suiteReferences(s.file);
    return row.read.some((r) => suiteCovers(refs, r.file));
  });
  checked += 1;
  if (!linked) {
    fail("C8", `${GUIDE}:${row.line}: "${area}" — no suite in Proves it references any file in Read first (${row.proves.map((s) => s.file).join(", ")} vs ${row.read.map((r) => r.file).join(", ")})`);
  }
}

/* --- the test matrix ------------------------------------------------------- */

const seenSuite = new Set();
const matrixAreas = new Set();

for (const { cells, line } of matrixRows) {
  const [areaCell, suiteCell, kindCell, cmdCell] = cells;
  const area = key(areaCell);
  const at = `${MATRIX}:${line}`;
  if (!areas.has(area)) {
    fail("C6", `${at}: area "${area}" is not in the ${GUIDE} routing table`);
    continue;
  }
  matrixAreas.add(area);
  const suites = checkRefs(`${at} [Suite]`, suiteCell, { mustBeSuite: true });
  if (suites.length === 0) fail("C6", `${at}: no suite named`);
  const kind = key(kindCell).toLowerCase();
  if (!KINDS.has(kind)) fail("C6", `${at}: Kind "${kind}" is not one of ${[...KINDS].join(", ")}`);
  const cmd = ticks(cmdCell)[0] ?? "";
  if (!cmd) fail("C6", `${at}: no Command named`);
  else if (!commandResolves(cmd, pkg.scripts)) fail("C4", `${at}: \`${cmd}\` does not resolve to a runnable script`);
  for (const s of suites) {
    const dupKey = `${area}::${s.file}`;
    if (seenSuite.has(dupKey)) fail("C7", `${at}: duplicate row — "${area}" already maps \`${s.file}\``);
    seenSuite.add(dupKey);
  }
}

for (const area of areas.keys()) {
  if (!matrixAreas.has(area)) fail("C6", `${MATRIX}: area "${area}" from ${GUIDE} has no row here`);
}

/* --- the module contracts -------------------------------------------------- */

const seenModule = new Set();
const contractAreas = new Set();

for (const { cells, line } of contractRows) {
  const [moduleCell, invariantCell, riskCell, areaCell] = cells;
  const at = `${CONTRACTS}:${line}`;
  const mods = checkRefs(`${at} [Module]`, moduleCell);
  if (mods.length === 0) {
    fail("C6", `${at}: no module named`);
    continue;
  }
  if (mods.length > 1) fail("C6", `${at}: ${mods.length} modules in one row — one contract per row`);
  const mod = mods[0];
  if (seenModule.has(mod.token)) fail("C7", `${at}: duplicate contract for \`${mod.token}\``);
  seenModule.add(mod.token);

  if (key(invariantCell).length < 12) fail("C6", `${at}: \`${mod.token}\` has no stated invariant`);

  const risk = key(riskCell).toUpperCase();
  if (!RISKS.has(risk)) fail("C6", `${at}: Risk "${risk}" is not one of ${[...RISKS].join(", ")}`);
  checked += 1;
  if (PROTECTED.has(mod.file) && risk !== "PROTECTED") {
    fail("C5", `${at}: \`${mod.file}\` is listed in ${PROTECTED_DOC} but labelled ${risk}`);
  }
  if (risk === "PROTECTED" && !PROTECTED.has(mod.file)) {
    fail("C5", `${at}: \`${mod.file}\` is labelled PROTECTED but is not listed in ${PROTECTED_DOC}`);
  }

  const area = key(areaCell);
  if (!areas.has(area)) fail("C6", `${at}: area "${area}" is not in the ${GUIDE} routing table`);
  contractAreas.add(area);
}

for (const area of areas.keys()) {
  if (!contractAreas.has(area)) fail("C6", `${CONTRACTS}: area "${area}" from ${GUIDE} has no contract row`);
}

/** Every protected file the map points an agent at must carry a written lock. */
for (const [area, row] of areas) {
  for (const r of [...row.read, ...row.avoid]) {
    if (PROTECTED.has(r.file) && !seenModule.has(r.file) && ![...seenModule].some((m) => splitRef(m).file === r.file)) {
      fail("C5", `${CONTRACTS}: \`${r.file}\` is protected and appears under "${area}" in ${GUIDE} but has no contract row here`);
    }
  }
}

/* --- the map the routing layer sits on ------------------------------------- */

/**
 * C9 — the one remaining table in PROJECT_MAP.md must cite live paths.
 *
 * A verified routing layer on top of an unverified map still rots: the guide can be
 * perfect while PROJECT_MAP.md points an agent at a file deleted six commits ago.
 *
 * Only table rows are scanned, and within them only tokens carrying a `/` or a known
 * extension. Both narrowings are load-bearing. The prose deliberately names a file
 * that must NOT resolve — `test-thing.mjs`, the example of a hyphenated name
 * `verify-all.mjs` silently never runs — and the rows deliberately name things that
 * are not paths at all: `__Host-rri_session` matches the extension-less config-file
 * shape (it starts with `_`), and `users` is cited precisely because querying it
 * fails against the singular production tables.
 */
function checkProjectMap() {
  const src = readRepo(PROJECT_MAP);
  if (src === null) {
    fail("C9", `${PROJECT_MAP} does not exist — the routing layer has no map to sit on`);
    return;
  }
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].trim().startsWith("|")) continue;
    for (const token of ticks(lines[i])) {
      if (!looksLikePath(token)) continue;
      const named = /\.(js|jsx|mjs|json|jsonc|sql|md|csv|css|html)(#.+|:\d+)?$/.test(token);
      if (!token.includes("/") && !named) continue;
      const { file, symbol } = splitRef(token);
      checked += 1;
      if (/:\d+$/.test(file)) {
        fail("C9", `${PROJECT_MAP}:${i + 1}: \`${token}\` cites a line number — cite \`file#symbol\` instead`);
      } else if (!pathExists(file)) {
        fail("C9", `${PROJECT_MAP}:${i + 1}: \`${file}\` does not exist`);
      } else if (symbol && !exportsSymbol(file, symbol)) {
        fail("C9", `${PROJECT_MAP}:${i + 1}: \`${file}\` does not export \`${symbol}\``);
      }
    }
  }
}
checkProjectMap();

/* ------------------------------------------------------------------ report -- */

function report() {
  const byCheck = new Map();
  for (const f of failures) byCheck.set(f.check, [...(byCheck.get(f.check) ?? []), f.msg]);

  if (failures.length === 0) {
    // The leading token is the summary contract scripts/probe-suite-integrity.mjs
    // enforces over every scripts/probe-*|verify-* file: a printed line must open
    // with the PASS / FAIL token so a sweep can read a verdict without parsing prose.
    console.log(`PASSED: repo-map — ${areas.size} areas, ${matrixRows.length} matrix rows, ${contractRows.length} contracts, ${checked} references resolved, 0 problems`);
    process.exit(0);
  }
  bail();
}

/** Print every failure grouped by check and exit 1. Safe to call at any point. */
function bail() {
  const byCheck = new Map();
  for (const f of failures) byCheck.set(f.check, [...(byCheck.get(f.check) ?? []), f.msg]);
  console.error(`FAILED: repo-map — ${failures.length} problem(s) across ${byCheck.size} check(s)\n`);
  const LABELS = {
    C0: "document / table structure",
    C1: "stale path",
    C2: "missing exported symbol",
    C2b: "line-number citation (use #symbol)",
    C3: "not a test or probe file",
    C4: "verification command does not resolve",
    C5: "protected / high-risk mislabelled",
    C6: "incomplete mapping",
    "C6-shape": "malformed table row",
    C7: "duplicate or conflicting mapping",
    C8: "named proof does not reach the named module",
    C9: "PROJECT_MAP.md table cites a path that is gone",
  };
  for (const [check, msgs] of [...byCheck].sort()) {
    console.error(`${check} — ${LABELS[check] ?? "unknown check"} (${msgs.length})`);
    for (const m of msgs) console.error(`  · ${m}`);
    console.error("");
  }
  console.error("The map is the contract. Fix the table in the same commit as the code move,");
  console.error("or correct the row if the tree is right and the map is wrong.");
  process.exit(1);
}

report();
