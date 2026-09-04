// probe-float-money.mjs — integer-cents discipline gate (static scanner).
//
// WHY THIS EXISTS
//
// BUSINESS.md: "ALL financial calculations MUST use integer cents (sumCents,
// Decimal.js). Raw floating-point math (+, -) on dollar values IS STRICTLY
// FORBIDDEN." Enforcing that by hand does not scale: measured 2026-08-24 there are
// 277 candidate sites in src/ (144 Math.round, 111 toFixed, 22 parseFloat across 71
// files), and every one of them was triaged that day. The conclusion of that triage
// was that NONE of them is a live violation:
//
//   * 38 sites operate on identifiers already named *Cents.
//   * 114 sites are display formatting (template literal, className, toLocaleString).
//   *  9 sites are ratios/percentages/scores, not money.
//   * The remainder are decimal.js's own dollars->cents primitives (Math.round(n *
//     SCALE) IS the conversion boundary), pricingEngine.js's basis-point RATE_SCALE
//     math, pixel/colour geometry in donutLabelLayout/pdfExport/image/eventSchedule,
//     and percent<->rate conversion for form fields.
//
// A count is not a gate, though — 277 churns on every unrelated edit, and a gate
// that churns is a gate the next agent edits instead of obeying. So this suite does
// NOT assert the total. It asserts the five structural invariants that were measured
// to hold on 2026-08-24 and that can only break by someone introducing a genuine
// float-money defect, plus two containment rules. Each invariant is phrased so that
// the failure it prevents is a specific, describable money bug, not a style opinion.
//
// WHAT IT DELIBERATELY DOES NOT DO
//
// It does not forbid Math.round(x * 100) / 100 outright. That expression is correct
// and idiomatic when rounding an already-computed dollar figure for a chart slice or
// a list row. It only fails when such a site appears in a module that has committed
// to integer cents (i.e. imports @/lib/decimal) and is not in the documented
// allowlist below — because in those modules a float-dollar round is a regression,
// not a display choice.
//
// A NOTE ON HOW THE 2026-08-24 TRIAGE WAS DONE, AND WHERE IT WAS BLIND
//
// The 277 sites were transcribed mechanically into gemini-out/float-money.tsv, one
// row per site, and every row was then validated back against the files: all 277
// matched byte-for-byte. But the transcription truncated each line at 200
// characters, and six lines were longer than that. On one of them —
// src/pages/Payroll.jsx:952, a 310-character JSX input — the Math.round sat past the
// cut, so the triage classified it from the visible prefix and never saw the money
// expression at all. This suite found it on its first run. That is the argument for
// a scanner over a spreadsheet: the review had a blind spot exactly where the lines
// were hardest to read, which is where defects prefer to live.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");

let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, label, detail) {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    failures.push(detail ? `${label} — ${detail}` : label);
  }
}

// ---------------------------------------------------------------- file inventory

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.jsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const files = walk(SRC).sort().map((abs) => {
  const rel = path.relative(ROOT, abs).split(path.sep).join("/");
  const text = fs.readFileSync(abs, "utf8");
  return { rel, text, lines: text.split(/\r?\n/) };
});

// The real hazard in a static scanner is not a wrong regex, it is a wrong ROOT. If
// SRC resolved somewhere empty, every invariant below would pass while inspecting
// nothing and the suite would report green — the same "asserted nothing = PASS"
// hole that _verdict.mjs had to be fixed for. So anchor on the modules that must be
// present for this gate to mean anything, rather than on a file count that drifts
// with every unrelated addition (a floor of 300 failed here on a legitimate 282).
const REQUIRED = [
  "src/lib/decimal.js",
  "src/lib/csvParser.js",
  "src/lib/hotel.js",
  "src/lib/payrollCalc.js",
  "src/components/dashboard/MoneyKept.jsx",
];
for (const rel of REQUIRED) {
  ok(files.some((f) => f.rel === rel), `scanner reached ${rel}`, `SRC resolved to ${SRC}`);
}

