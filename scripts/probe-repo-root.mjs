// Probe: no script may derive a filesystem path from a file:// URL's `.pathname`.
//
// THE BUG THIS EXISTS TO PREVENT, in plain terms.
//
// A file on Windows lives at `C:\repo\file.js`. As a URL that is
// `file:///C:/repo/file.js`. If you ask that URL for its `.pathname` you get
// `/C:/repo/file.js` — with a SLASH IN FRONT of the drive letter. Handing that to
// path.resolve() gives you `C:\C:\repo\file.js`: the drive letter twice. Nothing
// is there, so every read fails.
//
// On 2026-08-21 seven probes did exactly this. They did not report failures —
// they never started at all, which is far worse: a suite that cannot run is
// absent from the FAILED list, so it reads as a pass. The launch checklist
// recorded "probe-ws-server 20 passed, 0 failed" for a probe that had thrown
// ERR_MODULE_NOT_FOUND before its first check.
//
// The fix was one shared helper, scripts/_repo-root.mjs, using Node's own
// fileURLToPath(). This probe is the part that keeps it fixed: it reads every
// script and fails if the broken form comes back. Without it, the eighth script
// written next month reintroduces the bug and nobody notices for a month.
//
// It also proves the helper is actually correct rather than trusting it: section
// 3 checks REPO_ROOT points at a directory that really contains this repo's
// package.json, and section 4 checks the helper survives a path containing a
// space (this repo lives under OneDrive, and a space arrives as %20 in a URL —
// the second half of the same bug).
//
// Run: node scripts/probe-repo-root.mjs

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { REPO_ROOT } from './_repo-root.mjs';

const SCRIPTS_DIR = path.join(REPO_ROOT, 'scripts');

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

// Strip comments before scanning. This file, _repo-root.mjs and several probes
// QUOTE the broken pattern in their explanations, and a guard that fails because
// a file documents the bug it fixed is a guard that punishes the fix.
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

// ── 1. The broken pattern is gone from every script ─────────────────────────
section('1. No script derives a path from URL.pathname');

// Matches `new URL(...).pathname` and `new URL(import.meta.url).pathname`, the
// two shapes that were actually in the repo, plus a bare `.pathname` read off
// anything named like a URL. Deliberately narrow: `location.pathname` in browser
// code under src/ is legitimate and is not scanned here.
const BAD_PATHNAME = /new URL\([^)]*\)\s*\.pathname/;

// The scanner must not match its own source. The label below therefore names the
// pattern in pieces ("URL" + ".pathname") instead of spelling it out, which is
// how this probe first reported itself as an offender — a real result, not a
// false one: a string literal in this file is still a literal in this file.
const BAD_LABEL = `no script builds a filesystem path from new URL(..).${'path'}${'name'}`;

const scriptFiles = readdirSync(SCRIPTS_DIR)
  .filter((f) => /\.(mjs|js|cjs)$/.test(f))
  .sort();

check('there are scripts to scan', scriptFiles.length > 0, `found ${scriptFiles.length}`);

const offenders = [];
for (const f of scriptFiles) {
  const code = stripComments(readFileSync(path.join(SCRIPTS_DIR, f), 'utf8'));
  if (BAD_PATHNAME.test(code)) offenders.push(f);
}
check(
  BAD_LABEL,
  offenders.length === 0,
  offenders.length
    ? `${offenders.join(', ')} — use fileURLToPath() or import { REPO_ROOT } from './_repo-root.mjs'`
    : ''
);

// The seven that were broken, named individually. A generic "none found" check
// would also pass if someone deleted the files, so each is asserted to exist AND
// to be clean.
const PREVIOUSLY_BROKEN = [
  'probe-csrf-default-closed.mjs',
  'probe-delete-guard.mjs',
  'probe-money-kept-double-count.mjs',
  'probe-password-policy.mjs',
  'probe-ui-disabled-reason.mjs',
  'probe-ui-feedback.mjs',
  'probe-ws-server.mjs',
];
section('2. The seven suites that silently verified nothing');
for (const f of PREVIOUSLY_BROKEN) {
  const full = path.join(SCRIPTS_DIR, f);
  if (!existsSync(full)) {
    check(`${f} still exists`, false, 'the suite is gone, so its coverage is gone');
    continue;
  }
  const code = stripComments(readFileSync(full, 'utf8'));
  check(`${f} no longer uses URL.pathname`, !BAD_PATHNAME.test(code));
  check(
    `${f} resolves its root through the shared helper`,
    /_repo-root\.mjs/.test(readFileSync(full, 'utf8')) || /fileURLToPath/.test(code),
    'must import REPO_ROOT or use fileURLToPath'
  );
}

// ── 3. The helper actually points at this repository ────────────────────────
section('3. REPO_ROOT is a real directory containing this repo');

check('REPO_ROOT is an absolute path', path.isAbsolute(REPO_ROOT), REPO_ROOT);
check('REPO_ROOT exists and is a directory',
  existsSync(REPO_ROOT) && statSync(REPO_ROOT).isDirectory(), REPO_ROOT);
check('REPO_ROOT has no doubled drive letter',
  !/^[A-Za-z]:[\\/][A-Za-z]:/.test(REPO_ROOT),
  `${REPO_ROOT} — this is the exact shape of the original bug`);
check('REPO_ROOT contains package.json', existsSync(path.join(REPO_ROOT, 'package.json')));
check('REPO_ROOT contains src/', existsSync(path.join(REPO_ROOT, 'src')));
check('REPO_ROOT contains scripts/', existsSync(path.join(REPO_ROOT, 'scripts')));
check('REPO_ROOT has no trailing separator',
  REPO_ROOT === path.resolve(REPO_ROOT),
  `${REPO_ROOT} — a trailing slash breaks callers that concatenate strings`);

// The package.json really is THIS project's, not some parent directory's.
try {
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  check('REPO_ROOT resolves to this project', pkg.name === 'base44-app', `name=${pkg.name}`);
} catch (err) {
  check('REPO_ROOT package.json parses', false, String(err?.message || err));
}

// ── 4. Percent-escapes and spaces survive the round trip ────────────────────
section('4. fileURLToPath handles spaces and escapes; .pathname does not');

// Proven against a synthetic path rather than asserted, because "it works on my
// machine" is exactly how the original bug survived review. No file is created:
// this is pure string conversion.
const sample = process.platform === 'win32'
  ? 'C:\\Users\\me\\One Drive\\boston_project\\file.js'
  : '/home/me/One Drive/boston_project/file.js';
const asUrl = pathToFileURL(sample);
check('fileURLToPath round-trips a path containing a space',
  fileURLToPath(asUrl) === sample,
  `got ${fileURLToPath(asUrl)}`);
check('the URL really did escape the space (so this is a fair test)',
  asUrl.href.includes('%20'),
  asUrl.href);
check('URL.pathname does NOT round-trip it — the reason this probe exists',
  asUrl.pathname !== sample,
  `pathname=${asUrl.pathname}`);
if (process.platform === 'win32') {
  check('URL.pathname leaks a leading slash before the drive letter on Windows',
    /^\/[A-Za-z]:/.test(asUrl.pathname),
    asUrl.pathname);
}

// ── Result ──────────────────────────────────────────────────────────────────
console.log(`\n─── RESULT: ${pass} passed, ${fail} failed ───`);
if (fail > 0) {
  console.log(`Failures:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log('PASSED: every script resolves paths in a way that works on Windows, macOS and Linux.');
process.exit(0);
