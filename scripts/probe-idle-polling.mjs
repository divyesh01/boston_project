// Probe: the idle poll must never slide the session.
//
//   node scripts/probe-idle-polling.mjs
//
// Pure text assertions against the real source — no DOM, no Dexie, no network.
//
// WHAT THIS FILE USED TO BE (and why that mattered):
// it declared a local `isAuthenticated()` stub that incremented a counter, ran
// it ten times, and then printed "Calls to custom_auth_me (sliding endpoint): 0"
// — where `meCalls` was a variable that nothing in the file ever incremented. It
// proved zero by never writing to it. It imported no product code, asserted
// nothing, and always exited 0. It was in `npm run verify:all` for the runner's
// entire existence, reporting a security property it never once measured.
//
// THE PROPERTY THAT ACTUALLY MATTERS:
// an unattended tab must eventually log out. The frontend polls every
// IDLE_CHECK_MS to catch revocations, and that poll is only safe if it hits a
// READ-ONLY endpoint. The two endpoints are deliberately asymmetric:
//
//   custom_auth_check  reads expires_at, writes only is_revoked  → never slides
//   custom_auth_me     writes expires_at + re-issues the cookie  → slides
//
// So swapping one call for the other — a one-word edit, in either the client
// helper or the poll body — silently converts "idle tabs expire on schedule"
// into "a terminal left open at the front desk stays authenticated up to the
// 30-day absolute cap." Nothing else in the suite would notice. That is the
// regression this file exists to catch.

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

console.log("=== PROBE: IDLE POLLING MUST NOT SLIDE THE SESSION ===\n");

// ── 1. The poll body: reads, never touches ───────────────────────────────────
const auth = read("src/lib/AuthContext.jsx");

// Isolate the setInterval callback rather than testing the whole file: the file
// legitimately calls touchSession elsewhere (from handleActivity), so a
// file-wide grep would pass no matter what the poll does.
const pollBody = auth.match(/setInterval\(async \(\) => \{[\s\S]*?\}, IDLE_CHECK_MS\)/)?.[0] ?? "";
ok(pollBody.length > 0,
  "found the idle setInterval callback in AuthContext.jsx (anchored on IDLE_CHECK_MS)");
ok(/db\.auth\.isAuthenticated\(\)/.test(pollBody),
  "the idle poll calls db.auth.isAuthenticated() — the read-only check");
ok(!/touchSession|rotateSession/.test(pollBody),
  "the idle poll does NOT call touchSession/rotateSession (that would slide the expiry)",
  pollBody.replace(/\s+/g, " ").slice(0, 200));
ok(!/db\.auth\.me\(\)/.test(pollBody),
  "the idle poll does NOT call db.auth.me() (me() invokes the sliding endpoint)");
ok(/INACTIVITY_TIMEOUT_MS/.test(pollBody),
  "the idle poll enforces the inactivity timeout, so an unattended tab is signed out");

// ── 2. Only real user activity may slide ─────────────────────────────────────
const activity = auth.match(/const handleActivity = useCallback\([\s\S]*?\}, \[isAuthenticated\]\)/)?.[0] ?? "";
ok(activity.length > 0, "found handleActivity in AuthContext.jsx");
ok(/touchSession/.test(activity),
  "handleActivity DOES slide the session — user activity is the only thing allowed to");
ok(/addEventListener/.test(auth) && /'keydown'|"keydown"/.test(auth),
  "handleActivity is wired to real input events (keydown among them)");

// ── 3. The client helpers hit the endpoints their names claim ────────────────
const client = read("src/api/base44Client.js");
const isAuthFn = client.match(/async isAuthenticated\(\) \{[\s\S]*?\n {2}\}/)?.[0] ?? "";
ok(isAuthFn.length > 0, "found db.auth.isAuthenticated() in base44Client.js");
ok(/custom_auth_check/.test(isAuthFn),
  "isAuthenticated() invokes custom_auth_check (the non-sliding endpoint)");
ok(!/custom_auth_me/.test(isAuthFn),
  "isAuthenticated() does NOT invoke custom_auth_me — swapping these is the regression",
  isAuthFn.replace(/\s+/g, " "));

const touchFn = client.match(/async touchSession\(\) \{[\s\S]*?\n {2}\}/)?.[0] ?? "";
ok(touchFn.length > 0, "found db.auth.touchSession() in base44Client.js");
ok(/custom_auth_me/.test(touchFn),
  "touchSession() invokes custom_auth_me — sliding is its declared job");
ok(/THROTTLE_MS/.test(touchFn),
  "touchSession() is throttled, so a busy mouse cannot become a request flood");

// ── 4. The server halves must stay asymmetric ────────────────────────────────
// This is the invariant the whole probe rests on. If custom_auth_check ever
// learns to write expires_at, the idle poll starts sliding the session and every
// assertion above becomes true-but-meaningless.
const check = read("base44/functions/custom_auth_check/entry.js");
const me = read("base44/functions/custom_auth_me/entry.js");

ok(!/expires_at:\s/.test(check),
  "custom_auth_check never WRITES expires_at (it may only read it) — this is what makes it safe to poll",
  (check.match(/.{0,60}expires_at:\s.{0,40}/) ?? [""])[0]);
ok(/Session\.update\([^)]*\{\s*is_revoked/.test(check),
  "custom_auth_check's only Session write is the revocation on the absolute cap");
ok(/expires_at:\s*newExpiry/.test(me),
  "custom_auth_me DOES write a new expires_at — the asymmetry is real, not assumed");
ok(/Max-Age=/.test(me),
  "custom_auth_me re-issues the cookie (sliding the row alone would sign users out mid-shift)");

console.log("\n" + "=".repeat(72));
console.log(`${failed === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${failed} failed`);
if (failures.length) {
  console.log("\nFailures:");
  failures.forEach((f) => console.log("  x " + f));
}
console.log("=".repeat(72));
process.exit(failed > 0 ? 1 : 0);
