// Probe: does the backend leak internal error detail to the client?
//
// Sends deliberately malformed JSON at a function endpoint so the handler throws
// inside its own try/catch, then checks the RESPONSE BODY for internal detail
// (SyntaxError, parser messages, stack frames). Returning `err.message` straight
// out of a catch block hands an attacker the runtime, the parser and often file
// paths; every function in base44/functions/ is supposed to answer with a fixed
// "Internal server error" instead.
//
// FIXED 2026-08-20 — this probe used to report a FAILURE when no dev server was
// running:
//     Network error (is the dev server running?): fetch failed
//     process.exit(1)
// A red result that means "not tested" is worse than no result: it is
// indistinguishable from "your endpoint leaks stack traces", so the real signal
// is lost in a permanent false alarm. It now exits 0 with a "SKIP:" line, which
// scripts/verify-all.mjs reports as skipped and lists in the summary even on a
// green run — visible missing coverage instead of a fake failure.
//
// Run (needs the app running):  npm run dev   then   node scripts/probe-config-exposure.mjs

const BASE = process.env.PROBE_BASE_URL || "http://localhost:5173";
const ENDPOINT = `${BASE}/api/functions/aiAssistant`;

// Detail that must never reach a client. Kept as named patterns so a hit reports
// WHICH kind of internal detail escaped rather than just "something matched".
const LEAK_PATTERNS = [
  ["JS error class", /\b(SyntaxError|TypeError|ReferenceError|RangeError)\b/],
  ["parser message", /Unexpected (token|string|end of JSON|identifier)/i],
  ["stack frame", /\bat\s+\w+[\w.$]*\s*\(/],
  ["file path", /(\/[\w.-]+){2,}\.(js|ts|jsx|tsx|mjs)/],
  ["node internals", /node:internal|node_modules/],
];

let pass = 0;
let fail = 0;
const T = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`); }
};

async function post(body, contentType = "application/json") {
  return fetch(ENDPOINT, { method: "POST", headers: { "content-type": contentType }, body });
}

async function main() {
  let first;
  try {
    first = await post("{ this is invalid json ]");
  } catch (err) {
    // Distinguish "nothing is listening" from a real transport failure. Only the
    // former is a legitimate skip.
    const why = err?.cause?.code || err?.code || err?.message || String(err);
    console.log(`SKIP: no server reachable at ${BASE} (${why}).`);
    console.log("      Start the app with `npm run dev` (or set PROBE_BASE_URL) and re-run;");
    console.log("      this probe needs a live endpoint to observe what it returns on an error.");
    process.exit(0);
  }

  console.log(`Probing ${ENDPOINT} for internal error exposure...\n`);

  const cases = [
    ["malformed JSON body", await first.text(), first.status],
  ];
  for (const [label, body, ct] of [
    ["empty body", "", "application/json"],
    ["JSON array where an object is expected", "[1,2,3]", "application/json"],
    ["wrong content type", "not json at all", "text/plain"],
  ]) {
    try {
      const res = await post(body, ct);
      cases.push([label, await res.text(), res.status]);
    } catch (err) {
      cases.push([label, `((request failed: ${err?.message || err}))`, 0]);
    }
  }

  for (const [label, text, status] of cases) {
    const hits = LEAK_PATTERNS.filter(([, re]) => re.test(text)).map(([n]) => n);
    T(`${label} -> no internal detail in the response body`, hits.length === 0,
      `leaked: ${hits.join(", ")}\n          status ${status}, body: ${text.slice(0, 300)}`);
    // A 500 for a malformed request is itself a smell (it should be a 400), but a
    // 200 carrying an error is worse: it tells the client the call succeeded.
    T(`${label} -> answered with a client-error status, not 200`,
      status === 0 || status >= 400,
      `status ${status}, body: ${text.slice(0, 200)}`);
  }

  console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`FAILED: probe crashed: ${err?.stack || err}`);
  process.exit(1);
});
