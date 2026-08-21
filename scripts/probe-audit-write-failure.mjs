// Probe: an audit event that could not be written must never disappear quietly.
//
// THE DEFECT (launch item #7). Three writers caught a failed audit write and did
// nothing but `console.error`:
//     src/lib/auditLogger.js:34-36     catch (e) { console.error(...) }
//     src/api/base44Client.js:1115-1117 catch (e) { console.error(...) }
//     src/lib/pricingOverride.js:49-51  catch (err) { console.warn('Audit logging deferred', ...) }
// A console line in a browser is not a signal — nobody is watching it and it is
// gone on the next reload — so the operation carried on as if it had been
// recorded. That is the one gap an append-only trail cannot tolerate silently:
// `audit_verify` only checks that the rows it CAN see are correctly linked, so a
// row that was never written leaves the chain green and the event invisible. A
// rate override, a payroll approval or a session revocation could complete with
// nobody named against it and every screen in the app would look healthy.
//
// WHAT THE FIX IS NOT. It does not make audit failures throw. `AuthContext.jsx`
// (PROTECTED) awaits `logAuditEvent` during cross-tab session revocation and six
// callers await `db.audit.log`, including the report import path — so a logging
// outage would become a sign-in and import outage. The server-side writers
// already take this position (see base44/functions/autoPayroll/entry.ts#writeAudit).
// Sections [2]-[4] therefore assert the opposite of the usual instinct: these
// calls MUST still resolve. What changes is that the loss becomes durable and
// visible instead of vanishing.
//
// Run: node --import ./scripts/_loader-boot.mjs scripts/probe-audit-write-failure.mjs

await import("fake-indexeddb/auto");
globalThis.crypto ??= (await import("node:crypto")).webcrypto;

// Storage is a subject of this probe, not just scaffolding: section [1] swaps in
// a store that refuses writes and then removes storage altogether.
function makeStorage({ failWrites = false } = {}) {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      if (failWrites) throw new Error("QuotaExceededError: storage is full");
      map.set(k, String(v));
    },
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
  };
}
const liveStorage = makeStorage();
globalThis.localStorage = liveStorage;
globalThis.sessionStorage = makeStorage();

// A REAL DOM, before any app module is imported. `applyDynamicRateOverride`
// sanitises its inputs through securityUtils#sanitizeText, which calls
// DOMPurify.sanitize; dompurify exports its factory rather than an instance when
// no `window` existed at import time, so under plain Node section [4] dies with
// "DOMPurify.sanitize is not a function". Stubbing the sanitiser would mean this
// probe no longer exercises the real function it names. jsdom is already a
// declared devDependency, and scripts/probe-audit-export.mjs takes the same route
// for the same reason. Only `window` is replaced — _loader-boot.mjs's
// `document`/`location` shims stay, because axios and the base44 SDK are keyed to
// them, while DOMPurify reads window.document.
if (typeof globalThis.window?.document?.createElement !== "function") {
  let JSDOM;
  try {
    ({ JSDOM } = await import("jsdom"));
  } catch (err) {
    console.log("\nFATAL: jsdom could not be loaded, so the real sanitiser cannot run");
    console.log("and section [4] would not exercise applyDynamicRateOverride at all.");
    console.log("jsdom is a declared devDependency — run `npm install`.");
    console.log(`  ${err?.message}`);
    process.exit(1);
  }
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
  globalThis.window = dom.window;
}
if (globalThis.navigator === undefined) {
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "harness", language: "en-US" },
    configurable: true,
  });
}

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

const {
  recordAuditFailure,
  readAuditFailures,
  auditFailureCount,
  auditFailuresMayBeIncomplete,
  clearAuditFailures,
  AUDIT_FAILURE_STORAGE_KEY,
  AUDIT_FAILURE_MAX_ENTRIES,
} = await import("@/lib/auditFailureLog");
const { db } = await import("@/api/base44Client");
const { logAuditEvent } = await import("@/lib/auditLogger");
const { applyDynamicRateOverride } = await import("@/lib/pricingOverride");

let pass = 0;
let fail = 0;
const T = (label, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
};

// Every failure path below legitimately logs to the console. Capture rather than
// silence, so the probe can also assert the console line was NOT lost in the
// process of making the failure durable.
const realConsoleError = console.error;
const realConsoleWarn = console.warn;
let logged = [];
const captureConsole = () => {
  logged = [];
  const sink = (...a) => logged.push(a.map((x) => (x instanceof Error ? x.message : String(x))).join(" "));
  console.error = sink;
  console.warn = sink;
};
const releaseConsole = () => {
  console.error = realConsoleError;
  console.warn = realConsoleWarn;
};

