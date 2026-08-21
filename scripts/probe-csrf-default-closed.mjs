// scripts/probe-csrf-default-closed.mjs
//
// Playbook items #8 (CSRF validation bypassable when sessionStorage is
// unavailable) and #19 (the CSRF pair is static for the page lifetime).
//
// WHAT THE DEFECT WAS. src/lib/securityUtils.js#validateCsrfToken opened with
//
//     const ss = safeSessionStorage();
//     if (!ss) return true; // ... bypass client validation to prevent lockout
//
// so in any browser where sessionStorage is unavailable — Safari private and
// Lockdown modes, an embedded webview with storage partitioned off, anything
// configured to refuse site data — every call to the validator returned true,
// including one carrying a token the caller never issued. The comment was honest
// about the trade and wrong about the necessity.
//
// The reason it looked necessary is upstream of the line, and that is the part
// worth probing: getCsrfToken() persisted the token ONLY to sessionStorage, so
// with no sessionStorage it minted a fresh token on every call and stored none
// of them. Two consecutive calls disagreed. Making the validator default-closed
// without fixing the store would have refused every mutating action in those
// browsers — a real lockout, which is why the bypass was there. So the fix is a
// page-lifetime memory store (memoryCsrfToken), and only then `return false`.
//
// Section 2 is therefore the section that matters: it asserts BOTH that a forged
// token is refused AND that a legitimate one still passes, in the same
// no-sessionStorage world. A probe asserting only the refusal would also pass
// against a validator hard-coded to `return false`, which would ship a
// hotel-wide outage.
//
// #19 IS DELIBERATELY NOT "FIXED", and section 5 guards that. The pair the
// SERVER compares is stable for the page's lifetime because the base44 SDK
// copies its headers object once at construction into axios defaults. The last
// attempt to make rotation reach the server left cookie and header mismatched
// and every mutating call answered 403 until the tab was reloaded. Per-page-load
// randomness is what double-submit actually requires; rotating within a page
// only defends against replay of a token whose capture already implies script
// execution on this origin. So the assertions here PIN the pin: pinCsrfCookie()
// must keep restoring the first-issued token.

import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SRC = path.join(REPO, "src", "lib", "securityUtils.js");

let pass = 0;
let fail = 0;
const failures = [];

