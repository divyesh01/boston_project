#!/usr/bin/env node
/**
 * probe-repo-map-gate.mjs — proves verify-repo-map.mjs can actually FAIL.
 *
 * A documentation gate that cannot fail is decoration. This harness mutates one
 * routing document at a time to reproduce each failure mode the gate claims to
 * catch, asserts the gate exits 1 with the expected check id, restores the file,
 * and finally asserts every document is byte-identical to how it started and the
 * gate is green again.
 *
 * It found a real hole on the day it was written: `C2b line citation SURVIVED`,
 * because `looksLikePath()` rejected `src/pages/Payroll.jsx:153` before the C2b
 * branch could see it — the exact citation style the gate exists to ban was
 * unchecked. Without this harness that would have shipped green.
 *
 * Run: npm run map:mutate
 *
 * NOT part of `npm run verify:all` (see the EXCLUDE entry in verify-all.mjs): it
 * rewrites tracked files in place, so a run killed by the sweep's per-suite
 * timeout would leave a routing document mutated on disk. Run it deliberately.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = ["docs/AI_REPO_GUIDE.md", "docs/TEST_MATRIX.md", "docs/MODULE_CONTRACTS.md", "PROJECT_MAP.md"];
const at = (p) => path.join(ROOT, p);

const original = new Map(DOCS.map((d) => [d, readFileSync(at(d), "utf8")]));
const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 12);
const before = new Map([...original].map(([d, s]) => [d, sha(s)]));

/** [label, doc, find, replace, expected check id] */
const MUTATIONS = [
  ["C1  stale path", "docs/AI_REPO_GUIDE.md",
    "src/lib/csvParser.js#parseTextInWorker", "src/lib/csvParserGone.js#parseTextInWorker", "C1"],
  ["C2  renamed symbol", "docs/AI_REPO_GUIDE.md",
    "src/lib/decimal.js#sumCents", "src/lib/decimal.js#sumCentsRenamed", "C2"],
  ["C2b line citation", "docs/AI_REPO_GUIDE.md",
    "`src/pages/Payroll.jsx`", "`src/pages/Payroll.jsx:153`", "C2b"],
  ["C1  renamed test", "docs/TEST_MATRIX.md",
    "src/lib/refundAuditFilters.test.js", "src/lib/refundAuditFiltersOld.test.js", "C1"],
  ["C3  not a suite", "docs/TEST_MATRIX.md",
    "| Payments/refunds | `scripts/probe-parse-amount.mjs` | probe |",
    "| Payments/refunds | `src/lib/decimal.js` | probe |", "C3"],
  ["C4  dead command", "docs/TEST_MATRIX.md", "`npm run verify:all`", "`npm run verify:nope`", "C4"],
  ["C5  protected mislabelled", "docs/MODULE_CONTRACTS.md",
    "reflects the session; it never grants one. | PROTECTED |",
    "reflects the session; it never grants one. | HIGH |", "C5"],
  ["C5  false PROTECTED claim", "docs/MODULE_CONTRACTS.md",
    "| `src/lib/paymentNorm.js#refundTotal` | A refund is negative exactly once. Sign is decided here and never re-applied downstream. | HIGH |",
    "| `src/lib/paymentNorm.js#refundTotal` | A refund is negative exactly once. Sign is decided here and never re-applied downstream. | PROTECTED |", "C5"],
  ["C6  area deleted", "docs/AI_REPO_GUIDE.md",
    "| Deployment | `wrangler.jsonc`", "| Deploymentx | `wrangler.jsonc`", "C6"],
  ["C6  six files to read", "docs/AI_REPO_GUIDE.md",
    "| Payroll | `src/lib/payrollCalc.js#buildPayrollRunRecord`, `src/pages/Payroll.jsx` |",
    "| Payroll | `src/lib/payrollCalc.js#buildPayrollRunRecord`, `src/pages/Payroll.jsx`, `src/lib/decimal.js`, `src/lib/dbArchive.js`, `src/lib/importReset.js`, `src/lib/paymentNorm.js` |", "C6"],
  ["C7  two areas own one file", "docs/AI_REPO_GUIDE.md",
    "| Transactions | `src/lib/transactionNorm.js#assignDedupeKeys`",
    "| Transactions | `src/lib/decimal.js#sumCents`, `src/lib/transactionNorm.js#assignDedupeKeys`", "C7"],
  ["C7  duplicate matrix row", "docs/TEST_MATRIX.md",
    "| Deployment | `scripts/probe-deploy-config.mjs` | probe | `node scripts/probe-deploy-config.mjs` |",
    "| Deployment | `scripts/probe-deploy-config.mjs` | probe | `node scripts/probe-deploy-config.mjs` |\n| Deployment | `scripts/probe-deploy-config.mjs` | probe | `node scripts/probe-deploy-config.mjs` |", "C7"],
  ["C8  proof misses module", "docs/AI_REPO_GUIDE.md",
    "`scripts/probe-payroll-entry-parity.mjs`, `scripts/probe-payroll-cent-aggregation.mjs`",
    "`scripts/probe-payroll-cent-aggregation.mjs`", "C8"],
  ["C9  project map rot", "PROJECT_MAP.md",
    "`src/lib/parser.worker.js`", "`src/lib/parser.worker.deleted.js`", "C9"],
];

