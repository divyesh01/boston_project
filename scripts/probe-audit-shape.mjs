// scripts/probe-audit-shape.mjs — regression suite for the decision logic in
// scripts/_audit-report.mjs, which is what `npm run audit:gate` blocks the build on.
//
// WHY THIS EXISTS. audit-gate.mjs replaced a bare `npm audit --audit-level=high` so
// that named advisories could be accepted one at a time with a written reachability
// argument, instead of lowering the gate for everything forever. Its own header
// promises it FAILS CLOSED: "A gate that goes green because the registry was
// unreachable, or because npm changed its output shape, has verified nothing at all."
//
// Measured 2026-09-05, it did not keep that promise. With the registry unreachable
// `npm audit --json` still prints valid JSON — 186 bytes whose keys are exactly
// `message,error` — so the JSON.parse guard is satisfied and nothing stops the run.
// `report.vulnerabilities` is undefined, `?? {}` makes the scan loop iterate zero
// times, and the gate prints a clean bill of health for a run that audited nothing:
//
//   Audit: 0 critical, 0 high, 0 moderate, 0 low (gate blocks: high, critical)
//
// Then, because `seen` is empty, every accepted advisory looks stale and the gate
// instructs the reader to "Delete it from ACCEPTED in scripts/audit-gate.mjs" — which
// would erase the written record of a real, reviewed, unfixed HIGH-severity risk. It
// exits 1, which is the only reason this is P2 and not P0: the build does stop, but
// for a fabricated reason, and the remedy it prints makes the repository less safe.
//
// The two payloads below are MEASURED from real `npm audit --json` runs in this repo
// on 2026-09-05 (1586 bytes / exit 1, and 186 bytes / registry unreachable), not
// invented. Nothing here spawns npm: a suite that needs the network to go green is a
// suite that flips red on unchanged repository bytes. The end-to-end run is recorded
// as a measurement in docs/brain/, and the wiring is pinned by section 6 below.
//
// Do NOT relax a case to make this green: each one encodes a promise the gate makes.

import { readFileSync } from "node:fs";
import { classifyAuditReport } from "./_audit-report.mjs";

let pass = 0;
let fail = 0;
const failures = [];

function eq(label, actual, expected) {
  if (actual === expected) {
    pass += 1;
  } else {
    fail += 1;
    failures.push(`${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    console.log(`  FAIL  ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const BLOCKING = new Set(["high", "critical"]);

// The two advisories npm reports for xlsx: ONE vulnerable package entry carrying TWO
// `via` objects. That is why an allowlist with two keys is consistent with `total: 1`.
const XLSX_VIA = [
  {
    source: 1094599,
    name: "xlsx",
    dependency: "xlsx",
    title: "Prototype Pollution in sheetJS",
    url: "https://github.com/advisories/GHSA-4r6h-8v6p-xvw6",
    severity: "high",
    range: "<0.19.3",
  },
  {
    source: 1096411,
    name: "xlsx",
    dependency: "xlsx",
    title: "SheetJS Regular Expression Denial of Service (ReDoS)",
    url: "https://github.com/advisories/GHSA-5pgg-2g8v-p4x9",
    severity: "high",
    range: "<0.20.2",
  },
];

// MEASURED: exit 1, 1586 bytes, top keys auditReportVersion,vulnerabilities,metadata.
const REAL = {
  auditReportVersion: 2,
  vulnerabilities: {
    xlsx: {
      name: "xlsx",
      severity: "high",
      isDirect: true,
      via: XLSX_VIA,
      effects: [],
      range: "<=0.19.2",
      nodes: ["node_modules/xlsx"],
      fixAvailable: false,
    },
  },
  metadata: {
    vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 },
    dependencies: { prod: 1, dev: 1, optional: 0, peer: 0, peerOptional: 0, total: 1 },
  },
};

// MEASURED: 186 bytes, top keys EXACTLY `message,error`. No `vulnerabilities` key at
// all and no `metadata` key at all — both read back as undefined, which is precisely
// what `?? {}` turns into "nothing to report".
const OFFLINE = {
  message: "request to http://127.0.0.1:9/-/npm/v1/security/advisories/bulk failed",
  error: { code: "ECONNREFUSED", summary: "connect ECONNREFUSED 127.0.0.1:9", detail: "" },
};

// A tiny local allowlist on purpose. Coupling this suite to the real ACCEPTED map would
// turn it red the day an advisory is legitimately fixed and its entry deleted.
const ACCEPTED_XLSX = {
  "xlsx:GHSA-4r6h-8v6p-xvw6": { what: "Prototype Pollution in SheetJS" },
  "xlsx:GHSA-5pgg-2g8v-p4x9": { what: "SheetJS ReDoS" },
};

// A genuinely clean audit: an EMPTY vulnerabilities map plus real (zero) counts. This
// is the shape the guard must not mistake for a failed run.
const clean = () => ({
  auditReportVersion: 2,
  vulnerabilities: {},
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } },
});

