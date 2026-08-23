// Probe: the session lifetime constants and the cookie that carries them.
//
//   node scripts/probe-session-expiry.mjs
//
// Pure text assertions against the real source — no DOM, no Dexie, no network.
//
// WHAT THIS FILE USED TO BE (and why it was worse than empty):
// 22 lines of console.log prose with four hardcoded constants and no assertions.
// Its "SCENARIO 2" narrated, as current fact, that the 30s frontend poll calls
// custom_auth_me and therefore "Session is kept alive forever with NO user
// activity". That is FALSE for this code: the poll calls custom_auth_check,
// which never writes expires_at. The narration described the pre-fix behaviour
// and was never updated, so `npm run verify:all` printed a description of a
// live vulnerability that had already been fixed — while the file next to it
// (probe-idle-polling.mjs) printed the opposite conclusion. Two suites in one
// gate contradicting each other, neither asserting anything.
//
// Prose in a suite rots silently because nothing executes it. So this file now
// reads the numbers out of the source and asserts the RELATIONSHIPS between
// them. A hardcoded expectation would only relocate the rot: it would still be
// a number in a probe that a source change can silently diverge from. What
// cannot rot is an ordering invariant — "the slide threshold must be shorter
// than the cookie window" stays meaningful whatever the values become.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

let pass = 0;
let failed = 0;
const failures = [];
function ok(cond, label, detail = "") {
  if (cond) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// Evaluate a plain product of integers ("7 * 24 * 60 * 60") without eval().
// Returns null for anything that is not exactly that shape, so a source change
// to a computed or imported value surfaces as a failed match rather than a
// silently wrong number.
function product(expr) {
  if (typeof expr !== "string") return null;
  const parts = expr.trim().split("*").map((p) => p.trim());
  if (!parts.length || !parts.every((p) => /^\d+$/.test(p))) return null;
  return parts.reduce((a, p) => a * Number(p), 1);
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_MS = 60 * 1000;

console.log("=== PROBE: SESSION EXPIRY CONSTANTS AND COOKIE INTEGRITY ===\n");

// ── 1. Pull every constant out of the real source ────────────────────────────
const login = read("base44/functions/custom_auth_login/entry.js");
const me = read("base44/functions/custom_auth_me/entry.js");
const check = read("base44/functions/custom_auth_check/entry.js");
const auth = read("src/lib/AuthContext.jsx");
const client = read("src/api/base44Client.js");

// Cookie window, as seconds, from the Max-Age the login endpoint issues.
const loginMaxAge = product(login.match(/base44_session=\$\{token\}[^`]*Max-Age=\$\{([^}]+)\}/)?.[1]);
ok(loginMaxAge !== null, "read the login cookie Max-Age out of custom_auth_login",
  `got ${loginMaxAge}`);

// The same window, re-issued by the sliding endpoint.
const meMaxAge = product(me.match(/base44_session=\$\{token\}[^`]*Max-Age=\$\{([^}]+)\}/)?.[1]);
ok(meMaxAge !== null, "read the refreshed cookie Max-Age out of custom_auth_me",
  `got ${meMaxAge}`);

// Absolute cap, in ms, asserted independently in both session-reading endpoints.
const meAbsolute = product(me.match(/sessionAge > ([\d\s*]+)\)/)?.[1]);
const checkAbsolute = product(check.match(/sessionAge > ([\d\s*]+)\)/)?.[1]);
ok(meAbsolute !== null, "read the absolute session cap out of custom_auth_me", `got ${meAbsolute}`);
ok(checkAbsolute !== null, "read the absolute session cap out of custom_auth_check",
  `got ${checkAbsolute}`);

// The sliding threshold and the window it slides to.
const slideThreshold = product(me.match(/timeRemaining < ([\d\s*]+)\)/)?.[1]);
const slideTo = product(me.match(/Date\.now\(\) \+ ([\d\s*]+)\)\.toISOString\(\)/)?.[1]);
ok(slideThreshold !== null, "read the sliding threshold out of custom_auth_me",
  `got ${slideThreshold}`);
ok(slideTo !== null, "read the slid-to window out of custom_auth_me", `got ${slideTo}`);

// Frontend timers.
const idleCheck = product(auth.match(/IDLE_CHECK_MS\s*=\s*([\d\s*]+);/)?.[1]);
const inactivity = product(auth.match(/INACTIVITY_TIMEOUT_MS\s*=\s*([\d\s*]+);/)?.[1]);
const throttle = product(client.match(/THROTTLE_MS\s*=\s*([\d\s*]+);/)?.[1]);
ok(idleCheck !== null, "read IDLE_CHECK_MS out of AuthContext.jsx", `got ${idleCheck}`);
ok(inactivity !== null, "read INACTIVITY_TIMEOUT_MS out of AuthContext.jsx", `got ${inactivity}`);
ok(throttle !== null, "read THROTTLE_MS out of base44Client.js", `got ${throttle}`);

