// Probe for "integrity signals are computed, then discarded" (B8).
//
// scanTransactions computes the two signals that matter most for the main
// revenue ledger — the file's own trailer total vs the parsed sum, and rows
// dropped for an unreadable date — and puts them in `scan.errors`. Nothing
// renders `scan.errors`, and neither scanTransactions nor scanHotelStatistics
// returns a `validation` key, so importReport's blocking gate
// (`if (validation && !validation.ok && !forceImport)`) cannot fire for either
// of the two highest-stakes report types.
//
// Phase 2 of this probe is a MEASUREMENT, not just a pass/fail: before wiring
// validateImport into these two types, it prints exactly what the validator
// would say about the REAL files. Wiring it in is only safe if a good file
// still validates clean — otherwise the fix would block real imports.
//
// Run: node --import ./scripts/_loader-boot.mjs scripts/probe-import-validation.mjs

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

let pass = 0;
let fail = 0;
const T = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`); }
};

const DATA = join(dirname(fileURLToPath(import.meta.url)), "data");
const read = (f) => readFileSync(join(DATA, f), "utf8");
const { scanReport } = await import("@/lib/reportParsers");

const scanText = (type, name, csvText) =>
  scanReport(type, `file:///${name}`, {
    propertyId: "P1", propertyName: "Probe Property", sourceFile: name, csvText,
  });

const show = (label, v) => {
  if (!v) { console.log(`    ${label}: (no validation object)`); return; }
  console.log(`    ${label}: ok=${v.ok} errors=${v.errors.length} warnings=${v.warnings.length} firstFailingLayer=${v.firstFailingLayer}`);
  for (const f of [...v.errors, ...v.warnings]) {
    console.log(`      [${f.severity}/${f.layer}/${f.code}] ${f.message}`);
  }
};

// ── 1. The real transaction ledger ─────────────────────────────────────────
console.log("\n=== 1. All Transactions.csv — the real revenue ledger ===");
const txnName = "All Transactions.csv";
const txnText = read(txnName);
const txn = await scanText("transactions", txnName, txnText);
console.log(`    rows=${txn.totalRows} checksum=${JSON.stringify(txn.checksum)} errors=${JSON.stringify(txn.errors)}`);
show("validation", txn.validation);

T("the ledger parsed rows", txn.totalRows > 0, `totalRows=${txn.totalRows}`);
T("the real file agrees with its own trailer total", txn.checksum?.matches === true,
  JSON.stringify(txn.checksum));
T("scanTransactions returns a validation object", !!txn.validation);
T("a good real ledger is NOT blocked", txn.validation?.ok === true,
  `errors=${JSON.stringify(txn.validation?.errors?.map((f) => f.code))}`);

// ── 2. A tampered ledger must be blocked ───────────────────────────────────
// Change one amount so the parsed sum no longer matches the file's own trailer.
// This is the exact shape of a truncated or mis-parsed download.
console.log("\n=== 2. A ledger that disagrees with its own total ===");
// Amounts in this export are quoted and dollar-prefixed: "$1234.56".
// The file stacks five grids; only the widest (the LAST one) is imported, so the
// tamper has to land inside that grid or the checksum rightly ignores it. Walking
// backwards finds a dated data row in the used section; the trailer row is
// skipped because it starts with an empty Date field.
const AMOUNT_RE = /"\$([\d,]+\.\d\d)"/;
const DATED_ROW_RE = /^"[A-Z][a-z]{2} \d{1,2}, \d{4}"/;
const lines = txnText.split(/\r?\n/);
let tamperedAt = -1;
for (let i = lines.length - 1; i > 0; i--) {
  if (!DATED_ROW_RE.test(lines[i])) continue;
  const m = lines[i].match(AMOUNT_RE);
  if (m && parseFloat(m[1].replace(/,/g, "")) > 0) {
    const bumped = (parseFloat(m[1].replace(/,/g, "")) + 1000).toFixed(2);
    lines[i] = lines[i].replace(m[0], `"$${bumped}"`);
    tamperedAt = i;
    break;
  }
}
T("probe could tamper with an amount", tamperedAt > 0, `tamperedAt=${tamperedAt}`);
const tamperedText = lines.join("\n");
const tampered = await scanText("transactions", "tampered.csv", tamperedText);
console.log(`    checksum=${JSON.stringify(tampered.checksum)}`);
show("validation", tampered.validation);
T("the mismatch is detected", tampered.checksum?.matches === false);
T("the mismatch BLOCKS the import", tampered.validation?.ok === false,
  `ok=${tampered.validation?.ok}`);
