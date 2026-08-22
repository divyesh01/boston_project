// Probe: a disabled account must be told it is DISABLED — not "restricted", and
// not silently redirected to the login page.
//
// ─────────────────────────────────────────────────────────────────────────────
// REWRITTEN 2026-08-20. THE PRODUCT WAS ALREADY FIXED; THIS PROBE WAS STALE.
//
// What this file used to be: a script that declared two local variables, mutated
// them the way it believed AuthContext.jsx mutated its state, and then printed
//
//     console.log("\n❌ DEFECT CONFIRMED: ...");
//
// at line 72 — **outside every conditional** — before exiting 0. So it announced a
// defect on every single run and reported success at the same time. Its own header
// admitted the approach: "we'll run a textual demonstration probe mimicking the
// logic inside ProtectedRoute.jsx and AuthContext.jsx." Mimicking is the problem.
// It re-declared the product's logic instead of reading it, so when the product was
// fixed the copy stayed broken and kept printing a defect that no longer existed.
// It also imported `renderToString` and `React` and never used either.
//
// EVIDENCE THAT THE PRODUCT, NOT THE PROBE, WAS CURRENT (`git log`):
//
//   ee79a64  2026-08-17  fix: Disabled user shown wrong reason      src/lib/AuthContext.jsx
//   b8f7334  2026-08-19  fix: Resolve security and UX defects 7, 8, 9  src/lib/AuthContext.jsx
//   4dbebbf  2026-08-19  brain: Convert to Hub-and-Spoke model      <- the probe's ONLY commit
//
// The first commit's subject is verbatim the defect the probe described. Defect 7
// in BRAIN_TROUBLESHOOTING.md section 14 is "Wrong error message for disabled
// accounts ('revoked' vs 'disabled')", already marked FIXED. The probe was carried
// along by the docs migration and never revisited. Both behaviours it called
// defects are contradicted by the code at HEAD:
//
//   * `handleCrossTabRevocation` does NOT `setUser(null)` for a disabled account.
//     It preserves the user and marks it inactive, precisely so ProtectedRoute's
//     dedicated red screen fires: `setUser(prev => ({ ...prev, is_active: false }))`.
//   * `validateCurrentAccountStatus` returns 'disabled' for an inactive account and
//     short-circuits entirely when the account is already known inactive locally,
//     so the generic banner cannot preempt the dedicated screen. 'revoked' is now
//     reserved for a session that is genuinely gone (`me` is null), which is the
//     correct word for that state.
//
// So there is nothing to fix in the product. What was broken was the verification:
// a suite that could not fail, sitting in the runner's list looking like coverage.
// This rewrite turns each of those claims into an assertion, so the fix cannot be
// silently undone.
//
// WHAT THIS PROBE IS: a static source-contract check. `src/lib/AuthContext.jsx` is
// on PROTECTED_FILES.md and both files are JSX, so neither can be imported into
// node here — asserting against the source text is the only honest option left, and
// it is the same technique `probe-ui-feedback.mjs` uses and labels. It verifies that
// the wiring which produced the fix is still present. **It does not render React, so
// it does not prove what a browser paints.** Treat a failure here as "the contract
// moved — go and check the behaviour", not as a rendering bug.
//
// Run: node scripts/probe-ui-disabled-reason.mjs
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./_repo-root.mjs";

// See scripts/_repo-root.mjs — the old `.pathname` form gave `C:\C:\Users\...`
// on Windows, so this probe threw ENOENT at load and verified nothing.
const ROOT = REPO_ROOT;
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

// Negative assertions run against source with comments stripped. Both files quote
// the code they replaced, and a probe that fails because a file documents its own
// fix is a probe that punishes the fix. Borrowed from probe-ui-feedback.mjs; the
// `[^:]` guard keeps `https://` out of the line-comment rule.
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/.*$/gm, "$1");

let pass = 0;
let fail = 0;
const failures = [];

