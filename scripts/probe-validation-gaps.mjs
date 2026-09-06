// Probe: does a bad CSV value fail loudly, or become plausible-looking data?
//
// ─────────────────────────────────────────────────────────────────────────────
// REWRITTEN 2026-08-20. DO NOT REVERT THIS TO A PRINTING PROBE.
//
// What this file used to be: four sections that printed observations and exited 0.
// Its own header said "Each prints OBSERVED behaviour rather than asserting". That
// made it invisible to `npm run verify:all`, which counts exit codes — so it sat in
// the suite list looking like coverage while asserting nothing. Worse, section 3
// held a hand-copied duplicate of the occupancy branch from reportParsers.js, so it
// could only ever agree with a snapshot of the product taken at the time it was
// written. It ended with:
//
//     console.log("  -> if 85 becomes 0, the /100 branch is unreachable and the
//                    percent case loses its data.");
//
// That sentence was correct. It had been printed on every run for months and
// nothing acted on it, because a printed defect and a passing suite are the same
// exit code. Both halves of it are now assertions against the REAL parser, and the
// two defects behind them are fixed upstream in src/lib/reportParsers.js.
//
// Sections 2 and 4 were also stale: they concluded "with no count of either", which
// stopped being true when src/lib/importValidation.js was added. They now assert
// that the validator reports the loss, with counts.
//
// BEST OUTCOME NOTE: every occupancy case below is driven through the real
// `scanReport` via `meta.csvText`, which short-circuits the fetch. A probe that
// re-implements the branch it is testing cannot fail when the branch changes — that
// is failure mode #4 in BRAIN_TROUBLESHOOTING.md section 22, and it is why this
// probe never caught the defect its own last line described.
// ─────────────────────────────────────────────────────────────────────────────
//
// Run: node --import ./scripts/_loader-boot.mjs scripts/probe-validation-gaps.mjs

await import("fake-indexeddb/auto");
globalThis.crypto ??= (await import("node:crypto")).webcrypto;

const __store = new Map();
const __storage = {
  getItem: (k) => (__store.has(k) ? __store.get(k) : null),
  setItem: (k, v) => __store.set(k, String(v)),
  removeItem: (k) => __store.delete(k),
  clear: () => __store.clear(),
};
globalThis.localStorage = __storage;
globalThis.sessionStorage = __storage;
globalThis.window = globalThis;
if (globalThis.navigator === undefined) {
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "harness", language: "en-US" },
    configurable: true,
  });
}

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, "data");

const { parseAmount, parseCsvText, rowsToObjects } = await import("@/lib/csvParser");
const { scanReport } = await import("@/lib/reportParsers");

let pass = 0;
let fail = 0;
const failures = [];

// JSON.stringify(Infinity) is the string "null", and so is JSON.stringify(NaN).
// Reporting through it made the non-finite failures read "got null, expected null",
// which looks like a broken assertion instead of a caught defect. Non-finite numbers
// are the whole point of section 1, so they get rendered as themselves.
function show(v) {
  if (typeof v === "number" && !Number.isFinite(v)) return String(v);
  return JSON.stringify(v);
}

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
  ok(label, Object.is(actual, expected) || actual === expected,
    `got ${show(actual)}, expected ${show(expected)}`);
}

function near(label, actual, expected, tol = 1e-9) {
  ok(label, typeof actual === "number" && Math.abs(actual - expected) <= tol,
    `got ${show(actual)}, expected ~${expected}`);
}

// Findings helper: the validator returns { findings, errors, warnings, ok, ... }
// and each finding is { layer, severity, code, message, ...detail }.
const codes = (v) => (v?.findings || []).map((f) => f.code);
const byCode = (v, code) => (v?.findings || []).find((f) => f.code === code) || null;

// ═══ 1. parseAmount on values a real export actually contains ════════════════
//
// The contract (src/lib/importValidation.js#recordCoercion): null means "nothing
// numeric was found", and callers then store 0 with an `unparseable` coercion
// logged. A NON-null parse that lost information is the more dangerous case,
// because 12 looks entirely legitimate downstream — those must be logged
// `truncated`. Both rules only hold if parseAmount returns what is asserted here.
console.log("\n=== 1. parseAmount: garbage must return null, not a plausible number ===");

for (const v of ["N/A", "n/a", "-", "", "  ", "TOTAL", "abc", "#DIV/0!", "$", "(  )"]) {
  eq(`${JSON.stringify(v)} -> null`, parseAmount(v), null);
}
eq("null -> null", parseAmount(null), null);
eq("undefined -> null", parseAmount(undefined), null);

