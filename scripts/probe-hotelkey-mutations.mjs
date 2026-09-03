#!/usr/bin/env node
// Mutation harness for the HotelKey regression net.
//
// A regression suite that cannot distinguish the correct parser from a plausibly
// broken one is decoration. This script reintroduces one real defect at a time
// into the production sources, runs the two fixture suites, and asserts that the
// suites FAIL. A mutation that survives is reported as SURVIVED — that is a hole
// in the net, not a success.
//
// Every mutation is applied by exact string replacement and reverted from git, so
// the tree is byte-identical afterwards; the script refuses to start unless the
// files it mutates are clean, and verifies cleanliness again at the end.
//
//   node scripts/probe-hotelkey-mutations.mjs          # all mutations
//   node scripts/probe-hotelkey-mutations.mjs --only M3
//
// Exit code 0 only when every mutation was killed and the tree is restored.

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const PARSERS = "src/lib/reportParsers.js";
const TXN_NORM = "src/lib/transactionNorm.js";
const SCAN_SUITE = "src/lib/hotelKeyParserFixtures.test.js";
const IMPORT_SUITE = "src/lib/hotelKeyImportFixtures.test.js";

/**
 * @typedef {object} Mutation
 * @property {string} id
 * @property {string} behaviour  one of the seven behaviours the net must protect
 * @property {string} file
 * @property {string} find       exact source text, must occur exactly once
 * @property {string} replace
 * @property {string[]} suites
 */

