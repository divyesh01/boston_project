// The CI security gate — replaces a bare `npm audit --audit-level=high`.
//
//   node scripts/audit-gate.mjs
//
// WHY THIS FILE EXISTS
// `npm audit --audit-level=high` exits 1 on a high-severity advisory even when
// no fix exists, which on 2026-08-21 made the GitHub Actions job unpassable: the
// `xlsx` package carries two high advisories marked "No fix available", because
// SheetJS left the npm registry at 0.18.5 and publishes fixes only from its own
// CDN. The two ways out of that are both bad on their own:
//
//   --audit-level=critical  → silently tolerates EVERY high, forever, including
//                             ones that arrive next month in other packages.
//   continue-on-error: true → the step goes green no matter what it found.
//
// Both turn a security gate into decoration. This script instead accepts named
// advisories, one at a time, with a written reason — and keeps failing on
// everything else. It also fails when an exception becomes UNNECESSARY, so an
// allowlist entry cannot quietly outlive the problem it was written for.
//
// No new dependency: node builtins plus the npm CLI. (This repo has a hard
// no-new-dependency rule — see src/lib/exportData.js:49 — which rules out
// audit-ci / better-npm-audit.)

import { spawnSync } from "node:child_process";

/** Severities that block the build. Mirrors the old --audit-level=high. */
const BLOCKING = new Set(["high", "critical"]);

/**
 * Advisories we have examined and accepted, keyed `<package>:<GHSA id>`.
 *
 * To add an entry you must state why the advisory is not reachable in THIS
 * codebase. "No fix available" is not a reason on its own — it is the situation,
 * not the argument.
 */
const ACCEPTED = {
  "xlsx:GHSA-4r6h-8v6p-xvw6": {
    what: "Prototype Pollution in SheetJS",
    why:
      "Not reachable: this repo uses xlsx WRITE-ONLY. The single importer is " +
      "src/lib/exportData.js:55 and it calls only utils.aoa_to_sheet, " +
      "utils.json_to_sheet, utils.book_new, utils.book_append_sheet and " +
      "writeFile. Verified 2026-08-21 that XLSX.read, XLSX.readFile and " +
      "sheet_to_json appear nowhere under src/. Uploaded spreadsheets are " +
      "parsed server-side by the platform " +
      "(db.integrations.Core.ExtractDataFromUploadedFile, " +
      "src/pages/DataIntelligence.jsx:161), never by this package. The advisory " +
      "requires parsing an attacker-supplied workbook.",
    reviewed: "2026-08-21",
  },
  "xlsx:GHSA-5pgg-2g8v-p4x9": {
    what: "SheetJS Regular Expression Denial of Service (ReDoS)",
    why:
      "Same reachability argument as GHSA-4r6h-8v6p-xvw6: the ReDoS is in the " +
      "parse path, and nothing in src/ parses a spreadsheet with this package.",
    reviewed: "2026-08-21",
  },
};

const res = spawnSync("npm", ["audit", "--json"], {
  encoding: "utf8",
  shell: process.platform === "win32",
});

// FAIL CLOSED. A gate that goes green because the registry was unreachable, or
// because npm changed its output shape, has verified nothing at all.
let report;
try {
  report = JSON.parse(res.stdout);
} catch {
  console.error("AUDIT GATE: could not parse `npm audit --json` output.");
  console.error("This is a gate failure, not a pass — the audit did not run.");
  console.error("\n--- stdout ---\n" + (res.stdout || "(empty)"));
  console.error("\n--- stderr ---\n" + (res.stderr || "(empty)"));
  process.exit(1);
}

const blocking = [];
const seen = new Set();

for (const [pkg, vuln] of Object.entries(report.vulnerabilities ?? {})) {
  for (const via of vuln.via ?? []) {
    // A string `via` is a transitive pointer to another package's entry, not an
    // advisory of its own; the advisory itself is always an object with a url.
    if (typeof via !== "object" || !via.url) continue;
    if (!BLOCKING.has(via.severity)) continue;

    const id = via.url.split("/").pop();
    const key = `${pkg}:${id}`;
    seen.add(key);

    const accepted = ACCEPTED[key];
    if (!accepted) {
      blocking.push({ key, severity: via.severity, title: via.title, url: via.url, fixAvailable: vuln.fixAvailable });
      continue;
    }
    // The exception expires the moment it stops being needed.
    if (vuln.fixAvailable) {
      blocking.push({
        key,
        severity: via.severity,
        title: via.title,
        url: via.url,
        fixAvailable: vuln.fixAvailable,
        note: "A FIX IS NOW AVAILABLE. Upgrade and delete this entry from ACCEPTED.",
      });
    }
  }
}

// An allowlist entry for an advisory npm no longer reports is rot. Failing here
// is deliberate: it is the only moment anyone will ever delete the entry.
const stale = Object.keys(ACCEPTED).filter((k) => !seen.has(k));

const counts = report.metadata?.vulnerabilities ?? {};
console.log(
  `Audit: ${counts.critical ?? 0} critical, ${counts.high ?? 0} high, ` +
    `${counts.moderate ?? 0} moderate, ${counts.low ?? 0} low ` +
    `(gate blocks: ${[...BLOCKING].join(", ")})`
);

for (const key of Object.keys(ACCEPTED)) {
  if (seen.has(key)) console.log(`  accepted  ${key} — ${ACCEPTED[key].what}`);
}

if (stale.length) {
  console.error("\nAUDIT GATE FAILED — stale exception(s):");
  for (const key of stale) {
    console.error(`  ${key} is no longer reported by npm audit.`);
    console.error("  Delete it from ACCEPTED in scripts/audit-gate.mjs.");
  }
}

if (blocking.length) {
  console.error("\nAUDIT GATE FAILED — unaccepted advisor" + (blocking.length === 1 ? "y" : "ies") + ":");
  for (const b of blocking) {
    console.error(`\n  ${b.severity.toUpperCase()}  ${b.key}`);
    console.error(`  ${b.title}`);
    console.error(`  ${b.url}`);
    console.error(`  fixAvailable: ${JSON.stringify(b.fixAvailable)}`);
    if (b.note) console.error(`  ${b.note}`);
  }
  console.error(
    "\nFix it, or — only if it is genuinely unreachable in this codebase — add it\n" +
      "to ACCEPTED in scripts/audit-gate.mjs with a reason that says WHY it cannot\n" +
      "be reached. Never lower --audit-level and never set continue-on-error."
  );
}

if (stale.length || blocking.length) process.exit(1);
console.log("\nAudit gate passed: no unaccepted high or critical advisories.");