// A comment line cannot execute, so a pattern quoted inside documentation must not
// fail a gate. timecardCalc.js:353-354 quote `Math.round(1500 * 37.38)` precisely to
// explain why that ordering is wrong; a scanner that cannot tell prose from code
// would force the explanation to be deleted.
const isComment = (line) => {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
};

// Every (file, line) pair whose code — not prose — matches `re`.
function sites(re) {
  const hits = [];
  for (const f of files) {
    f.lines.forEach((line, i) => {
      if (!isComment(line) && re.test(line)) hits.push({ rel: f.rel, line: i + 1, text: line.trim() });
    });
  }
  return hits;
}

const fmt = (hits) => hits.map((h) => `${h.rel}:${h.line}`).join(", ");

// ------------------------------------------- 1. no money round-trip through text
//
// `Number(x.toFixed(2))` looks harmless and is the single most effective way to
// lose money in this codebase: it formats a float to 2dp, discards everything
// below, and hands the truncated value back as a number that later gets summed.
// The loss is invisible at the call site and unrecoverable downstream.
const roundTrip = sites(/(?:Number|parseFloat|parseInt)\s*\(\s*[^)]*\.toFixed\s*\(/);
ok(roundTrip.length === 0, "no money is round-tripped back out of a toFixed string", fmt(roundTrip));

// ------------------------------------------------- 2. no toFixed in a comparison
//
// Comparing formatted strings ("10.00" < "9.00" is true, lexicographically) is a
// silent correctness bug in any threshold, sort or reconciliation check.
const fixedCompare = sites(/\.toFixed\s*\([^)]*\)\s*(?:===|!==|==|!=|>=|<=|>|<)/);
ok(fixedCompare.length === 0, "no comparison is performed on a toFixed string", fmt(fixedCompare));

// ------------------------------------- 3. no *Cents value re-entering float math
//
// `someCents / 100` is a deliberate exit from integer cents to display dollars. If
// the result is then multiplied or added, the code has left the cents domain and
// resumed float arithmetic on money — exactly what BUSINESS.md forbids.
const centsEscape = sites(/[A-Za-z0-9_$]+Cents\s*\/\s*100\s*[*+]/);
ok(centsEscape.length === 0, "no *Cents value is divided out and then re-multiplied", fmt(centsEscape));

// ----------------------------- 4. no float-rounded dollars persisted to the store
//
// Display rounding is fine. Persisting a display-rounded figure is not: it becomes
// the value every later total is built from, so the rounding error compounds and
// the ledger stops reconciling to the cent.
const persistedFloat = sites(/(?:create|update|bulkAdd|bulkPut|\bput|\badd)\s*\([^)]*Math\.round\s*\([^)]*\*\s*100\s*\)\s*\/\s*100/);
ok(persistedFloat.length === 0, "no float-dollar rounded value is written to the database", fmt(persistedFloat));

// --------------------------------- 5. the CSV money boundary stays sanitizer-only
//
// This is the invariant with real teeth. parseFloat("1,100.00") is 1 — it stops at
// the comma and returns one dollar for an eleven-hundred-dollar refund, with no
// error and no NaN to notice. csvParser.js#parseAmount exists to prevent that: it
// strips [$,\s], handles the three negative conventions real PMS exports use
// (leading minus, trailing minus, accounting parentheses), and rejects non-finite
// values. Every import path must go through it. A future agent adding a quick
// `parseFloat(row[3])` to a parser would reintroduce the truncation silently, so
// the rule is enforced structurally: inside the import pipeline, a parseFloat call
// is only legal if its argument was sanitized first.
const PIPELINE = [
  "src/lib/reportParsers.js",
  // Destination of the transaction-scanner extraction out of reportParsers.js.
  // Listed before the file exists on purpose: PIPELINE is consulted once, while
  // iterating files found on disk, so an entry with no file behind it matches
  // nothing and is inert — and the parseFloat rule starts guarding the new module
  // the moment it lands, instead of the module arriving unguarded and someone
  // having to remember this list.
  "src/lib/parsers/transactions.js",
  "src/lib/manualEntryImport.js",
  "src/lib/transactionNorm.js",
  "src/lib/paymentNorm.js",
  "src/lib/universalParser.js",
  "src/lib/importValidation.js",
  "src/lib/dataScanner.js",
];
// csvParser.js is the one legal home for a bare parseFloat: parseAmount applies it
// to `body`, a string it has already stripped of currency symbols and separators.
// That single call IS the sanitizer, so it cannot be required to call itself.
const PARSEFLOAT_HOME = "src/lib/csvParser.js";

