// scripts/_audit-report.mjs — the decision logic for scripts/audit-gate.mjs.
//
// WHY THIS IS ITS OWN FILE. Same reason as scripts/_verdict.mjs: the gate script
// spawns `npm audit --json` at module scope, so importing it to test its decision
// runs a real audit and then calls process.exit. Nothing could feed it a payload.
// The result was a security gate whose entire decision — what blocks, what is
// accepted, what has gone stale — had no test of its own.
//
// Leading `_` keeps this file out of BOTH discovery walks (verify-all.mjs's
// `isSuite` and probe-suite-integrity.mjs's audit). Its regression suite is
// scripts/probe-audit-shape.mjs.

/**
 * Decide what one parsed `npm audit --json` report means.
 *
 * @param {unknown} report                 parsed JSON from `npm audit --json`
 * @param {object}  opts
 * @param {Record<string, {what: string}>} opts.accepted  allowlist, keyed `<pkg>:<GHSA>`
 * @param {Set<string>} opts.blocking      severities that block the build
 * @returns {{
 *   ran: boolean, reason: string|null,
 *   counts: Record<string, number>,
 *   seen: Set<string>, stale: string[],
 *   blocking: Array<{key: string, severity: string, title: string, url: string, fixAvailable: unknown, note?: string}>,
 * }}
 */
export function classifyAuditReport(report, { accepted, blocking: blockingSeverities }) {
  // FAIL CLOSED ON SHAPE. `npm audit --json` prints valid JSON when it fails, so
  // JSON.parse succeeding proves nothing about whether an audit happened: with the
  // registry unreachable the whole payload is `{message, error}`, `vulnerabilities` is
  // undefined, `?? {}` scans zero packages, and the caller reports 0 of everything —
  // a clean bill of health for a run that audited nothing. Worse, `seen` comes back
  // empty, so every accepted advisory looks stale and the gate tells the reader to
  // delete the written record of a real, reviewed, unfixed high-severity risk.
  //
  // A run only counts as an audit when npm reported no error AND gave us both halves
  // it always gives us on success: a vulnerabilities MAP (`{}` on a clean repo — the
  // map being empty is a result, its absence is not) and a metadata count object.
  const notRan = (reason) => ({
    ran: false,
    reason,
    counts: {},
    seen: new Set(),
    stale: [],
    blocking: [],
  });
  const isMap = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

  if (!isMap(report)) return notRan("the audit output was not a JSON object.");
  if (report.error !== undefined) {
    const detail = report.error?.code ?? report.message ?? "no detail given";
    return notRan(`npm reported an error instead of an audit: ${detail}`);
  }
  if (!isMap(report.vulnerabilities)) {
    return notRan("the audit output carried no `vulnerabilities` map.");
  }
  if (!isMap(report.metadata?.vulnerabilities)) {
    return notRan("the audit output carried no `metadata.vulnerabilities` counts.");
  }

  const blocking = [];
  const seen = new Set();

  for (const [pkg, vuln] of Object.entries(report.vulnerabilities)) {
    for (const via of vuln?.via ?? []) {
      // A string `via` is a transitive pointer to another package's entry, not an
      // advisory of its own; the advisory itself is always an object with a url.
      if (typeof via !== "object" || !via.url) continue;
      if (!blockingSeverities.has(via.severity)) continue;

      const id = via.url.split("/").pop();
      const key = `${pkg}:${id}`;
      seen.add(key);

      const entry = accepted[key];
      if (!entry) {
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

  // An allowlist entry for an advisory npm no longer reports is rot. Failing on
  // it is deliberate: it is the only moment anyone will ever delete the entry.
  const stale = Object.keys(accepted).filter((k) => !seen.has(k));

  return {
    ran: true,
    reason: null,
    counts: report.metadata.vulnerabilities,
    seen,
    stale,
    blocking,
  };
}
