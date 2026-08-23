// Probe: an active user stays signed in; an idle one does not.
//
//   node scripts/probe-active-vs-idle.mjs
//
// Pure simulation + text extraction — no DOM, no Dexie, no network.
//
// WHAT THIS FILE USED TO BE:
// the same simulation, but with every constant hardcoded and no assertions —
// it printed "[Day 8] User is still logged in!" and exited 0 whatever happened.
// A simulation with no assertion cannot fail, and a simulation whose constants
// are hardcoded is not a simulation OF ANYTHING: the moment the real session
// window or sliding threshold changes, the model keeps happily reporting the old
// system's behaviour. It was in `npm run verify:all` reporting neither.
//
// Both halves are fixed here: the constants are read out of the real source
// (custom_auth_me / custom_auth_login / base44Client), and the two outcomes are
// asserted. The value of the model is that it covers something no text
// assertion can — the INTERACTION of the throttle, the sliding threshold and the
// absolute cap over time. probe-session-expiry.mjs checks those constants are
// individually sane and correctly ordered; this file checks that running the
// clock forward with them produces the behaviour the product promises.

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

function product(expr) {
  if (typeof expr !== "string") return null;
  const parts = expr.trim().split("*").map((p) => p.trim());
  if (!parts.length || !parts.every((p) => /^\d+$/.test(p))) return null;
  return parts.reduce((a, p) => a * Number(p), 1);
}

const DAY_MS = 24 * 60 * 60 * 1000;

console.log("=== PROBE: ACTIVE VS IDLE USER OVER TIME ===\n");

// ── Constants, from the real source ──────────────────────────────────────────
const me = read("base44/functions/custom_auth_me/entry.js");
const login = read("base44/functions/custom_auth_login/entry.js");
const client = read("src/api/base44Client.js");