const one = (severity, url, extra = {}) => ({
  auditReportVersion: 2,
  vulnerabilities: {
    pkg: { name: "pkg", severity, via: [{ title: "T", url, severity }], fixAvailable: false, ...extra },
  },
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 } },
});

const run = (report, accepted = {}) => classifyAuditReport(report, { accepted, blocking: BLOCKING });

console.log("1. the measured real payload");

eq("a real report is recognised as an audit that ran", run(REAL, ACCEPTED_XLSX).ran, true);
eq("its counts are carried through", run(REAL, ACCEPTED_XLSX).counts.high, 1);
eq("both advisories of one package are seen separately", run(REAL, ACCEPTED_XLSX).seen.size, 2);
eq("neither accepted advisory blocks while no fix exists", run(REAL, ACCEPTED_XLSX).blocking.length, 0);
eq("neither accepted advisory is reported stale", run(REAL, ACCEPTED_XLSX).stale.length, 0);
eq("with no allowlist at all, both advisories block", run(REAL).blocking.length, 2);

console.log("\n2. REGRESSION: a report that audited nothing must not read as clean");

eq("the registry-unreachable payload is not an audit", run(OFFLINE, ACCEPTED_XLSX).ran, false);
eq("...and it says why", typeof run(OFFLINE, ACCEPTED_XLSX).reason, "string");
// The dangerous half. `seen` is empty because nothing was scanned, so every accepted
// advisory looks stale and the gate tells the reader to delete a real reviewed risk.
eq("...and it does NOT declare the acceptances stale", run(OFFLINE, ACCEPTED_XLSX).stale.length, 0);
eq("...and it does NOT report a scan result", run(OFFLINE, ACCEPTED_XLSX).blocking.length, 0);

console.log("\n3. other shapes that mean the audit did not run");

eq("an error key fails closed even when the rest looks well formed",
  run({ ...clean(), error: { code: "EAI_AGAIN" } }).ran, false);
eq("no metadata at all is not an audit", run({ vulnerabilities: {} }).ran, false);
eq("metadata without a vulnerabilities count is not an audit",
  run({ vulnerabilities: {}, metadata: { dependencies: {} } }).ran, false);
eq("a non-object vulnerabilities map is a shape change, not an empty audit",
  run({ vulnerabilities: "none", metadata: { vulnerabilities: {} } }).ran, false);
eq("an ARRAY vulnerabilities value is a shape change too",
  run({ vulnerabilities: [], metadata: { vulnerabilities: {} } }).ran, false);
eq("a null report is not an audit", run(null).ran, false);
eq("a non-object report is not an audit", run("").ran, false);

console.log("\n4. a genuinely clean audit stays green, and staleness must still fire");