// Real formats that must survive.
eq('"1,234.50" -> 1234.5', parseAmount("1,234.50"), 1234.5);
eq('"$1,337.80 " -> 1337.8 (trailing space, as the PMS prints it)', parseAmount("$1,337.80 "), 1337.8);
eq('"($100.00)" -> -100 (accounting parentheses)', parseAmount("($100.00)"), -100);
eq('"-25.50" -> -25.5 (leading minus)', parseAmount("-25.50"), -25.5);
eq('"25.50-" -> -25.5 (trailing minus)', parseAmount("25.50-"), -25.5);
eq('"0.00" -> 0 (a real zero is not nothing)', parseAmount("0.00"), 0);

// Partial parses. These are kept on purpose — a malformed cell stays importable —
// but they are exactly why the coercion log exists.
eq('"12abc" -> 12 (truncated, must be logged)', parseAmount("12abc"), 12);
eq('"1.2.3" -> 1.2 (truncated, must be logged)', parseAmount("1.2.3"), 1.2);
eq('"1e5" -> 100000 (exponent form is legal)', parseAmount("1e5"), 100000);

// Non-finite. A money column has no infinite value, and Infinity is unrecoverable
// once summed: Infinity - Infinity is NaN, so one poisoned cell takes the whole
// period's total with it and no later check can tell which cell did it.
eq('"Infinity" -> null (not Infinity)', parseAmount("Infinity"), null);
eq('"-Infinity" -> null', parseAmount("-Infinity"), null);
eq('"1e999" -> null (overflows to Infinity)', parseAmount("1e999"), null);
ok("no sentinel returns a non-finite number",
  ["Infinity", "-Infinity", "1e999", "NaN"].every((s) => {
    const r = parseAmount(s);
    return r === null || Number.isFinite(r);
  }));

// ═══ 2. Unknown columns must be reported, with names ════════════════════════
console.log("\n=== 2. an unrecognised column is named, not silently dropped ===");

const mysteryCsv = "Date,Room Revenue,Mystery Column,Total Sold Rooms,Total Rooms\n2026-01-01,100.00,999,5,100\n";
const mystery = await scanReport("occupancy", "occupancy.csv", { csvText: mysteryCsv });

const unknown = byCode(mystery.validation, "unknown_columns");
ok("an unknown_columns finding is raised", !!unknown);
ok('the finding names "Mystery Column"', !!unknown && (unknown.columns || []).includes("Mystery Column"),
  JSON.stringify(unknown?.columns));
ok("the row still imported (a dropped column is not a rejected file)", mystery.totalRows === 1,
  `totalRows=${mystery.totalRows}`);
ok("the unknown column is absent from the imported row",
  mystery.rowsToImport?.[0] && !("Mystery Column" in mystery.rowsToImport[0]));

// The object form keeps the header, so the loss is in mapRow's COLUMN_MAP lookup,
// not in the CSV reader. Asserted so a future "fix" to the reader looks wrong here.
const objs = rowsToObjects(parseCsvText(mysteryCsv));
ok("the CSV reader itself preserves the unknown header",
  Object.prototype.hasOwnProperty.call(objs[0], "Mystery Column"));

// ═══ 3. The occupancy branch, through the REAL parser ═══════════════════════
//
// Occupancy reaches the parser in three forms: a printed percentage (85), a
// printed ratio (0.85), or two audited room counts. This is the section whose
// hand-copied duplicate used to print a defect and exit 0.
console.log("\n=== 3. occupancy: percent, ratio, and derived-from-counts ===");

const OCC_COL = "Occupancy Including OOO Comp and House Use";

async function occ(csvText) {
  const r = await scanReport("occupancy", "occupancy.csv", { csvText });
  return { value: r.rowsToImport?.[0]?.occupancy, scan: r };
}

// (a) percent form with no room counts. THE DEFECT: this imported as 0 — a full
// hotel recorded as an empty one, silently, and it propagates into ADR/RevPAR.
const a = await occ(`Date,Room Revenue,${OCC_COL}\n2026-01-01,1337.80,85\n`);
near("percent 85, no room counts -> 0.85", a.value, 0.85);
ok("...and it is NOT 0 (the defect this probe used to only print)", a.value !== 0);

// (b) percent form WITH room counts. The audited integers win: they are two
// numbers the night audit reconciles, the printed percentage is derived output.
const b = await occ(`Date,${OCC_COL},Total Sold Rooms,Total Rooms\n2026-01-01,85,80,100\n`);
near("percent 85 + counts 80/100 -> 0.80 (counts win)", b.value, 0.8);