// ── 1. The recorder in isolation ────────────────────────────────────────────
console.log("\n[1] the recorder itself");

clearAuditFailures();
T("starts with nothing recorded", readAuditFailures().length === 0);

recordAuditFailure("PROBE_ERROR", new Error("boom"), { source: "unit", property_id: "p1" });
const first = readAuditFailures();
T("records the loss", first.length === 1, `got ${first.length}`);
T("keeps the action that was lost", first[0]?.action === "PROBE_ERROR", JSON.stringify(first[0]));
T("extracts the Error message as the reason", first[0]?.reason === "boom", JSON.stringify(first[0]?.reason));
T("keeps the caller's context", first[0]?.source === "unit" && first[0]?.property_id === "p1");
T("timestamps the loss", typeof first[0]?.at === "string" && !Number.isNaN(Date.parse(first[0].at)));

// Read the store directly rather than through the accessor being tested.
const rawStored = JSON.parse(liveStorage.getItem(AUDIT_FAILURE_STORAGE_KEY) || "null");
T("persists under the documented key, as an array", Array.isArray(rawStored) && rawStored.length === 1);

// `error.message` alone would lose each of these. An offline fetch and a
// non-Error rejection are the realistic causes here, so none may degrade to an
// entry with no reason at all.
clearAuditFailures();
recordAuditFailure("A", "plain string failure");
T("a thrown string survives as the reason", readAuditFailures()[0]?.reason === "plain string failure",
  JSON.stringify(readAuditFailures()[0]?.reason));

clearAuditFailures();
recordAuditFailure("B", { status: 503, statusText: "Service Unavailable" });
T("a non-Error object is serialised, not dropped",
  readAuditFailures()[0]?.reason === '{"status":503,"statusText":"Service Unavailable"}',
  JSON.stringify(readAuditFailures()[0]?.reason));

clearAuditFailures();
const circular = { status: 503 };
circular.self = circular;
recordAuditFailure("C", circular);
const circEntry = readAuditFailures()[0];
T("a circular payload does not discard the record", circEntry?.action === "C", JSON.stringify(circEntry));
T("...and still yields some reason string", typeof circEntry?.reason === "string" && circEntry.reason.length > 0);

clearAuditFailures();
recordAuditFailure("D", undefined);
T("a missing error still records the lost action", readAuditFailures()[0]?.action === "D");

clearAuditFailures();
recordAuditFailure("OLDEST", new Error("1"));
recordAuditFailure("NEWEST", new Error("2"));
const ordered = readAuditFailures();
T("newest first", ordered[0]?.action === "NEWEST" && ordered[1]?.action === "OLDEST",
  ordered.map((e) => e.action).join(","));

// Bounded, and bounded the right way round: during a sustained outage the recent
// events are the ones an operator can still chase.
clearAuditFailures();
const N = AUDIT_FAILURE_MAX_ENTRIES + 5;
for (let i = 0; i < N; i++) recordAuditFailure(`E${i}`, new Error(String(i)));
const bounded = readAuditFailures();
T(`bounded at ${AUDIT_FAILURE_MAX_ENTRIES} entries`, bounded.length === AUDIT_FAILURE_MAX_ENTRIES, `got ${bounded.length}`);
T("the newest is kept", bounded[0]?.action === `E${N - 1}`, bounded[0]?.action);
T("the oldest is the one dropped", !bounded.some((e) => e.action === "E0"));
T("the count agrees", auditFailureCount() === AUDIT_FAILURE_MAX_ENTRIES);

clearAuditFailures();
liveStorage.setItem(AUDIT_FAILURE_STORAGE_KEY, "{not json");
T("a corrupt store reads as empty instead of throwing", readAuditFailures().length === 0);
liveStorage.setItem(AUDIT_FAILURE_STORAGE_KEY, '{"an":"object"}');
T("a non-array store reads as empty", readAuditFailures().length === 0);
recordAuditFailure("AFTER_CORRUPT", new Error("x"));
T("recording recovers from a corrupt store",
  readAuditFailures().some((e) => e.action === "AFTER_CORRUPT"));

// Private browsing / full quota: setItem throws.
clearAuditFailures();
globalThis.localStorage = makeStorage({ failWrites: true });
recordAuditFailure("QUOTA", new Error("y"));
T("a refused write keeps the record in memory",
  readAuditFailures().some((e) => e.action === "QUOTA"), JSON.stringify(readAuditFailures()));