T("the blocking finding names the checksum",
  tampered.validation?.errors?.some((f) => f.code === "checksum_mismatch"),
  JSON.stringify(tampered.validation?.errors?.map((f) => f.code)));

// ── 3. An unparseable amount must not silently become 0 ────────────────────
console.log("\n=== 3. An amount that is not a number ===");
const badAmountText = (() => {
  const l = txnText.split(/\r?\n/);
  l[tamperedAt] = l[tamperedAt].replace(AMOUNT_RE, '"N/A"');
  return l.join("\n");
})();
const badAmount = await scanText("transactions", "bad-amount.csv", badAmountText);
show("validation", badAmount.validation);
T("the zero-filled amount is reported",
  badAmount.validation?.findings?.some((f) => f.code === "unparseable_numbers" && f.field === "amount"),
  JSON.stringify(badAmount.validation?.findings?.map((f) => f.code)));

// ── 3b. The fabricated zero must block on its own merit ────────────────────
//
// Section 3 proves the "N/A" is *reported*, but that file is also blocked by the
// checksum: dropping 87.30 out of a summed column makes the parsed total disagree
// with the trailer. So section 3 cannot say whether the fabricated zero itself
// blocks anything. Remove the checksum error and the question is answered.
//
// Here the trailer is reduced by exactly the amount that was blanked, so the file
// agrees with itself and the only defect left is a numeric cell the parser could
// not read and silently turned into 0. This matters beyond the ledger: a
// transactions export happens to carry a trailer total, but Hotel Statistics and
// the summary reports do not, so for those files this finding is the only line of
// defence that exists.
console.log("\n=== 3b. A fabricated zero with a self-consistent trailer ===");
const isoText = (() => {
  const l = txnText.split(/\r?\n/);
  const blanked = parseFloat(l[tamperedAt].match(AMOUNT_RE)[1].replace(/,/g, ""));
  l[tamperedAt] = l[tamperedAt].replace(AMOUNT_RE, '"N/A"');
  // The trailer is the summary row: it carries an amount but no date.
  for (let i = l.length - 1; i > 0; i--) {
    if (!l[i].trim() || DATED_ROW_RE.test(l[i])) continue;
    const m = l[i].match(AMOUNT_RE);
    if (!m) continue;
    const declared = parseFloat(m[1].replace(/,/g, ""));
    // parseAmount strips "$" and "," alike, so an un-grouped number is read the
    // same as a grouped one and this needs no comma formatter.
    l[i] = l[i].replace(m[0], `"$${(declared - blanked).toFixed(2)}"`);
    break;
  }
  return l.join("\n");
})();
const iso = await scanText("transactions", "fabricated-zero.csv", isoText);
console.log(`    checksum=${JSON.stringify(iso.checksum)}`);
show("validation", iso.validation);
const isoFinding = iso.validation?.findings?.find((f) => f.code === "unparseable_numbers");
T("the file agrees with its own trailer, so the checksum is not the blocker",
  iso.checksum?.matches === true, JSON.stringify(iso.checksum));
T("no checksum error remains to confuse the result",
  !iso.validation?.errors?.some((f) => f.code === "checksum_mismatch"),
  JSON.stringify(iso.validation?.errors?.map((f) => f.code)));