const unsanitized = [];
for (const f of files) {
  if (!PIPELINE.includes(f.rel)) continue;
  f.lines.forEach((line, i) => {
    if (isComment(line) || !line.includes("parseFloat(")) return;
    if (line.includes("replace(")) return; // separators stripped on the same line
    unsanitized.push({ rel: f.rel, line: i + 1, text: line.trim() });
  });
}
ok(
  unsanitized.length === 0,
  "import pipeline never calls parseFloat on an unsanitized cell (use parseAmount)",
  fmt(unsanitized),
);

const csvParser = files.find((f) => f.rel === PARSEFLOAT_HOME);
ok(!!csvParser, `${PARSEFLOAT_HOME} exists`);
ok(
  !!csvParser && /export function parseAmount\b/.test(csvParser.text),
  "parseAmount is still exported as the shared money-cell parser",
);
ok(
  !!csvParser && /replace\(\s*\/\[\$,\\s\]\/g/.test(csvParser.text),
  "parseAmount still strips currency symbols and thousands separators before parseFloat",
);
ok(
  !!csvParser && /Number\.isFinite\(n\)/.test(csvParser.text),
  "parseAmount still rejects non-finite amounts instead of returning Infinity as money",
);

// ------------------ 6. modules committed to integer cents stay out of float money
//
// A module that imports @/lib/decimal has opted into the cents domain. Float-dollar
// rounding inside one is a regression unless it is a documented display conversion.
// Quote-agnostic and extension-agnostic on purpose: the repo writes this import with
// single quotes, and an earlier version of this check that hardcoded double quotes
// silently classified all nine cents-committed modules as "does not import decimal".
const IMPORTS_DECIMAL = /from\s+['"][^'"]*\/decimal(?:\.js)?['"]/;
const FLOAT_DOLLAR_ROUND = /Math\.round\s*\([^;]*\*\s*100\s*\)\s*\/\s*100/;

// Allowlisted display conversions, with the reason each one is not a money bug.
// Keyed by file with an exact expected count: a NEW site in one of these files
// pushes the count over `max` and fails, which forces the next agent to triage it
// rather than inherit the exemption for free. Counts are LINES, not occurrences —
// MoneyKept.jsx:615 rounds two fields on one line and counts once.
const DISPLAY_ROUNDING_ALLOWLIST = {
  "src/components/dashboard/MoneyKept.jsx": {
    max: 7,
    why: "chart slice + deduction-row values (lines 414/615/637/649/657/666/667); the cents figures they derive from are unchanged, and the headline total is computed in cents (see probe-money-kept-fix.mjs)",
  },
  "src/lib/hotel.js": {
    max: 1,
    why: "aggregate() emits {name, value} chart series for display only; callers that need money read the cents helpers in the same module",
  },
  "src/pages/Payroll.jsx": {
    max: 1,
    why: "line 952 rounds estAdr only to build an input placeholder string; the value actually used for pay math is `const adr = Number(adrOverride) || estAdr || 0` at line 712, which reads estAdr unrounded",
  },
};

const centsCommitted = files.filter((f) => IMPORTS_DECIMAL.test(f.text));
ok(centsCommitted.length >= 9, "the cents-committed module set is still populated", `found ${centsCommitted.length}`);

const violations = [];
for (const f of centsCommitted) {
  const hits = f.lines
    .map((line, i) => ({ line: i + 1, text: line.trim() }))
    .filter((h) => !isComment(h.text) && FLOAT_DOLLAR_ROUND.test(h.text));
  if (hits.length === 0) continue;
  const allowed = DISPLAY_ROUNDING_ALLOWLIST[f.rel];
  if (!allowed) {
    violations.push(`${f.rel} (${hits.length} site(s), not allowlisted): ${hits.map((h) => h.line).join(",")}`);
  } else if (hits.length > allowed.max) {
    violations.push(`${f.rel} has ${hits.length} float-dollar rounds, allowlist permits ${allowed.max}`);
  }
}
ok(violations.length === 0, "cents-committed modules contain no undocumented float-dollar rounding", violations.join(" | "));

// Guard the allowlist against silent rot in the other direction: an entry that no
// longer matches anything is stale, and a stale exemption is how a real violation
// gets waved through later under a name that used to mean something else.
for (const [rel, meta] of Object.entries(DISPLAY_ROUNDING_ALLOWLIST)) {
  const f = files.find((x) => x.rel === rel);
  ok(!!f, `allowlisted file ${rel} still exists`);
  if (!f) continue;
  const count = f.lines.filter((l) => !isComment(l) && FLOAT_DOLLAR_ROUND.test(l)).length;
  ok(count > 0, `allowlist entry for ${rel} is not stale`, "no float-dollar rounding found; remove the entry");
  ok(typeof meta.why === "string" && meta.why.length > 40, `allowlist entry for ${rel} documents why`);
}

// ------------------------------------------- 7. float-dollar rate math stays dead
//
// yieldOptimizer.js#calculateDynamicRateRecommendation computes
// `Math.round(baseRate * adjustmentMultiplier)` on float dollars. The module carries
// a comment saying so and is currently unwired — nothing under pages/ or components/
// imports it, so the defect cannot reach a user. That containment is the only reason
// it is acceptable to leave, which makes the containment itself worth gating: wiring
// this module into a screen must not be a one-line change that passes review.
const YIELD = "yieldOptimizer";
const wiredFrom = files
  .filter((f) => (f.rel.startsWith("src/pages/") || f.rel.startsWith("src/components/")) && !/\.test\.jsx?$/.test(f.rel))
  .filter((f) => new RegExp(`from\\s+['"][^'"]*${YIELD}(?:\\.js)?['"]`).test(f.text))
  .map((f) => f.rel);
ok(
  wiredFrom.length === 0,
  "yieldOptimizer's float-dollar rate math is still unreachable from any page or component",
  `now imported by ${wiredFrom.join(", ")} — convert it to integer cents before wiring it up`,
);

const yo = files.find((f) => f.rel === "src/lib/yieldOptimizer.js");
ok(!!yo, "src/lib/yieldOptimizer.js exists");
ok(
  !!yo && /FLOAT DOLLARS/.test(yo.text),
  "yieldOptimizer still carries the comment naming its float-dollar defect",
  "the warning was removed while the defect remained",
);

// --------------------------------------------------------------------- inventory
//
// Printed, not asserted. Drift in these numbers is information for a human, not a
// reason to fail a build — but a reviewer who sees the display bucket jump by forty
// knows to look at what was just added.
const inv = {
  "Math.round": sites(/Math\.round/).length,
  toFixed: sites(/toFixed/).length,
  parseFloat: sites(/parseFloat/).length,
  "cents-committed modules": centsCommitted.length,
};

console.log("float-money inventory (informational, not asserted):");
for (const [k, v] of Object.entries(inv)) console.log(`  ${k}: ${v}`);
console.log(`  allowlisted display-rounding files: ${Object.keys(DISPLAY_ROUNDING_ALLOWLIST).length}`);

if (failures.length) {
  console.log("\nfailures:");
  for (const f of failures) console.log(`  - ${f}`);
}

// Printed with console.log directly rather than through a helper: the summary
// contract in probe-suite-integrity.mjs reads this file's SOURCE, not its output,
// and looks for a console.log/error/info whose first template literal opens with
// PASSED:/FAILED:. Routed through a wrapper the verdict is invisible to it, and a
// suite whose verdict a machine cannot find is one verify-all cannot summarise.
console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);

// process.exitCode rather than process.exit(): an abrupt exit aborts on Windows
// while keep-alive handles are still in flight, which turns a clean pass into a
// spurious BROKEN row in verify-all.
process.exitCode = fail === 0 ? 0 : 1;