T("...and admits the list may be incomplete", auditFailuresMayBeIncomplete() === true);

// No storage at all (Node, a worker, a hardened profile). This case is the
// module's own version of the bug it exists to fix: an optional-chained
// `localStorage?.setItem(...)` evaluates to undefined WITHOUT throwing, so a
// writer built on it reports success for a write that never happened and then
// drops the entry from the memory fallback — losing the record of the loss.
clearAuditFailures();
delete globalThis.localStorage;
recordAuditFailure("NO_STORAGE", new Error("z"));
T("with no localStorage at all the record still survives in memory",
  readAuditFailures().some((e) => e.action === "NO_STORAGE"), JSON.stringify(readAuditFailures()));
T("...and is reported as incomplete", auditFailuresMayBeIncomplete() === true);
globalThis.localStorage = liveStorage;

clearAuditFailures();
T("clearing resets both the count and the incomplete flag",
  auditFailureCount() === 0 && auditFailuresMayBeIncomplete() === false);

// Every caller is already inside a catch block. Throwing from here would
// re-swallow the failure at best and break the audited operation at worst.
let threw = null;
try {
  recordAuditFailure(undefined, undefined);
  recordAuditFailure(null, null, null);
  recordAuditFailure(Symbol("s").toString(), { get message() { throw new Error("nope"); } });
  recordAuditFailure("E", new Error(""), { nested: { deep: [1, 2, 3] } });
} catch (e) {
  threw = e;
}
T("never throws, whatever it is handed", threw === null, threw ? String(threw) : "");

// ── 2. db.audit.log — the writer six callers await ──────────────────────────
console.log("\n[2] db.audit.log (base44Client)");

// db.functions is the SAME object the module-local `functions` binding points at
// (base44Client.js:2182), so patching invoke here is what audit.log will call.
const realInvoke = db.functions.invoke;
const invoked = [];

clearAuditFailures();
captureConsole();
db.functions.invoke = async (name) => {
  invoked.push(name);
  if (name === "audit_log") throw new Error("network unreachable");
  return {};
};
const res = await db.audit.log({
  action: "PROBE_TXN_IMPORTED", username: "probe", property_id: "prop-x", detail: "d",
});
releaseConsole();

T("resolves instead of throwing at its callers", res && typeof res === "object", JSON.stringify(res));
T("reports the failure to the caller", res?.ok === false, JSON.stringify(res));
T("names the cause", String(res?.error).includes("network unreachable"), String(res?.error));
T("did attempt the server write", invoked.includes("audit_log"), invoked.join(","));
const rec2 = readAuditFailures();
T("records exactly one loss", rec2.length === 1, `got ${rec2.length}: ${JSON.stringify(rec2)}`);
T("attributes it to the right writer", rec2[0]?.source === "base44Client.db.audit.log", rec2[0]?.source);
T("keeps the action that went unrecorded", rec2[0]?.action === "PROBE_TXN_IMPORTED", rec2[0]?.action);
T("keeps the property scope", rec2[0]?.property_id === "prop-x");
T("still writes the console line too", logged.some((l) => l.includes("[audit] failed to write log")),
  logged.join(" | "));

clearAuditFailures();
db.functions.invoke = async () => ({ ok: true });
const good = await db.audit.log({ action: "PROBE_OK", username: "probe" });
T("a successful write reports ok", good?.ok === true, JSON.stringify(good));
T("...and records no failure", auditFailureCount() === 0);

// ── 3. logAuditEvent — must not double-count, must not throw ────────────────
console.log("\n[3] logAuditEvent (auditLogger)");

clearAuditFailures();
captureConsole();
db.functions.invoke = async (name) => {
  if (name === "audit_log") throw new Error("server 500");
  return {};
};
const le = await logAuditEvent("PROBE_LOGIN", { username: "probe", property_id: "prop-y" });
releaseConsole();
T("resolves — AuthContext awaits this during session revocation", le && typeof le === "object");
T("reports ok:false", le?.ok === false, JSON.stringify(le));
// The inner writer already recorded it. Recording again here would inflate the
// number on the Audit Log page and make one lost event look like two.
T("records exactly one failure, not two", auditFailureCount() === 1, `got ${auditFailureCount()}`);
T("the one record comes from the inner writer",
  readAuditFailures()[0]?.source === "base44Client.db.audit.log", readAuditFailures()[0]?.source);