T("the fabricated zero is rated as corruption, not a warning",
  isoFinding?.severity === "error", `severity=${isoFinding?.severity}`);
T("the fabricated zero alone BLOCKS the import", iso.validation?.ok === false,
  `ok=${iso.validation?.ok} errors=${JSON.stringify(iso.validation?.errors?.map((f) => f.code))}`);
T("and it is the only thing blocking",
  iso.validation?.errors?.length === 1
    && iso.validation.errors[0].code === "unparseable_numbers",
  JSON.stringify(iso.validation?.errors?.map((f) => f.code)));
T("the message still names the column an operator can go look at",
  isoFinding?.field === "amount" && /treated as 0/.test(isoFinding?.message || ""),
  JSON.stringify(isoFinding));

// A partial parse was already an error. "12abc" → 12 is the sibling of this
// defect — same cause, same harm — and the two must not drift apart again.
const truncText = txnText.split(/\r?\n/)
  .map((l, i) => (i === tamperedAt ? l.replace(AMOUNT_RE, '"12abc"') : l)).join("\n");
const trunc = await scanText("transactions", "truncated.csv", truncText);
T("a partly-numeric amount is still an error",
  trunc.validation?.errors?.some((f) => f.code === "truncated_numbers"),
  JSON.stringify(trunc.validation?.errors?.map((f) => f.code)));

// An error is a gate, not a wall: the operator can still force a file through
// after reading what is wrong with it. If that escape ever disappears, one stray
// cell would make a file permanently unimportable, which is its own outage.
const parserSrc = read(join("..", "..", "src", "lib", "reportParsers.js"));
T("a blocked import can still be forced by the operator",
  /!validation\.ok\s*&&\s*!forceImport/.test(parserSrc),
  "the forceImport escape hatch in importReport is gone");

// ── 4. The real hotel statistics file ──────────────────────────────────────
console.log("\n=== 4. Hotel Statistics (1).csv — the real snapshot ===");
const statName = "Hotel Statistics (1).csv";
const stat = await scanText("hotel_statistics", statName, read(statName));
console.log(`    metrics=${stat.totalRows} unknownMetrics=${stat.unknownMetrics?.length ?? "n/a"} errors=${JSON.stringify(stat.errors)}`);
show("validation", stat.validation);
T("the snapshot parsed metrics", stat.totalRows > 0, `totalRows=${stat.totalRows}`);
T("scanHotelStatistics returns a validation object", !!stat.validation);
T("a good real snapshot is NOT blocked", stat.validation?.ok === true,
  `errors=${JSON.stringify(stat.validation?.errors?.map((f) => f.code))}`);

// ── 5. A statistics file that parses to nothing must be blocked ────────────
console.log("\n=== 5. A statistics file that yields no metrics ===");
const emptyStat = await scanText("hotel_statistics", "empty-stats.csv", "Hotel Statistics\n\n");
show("validation", emptyStat.validation);
T("zero metrics blocks the import", emptyStat.validation?.ok === false,
  `totalRows=${emptyStat.totalRows} ok=${emptyStat.validation?.ok}`);

// ── 6. Unknown metric names are surfaced, not swallowed ────────────────────
console.log("\n=== 6. A renamed metric row ===");
// A metric label the PMS renamed to something the category map cannot place.
// "Stay Overs" is chosen because the replacement shares no keyword with any
// known category — renaming to a string that still contains "occupancy" or
// "rooms" would be correctly recognised and prove nothing.
const renamedStat = await scanText("hotel_statistics", "renamed.csv",
  read(statName).replace('"Stay Overs"', '"Zzq Widget Throughput"'));
show("validation", renamedStat.validation);
T("unrecognised metrics are reported",
  renamedStat.validation?.findings?.some((f) => f.code === "unknown_metrics"),
  JSON.stringify(renamedStat.validation?.findings?.map((f) => f.code)));

console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