/** @type {Mutation[]} */
const MUTATIONS = [
  {
    id: "M1",
    behaviour: "property assignment",
    file: PARSERS,
    find: '    property_id: meta.propertyId || "",',
    replace: '    property_id: "",',
    suites: [IMPORT_SUITE],
  },
  {
    id: "M2",
    behaviour: "property assignment (stamp-before-key ordering)",
    file: PARSERS,
    find: "    const rows = assignDedupeKeys((scanResult.rowsToImport || []).map((r) => addMetaFn(r)));",
    replace: "    const rows = assignDedupeKeys(scanResult.rowsToImport || []).map((r) => addMetaFn(r));",
    suites: [IMPORT_SUITE],
  },
  {
    id: "M3",
    behaviour: "property isolation (file-hash guard scope)",
    file: PARSERS,
    find: "      const priorFile = await db.entities.TransactionLine.filter({\n        file_hash: fileHash,\n        property_id: restMeta.propertyId || \"\",\n      });",
    replace: "      const priorFile = await db.entities.TransactionLine.filter({\n        file_hash: fileHash,\n      });",
    suites: [IMPORT_SUITE],
  },
  {
    id: "M4",
    behaviour: "dedupe (occurrence index)",
    file: TXN_NORM,
    find: "    occurrence,\n  ].join(\"|\");",
    replace: "  ].join(\"|\");",
    suites: [SCAN_SUITE, IMPORT_SUITE],
  },
  {
    id: "M5",
    behaviour: "property gate (whitespace is not a property)",
    file: PARSERS,
    find: '  if (typeof propertyId !== "string" || propertyId.trim() === "") {',
    replace: '  if (typeof propertyId !== "string" || propertyId === "") {',
    suites: [IMPORT_SUITE],
  },
  {
    id: "M6",
    behaviour: "validation gate",
    file: PARSERS,
    find: "  if (validation && !validation.ok && !forceImport) {",
    replace: "  if (false && validation && !validation.ok && !forceImport) {",
    suites: [IMPORT_SUITE],
  },
  {
    id: "M7",
    behaviour: "stacked sections (widest section with rows wins)",
    file: PARSERS,
    find: "  let best = null;\n  for (const s of sections) {",
    replace: "  let best = null;\n  for (const s of sections.slice().reverse()) {",
    suites: [SCAN_SUITE],
  },
  {
    id: "M8",
    behaviour: "repeated headers (a second header row is data, not a header)",
    file: PARSERS,
    find: "    if (current.headers) current.rows.push(row);",
    replace: "    if (current.headers) { if (!looksLikeHeader) current.rows.push(row); }",
    suites: [SCAN_SUITE],
  },
  {
    id: "M9",
    behaviour: "revenue + dates (trailer absorption)",
    file: TXN_NORM,
    find: "export function isTrailerRow(mapped) {",
    replace: "export function isTrailerRow(mapped) {\n  return false;\n  // eslint-disable-next-line no-unreachable",
    suites: [SCAN_SUITE],
  },
  {
    id: "M10",
    behaviour: "malformed money (unparseable is not silently zero-clean)",
    file: "src/lib/importValidation.js",
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
    file: TXN_NORM,
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
  const dirty = git(["status", "--porcelain", "--", ...files]).trim();
  if (dirty) {
    console.error(`\nABORT: ${when} these files are not clean:\n${dirty}`);
    console.error("This harness rewrites production sources and reverts them from git.");
    console.error("Commit or stash your changes to them first.");
    process.exit(2);
  }
}

/** @param {string[]} suites */
function runSuites(suites) {
  const r = spawnSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["vitest", "run", ...suites, "--reporter=dot"],
    { encoding: "utf8", shell: process.platform === "win32" },
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

const touched = [...new Set(MUTATIONS.map((m) => m.file))];
assertClean(touched, "before starting,");

// The unmutated baseline has to be green, or every "killed" below is meaningless.
process.stdout.write("baseline (no mutation) ... ");
const baseline = runSuites([SCAN_SUITE, IMPORT_SUITE]);
if (baseline.code !== 0) {
  console.error("FAILED\n");
  console.error(baseline.out.split("\n").slice(-30).join("\n"));
  console.error("\nABORT: the suites must pass before mutation results mean anything.");
  process.exit(2);
}
const baseTests = /Tests\s+(\d+) passed/.exec(baseline.out)?.[1] ?? "?";
console.log(`green (${baseTests} tests)\n`);

/** @type {{id:string, behaviour:string, verdict:string, detail:string, names:string[]}[]} */
const results = [];

for (const m of selected) {
  const before = readFileSync(m.file, "utf8");
  // Anchors are authored with \n, but this repo is checked out with CRLF on
  // Windows. Re-express both sides in the file's own line ending or every
  // multi-line anchor silently misses and reports STALE.
  const eol = before.includes("\r\n") ? "\r\n" : "\n";
  const find = m.find.split("\n").join(eol);
  const replace = m.replace.split("\n").join(eol);
  const hits = before.split(find).length - 1;
  if (hits !== 1) {
    results.push({
      id: m.id,
      behaviour: m.behaviour,
      verdict: "STALE",
      detail: `anchor found ${hits}x in ${m.file} (expected 1) — the source moved`,
    });
    console.log(`${m.id} ${"STALE".padEnd(8)} anchor not unique in ${m.file}`);
    continue;
  }

  writeFileSync(m.file, before.replace(find, replace));
  process.stdout.write(`${m.id} running ... `);
  const run = runSuites(m.suites);
  git(["checkout", "--", m.file]);

  const after = readFileSync(m.file, "utf8");
  const restored = after === before;
  // Anchor on vitest's "Tests" summary line. A bare /(\d+) failed/ matches the
  // "Test Files" line first and reports a FILE count as a test count.
  const failed = /^\s*Tests\s+(\d+) failed/m.exec(run.out);
  const names = [...run.out.matchAll(/^\s*(?:×|✕|FAIL)\s+(.+?)\s*$/gm)].map((x) => x[1]);
  const verdict = !restored ? "RESIDUE" : run.code !== 0 ? "KILLED" : "SURVIVED";
  const detail = !restored
    ? `revert did not restore ${m.file} (${before.length} -> ${after.length} bytes;` +
      ` git porcelain: ${JSON.stringify(git(["status", "--porcelain", "--", m.file]).trim())})`
    : run.code !== 0
      ? `${failed?.[1] ?? "?"} test(s) failed — the net caught it`
      : "suites still passed — THE NET HAS A HOLE HERE";
  results.push({ id: m.id, behaviour: m.behaviour, verdict, detail, names });
  console.log(`${verdict.padEnd(8)} ${detail}`);
  // Which assertion caught it. A mutation filed under one behaviour but killed
  // only by an unrelated test is an incidental kill, not proof of that behaviour.
  for (const n of names.slice(0, 4)) console.log(`${" ".repeat(13)}↳ ${n}`);
}

assertClean(touched, "after finishing,");

console.log("\n─── mutation report ───");
for (const r of results) {
  console.log(`${r.id.padEnd(4)} ${r.verdict.padEnd(9)} ${r.behaviour}`);
}
const bad = results.filter((r) => r.verdict !== "KILLED");
console.log(`\n${results.length - bad.length}/${results.length} mutations killed`);
if (bad.length) {
  console.log(`NOT KILLED: ${bad.map((r) => `${r.id} (${r.verdict})`).join(", ")}`);
  process.exit(1);
}
console.log("Every mutation was caught and every mutated file was restored from git.");