// The outer catch: db.audit.log itself throwing (or createAuditEntry throwing).
clearAuditFailures();
const realAuditLog = db.audit.log;
captureConsole();
db.audit.log = async () => { throw new Error("audit.log itself exploded"); };
const le2 = await logAuditEvent("PROBE_REVOKE", { username: "probe", property_id: "prop-y" });
releaseConsole();
db.audit.log = realAuditLog;
T("survives a throw from db.audit.log", le2?.ok === false, JSON.stringify(le2));
T("records it against auditLogger", readAuditFailures()[0]?.source === "auditLogger.logAuditEvent",
  readAuditFailures()[0]?.source);
T("keeps the lost action", readAuditFailures()[0]?.action === "PROBE_REVOKE");

clearAuditFailures();
db.functions.invoke = async () => ({});
const le3 = await logAuditEvent("PROBE_OK2", { username: "probe" });
T("ok when the write succeeds", le3?.ok === true, JSON.stringify(le3));
T("...and records no failure", auditFailureCount() === 0);

// ── 4. applyDynamicRateOverride — a money-moving change ────────────────────
console.log("\n[4] applyDynamicRateOverride (pricingOverride)");

// Guards against a future harness "fix" that stubs the sanitiser and makes the
// section below exercise something other than the shipped function.
const { sanitizeText } = await import("@/lib/securityUtils");
T("the real DOMPurify-backed sanitiser is in play",
  sanitizeText("<script>alert(1)</script>ok") === "ok", JSON.stringify(sanitizeText("<script>alert(1)</script>ok")));

clearAuditFailures();
captureConsole();
db.functions.invoke = async (name) => {
  if (name === "audit_log") throw new Error("audit down");
  return {};
};
const payload = await applyDynamicRateOverride({
  propertyId: "prop-z", newRate: 149.5, roomType: "Double Queen",
  justification: "probe", user: { id: "u1", username: "mgr" },
});
releaseConsole();
T("the rate change still returns its payload", payload?.current_rate === 149.5, JSON.stringify(payload));
T("records the now-unattributable override", auditFailureCount() === 1, `got ${auditFailureCount()}`);
const ov = readAuditFailures()[0];
T("...with the right action", ov?.action === "RATE_OVERRIDE_APPLIED", ov?.action);
T("...the right site", ov?.source === "pricingOverride.applyDynamicRateOverride", ov?.source);
T("...and the property it applied to", ov?.property_id === "prop-z", ov?.property_id);
T("no longer calls the loss 'deferred'", !logged.some((l) => /deferred/i.test(l)), logged.join(" | "));

db.functions.invoke = realInvoke;
clearAuditFailures();

// ── 5. Structural guards ───────────────────────────────────────────────────
console.log("\n[5] structure");

// Negative assertions run against comment-stripped source. Both fixes below
// deliberately quote what they replaced — pricingOverride.js names the old
// "Audit logging deferred" wording and auditFailureLog.js names the
// optional-chained setItem that reported false success — and a probe that fails
// because a file explains its own defect punishes the fix. Borrowed from
// probe-ui-feedback.mjs; the `[^:]` guard keeps `https://` out of the
// line-comment rule.
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/.*$/gm, "$1");
const readCode = (rel) => stripComments(read(rel));

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(js|jsx)$/.test(name)) out.push(p);
  }
  return out;
}
const srcFiles = walk(path.join(ROOT, "src"));
const stillDeferred = srcFiles.filter((p) =>
  stripComments(readFileSync(p, "utf8")).includes("Audit logging deferred"));
T('no file describes a dropped audit write as "deferred"', stillDeferred.length === 0,
  stillDeferred.map((p) => path.relative(ROOT, p)).join(", "));

for (const rel of ["src/lib/auditLogger.js", "src/api/base44Client.js", "src/lib/pricingOverride.js"]) {
  T(`${rel} records its audit failures`, /recordAuditFailure\(/.test(readCode(rel)));
}

const page = readCode("src/pages/AuditLog.jsx");
T("the audit page reads and can clear the failure log",
  /readAuditFailures/.test(page) && /clearAuditFailures/.test(page));
const iFail = page.indexOf("writeFailures.length > 0");
const iChain = page.indexOf("{chain && (");
// Order matters: a green "chain verified" banner above an unnoticed warning is
// how a reader concludes the trail is complete when it is not.
T("the failure banner renders above the chain-verified banner",
  iFail > -1 && iChain > -1 && iFail < iChain, `failures@${iFail} chain@${iChain}`);

T("the writer cannot report success when there is no store",
  !/localStorage\?\.setItem/.test(readCode("src/lib/auditFailureLog.js")));

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