const run = () => {
  const r = spawnSync("node", ["scripts/verify-repo-map.mjs"], { cwd: ROOT, encoding: "utf8" });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
};

const base = run();
if (base.code !== 0) {
  console.error(`baseline is not green; aborting before mutating anything\n${base.out}`);
  process.exit(1);
}
console.log(`baseline           EXIT=0  ${base.out.trim().split("\n")[0]}\n`);

let killed = 0;
let setupFailed = 0;
for (const [name, doc, from, to, want] of MUTATIONS) {
  const src = original.get(doc);
  if (!src.includes(from)) {
    // The anchor text moved. Not a gate failure, but the mutation proved nothing,
    // so it must not be counted as a kill.
    console.log(`${name.padEnd(28)} SETUP-FAIL  anchor not found in ${doc}`);
    setupFailed += 1;
    continue;
  }
  writeFileSync(at(doc), src.replace(from, to));
  const r = run();
  writeFileSync(at(doc), src);
  const caught = r.code === 1 && new RegExp(`^${want} `, "m").test(r.out);
  if (caught) killed += 1;
  const first = (r.out.match(/^ {2}· .*$/m) ?? [""])[0].trim().slice(0, 96);
  console.log(`${name.padEnd(28)} ${caught ? "KILLED " : "SURVIVED"} exit=${r.code}  ${first}`);
}

const after = new Map(DOCS.map((d) => [d, sha(readFileSync(at(d), "utf8"))]));
const restored = DOCS.every((d) => before.get(d) === after.get(d));
const final = run();
const ok = killed === MUTATIONS.length && restored && final.code === 0;

console.log(`\n${killed}/${MUTATIONS.length} mutations killed${setupFailed ? ` (${setupFailed} setup-failed)` : ""}`);
console.log(`restore byte-identical: ${restored ? "YES" : "NO"}`);
console.log(`post-restore gate: EXIT=${final.code}  ${final.out.trim().split("\n")[0]}`);

// Verdict line for the summary contract in scripts/probe-suite-integrity.mjs: the
// printed line must open with the PASS / FAIL token. Written as a ternary so one
// line is honest for both outcomes — a suite that prints the pass token
// unconditionally satisfies the auditor and tells a sweep nothing.
console.log(`${ok ? "PASSED" : "FAILED"}: ${killed}/${MUTATIONS.length} mutations killed, ${MUTATIONS.length - killed} survived, restore ${restored ? "byte-identical" : "DIVERGED"}, post-restore exit=${final.code}`);
if (!ok) console.error("\nrepo-map-gate: the gate did not catch every failure mode it claims to.");
process.exit(ok ? 0 : 1);
