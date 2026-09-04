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
 * Every mutation is restored by a `finally`, and SIGINT/SIGTERM restore whatever is
 * in flight before exiting non-zero, so a throw or a Ctrl-C between the two writes
 * cannot leave a deliberately-broken routing document on disk.
 *
 * NOT part of `npm run verify:all` (see the EXCLUDE entry in verify-all.mjs): it
 * rewrites tracked files in place, and that sweep enforces its per-suite timeout by
 * calling `child.kill("SIGKILL")` — a signal no handler can catch, so the net below
 * cannot save a doc from it. Run it deliberately.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = ["docs/AI_REPO_GUIDE.md", "docs/TEST_MATRIX.md", "docs/MODULE_CONTRACTS.md", "PROJECT_MAP.md"];
const at = (p) => path.join(ROOT, p);

// Read ONCE, as raw bytes, and hand exactly those bytes back on restore. These are
// TRACKED files, so the restore must be byte-for-byte, and a utf8 decode/re-encode
// round trip is not the identity function: any byte that is not valid UTF-8 returns
// as U+FFFD. With `* text=auto` and core.autocrlf=true a doc's on-disk line endings
// are a property of the checkout, never something this harness may re-decide. The
// decoded text is used only to locate and apply a mutation.
const originalBytes = new Map(DOCS.map((d) => [d, readFileSync(at(d))]));
const originalText = new Map([...originalBytes].map(([d, b]) => [d, b.toString("utf8")]));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex").slice(0, 12);
const before = new Map([...originalBytes].map(([d, b]) => [d, sha(b)]));

/** [label, doc, find, replace, expected check id] */
const MUTATIONS = [
  ["C0  blank line split", "docs/TEST_MATRIX.md",
    "| Deployment | `scripts/verify-all.mjs` | gate | `npm run verify:all` |",
    "\n| Deployment | `scripts/verify-all.mjs` | gate | `npm run verify:all` |", "C0"],
  ["C1  stale path", "docs/AI_REPO_GUIDE.md",
    "src/lib/csvParser.js#parseTextInWorker", "src/lib/csvParserGone.js#parseTextInWorker", "C1"],
  ["C2  renamed symbol", "docs/AI_REPO_GUIDE.md",
    "src/lib/decimal.js#sumCents", "src/lib/decimal.js#sumCentsRenamed", "C2"],
  ["C2  comment export", "docs/AI_REPO_GUIDE.md",
    "scripts/probe-decimal-integration.mjs", "scripts/probe-settings-persistence.mjs#getXConfig", "C2"],
  ["C2b line citation", "docs/AI_REPO_GUIDE.md",
    "`src/pages/Payroll.jsx`", "`src/pages/Payroll.jsx:153`", "C2b"],
  ["C2b line range", "docs/AI_REPO_GUIDE.md",
    "`src/pages/Payroll.jsx`", "`src/pages/Payroll.jsx:153-160`", "C2b"],
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

/**
 * The one place that knows which docs are mutated on disk right now: doc → the exact
 * original bytes. `withMutation`'s `finally` and the signal handlers both restore
 * from here, so no code path can mutate a doc that another path will not put back.
 *
 * An entry is added BEFORE the mutating write (a write that throws part-way through
 * still needs restoring) and removed only once the original bytes are back on disk,
 * which makes a second restore a no-op instead of a second write of stale content.
 */
const inFlight = new Map();

/** Puts every in-flight doc back byte-for-byte. Returns the ones it could not. */
function restoreAll() {
  const stuck = [];
  for (const [doc, bytes] of [...inFlight]) {
    try {
      writeFileSync(at(doc), bytes);
      inFlight.delete(doc);
    } catch (err) {
      // Keep going: one locked doc must not strand the other three. The entry stays
      // in `inFlight`, so a later `finally` or a signal handler retries it.
      stuck.push(`${doc}: ${err.message}`);
    }
  }
  return stuck;
}

const reportStuck = (stuck) => {
  if (stuck.length) console.error(`RESTORE FAILED — tracked docs left mutated: ${stuck.join("; ")}`);
};

/** Mutates one doc, runs the gate, and restores byte-for-byte whatever happens next. */
function withMutation(doc, mutated) {
  try {
    inFlight.set(doc, originalBytes.get(doc));
    writeFileSync(at(doc), mutated);
    return run();
  } finally {
    reportStuck(restoreAll());
  }
}

// A Ctrl-C, or a SIGTERM from a parent that has given up, used to land between the
// mutate and the restore and leave a broken routing document committed-ready on disk.
// Registering a listener also suppresses Node's default death, so the exit is
// explicit and non-zero: the run did not finish, and no caller may read it as green.
// spawnSync blocks the loop, so a signal that arrives during a gate run is delivered
// when that child returns — the doc is still in `inFlight` at that moment either way.
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  process.on(signal, () => {
    const pending = inFlight.size;
    const stuck = restoreAll();
    console.error(`\n${signal} received — restored ${pending - stuck.length}/${pending} mutated doc(s), aborting`);
    reportStuck(stuck);
    process.exit(code);
  });
}

const base = run();
if (base.code !== 0) {
  console.error(`baseline is not green; aborting before mutating anything\n${base.out}`);
  process.exit(1);
}
console.log(`baseline           EXIT=0  ${base.out.trim().split("\n")[0]}\n`);

let killed = 0;
let setupFailed = 0;
for (const [name, doc, from, to, want] of MUTATIONS) {
  const src = originalText.get(doc);
  if (!src.includes(from)) {
    // The anchor text moved. Not a gate failure, but the mutation proved nothing,
    // so it must not be counted as a kill.
    console.log(`${name.padEnd(28)} SETUP-FAIL  anchor not found in ${doc}`);
    setupFailed += 1;
    continue;
  }
  const r = withMutation(doc, src.replace(from, to));
  const caught = r.code === 1 && new RegExp(`^${want} `, "m").test(r.out);
  if (caught) killed += 1;
  const first = (r.out.match(/^ {2}· .*$/m) ?? [""])[0].trim().slice(0, 96);
  console.log(`${name.padEnd(28)} ${caught ? "KILLED " : "SURVIVED"} exit=${r.code}  ${first}`);
}

// Re-read from disk as BYTES, not as decoded text: this is the assertion that the
// restore was byte-for-byte, so comparing anything other than the real file bytes
// would be comparing a normalisation of them.
const after = new Map(DOCS.map((d) => [d, sha(readFileSync(at(d)))]));
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