console.log(`\n  Measured from source:`);
console.log(`    cookie window        ${loginMaxAge / 86400} days (login) / ${meMaxAge / 86400} days (refresh)`);
console.log(`    absolute cap         ${meAbsolute / DAY_MS} days (me) / ${checkAbsolute / DAY_MS} days (check)`);
console.log(`    slides when under    ${slideThreshold / DAY_MS} days remaining, to +${slideTo / DAY_MS} days`);
console.log(`    idle poll            ${idleCheck / 1000}s`);
console.log(`    inactivity logout    ${inactivity / MIN_MS} min`);
console.log(`    touch throttle       ${throttle / MIN_MS} min\n`);

// ── 2. The relationships that must hold whatever the values are ──────────────
ok(loginMaxAge === meMaxAge,
  "the refreshed cookie carries the SAME window as the one login issues (a renewal, not a downgrade)",
  `login ${loginMaxAge}s vs refresh ${meMaxAge}s`);
ok(meAbsolute === checkAbsolute,
  "both session-reading endpoints enforce the SAME absolute cap (one lagging behind is a bypass)",
  `me ${meAbsolute}ms vs check ${checkAbsolute}ms`);
ok(slideThreshold < loginMaxAge * 1000,
  "the slide threshold is shorter than the cookie window, so sliding happens before expiry",
  `threshold ${slideThreshold}ms vs window ${loginMaxAge * 1000}ms`);
ok(slideTo === loginMaxAge * 1000,
  "sliding extends to exactly the login window — not longer",
  `slideTo ${slideTo}ms vs window ${loginMaxAge * 1000}ms`);
ok(loginMaxAge * 1000 < meAbsolute,
  "the cookie window is shorter than the absolute cap, so the cap is the thing that ends a session",
  `window ${loginMaxAge * 1000}ms vs cap ${meAbsolute}ms`);
ok(inactivity < loginMaxAge * 1000,
  "the inactivity logout fires long before the cookie window ends (an idle tab dies first)",
  `inactivity ${inactivity}ms vs window ${loginMaxAge * 1000}ms`);
ok(idleCheck < inactivity,
  "the poll runs more often than the inactivity timeout, so the timeout can actually be observed",
  `poll ${idleCheck}ms vs timeout ${inactivity}ms`);
ok(throttle < inactivity,
  "the touch throttle is shorter than the inactivity timeout, so an active user is never logged out",
  `throttle ${throttle}ms vs timeout ${inactivity}ms`);

// ── 3. Cookie attribute integrity, on BOTH cookies ───────────────────────────
// The source comment at custom_auth_me warns that "any weakening of these
// attributes here would silently downgrade every long-lived session". Nothing
// enforced that warning until now.
for (const [name, src] of [["custom_auth_login", login], ["custom_auth_me", me]]) {
  const cookie = src.match(/`base44_session=\$\{token\}[^`]*`/)?.[0] ?? "";
  ok(cookie.length > 0, `${name} issues a base44_session cookie`);
  ok(/HttpOnly/.test(cookie), `${name}'s cookie is HttpOnly (no script can read the session)`);
  ok(/SameSite=Lax/.test(cookie), `${name}'s cookie is SameSite=Lax`);
  ok(/Secure/.test(cookie) && /isProd \? '; Secure'/.test(cookie),
    `${name}'s cookie carries Secure in production`, cookie);
}

// An unreadable request URL must fail toward the stricter cookie, not the looser
// one — otherwise a renewed session could travel in clear text.
const isProdBlock = me.match(/let isProd = true;[\s\S]*?\n {4}\}/)?.[0] ?? "";
ok(isProdBlock.length > 0, "found the isProd derivation in custom_auth_me");
ok(/catch \{\s*isProd = true;/.test(isProdBlock),
  "an unparseable request URL defaults isProd to TRUE, so the cookie fails toward Secure",
  isProdBlock.replace(/\s+/g, " "));

// ── 4. The absolute cap actually revokes ─────────────────────────────────────
for (const [name, src] of [["custom_auth_me", me], ["custom_auth_check", check]]) {
  ok(/is_revoked: true/.test(src),
    `${name} REVOKES the session row on hitting the absolute cap (not merely returns 401)`);
}

console.log("\n" + "=".repeat(72));
console.log(`${failed === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${failed} failed`);
if (failures.length) {
  console.log("\nFailures:");
  failures.forEach((f) => console.log("  x " + f));
}
console.log("=".repeat(72));
process.exit(failed > 0 ? 1 : 0);