function ok(label, cond, detail) {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    failures.push(detail ? `${label} — ${detail}` : label);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function eq(label, actual, expected) {
  ok(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ── Storage doubles ──────────────────────────────────────────────────────────
// sessionStorage is a SUBJECT of this probe, not scaffolding: the whole defect
// lives in how the module behaves across its three real-world states. Hence a
// factory rather than a single stub.
function makeStorage({ failWrites = false } = {}) {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      // Note the ORDER a real quota failure has: the probe write that
      // safeSessionStorage() performs must succeed (otherwise the module simply
      // treats the store as absent, which is section 2's world, not this one),
      // and the real write must throw.
      if (failWrites && !String(k).startsWith("_rri_test_")) {
        throw new DOMException("QuotaExceededError", "QuotaExceededError");
      }
      map.set(k, String(v));
    },
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
    _map: map,
  };
}

// A fresh module instance per scenario. memoryCsrfToken and csrfHeaderToken are
// module-level state, so reusing one instance across scenarios would let the
// first scenario's token satisfy the next one's assertions — the probe would
// pass while proving nothing. The alias hook appends ".js" to any specifier not
// ending in an extension, so "@/lib/securityUtils.js?v=1" would resolve to
// "...js?v=1.js"; import the file URL directly instead.
let instance = 0;
function freshModule() {
  instance += 1;
  return import(`${pathToFileURL(SRC).href}?probe=${instance}`);
}

function resetCookie() {
  if (!globalThis.document) globalThis.document = { cookie: "" };
  globalThis.document.cookie = "";
}

const HEX64 = /^[0-9a-f]{64}$/;

// ── Section 1: sessionStorage available (the ordinary path) ───────────────────
console.log("\n[1] sessionStorage available — the ordinary path must be unchanged");
{
  const ss = makeStorage();
  globalThis.sessionStorage = ss;
  resetCookie();

  const m = await freshModule();

  const first = m.getCsrfToken();
  ok("getCsrfToken returns 64 hex chars", HEX64.test(first), JSON.stringify(first));
  eq("second call returns the same token (persisted)", m.getCsrfToken(), first);
  eq("token is written to sessionStorage['rri_csrf_token']", ss.getItem("rri_csrf_token"), first);
  ok("cookie carries the token", globalThis.document.cookie.includes(`__Host-csrf_token=${first}`), globalThis.document.cookie);
  ok("cookie is __Host- prefixed with Path=/", globalThis.document.cookie.startsWith("__Host-csrf_token=") && globalThis.document.cookie.includes("Path=/"), globalThis.document.cookie);

  eq("issued token validates", m.validateCsrfToken(first), true);
  eq("a different token is refused", m.validateCsrfToken("f".repeat(64)), false);
  eq("a truncated token is refused", m.validateCsrfToken(first.slice(0, 63)), false);
  eq("a token with one extra char is refused", m.validateCsrfToken(first + "0"), false);

  const rotated = m.rotateCsrfToken();
  ok("rotateCsrfToken returns 64 hex chars", HEX64.test(rotated), JSON.stringify(rotated));
  ok("rotation yields a different token", rotated !== first);
  eq("rotation persists to sessionStorage", ss.getItem("rri_csrf_token"), rotated);
  eq("the rotated token validates", m.validateCsrfToken(rotated), true);
  eq("the pre-rotation token no longer validates", m.validateCsrfToken(first), false);

  // #19: the server-compared pair. pinCsrfCookie must put the cookie back to the
  // token the SDK froze into its header at construction — the FIRST one issued.
  m.pinCsrfCookie();
  ok("pinCsrfCookie restores the first-issued token to the cookie",
    globalThis.document.cookie.includes(`__Host-csrf_token=${first}`), globalThis.document.cookie);
  ok("pinCsrfCookie does NOT put the rotated token in the cookie",
    !globalThis.document.cookie.includes(`__Host-csrf_token=${rotated}`), globalThis.document.cookie);
  eq("rotation still governs the in-page check after pinning", m.validateCsrfToken(rotated), true);
}

// ── Section 2: no sessionStorage — the bug ───────────────────────────────────
console.log("\n[2] sessionStorage ABSENT — the bypass, and the lockout that made it look necessary");
{
  delete globalThis.sessionStorage;
  ok("precondition: typeof sessionStorage === 'undefined'", typeof globalThis.sessionStorage === "undefined");
  resetCookie();

  const m = await freshModule();

  const first = m.getCsrfToken();
  ok("a token is still issued with no sessionStorage", HEX64.test(first), JSON.stringify(first));

  // The upstream half. Before the fix this produced a DIFFERENT token every
  // call, which is what left the validator nothing to compare against.
  eq("two calls agree on one token (page-lifetime store)", m.getCsrfToken(), first);
  eq("a third call still agrees", m.getCsrfToken(), first);
  ok("cookie carries it", globalThis.document.cookie.includes(`__Host-csrf_token=${first}`), globalThis.document.cookie);

  // The security half: this is the assertion the old code failed.
  eq("a forged token is REFUSED with no sessionStorage", m.validateCsrfToken("a".repeat(64)), false);
  eq("a plausible-looking forgery is refused", m.validateCsrfToken("deadbeef".repeat(8)), false);
  eq("the empty string is refused", m.validateCsrfToken(""), false);
  eq("undefined is refused", m.validateCsrfToken(undefined), false);
  eq("null is refused", m.validateCsrfToken(null), false);
  eq("a non-string is refused", m.validateCsrfToken(12345), false);
  eq("an object is refused", m.validateCsrfToken({ toString: () => first }), false);

  // The availability half, in the same world. Without this the section would
  // also pass against `return false`, which would refuse every save.
  eq("the legitimately issued token STILL validates", m.validateCsrfToken(first), true);

  const rotated = m.rotateCsrfToken();
  ok("rotation works with no sessionStorage", HEX64.test(rotated) && rotated !== first, JSON.stringify(rotated));
  eq("the rotated token validates", m.validateCsrfToken(rotated), true);
  eq("the pre-rotation token is refused", m.validateCsrfToken(first), false);

  m.pinCsrfCookie();
  ok("pinCsrfCookie still pins the first-issued token", globalThis.document.cookie.includes(`__Host-csrf_token=${first}`), globalThis.document.cookie);
}

// ── Section 3: sessionStorage present but refusing writes ────────────────────
console.log("\n[3] sessionStorage writable on probe, throwing on the real write (quota)");
{
  const ss = makeStorage({ failWrites: true });
  globalThis.sessionStorage = ss;
  resetCookie();

  const m = await freshModule();

  const first = m.getCsrfToken();
  ok("a token is issued despite the refused write", HEX64.test(first), JSON.stringify(first));
  eq("nothing reached sessionStorage", ss.getItem("rri_csrf_token"), null);
  eq("two calls still agree (memory copy stands in)", m.getCsrfToken(), first);
  eq("the issued token validates", m.validateCsrfToken(first), true);
  eq("a forged token is refused", m.validateCsrfToken("b".repeat(64)), false);

  const rotated = m.rotateCsrfToken();
  eq("the rotated token validates", m.validateCsrfToken(rotated), true);
  eq("the pre-rotation token is refused", m.validateCsrfToken(first), false);
}

// ── Section 4: return type ──────────────────────────────────────────────────
console.log("\n[4] the validator returns a strict boolean on every path");
{
  const ss = makeStorage();
  globalThis.sessionStorage = ss;
  resetCookie();
  const m = await freshModule();
  const t = m.getCsrfToken();

  // The old implementation ended with `return stored && stored === token`, which
  // yields '' or null on its miss paths. A caller written as
  // `if (validateCsrfToken(t) === false)` reads those as a pass.
  for (const [label, input] of [
    ["issued token", t],
    ["wrong token", "c".repeat(64)],
    ["empty string", ""],
    ["undefined", undefined],
    ["null", null],
    ["number", 7],
  ]) {
    eq(`typeof result is boolean for ${label}`, typeof m.validateCsrfToken(input), "boolean");
  }

  // And with nothing ever issued, on a fresh instance.
  delete globalThis.sessionStorage;
  const m2 = await freshModule();
  eq("un-issued instance refuses any token", m2.validateCsrfToken("d".repeat(64)), false);
  eq("un-issued instance returns a boolean", typeof m2.validateCsrfToken("d".repeat(64)), "boolean");
}

// ── Section 5: structural guards ────────────────────────────────────────────
// Run against comment-stripped source, per the convention in this repo's other
// probes: a probe that fails because a file DOCUMENTS its own former defect
// punishes the fix. The [^:] guard keeps "https://" out of the line-comment rule.
console.log("\n[5] structural guards on src/lib/securityUtils.js");
{
  const raw = readFileSync(SRC, "utf8");
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  ok("the fail-open line is gone", !/if\s*\(\s*!ss\s*\)\s*return\s+true/.test(code));
  ok("no CSRF path returns a bare true on missing storage", !/safeSessionStorage\(\)[\s\S]{0,80}return\s+true/.test(code));
  ok("validateCsrfToken compares with constantTimeEqual", /export function validateCsrfToken[\s\S]{0,600}constantTimeEqual\(/.test(code));
  ok("validateCsrfToken reads the shared store accessor", /export function validateCsrfToken[\s\S]{0,600}readStoredCsrfToken\(/.test(code));
  ok("validateCsrfToken has an explicit false for a missing store", /export function validateCsrfToken[\s\S]{0,600}return\s+false/.test(code));
  ok("getCsrfToken persists through the shared writer", /export function getCsrfToken[\s\S]{0,300}persistCsrfToken\(/.test(code));
  ok("rotateCsrfToken persists through the shared writer", /export function rotateCsrfToken[\s\S]{0,300}persistCsrfToken\(/.test(code));
  ok("the memory fallback is assigned before the sessionStorage write",
    /function persistCsrfToken\(token\)\s*\{\s*memoryCsrfToken = token;/.test(code));
  ok("sessionStorage is no longer the only store (setItem is not the sole persist)",
    (code.match(/setItem\(CSRF_TOKEN_KEY/g) || []).length === 1,
    `found ${(code.match(/setItem\(CSRF_TOKEN_KEY/g) || []).length}`);

  // #19 pin must survive. If a future change "fixes" rotation by dropping the
  // pin, every mutating call 403s — the regression this guards is an outage.
  ok("csrfHeaderToken is still captured once in getCsrfToken",
    /if \(csrfHeaderToken === null\) csrfHeaderToken = token;/.test(code));
  ok("pinCsrfCookie still writes the frozen header token",
    /export function pinCsrfCookie[\s\S]{0,300}writeCsrfCookie\(csrfHeaderToken\)/.test(code));
  ok("rotateCsrfToken does not touch csrfHeaderToken",
    !/export function rotateCsrfToken[\s\S]{0,300}csrfHeaderToken\s*=/.test(code));
  ok("writeCsrfCookie is still the single cookie writer",
    (code.match(/document\.cookie\s*=/g) || []).length === 1,
    `found ${(code.match(/document\.cookie\s*=/g) || []).length}`);

  // The old comment claimed the bypass prevented lockout. If that text is still
  // present the file is describing behaviour it no longer has.
  ok("the 'bypass client validation' comment is gone from the source",
    !/bypass client validation/i.test(raw));
}

console.log(`\n${"─".repeat(70)}`);
if (failures.length) {
  console.log("Failures:");
  failures.forEach((f) => console.log(`  • ${f}`));
}
console.log(`PASS ${pass}   FAIL ${fail}`);
process.exit(fail ? 1 : 0);
