// Probe: a 35s import timeout must never unlock the queue mid-transaction.
//
// Defect: src/pages/Import.jsx awaited `withActionTimeout(importReport(...), 35000)`.
// The wrapper REJECTS its caller at the deadline but cannot cancel the underlying
// promise, so `runTransaction` inside importReport kept running while the queue
// item flipped to error and handleImportAll started File B — two write
// transactions overlapping on the same store.
//
// Q1 proves the mechanism against the real helper (a timed-out race rejects the
// caller while the underlying work continues).
// Q2 pins the fixed contract in Import.jsx by source inspection.
//
// Run: node scripts/probe-long-import-transaction-coordination.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { withActionTimeout } from "../src/lib/actionTimeout.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
let pass = 0;
let fail = 0;
const T = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`); }
};

console.log("\n=== Q1. A timeout rejects the caller while the underlying work continues ===");
let underlyingSettled = false;
const work = new Promise((r) => setTimeout(() => { underlyingSettled = true; r("committed"); }, 120));
let timedOut = false;
try {
  await withActionTimeout(work, 30, "File import timed out after 35s.");
} catch (e) {
  timedOut = e?.code === "ACTION_TIMEOUT";
}
T("the raced caller rejects at the deadline", timedOut === true);
T("the underlying importReport/transaction keeps running after the caller gave up",
  underlyingSettled === false,
  underlyingSettled ? "underlying work had already settled" : "");
await new Promise((r) => setTimeout(r, 200));
T("the underlying work still settles later (it was never cancelled)", underlyingSettled === true);

console.log("\n=== Q2. Import.jsx no longer races importReport against a timeout ===");
const src = readFileSync(resolve(__dirname, "../src/pages/Import.jsx"), "utf8");
T("importReport is awaited directly", /result = await importReport\(/.test(src));
T("no withActionTimeout wraps the importReport call",
  !/withActionTimeout\(\s*reportPromise/.test(src) && !/withActionTimeout\(\s*importReport\(/.test(src));
T("the 35s timer only publishes a truthful still-importing notice",
  /Still importing/.test(src) && /35000/.test(src));
T("a failed rollback marks the outcome unverifiable",
  /authoritativeOutcomeUnknown\s*=\s*true/.test(src));
T("importSingle can return stopBatch", /stopBatch:\s*e\?\.authoritativeOutcomeUnknown === true/.test(src));
T("the batch loop breaks on stopBatch", /if \(r\?\.stopBatch\) break;/.test(src));
T("row Import/Retry share one synchronous overlap guard", /importingRef\.current = true/.test(src));
T("row Import/Retry guard on the synchronous ref before the state",
  /if \(importingRef\.current \|\| importing \|\| busy\) return null;/.test(src));
T("the batch loop takes the same synchronous guard, so it cannot double-start",
  /if \(!pending\.length \|\| importingRef\.current \|\| importing\) return;/.test(src));

console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);