function ok(label, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  PASS ${label}`);
  } else {
    fail++;
    failures.push(label);
    console.log(`  FAIL ${label}${detail ? `\n         ${detail}` : ""}`);
  }
}

// Pull one region out of a source file. Both markers must be found, and a missing
// marker is reported as its own failure rather than silently matching "" — an
// empty haystack would make every `includes` assertion below pass vacuously,
// which is the exact failure mode this rewrite exists to remove.
function region(label, src, startMarker, endMarker) {
  const a = src.indexOf(startMarker);
  if (a === -1) {
    ok(`[region] ${label}: start marker found`, false, `missing: ${startMarker}`);
    return null;
  }
  const b = src.indexOf(endMarker, a + startMarker.length);
  if (b === -1) {
    ok(`[region] ${label}: end marker found`, false, `missing: ${endMarker}`);
    return null;
  }
  ok(`[region] ${label} located`, true);
  return src.slice(a, b);
}

const AUTH = stripComments(read("src/lib/AuthContext.jsx"));
const ROUTE_RAW = read("src/components/ProtectedRoute.jsx");
const ROUTE = stripComments(ROUTE_RAW);

// ═══ 1. Cross-tab disable must keep the user object ════════════════════════
//
// An admin disables the account in another tab. The BroadcastChannel message
// arrives with status 'disabled'. If this branch nulls the user, ProtectedRoute's
// `isAccountDisabled = user?.is_active === false` evaluates false and the dedicated
// screen is skipped — which is the defect the old probe simulated.
console.log("\n=== 1. cross-tab 'disabled' preserves the user, marked inactive ===");

const disabledBranch = region(
  "handleCrossTabRevocation disabled branch",
  AUTH,
  "if (message.status === 'disabled')",
  "} else {",
);

if (disabledBranch) {
  ok("the branch marks the existing user inactive",
    /is_active:\s*false/.test(disabledBranch),
    disabledBranch.trim());
  ok("the branch does NOT discard the user with setUser(null)",
    !/setUser\(\s*null\s*\)/.test(disabledBranch),
    "setUser(null) here re-breaks the red Account Disabled screen");
  ok("...and it clears accountRestricted so the generic banner does not preempt",
    /setAccountRestricted\(\s*null\s*\)/.test(disabledBranch));
}

// The 'logged_out' path is the one that legitimately nulls the user, and it must
// keep doing so — otherwise a plain sign-out in another tab would leave this tab
// showing a stale user. Asserted so the check above cannot be "fixed" globally.
ok("a plain cross-tab logout still clears the user",
  /message\.status === 'logged_out'[\s\S]{0,200}setUser\(null\)/.test(AUTH));

// ═══ 2. validateCurrentAccountStatus must say 'disabled', not 'revoked' ════
console.log("\n=== 2. the live status check names the right reason ===");

const validate = region(
  "validateCurrentAccountStatus",
  AUTH,
  "const validateCurrentAccountStatus",
  "}, []);",
);

if (validate) {
  ok("an inactive account maps to status 'disabled'",
    /is_active === false\)\s*return\s*\{\s*valid:\s*false,\s*status:\s*'disabled'\s*\}/.test(validate),
    validate.trim());
  ok("a locked account maps to status 'locked'",
    /is_locked === true\)\s*return\s*\{\s*valid:\s*false,\s*status:\s*'locked'\s*\}/.test(validate));
  ok("'revoked' is reserved for a session that is actually gone (!me)",
    /if\s*\(!me\)\s*return\s*\{\s*valid:\s*false,\s*status:\s*'revoked'\s*\}/.test(validate));
  ok("no branch maps an inactive account to 'revoked'",
    !/is_active === false[\s\S]{0,80}'revoked'/.test(validate));
  // Without this short-circuit the on-navigation re-check runs against a user we
  // already know is inactive, sets restrictedStatus, and the generic banner wins
  // the render race against the dedicated screen.
  ok("a locally-known inactive user short-circuits as valid, leaving the dedicated screen to render",
    /user\?\.is_active === false\)\s*return\s*\{\s*valid:\s*true\s*\}/.test(validate));
}

// ═══ 3. ProtectedRoute renders disabled as disabled ═══════════════════════
console.log("\n=== 3. ProtectedRoute: 'disabled' is a red screen titled Account Disabled ===");

ok("isAccountDisabled is derived from the live user record",
  /const isAccountDisabled = user\?\.is_active === false/.test(ROUTE));
ok("there is a dedicated screen gated on isAccountDisabled",
  /if \(isAccountDisabled\)/.test(ROUTE));
ok("...titled 'Account Disabled'", ROUTE_RAW.includes(">Account Disabled<"));

const banner = region(
  "effectiveRestriction banner",
  ROUTE,
  "const effectiveRestriction",
  "if (!isAuthenticated)",
);

if (banner) {
  // Amber is the "your account is fine, this release just cannot serve it" tone.
  // A disabled account is not that, so 'disabled' must not fall into isWarning.
  ok("the amber (warning) tone is composed ONLY of locked and property_restricted",
    /const isWarning = isLocked \|\| isPropertyRestricted;/.test(banner),
    "if 'disabled' can reach isWarning, a disabled user gets an amber advisory");
  ok("the banner titles a 'disabled' restriction 'Account Disabled'",
    /effectiveRestriction === 'revoked' \? 'Account Restricted' : 'Account Disabled'/.test(banner),
    "the ternary must default to Account Disabled, with 'revoked' the named exception");
  ok("'locked' gets its own title", /'Account Locked'/.test(banner));
  ok("'property_restricted' is not described as an inactive account",
    /Single-Property Access Not Available/.test(banner));
}

// ═══ 4. Ordering: the reason must outrank the login redirect ══════════════
//
// The session is already cleared by the time either path renders, so
// `isAuthenticated` is false. If the redirect were checked first, a disabled user
// would be bounced to /login with no explanation and would keep trying to sign in.
console.log("\n=== 4. the restricted banner is reached before the login redirect ===");

const iBanner = ROUTE.indexOf("if (effectiveRestriction)");
const iRedirect = ROUTE.indexOf('if (!isAuthenticated)');
const iDisabled = ROUTE.indexOf("if (isAccountDisabled)");
ok("the effectiveRestriction banner is checked before the /login redirect",
  iBanner > -1 && iRedirect > -1 && iBanner < iRedirect,
  `banner@${iBanner} redirect@${iRedirect}`);
ok("the loading state is checked before both, so a slow auth check is not a redirect",
  ROUTE.indexOf("if (isLoadingAuth || !authChecked)") > -1
    && ROUTE.indexOf("if (isLoadingAuth || !authChecked)") < iBanner);
ok("the dedicated disabled screen sits after the redirect, where an authenticated-but-inactive user lands",
  iDisabled > iRedirect,
  `disabled@${iDisabled} redirect@${iRedirect}`);

console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
if (fail) {
  console.log(`Failures:\n  - ${failures.join("\n  - ")}`);
  console.log("\nThis probe reads source, not a rendered page. If a failure above looks");
  console.log("like a reformatting artefact, verify the behaviour in a browser first, then");
  console.log("update the pattern — do not delete the assertion.");
}
process.exit(fail > 0 ? 1 : 0);