eq("an empty vulnerabilities map with real counts IS an audit that ran", run(clean()).ran, true);
eq("...and blocks nothing", run(clean()).blocking.length, 0);
eq("...and reports nothing stale when the allowlist is empty", run(clean()).stale.length, 0);
// The case the shape guard must not swallow: a real audit that no longer reports an
// advisory the allowlist still carries. That failure is the only moment anyone deletes it.
eq("REGRESSION: a real clean audit still reports a stale allowlist key",
  run(clean(), ACCEPTED_XLSX).stale.length, 2);

console.log("\n5. the scan rules the gate has always had and never tested");

const GHSA = "https://github.com/advisories/GHSA-xxxx-xxxx-xxxx";
eq("the key is <package>:<advisory id> from the url's last segment",
  run(one("high", GHSA)).blocking[0].key, "pkg:GHSA-xxxx-xxxx-xxxx");
eq("a high advisory with no allowlist entry blocks", run(one("high", GHSA)).blocking.length, 1);
eq("a critical advisory blocks", run(one("critical", GHSA)).blocking.length, 1);
eq("a moderate advisory does not block", run(one("moderate", GHSA)).blocking.length, 0);
eq("...and is not recorded as seen either", run(one("moderate", GHSA)).seen.size, 0);
// A string `via` is a transitive pointer to another package's entry, not an advisory.
eq("a string via is skipped",
  run({ vulnerabilities: { a: { via: ["b"], severity: "high", fixAvailable: false } },
        metadata: { vulnerabilities: {} } }).blocking.length, 0);
eq("an object via with no url is skipped",
  run({ vulnerabilities: { a: { via: [{ title: "T", severity: "high" }], fixAvailable: false } },
        metadata: { vulnerabilities: {} } }).blocking.length, 0);
eq("an accepted advisory with no fix does not block",
  run(one("high", GHSA), { "pkg:GHSA-xxxx-xxxx-xxxx": { what: "x" } }).blocking.length, 0);
// The exception expires the moment it stops being needed.
const fixed = run(one("high", GHSA, { fixAvailable: true }), { "pkg:GHSA-xxxx-xxxx-xxxx": { what: "x" } });
eq("an accepted advisory that now has a fix blocks again", fixed.blocking.length, 1);
eq("...with the upgrade instruction attached", /FIX IS NOW AVAILABLE/.test(fixed.blocking[0]?.note ?? ""), true);
eq("an allowlist key for an advisory this audit did not report is stale",
  run(one("high", GHSA), { "other:GHSA-1111-1111-1111": { what: "x" } }).stale.length, 1);

console.log("\n6. the wiring, pinned statically so the guard cannot be left unused");

const gate = readFileSync(new URL("./audit-gate.mjs", import.meta.url), "utf8");
const iGuard = gate.search(/if\s*\(!ran\)/);
const iCount = gate.indexOf("gate blocks:");
const iStale = gate.indexOf("stale exception");

eq("audit-gate.mjs imports the classifier",
  /import\s*\{[^}]*classifyAuditReport[^}]*\}\s*from\s*"\.\/_audit-report\.mjs"/.test(gate), true);
eq("audit-gate.mjs keeps no second copy of the scan loop",
  /Object\.entries\(report[?.]*\.vulnerabilities/.test(gate), false);
eq("it guards on `ran`", iGuard >= 0, true);
// Order IS the defect. A guard that runs after the count line has already printed the
// false all-clear, and after the stale comparison has told the reader to delete a real
// acceptance, is not a guard.
eq("the guard precedes the audit count line", iGuard >= 0 && iCount > iGuard, true);
eq("the guard precedes the stale report", iGuard >= 0 && iStale > iGuard, true);
eq("the guard exits non-zero before either",
  iGuard >= 0 && iCount > iGuard
    && /process\.exit\(1\)/.test(gate.slice(iGuard, iCount)), true);

console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("\nFailures:");
  failures.forEach((f) => console.log(`  - ${f}`));
}
process.exit(fail > 0 ? 1 : 0);
