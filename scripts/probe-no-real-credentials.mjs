// Probe: no real person's identity or credential may sit in a tracked file.
//
// WHAT WENT WRONG BEFORE, in plain terms.
//
// Two separate things were found in this repo, and they are worth telling apart
// because the fix is different for each:
//
//   1. A REAL CREDENTIAL. `test-auth.cjs` at the repo root held the owner's real
//      email AND real password in plain text. Deleted 2026-08-21. Deleting a file
//      does not un-leak it — the value is still in git history — so the owner was
//      told to rotate the password.
//
//   2. A REAL IDENTITY. `src/api/authLocal.test.js` held the owner's real Gmail
//      address next to a fixture password. The password was never real (it was
//      literally named "Mock..."), but the address was, and it was in every clone
//      of the repo. Replaced 2026-08-21 with `owner@test.local`.
//
// Both survived because nothing was looking. The lint config ignores `*.cjs`,
// jsconfig type-checks only `src/`, and verify-all discovers only
// `probe-*`/`verify-*` under `scripts/`. This probe is what looks.
//
// HOW IT DECIDES. Two rules, kept deliberately narrow so it does not cry wolf:
//
//   - Email addresses must use a reserved test domain (`.test`, `.local`,
//     `.invalid`, `.example`, or `example.com`/`example.org`). Those can never
//     resolve to a real mailbox — RFC 2606 and RFC 6761 reserve them for exactly
//     this. A `@gmail.com` or any other routable domain fails.
//
//   - A password/secret/token/api-key name must not be assigned a string
//     literal, UNLESS the literal is obviously a fixture (it contains "mock",
//     "fake", "dummy", "test", "example", "placeholder", "changeme", or is a
//     deliberately-wrong value like "WrongPass"). Reading from
//     `process.env.SOMETHING` is always legal — that is the correct pattern.
//
// WHY A FIXTURE PASSWORD IS ALLOWED. The auth tests must exercise the real
// registration and login path, which requires a password strong enough to pass
// validatePasswordStrength. Banning every literal would force the tests to use a
// weak value and take the rejection branch instead, so the suite would stop
// testing what it claims to test. Naming the fixture is the honest compromise:
// "MockSecurePass#2026" cannot be mistaken for anyone's real credential.
//
// Run: node scripts/probe-no-real-credentials.mjs

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './_repo-root.mjs';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n── ${title}`);
}

// Directories that hold source we control. node_modules, dist and graphify-out
// are excluded: they are generated or third-party, and a finding there is not
// something an edit to this repo can fix.
const SCAN_DIRS = ['src', 'scripts', 'base44', 'backend', 'tests'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'graphify-out', '__pycache__', 'data']);
const CODE_EXT = /\.(js|jsx|mjs|cjs|ts|tsx)$/;

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
    } else if (CODE_EXT.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

const files = [];
for (const d of SCAN_DIRS) walk(path.join(REPO_ROOT, d), files);
// Root-level scripts too — this is the exact gap test-auth.cjs slipped through.
for (const entry of readdirSync(REPO_ROOT, { withFileTypes: true })) {
  if (entry.isFile() && CODE_EXT.test(entry.name)) files.push(path.join(REPO_ROOT, entry.name));
}

const rel = (f) => path.relative(REPO_ROOT, f).replace(/\\/g, '/');

// This probe necessarily contains the patterns it hunts for, inside its own
// explanation and its own regexes. Skip itself rather than matching itself.
const SELF = rel(new URL(import.meta.url).href ? path.join(REPO_ROOT, 'scripts', 'probe-no-real-credentials.mjs') : '');

section(`1. Scanning ${files.length} source files for routable email addresses`);

// Reserved, non-routable domains. Anything else is treated as a real address.
const SAFE_EMAIL_DOMAIN = /@(?:[\w-]+\.)*(?:test|local|localhost|invalid|example)$|@example\.(?:com|org|net)$/i;
// The final label must be an alphabetic TLD of 2+ characters. Without that guard
// an npm specifier — `npm:@base44/sdk@0.8.40`, `pkg@1.0.0`, `vite@6.4.3` — parses
// as an address and the probe reports 12 phantom leaks, which is exactly how a
// noisy gate gets ignored. A numeric last label is a version, not a domain.
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}/g;

// Domains that appear in prose/comments as documentation of a bug rather than as
// a usable address. `hotel-operator.com` is the alert recipient the code cannot
// actually reach (documented in hotel.js); `your-app.com` is a placeholder that
// is separately fixed. Both are non-identifying, so they are not this probe's job.
const IGNORE_EMAIL = /@(?:hotel-operator\.com|your-app\.com|sentry\.io)/i;

const emailOffenders = [];
for (const f of files) {
  if (rel(f) === SELF) continue;
  const src = readFileSync(f, 'utf8');
  for (const m of src.match(EMAIL) || []) {
    if (SAFE_EMAIL_DOMAIN.test(m) || IGNORE_EMAIL.test(m)) continue;
    // A line that is clearly a regex or a validation pattern, not an address.
    emailOffenders.push(`${rel(f)}: ${m.replace(/^(.).*(@.*)$/, '$1***$2')}`);
  }
}
check(
  'no source file contains a routable email address',
  emailOffenders.length === 0,
  emailOffenders.length
    ? `${emailOffenders.slice(0, 8).join('; ')}${emailOffenders.length > 8 ? ` (+${emailOffenders.length - 8} more)` : ''} — use a reserved domain such as @test.local`
    : ''
);

section('2. No credential-shaped literals outside recognised fixtures');

// `password: "..."`, `secret = '...'`, `apiKey: "..."`, `token = "..."`.
// Template literals and process.env reads are deliberately not matched.
//
// A bare `pass` is NOT in this list. It matched `const PASS = "PASS   "` in
// verify-all.mjs — a console label, not a credential — and a gate that reports a
// display string as a leaked secret is a gate people learn to ignore. Every real
// credential in this repo is named password/passwd/pwd/secret/key/token.
const CRED_ASSIGN = /\b(pass(?:word|wd)|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key)\b\s*[:=]\s*["']([^"']{6,})["']/gi;

// Named field values that are sentinels rather than credentials.
const SENTINEL = /^(?:http-only|all|none|null|undefined|true|false|owner|admin)$/i;

// TWO RULES, because the two risks are not the same size.
//
// In SHIPPING code (anything that is not a test, probe or harness) a credential
// literal is never acceptable — it would be in the bundle, in the deployed
// function, in every clone. Zero tolerance, no allowlist.
//
// In TEST code a literal is unavoidable: the auth suites must register and log in
// with a password strong enough to pass validatePasswordStrength, so banning
// literals would push every test onto the rejection branch and it would stop
// testing the thing it claims to test.
//
// For test code the rule is therefore an EXPLICIT ALLOWLIST rather than a clever
// pattern. Every fixture credential in the repo is named below with the reason it
// exists. That is deliberately more work than a regex: a new unexplained
// credential FAILS this probe and someone has to justify it in writing, which is
// exactly the review step that `test-auth.cjs` never got.
// What counts as test code. Covers `*.test.js(x)`, anything under `tests/`, and
// the `scripts/` harnesses whichever naming convention they use — `probe-*`,
// `verify-*`, `verify_*`, `test_*`, `test-*` and the shared `_*` helpers. The
// underscore forms were missing at first, which is why verify_cross_module_impact
// was reported as shipping code.
const TEST_FILE = /(?:\.test\.[jt]sx?$|(?:^|\/)tests\/|(?:^|\/)scripts\/(?:probe[-_]|verify[-_]|test[_-]|acceptance|_))/;

const ALLOWED_TEST_FIXTURES = new Map([
  // The auth lifecycle suites. Named "Mock..." so it cannot be read as real.
  ['MockSecurePass#2026', 'authLocal.test.js / dataIntegrity.test.js owner fixture'],
  // A deliberately DIFFERENT password, proving a second owner registration is
  // refused for a reason other than a duplicate password.
  ['Another!Pass2026', 'authLocal.test.js second-owner rejection case'],
  ['AdminPass#2026x', 'authLocal.test.js local-admin authorization fixture'],
  ['ClerkPass#2026x', 'authLocal.test.js local roster-access fixture'],
  // The import-rollback suite needs any valid-strength value; this is the most
  // obviously synthetic one possible.
  ['Password1!', 'base44Client.importRollback.test.js sign-in fixture'],
  // xkcd 936's example passphrase — the single most published example password
  // in software. Used by probe-auth-audit for the SUCCESSFUL login case.
  ['Correct-Horse-Battery-9!', 'probe-auth-audit.mjs valid-credential case'],
  // The classic meme wrong password. Used only on failure paths, where the whole
  // point is that it does not work.
  ['hunter2', 'probe-auth-audit.mjs wrong-password cases'],
  // Audit chain secrets. Prefixed "probe-" so their scope is unmistakable, and
  // they stand in for AUDIT_CHAIN_SECRET which production reads from the env.
  ['probe-chain-secret', 'probe-audit-chain / probe-auth-audit chain secret'],
  ['probe-race-secret', 'probe-audit-chain-race chain secret'],
  // The canonical TOTP test vector from RFC 6238 / the otplib docs.
  ['JBSWY3DPEHPK3PXP', 'RFC 6238 published TOTP test secret'],
  // Property-isolation harness sign-in. Self-describing name.
  ['Probe-Password-9!', 'probe-property-isolation.mjs harness sign-in'],
  // The welcome-email probe asserts this string is ABSENT from the sent mail, so
  // the literal is the thing under test, not a usable credential.
  ['MySuperSecretPassword123!', 'probe-welcome-email.mjs negative assertion — must NOT appear in the email body'],
  // Local-auth harness. Four distinct values because the suite has to tell a
  // change-password from a set-password from a new-user path apart.
  ['NewPass456!@#', 'test_local_auth.mjs change-password path'],
  ['StrongPass123!@#', 'test_local_auth.mjs strength-accepted path'],
  ['TestPass123!@#', 'test_local_auth.mjs sign-in path'],
  ['NewUserPass123!@#', 'test_local_auth.mjs new-user path'],
  ['ConsistentPass123!@#', 'verify_cross_module_impact.mjs cross-module sign-in'],
  // The shared harness sign-in used by every suite that must authenticate first
  // (see _harness-auth.mjs). Self-describing name.
  ['Harness-Owner-Password-1!', '_harness-auth.mjs shared owner sign-in'],
]);

const credOffenders = [];
const unexplainedFixtures = [];
for (const f of files) {
  if (rel(f) === SELF) continue;
  const isTest = TEST_FILE.test(rel(f));
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(CRED_ASSIGN)) {
    const [, name, value] = m;
    if (SENTINEL.test(value)) continue;
    // Report the NAME and the shape, never the value. A probe that prints the
    // secret it found has published it into every CI log.
    const shape = value.replace(/[a-z]/g, 'a').replace(/[A-Z]/g, 'A').replace(/\d/g, '9');
    const where = `${rel(f)}: ${name} = <${value.length} chars, shape ${shape}>`;
    if (!isTest) {
      credOffenders.push(where);
    } else if (!ALLOWED_TEST_FIXTURES.has(value)) {
      unexplainedFixtures.push(where);
    }
  }
}
check(
  'no shipping file assigns a credential literal',
  credOffenders.length === 0,
  credOffenders.length
    ? `${credOffenders.slice(0, 6).join('; ')} — read it from process.env`
    : ''
);
check(
  'every test fixture credential is on the documented allowlist',
  unexplainedFixtures.length === 0,
  unexplainedFixtures.length
    ? `${unexplainedFixtures.slice(0, 6).join('; ')} — add it to ALLOWED_TEST_FIXTURES in this probe with the reason it exists, or use an existing fixture`
    : ''
);
// The allowlist must not rot: an entry for a value nobody uses any more is a
// place a real credential could hide behind an innocent-looking reason.
const allSource = files.filter((f) => rel(f) !== SELF).map((f) => readFileSync(f, 'utf8')).join('\n');
const staleAllowlist = [...ALLOWED_TEST_FIXTURES.keys()].filter((v) => !allSource.includes(v));
check('the fixture allowlist has no stale entries', staleAllowlist.length === 0,
  staleAllowlist.length ? `${staleAllowlist.length} entr(y/ies) no longer used — remove them` : '');

section('3. The two files that leaked, named individually');

// A generic sweep also passes if someone deletes the files, so each is asserted
// to exist AND to be clean.
check('test-auth.cjs has not returned',
  !existsSync(path.join(REPO_ROOT, 'test-auth.cjs')),
  'it held a real email and password in plain text at the repo root');

const AUTH_TEST = path.join(REPO_ROOT, 'src', 'api', 'authLocal.test.js');
if (existsSync(AUTH_TEST)) {
  const src = readFileSync(AUTH_TEST, 'utf8');
  const addresses = (src.match(EMAIL) || []).filter((m) => !SAFE_EMAIL_DOMAIN.test(m));
  check('authLocal.test.js uses only reserved test domains', addresses.length === 0,
    addresses.map((a) => a.replace(/^(.).*(@.*)$/, '$1***$2')).join(', '));
  check('authLocal.test.js still exercises the real registration path',
    /registerUser/.test(src) && /db\.auth\.login/.test(src),
    'the fixture must still drive real auth — a sanitised test that stops testing is worse than the leak');
} else {
  check('authLocal.test.js still exists', false, 'the suite is gone, so its coverage is gone');
}

section('4. Reserved-domain rule is real, not vacuous');

// Self-test: the rules must actually reject the shapes they claim to reject.
// Without this, a broken regex would report a clean repo forever.
check('a gmail address is rejected by the domain rule',
  !SAFE_EMAIL_DOMAIN.test('someone@gmail.com'));
check('an @test.local address is accepted',
  SAFE_EMAIL_DOMAIN.test('owner@test.local'));
check('an @example.com address is accepted',
  SAFE_EMAIL_DOMAIN.test('user@example.com'));
check('a bare corporate domain is rejected',
  !SAFE_EMAIL_DOMAIN.test('admin@acme-hotels.co.uk'));
check('an npm version specifier is not mistaken for an address',
  !EMAIL.test('npm:@base44/sdk@0.8.40'),
  'a numeric final label is a version, not a domain');
check('a documented allowlist entry is recognised',
  ALLOWED_TEST_FIXTURES.has('MockSecurePass#2026'));
check('an opaque password literal is NOT on the allowlist',
  !ALLOWED_TEST_FIXTURES.has('Hunter2!Winter24x'));
check('a process.env read is not matched at all',
  !new RegExp(CRED_ASSIGN.source, 'i').test('const password = process.env.OWNER_PASSWORD;'));

console.log(`\n─── RESULT: ${pass} passed, ${fail} failed ───`);
if (fail > 0) {
  console.log(`Failures:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log('PASSED: no real identity or credential in tracked source.');
process.exit(0);
