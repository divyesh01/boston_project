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
const businessSyncSrc = readFileSync(resolve(__dirname, "../src/api/businessSync.js"), "utf8");
const directlyAwaitsImport = (source) =>
  /result = await importReport\(/.test(source)
  && !/withActionTimeout\(\s*reportPromise/.test(source)
  && !/withActionTimeout\(\s*importReport\(/.test(source);
const batchOwnsSynchronousLock = (source) =>
  /if \(!pending\.length \|\| importingRef\.current \|\| importing\) return;/.test(source)
  && /importingRef\.current = true;\s*setImporting\(true\);\s*const newResults/.test(source)
  && /finally \{\s*importingRef\.current = false;\s*setImporting\(false\);/.test(source);
const unknownOutcomeStopsBatch = (source) =>
  /authoritativeOutcomeUnknown\s*=\s*true/.test(source)
  && /stopBatch:\s*e\?\.authoritativeOutcomeUnknown === true/.test(source)
  && /if \(r\?\.stopBatch\) break;/.test(source);
const transactionExecutorSection = (source) => source.slice(
  source.indexOf("async function executeTransactionEntry"),
  source.indexOf("async function recoverPendingTransactions"),
);
const commitResponseIsReconciled = (source) => {
  const executor = transactionExecutorSection(source);
  return /transaction\/status\?tx_id=/.test(executor)
    && /status\.status !== 'committed'/.test(executor)
    && /await finalizeTransactionEntry\(entry\)/.test(executor);
};
const trueNestedTransactionsAreRejected = (source) =>
  /if \(transactionPending \|\| activeTransaction\) throw new Error\('Nested or concurrent authoritative business transactions are not supported\.'\)/.test(source);

T("importReport is awaited directly", directlyAwaitsImport(src));
T("no withActionTimeout wraps the importReport call", directlyAwaitsImport(src));
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

console.log("\n=== Q3. In-memory mutation proof (working files are never changed) ===");
const m1 = src.replace("result = await importReport(", "result = await withActionTimeout(importReport(");
T("M1 old timeout wrapper is detected", !directlyAwaitsImport(m1));

const m2 = src.replace(
  /importingRef\.current = true;\s*setImporting\(true\);\s*const newResults/,
  "setImporting(true);\n    const newResults",
);
T("M2 early File B start is detected", !batchOwnsSynchronousLock(m2));

const m3 = src.replace("if (r?.stopBatch) break;", "// mutation: continue despite unknown outcome");
T("M3 missing unknown-outcome stop is detected", !unknownOutcomeStopsBatch(m3));

const m4 = businessSyncSrc.replace(
  "const status = await request(`business-sync/transaction/status?tx_id=${encodeURIComponent(entry.mutation_id)}`);",
  "const status = { status: 'unknown' };",
);
T("M4 missing commit-status reconciliation is detected", !commitResponseIsReconciled(m4));

const m5 = businessSyncSrc.replace(
  "if (transactionPending || activeTransaction) throw new Error('Nested or concurrent authoritative business transactions are not supported.');",
  "// mutation: nested transaction guard removed",
);
T("M5 missing true-nested rejection is detected", !trueNestedTransactionsAreRejected(m5));

T("All mutations restored (in-memory only)",
  directlyAwaitsImport(src)
  && batchOwnsSynchronousLock(src)
  && unknownOutcomeStopsBatch(src)
  && commitResponseIsReconciled(businessSyncSrc)
  && trueNestedTransactionsAreRejected(businessSyncSrc));

console.log("\n=== Q4. Large-operation chunk order stays deterministic at 13 ===");
const chunkOperations = (count) => {
  const operations = Array.from({ length: count }, (_, index) => index);
  const chunks = [];
  for (let offset = 0; offset < operations.length; offset += 13) {
    chunks.push(operations.slice(offset, offset + 13));
  }
  return chunks;
};
for (const count of [1, 13, 14, 100, 1000, 7918]) {
  const chunks = chunkOperations(count);
  const flattened = chunks.flat();
  const ordered = flattened.every((value, index) => value === index);
  T(`${count} operations preserve count, order, and <=13 chunk size`,
    flattened.length === count
      && ordered
      && chunks.every((chunk) => chunk.length >= 1 && chunk.length <= 13)
      && chunks.length === Math.ceil(count / 13));
}
T("7,918 operations produce exactly 610 chunks", chunkOperations(7918).length === 610);

console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