const WINDOW_MS = (product(login.match(/base44_session=\$\{token\}[^`]*Max-Age=\$\{([^}]+)\}/)?.[1]) ?? 0) * 1000;
const SLIDE_UNDER_MS = product(me.match(/timeRemaining < ([\d\s*]+)\)/)?.[1]);
const SLIDE_TO_MS = product(me.match(/Date\.now\(\) \+ ([\d\s*]+)\)\.toISOString\(\)/)?.[1]);
const ABSOLUTE_MS = product(me.match(/sessionAge > ([\d\s*]+)\)/)?.[1]);
const THROTTLE_MS = product(client.match(/THROTTLE_MS\s*=\s*([\d\s*]+);/)?.[1]);

ok(WINDOW_MS > 0, "read the session window from custom_auth_login", `got ${WINDOW_MS}`);
ok(SLIDE_UNDER_MS !== null, "read the sliding threshold from custom_auth_me", `got ${SLIDE_UNDER_MS}`);
ok(SLIDE_TO_MS !== null, "read the slid-to window from custom_auth_me", `got ${SLIDE_TO_MS}`);
ok(ABSOLUTE_MS !== null, "read the absolute cap from custom_auth_me", `got ${ABSOLUTE_MS}`);
ok(THROTTLE_MS !== null, "read the touch throttle from base44Client", `got ${THROTTLE_MS}`);

console.log(`\n  window ${WINDOW_MS / DAY_MS}d · slides under ${SLIDE_UNDER_MS / DAY_MS}d to +${SLIDE_TO_MS / DAY_MS}d`
  + ` · absolute cap ${ABSOLUTE_MS / DAY_MS}d · throttle ${THROTTLE_MS / 60000}min\n`);

// ── The model ────────────────────────────────────────────────────────────────
// One step every 2 minutes. `active` means the user generates input, which is
// what calls touchSession (throttled). An idle user generates none: the 30s poll
// hits the non-sliding endpoint, so nothing extends the session.
function simulate({ active, days }) {
  const STEP = 2 * 60 * 1000;
  const sessionStart = 0;
  let now = 0;
  let expiry = WINDOW_MS;
  let lastTouch = -Infinity;
  let slides = 0;

  while (now <= days * DAY_MS) {
    // The absolute cap is checked server-side on every read and ends the session
    // regardless of activity — this is what stops sliding forever.
    if (now - sessionStart > ABSOLUTE_MS) {
      return { loggedOutAt: now, reason: "absolute cap", slides, expiry };
    }
    if (now > expiry) {
      return { loggedOutAt: now, reason: "window expired", slides, expiry };
    }
    if (active && now - lastTouch >= THROTTLE_MS) {
      lastTouch = now;
      if (expiry - now < SLIDE_UNDER_MS) {
        expiry = now + SLIDE_TO_MS;
        slides++;
      }
    }
    now += STEP;
  }
  return { loggedOutAt: null, reason: null, slides, expiry };
}

// ── Scenario A: the active user survives past the original window ────────────
const activeDays = (WINDOW_MS / DAY_MS) + 1;
const a = simulate({ active: true, days: activeDays });
console.log(`  Scenario A — active for ${activeDays}d: `
  + (a.loggedOutAt === null
    ? `still signed in, ${a.slides} slide(s), expiry now day ${a.expiry / DAY_MS}`
    : `signed out on day ${a.loggedOutAt / DAY_MS} (${a.reason})`));
ok(a.loggedOutAt === null,
  `an active user is still signed in after ${activeDays} days (past the original window)`,
  a.loggedOutAt === null ? "" : `signed out day ${a.loggedOutAt / DAY_MS} (${a.reason})`);
ok(a.slides > 0,
  "the active user's session actually slid — the model exercised the sliding path, not just a long window",
  `slides=${a.slides}`);
ok(a.expiry > WINDOW_MS,
  "the active user's expiry moved beyond the window login issued", `expiry=${a.expiry}`);

// ── Scenario B: the idle user is signed out on the original clock ─────────────
const b = simulate({ active: false, days: activeDays });
console.log(`  Scenario B — idle for ${activeDays}d:   `
  + (b.loggedOutAt === null
    ? `STILL SIGNED IN (expiry day ${b.expiry / DAY_MS})`
    : `signed out on day ${b.loggedOutAt / DAY_MS} (${b.reason})`));
ok(b.loggedOutAt !== null,
  "an idle user IS eventually signed out — an unattended tab must not stay authenticated");
ok(b.slides === 0,
  "the idle user's session never slid (only user activity may slide it)", `slides=${b.slides}`);
ok(b.loggedOutAt !== null && Math.abs(b.loggedOutAt - WINDOW_MS) <= 2 * 60 * 1000,
  "the idle user is signed out on the original window, within one simulation step",
  `out at ${b.loggedOutAt}, window ${WINDOW_MS}`);

// ── Scenario C: sliding cannot outlive the absolute cap ──────────────────────
// The property that makes indefinite sliding safe. Run well past the cap.
const capDays = (ABSOLUTE_MS / DAY_MS) + 2;
const c = simulate({ active: true, days: capDays });
console.log(`  Scenario C — active for ${capDays}d:  `
  + (c.loggedOutAt === null
    ? `STILL SIGNED IN — the absolute cap did not hold`
    : `signed out on day ${c.loggedOutAt / DAY_MS} (${c.reason})`));
ok(c.loggedOutAt !== null,
  "even a permanently active user is signed out eventually — sliding cannot be indefinite");
ok(c.reason === "absolute cap",
  "the thing that ends a continuously-active session is the absolute cap", `reason=${c.reason}`);
ok(c.loggedOutAt !== null && c.loggedOutAt > ABSOLUTE_MS,
  "the active session survived right up to the cap before ending",
  `out at ${c.loggedOutAt}, cap ${ABSOLUTE_MS}`);

console.log("\n" + "=".repeat(72));
console.log(`${failed === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${failed} failed`);
if (failures.length) {
  console.log("\nFailures:");
  failures.forEach((f) => console.log("  x " + f));
}
console.log("=".repeat(72));
process.exit(failed > 0 ? 1 : 0);