// (c) ratio form is left EXACTLY as imported, even when counts disagree. A
// disagreement is a data-quality signal for the owner, not something to paper over.
const c = await occ(`Date,${OCC_COL},Total Sold Rooms,Total Rooms\n2026-01-01,0.85,10,100\n`);
near("ratio 0.85 with contradicting counts -> 0.85 unchanged", c.value, 0.85);

// (d) no printed occupancy, counts present.
const d = await occ("Date,Total Sold Rooms,Total Rooms\n2026-01-01,80,100\n");
near("no printed occupancy, counts 80/100 -> 0.80", d.value, 0.8);

// (e) nothing to work with. 0 is the only honest answer, but it must not be a
// silent one: the structural layer has to say the file is missing what it needs.
//
// This is the assertion that caught the second defect of the day. The branch above
// always writes `r.occupancy`, so the `= 0` fallback made `occupancy` look PRESENT
// to REQUIRED_FIELDS in importValidation.js — the file imported with zero findings
// and every day recorded as an empty hotel. The parser now reports it through
// `extraFindings`, which is the channel that gates an import the same way the
// generic layers do.
const e = await occ("Date,Room Revenue\n2026-01-01,1337.80\n");
eq("no occupancy and no counts -> 0", e.value, 0);
const eF = byCode(e.scan.validation, "occupancy_underivable");
ok("...and the file raises an ERROR rather than importing quietly",
  !!eF && eF.severity === "error",
  JSON.stringify(codes(e.scan.validation)));
ok("...which blocks the import", e.scan.validation?.ok === false);
eq("...and counts the affected rows", eF?.count, 1);

// (f) over 100%. Deliberately NOT clamped: >100% occupancy is the signal for a
// duplicated import, and clamping it to 1.0 is what makes a double import
// invisible. See BRAIN_FINANCE.md 12.3.
const f = await occ(`Date,${OCC_COL}\n2026-01-01,150\n`);
near("percent 150, no counts -> 1.5, not clamped to 1", f.value, 1.5);
ok("...and 1.5 trips the constraint layer so the owner is told",
  f.scan.validation?.findings?.some((x) => x.layer === "constraint" && /occupanc/i.test(x.message || "")),
  JSON.stringify(codes(f.scan.validation)));

// (g) The mapping that makes (a) and (f) reachable at all. Before 2026-08-20 no
// header spelling mapped to `occupancy`, so the printed forms could never arrive.
ok(`"${OCC_COL}" is a recognised header`,
  !(byCode(a.scan.validation, "unknown_columns")?.columns || []).includes(OCC_COL),
  JSON.stringify(byCode(a.scan.validation, "unknown_columns")?.columns || []));

// ═══ 4. Ragged rows must be counted ════════════════════════════════════════
console.log("\n=== 4. short and long rows are counted, not absorbed ===");

const ragged = "Date,Room Revenue,Total Sold Rooms,Total Rooms\n2026-01-01,100.00\n2026-01-02,200.00,10,100,EXTRA\n";
const rg = await scanReport("occupancy", "occupancy.csv", { csvText: ragged });

const shortF = byCode(rg.validation, "short_rows");
const longF = byCode(rg.validation, "long_rows");
ok("a short row is reported", !!shortF, shortF?.message);
eq("...with a count of 1", shortF?.count, 1);
ok("a long row is reported", !!longF, longF?.message);
eq("...with a count of 1", longF?.count, 1);
ok("the short row's missing cells did not become a fake occupancy",
  rg.rowsToImport?.[0]?.occupancy === 0,
  `occupancy=${JSON.stringify(rg.rowsToImport?.[0]?.occupancy)}`);

// ═══ 5. The real export, end to end ════════════════════════════════════════
//
// Anchored to the PMS's own printed column rather than to a number typed into a
// document. `Total Sold Rooms / Total Rooms` equals the printed percentage on
// every row of the real file, so the derived value can be checked against the
// source of truth instead of against a snapshot.
console.log("\n=== 5. the real Occupancy Summary: derived == what the PMS printed ===");

// OCCUPANCY_FILE overrides the fixture path, mirroring verify-statistics.mjs's
// STATS_FILE. Two reasons, both practical: the default is a *.csv .gitignore keeps
// out of the repository, so a fresh clone has no way to point section 5 at a real
// export it does hold; and the absent-fixture branch below is otherwise only
// reachable by moving the owner's own untracked data out of the way, which is not an
// acceptable price for testing the runner's decline handling. Point it at a
// nonexistent path to exercise the SKIP branch.
const REAL = process.env.OCCUPANCY_FILE
  || path.join(DATA, "Occupancy Summary midelboro.csv");
if (!fs.existsSync(REAL)) {
  // "SKIP:" with the colon is what scripts/_verdict.mjs anchors on. This is a
  // SECTION-scoped decline: the suite goes on to print its own PASSED/FAILED counter
  // for the other 56 checks, so the runner files this under PARTIAL COVERAGE. Before
  // 2026-09-05 it read the line as a whole-suite decline and reported 56 real
  // assertions as zero coverage — which, on a fresh clone, was every run.
  console.log(`  SKIP: fixture not found at ${REAL}`);
} else {
  const text = fs.readFileSync(REAL, "utf8");
  const real = await scanReport("occupancy", "Occupancy Summary midelboro.csv", { csvText: text });

  ok("the real file imports rows", real.totalRows > 200, `totalRows=${real.totalRows}`);
  ok("no structural or type ERROR on a known-good file",
    (real.validation?.errors || []).length === 0,
    JSON.stringify((real.validation?.errors || []).map((x) => x.code)));
  // The new underivable check must not fire on a good file. A gate that cries wolf on
  // the owner's own export is worse than no gate — see BRAIN_FINANCE.md 12.1.
  ok("the occupancy_underivable gate does not fire on the real export",
    !byCode(real.validation, "occupancy_underivable"));

  // Every row: the imported ratio must equal the printed percentage / 100.
  const printedByDate = new Map();
  const grid = parseCsvText(text);
  const head = (grid[0] || []).map((h) => String(h).trim());
  const iDate = head.indexOf("Date");
  const iPrinted = head.indexOf(OCC_COL);
  for (let i = 1; i < grid.length; i++) {
    const row = grid[i];
    if (!row || !row[iDate]) continue;
    printedByDate.set(String(row[iDate]).trim(), parseAmount(row[iPrinted]));
  }

  let compared = 0;
  let drift = 0;
  let outOfRange = 0;
  let worst = 0;
  for (const r of real.rowsToImport || []) {
    if (typeof r.occupancy !== "number") continue;
    if (r.occupancy < 0 || r.occupancy > 1) outOfRange++;
    // Match back by the PMS's own date spelling via the row's day-of-week + counts
    // is fragile; compare against sold/total, which the file itself agrees with.
    const sold = Number(r.rooms_sold) || 0;
    const total = Number(r.total_rooms) || 0;
    if (total <= 0) continue;
    compared++;
    const delta = Math.abs(r.occupancy - sold / total);
    if (delta > worst) worst = delta;
    if (delta > 1e-9) drift++;
  }
  ok("every row was compared against its own room counts", compared > 200, `compared=${compared}`);
  eq("zero rows drift from sold/total", drift, 0);
  eq("zero rows land outside 0..1", outOfRange, 0);
  ok("worst absolute delta is 0", worst === 0, `worst=${worst}`);

  // And the printed column agrees with the counts, which is what licenses the
  // derivation in the first place. Checked against the raw grid, 2dp as printed.
  let printedCompared = 0;
  let printedMismatch = 0;
  for (let i = 1; i < grid.length; i++) {
    const row = grid[i];
    if (!row || !row[iDate]) continue;
    const sold = parseAmount(row[head.indexOf("Total Sold Rooms")]);
    const total = parseAmount(row[head.indexOf("Total Rooms")]);
    const printed = printedByDate.get(String(row[iDate]).trim());
    if (!total || printed === null) continue;
    printedCompared++;
    if (Math.abs((sold / total) * 100 - printed) > 0.005) printedMismatch++;
  }
  ok("the PMS's printed percentage agrees with its own room counts",
    printedCompared > 200 && printedMismatch === 0,
    `compared=${printedCompared} mismatches=${printedMismatch}`);

  // The three unmapped occupancy definitions stay unmapped ON PURPOSE — mapping
  // more than one would make column order decide which definition wins.
  const un = byCode(real.validation, "unknown_columns")?.columns || [];
  ok("the three alternate occupancy definitions are still reported as unmapped",
    un.filter((x) => /^Occupancy /.test(x)).length === 3,
    JSON.stringify(un.filter((x) => /^Occupancy /.test(x))));
}

console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
if (fail) console.log(`Failures:\n  - ${failures.join("\n  - ")}`);
process.exit(fail > 0 ? 1 : 0);
