// Probe: the STANDALONE deployment shape.
//
// WHY THIS EXISTS. With base44 gone there is no server to authenticate against,
// so a production build has to run the in-browser auth path. That path is NOT a
// security boundary - it trusts localStorage/IndexedDB - so main.jsx refuses to
// boot a production bundle that enables it, unless a SECOND flag declares the
// standalone shape on purpose. Two flags, not one, is the whole design: a stray
// production build with only VITE_USE_LOCAL_AUTH set must still refuse.
//
// Nothing else in the repo gates that condition. It lives in four lines of
// main.jsx, it is invisible to lint and typecheck (both pass either way), and it
// folds away at build time, so the only way it regresses is silently. The same
// is true of the websocket endpoint guard: a hosting dashboard that demands a
// value for every variable it discovers means "off" has to be expressible as a
// placeholder, and if that guard is removed the placeholder starts an endless
// WebSocket backoff loop in every visitor's tab.
//
// HOW. Both checks EVALUATE THE PRODUCT'S OWN SOURCE TEXT: the condition is
// extracted verbatim from main.jsx / crdt.jsx and run against a table of
// environments. Reimplementing the logic here would only prove this file agrees
// with itself, and would keep passing after the real guard was deleted.
//
// Run: node scripts/probe-standalone-deploy.mjs

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ── Section 1: the two-flag boot guard in src/main.jsx ──────────────────────
console.log('\nSection 1: production boot guard (src/main.jsx)');

const mainSrc = read('src/main.jsx');

check('main.jsx still refuses to boot on a bad combination',
  /Refusing to start/.test(mainSrc),
  'the refuse-to-boot branch is present');

check('the guard reads VITE_STANDALONE_LOCAL, not just VITE_USE_LOCAL_AUTH',
  /VITE_STANDALONE_LOCAL/.test(mainSrc),
  'a one-flag guard cannot express the standalone shape');

// Pull the condition out verbatim: from the `if (` that precedes the refusal
// message up to its closing `) {`.
const guardMatch = mainSrc.match(/if\s*\(([\s\S]*?)\)\s*\{\s*\n\s*document\.body\.innerHTML/);
check('the guard condition could be located in source',
  !!guardMatch,
  guardMatch ? 'extracted' : 'pattern did not match — the guard was restructured');

let evalGuard = null;
if (guardMatch) {
  const raw = guardMatch[1];
  const rewritten = raw.replace(/import\.meta\.env/g, 'env');
  check('the extracted condition contains no un-rewritten import.meta',
    !/import\.meta/.test(rewritten),
    'import.meta is a SyntaxError inside new Function, so a miss here would be silent');
  try {
     
    evalGuard = new Function('env', `return !!(${rewritten});`);
  } catch (e) {
    check('the extracted condition is evaluable', false, e.message);
  }
}

// true  = REFUSES to boot.  false = boots.
const GUARD_CASES = [
  ['deployed standalone config boots',
    { PROD: true, VITE_USE_LOCAL_AUTH: 'true', VITE_STANDALONE_LOCAL: 'true' }, false],
  ['local-auth in prod with the second flag MISSING refuses',
    { PROD: true, VITE_USE_LOCAL_AUTH: 'true' }, true],
  ['local-auth in prod with the second flag FALSE refuses',
    { PROD: true, VITE_USE_LOCAL_AUTH: 'true', VITE_STANDALONE_LOCAL: 'false' }, true],
  ['local-auth in prod with the second flag EMPTY refuses',
    { PROD: true, VITE_USE_LOCAL_AUTH: 'true', VITE_STANDALONE_LOCAL: '' }, true],
  ['server-backed prod build boots',
    { PROD: true, VITE_USE_LOCAL_AUTH: 'false' }, false],
  ['server-backed prod build boots even with the standalone flag set',
    { PROD: true, VITE_USE_LOCAL_AUTH: 'false', VITE_STANDALONE_LOCAL: 'true' }, false],
  ['npm run dev is unaffected',
    { PROD: false, VITE_USE_LOCAL_AUTH: 'true' }, false],
];

if (evalGuard) {
  for (const [name, env, expectRefuse] of GUARD_CASES) {
    let got;
    try {
      got = evalGuard(env);
    } catch (e) {
      got = `threw: ${e.message}`;
    }
    check(name, got === expectRefuse,
      `refuses=${got} (expected ${expectRefuse})`);
  }
}

// ── Section 2: the websocket endpoint guard in src/crdt.jsx ─────────────────
console.log('\nSection 2: websocket endpoint guard (src/crdt.jsx)');

const crdtSrc = read('src/crdt.jsx');

check('crdt.jsx still gates the connection on ENDPOINT',
  /if\s*\(!ENDPOINT\)\s*return;/.test(crdtSrc),
  'without this the resolved value is computed and then ignored');

const rawLine = crdtSrc.match(/^\s*const RAW_ENDPOINT\s*=.*$/m);
const endLine = crdtSrc.match(/^\s*const ENDPOINT\s*=.*$/m);
check('both endpoint resolution lines could be located',
  !!rawLine && !!endLine,
  rawLine && endLine ? 'extracted' : 'the resolution was restructured');

let evalEndpoint = null;
if (rawLine && endLine) {
  const src = `${rawLine[0]}\n${endLine[0]}\nreturn ENDPOINT;`
    .replace(/import\.meta\.env/g, 'env');
  check('the extracted resolution contains no un-rewritten import.meta',
    !/import\.meta/.test(src), 'would be a silent SyntaxError otherwise');
  try {
     
    evalEndpoint = new Function('env', src);
  } catch (e) {
    check('the extracted resolution is evaluable', false, e.message);
  }
}

// '' = realtime sync stays OFF.  Anything else = a connection is attempted.
const ENDPOINT_CASES = [
  ['unset stays off', {}, ''],
  ['empty string stays off', { VITE_WEBSOCKET_ENDPOINT: '' }, ''],
  ['whitespace-only stays off', { VITE_WEBSOCKET_ENDPOINT: '   ' }, ''],
  ['the placeholder "disabled" stays off', { VITE_WEBSOCKET_ENDPOINT: 'disabled' }, ''],
  ['the placeholder "off" stays off', { VITE_WEBSOCKET_ENDPOINT: 'off' }, ''],
  ['an https:// URL stays off', { VITE_WEBSOCKET_ENDPOINT: 'https://example.com' }, ''],
  ['a bare scheme with no host stays off', { VITE_WEBSOCKET_ENDPOINT: 'wss://' }, ''],
  ['a real ws:// endpoint connects',
    { VITE_WEBSOCKET_ENDPOINT: 'ws://localhost:1234' }, 'ws://localhost:1234'],
  ['a real wss:// endpoint connects',
    { VITE_WEBSOCKET_ENDPOINT: 'wss://sync.example.com' }, 'wss://sync.example.com'],
  ['an uppercase scheme connects',
    { VITE_WEBSOCKET_ENDPOINT: 'WSS://sync.example.com' }, 'WSS://sync.example.com'],
  ['a padded real endpoint is trimmed, not rejected',
    { VITE_WEBSOCKET_ENDPOINT: '  wss://sync.example.com  ' }, 'wss://sync.example.com'],
];

if (evalEndpoint) {
  for (const [name, env, expected] of ENDPOINT_CASES) {
    let got;
    try {
      got = evalEndpoint(env);
    } catch (e) {
      got = `threw: ${e.message}`;
    }
    check(name, got === expected, `resolved=${JSON.stringify(got)} (expected ${JSON.stringify(expected)})`);
  }
  check('a discarded value is not discarded in silence',
    /console\.warn/.test(crdtSrc.slice(crdtSrc.indexOf('RAW_ENDPOINT'))),
    'a set-but-ignored variable must say so');
}

// ── Section 3: the production env file agrees with the guard ────────────────
console.log('\nSection 3: .env.production values (committed — see section 7)');

// Print key presence and value length only. Never the values.
const envProdPath = '.env.production';
if (existsSync(path.join(ROOT, envProdPath))) {
  const envProd = read(envProdPath);
  const flag = (k) => {
    const m = envProd.match(new RegExp(`^\\s*${k}\\s*=\\s*(.*)$`, 'm'));
    return m ? m[1].trim() : undefined;
  };
  const local = flag('VITE_USE_LOCAL_AUTH');
  const standalone = flag('VITE_STANDALONE_LOCAL');
  const server = flag('VITE_USE_SERVER_AUTH');
  const d1Data = flag('VITE_USE_D1_API');
  check('.env.production disables legacy browser-local auth',
    local === 'false' && standalone === 'false', `local=${local}; standalone=${standalone}`);
  check('.env.production selects server auth without D1 business storage',
    server === 'true' && d1Data === 'false', `server=${server}; d1Data=${d1Data}`);
  if (evalGuard) {
    check('a build from .env.production would actually boot',
      evalGuard({ PROD: true, VITE_USE_LOCAL_AUTH: local, VITE_STANDALONE_LOCAL: standalone }) === false,
      'the file is fed to the real extracted condition');
  }
} else {
  check('.env.production exists', false, 'a local production build would have no flags at all');
}

// ── Section 4: the dashboard-discoverable template ─────────────────────────
console.log('\nSection 4: .env.example (the template a dashboard seeds from)');

const example = read('.env.example');
check('.env.example declares VITE_STANDALONE_LOCAL',
  /VITE_STANDALONE_LOCAL/.test(example),
  'hosting dashboards seed their variable list from this file; an absent name is a variable nobody knows to set');
check('.env.example does not ship the standalone flag switched ON',
  !/^\s*VITE_STANDALONE_LOCAL\s*=\s*true\s*$/m.test(example),
  'the template must default to the safe value');
check('.env.example still documents the websocket endpoint',
  /VITE_WEBSOCKET_ENDPOINT/.test(example));

// ── Section 5: the build-time guard in envGuardPlugin.js ────────────────────
console.log('\nSection 5: build-time guard (envGuardPlugin.js)');

// The runtime guard above only fires when local auth is ON without the
// standalone flag. When BOTH flags are absent — which is exactly what a hosting
// or CI checkout sees, because .env.production is gitignored — main.jsx boots
// happily and base44Client.js routes login to a backend that no longer exists.
// Measured 2026-08-23: Cloudflare's Git build reported "Build variables: None".
// So the build itself has to refuse. This section RUNS the real plugin.
const guardPluginPath = 'envGuardPlugin.js';
check('envGuardPlugin.js exists', existsSync(path.join(ROOT, guardPluginPath)));

if (existsSync(path.join(ROOT, guardPluginPath))) {
  const mod = await import(new URL(`../${guardPluginPath}`, import.meta.url));
  const plugin = mod.default();

  check('the guard runs on builds only',
    plugin.apply === 'build',
    `apply=${JSON.stringify(plugin.apply)} — the dev server must stay usable without production flags`);

  check('the guard runs in configResolved, before any asset is written',
    typeof plugin.configResolved === 'function',
    'a later hook would waste a full build to report a one-line config mistake');

  // true = REFUSES to build.  false = build proceeds.
  const BUILD_CASES = [
    ['the deployed standalone config builds',
      { mode: 'production', env: { VITE_USE_LOCAL_AUTH: 'true', VITE_STANDALONE_LOCAL: 'true' } }, false],
    ['the server-auth/local-business-data config builds',
      { mode: 'production', env: { VITE_USE_SERVER_AUTH: 'true', VITE_USE_D1_API: 'false' } }, false],
    ['server auth refuses when D1 business-data mode is also enabled',
      { mode: 'production', env: { VITE_USE_SERVER_AUTH: 'true', VITE_USE_D1_API: 'true' } }, true],
    ['a production build with NO flags refuses (the Cloudflare/CI case)',
      { mode: 'production', env: {} }, true],
    ['a production build with only VITE_USE_LOCAL_AUTH refuses',
      { mode: 'production', env: { VITE_USE_LOCAL_AUTH: 'true' } }, true],
    ['a production build with only VITE_STANDALONE_LOCAL refuses',
      { mode: 'production', env: { VITE_STANDALONE_LOCAL: 'true' } }, true],
    ['"TRUE" is not "true" — refuses rather than half-enabling',
      { mode: 'production', env: { VITE_USE_LOCAL_AUTH: 'TRUE', VITE_STANDALONE_LOCAL: 'TRUE' } }, true],
    ['a missing env object refuses instead of throwing TypeError',
      { mode: 'production' }, true],
    ['a non-production mode is left alone',
      { mode: 'development', env: {} }, false],
  ];

  let message = '';
  for (const [name, config, expectRefuse] of BUILD_CASES) {
    let refused = false;
    try {
      plugin.configResolved(config);
    } catch (e) {
      refused = true;
      message = e.message;
    }
    check(name, refused === expectRefuse, `refused=${refused} (expected ${expectRefuse})`);
  }

  check('the refusal names the supported authentication shapes and where to set them',
    /VITE_USE_LOCAL_AUTH/.test(message) &&
    /VITE_STANDALONE_LOCAL/.test(message) &&
    /VITE_USE_SERVER_AUTH/.test(message) &&
    /Cloudflare/.test(message),
    'a build failure that does not say which knob to turn costs an hour');
}

// ── Section 6: the guard is wired into every build path ────────────────────
console.log('\nSection 6: the guard is actually in the pipeline');

const viteConfig = read('vite.config.js');
check('vite.config.js imports the guard',
  /import\s+\w+\s+from\s+['"]\.\/envGuardPlugin\.js['"]/.test(viteConfig),
  'a guard outside the plugins array protects nothing');
check('vite.config.js invokes the guard in its plugins array',
  /\benvGuard\s*\(\s*\)/.test(viteConfig));

// The CI job clones the repo, so since 2026-08-24 it gets .env.production and the
// guard stays quiet. These two lines are belt-and-braces: they keep the job green
// if that file is ever renamed or re-ignored, and they state the required shape at
// the one place a reader of the workflow looks. Asserted so a tidy-up cannot drop
// them — losing them would only be noticed by a red build weeks later.
const workflowPath = '.github/workflows/security.yml';
if (existsSync(path.join(ROOT, workflowPath))) {
  const wf = read(workflowPath);
  const stepIdx = wf.indexOf('Verify Production Build');
  const step = stepIdx >= 0 ? wf.slice(stepIdx, stepIdx + 900) : '';
  check('the CI production-build step exists', stepIdx >= 0);
  check('the CI production-build step sets VITE_USE_SERVER_AUTH=true',
    /VITE_USE_SERVER_AUTH:\s*'?true'?/.test(step),
    'otherwise CI verifies the wrong authentication shape');
  check('the CI production-build step keeps VITE_USE_D1_API=false',
    /VITE_USE_D1_API:\s*'?false'?/.test(step));
} else {
  check('.github/workflows/security.yml exists', false, 'the CI gate went missing');
}

// ── Section 7: .env.production travels with the repo, and holds no secrets ──
console.log('\nSection 7: .env.production is committed, LF-only and flag-only');

// Both values in that file are PUBLIC by construction — vite folds every
// VITE_-prefixed variable into the shipped JavaScript, so anyone who loads the
// site can read them. Keeping it untracked therefore bought no secrecy, and cost
// two dead Cloudflare builds (#2576feba shipped a bundle that could never log in;
// #159d05dc failed at the guard). A host build clones this repo; if the flags are
// not IN the repo, every deploy depends on a dashboard staying correct by hand.
//
// The trade is that this file is now the one place in version control where a
// careless `echo SECRET=... >> .env.production` would be silently committed. So
// the rule "never put a secret here" is enforced below as a key ALLOWLIST rather
// than left as a comment nobody re-reads.
const ENV_PROD = '.env.production';
const ENV_PROD_ALLOWED = [
  'VITE_USE_LOCAL_AUTH',
  'VITE_STANDALONE_LOCAL',
  'VITE_USE_SERVER_AUTH',
  'VITE_USE_D1_API',
  // Public build-time mode switch for the staged cross-browser business sync.
  // Vite folds it into the bundle exactly like the four above, so it carries no
  // secrecy value and belongs in the repo rather than in a dashboard field that
  // has to stay correct by hand. Added to the ALLOWLIST deliberately — the point
  // of the list is that a new key needs a decision, not that no key may be added.
  'VITE_USE_SERVER_DATA_SYNC',
];

check(`${ENV_PROD} exists`, existsSync(path.join(ROOT, ENV_PROD)),
  'without it, a cloned checkout builds a bundle that cannot authenticate anyone');

const git = (...args) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });

// Two measured gotchas in `git check-ignore`, both of which made an earlier
// version of this assertion useless (2026-08-24):
//
//   1. Without `--no-index` git skips any path already in the index, so this
//      check silently degraded into a duplicate of the "is tracked" one below
//      and kept passing after `.env.production` was re-added to .gitignore.
//   2. With `-v`, exit status 0 means "some pattern MATCHED", not "is ignored" —
//      a negation matches too. Observed: `.env.production` -> rc=0,
//      `.gitignore:21:!.env.production`, and `.env.example` behaves identically.
//      So the exit code alone is not the predicate; the matched pattern is.
//
// Verdict: not ignored means either no pattern matched (rc=1) or the winning
// pattern is a negation. Anything else means a clone would not carry the flags.
// `-v` output shape: <source>:<line>:<pattern>\t<pathname>
const ignore = git('check-ignore', '--no-index', '-v', '--', ENV_PROD);
const ignoreLine = (ignore.stdout || '').trim().split('\n')[0] || '';
const matchedPattern = ignoreLine
  ? ignoreLine.split('\t')[0].split(':').slice(2).join(':')
  : '';
check(`${ENV_PROD} is NOT excluded by any .gitignore rule`,
  ignore.status === 1 || (ignore.status === 0 && matchedPattern.startsWith('!')),
  ignore.status === 1
    ? 'no pattern matches it at all'
    : `winning pattern is ${JSON.stringify(matchedPattern)} (${ignoreLine.split('\t')[0].split(':').slice(0, 2).join(':')})${matchedPattern.startsWith('!') ? '' : ' — a cloned build would get no flags'}`);

const tracked = git('ls-files', '--error-unmatch', '--', ENV_PROD);
check(`${ENV_PROD} is tracked (or staged)`,
  tracked.status === 0,
  'un-ignoring it is not enough — it has to be in the index to reach a clone');

const envProdRaw = existsSync(path.join(ROOT, ENV_PROD)) ? read(ENV_PROD) : '';

// dotenv keeps a trailing CR inside the VALUE, so a CRLF checkout would yield
// "true\r" and the guard — which compares against the exact string "true" — would
// fail the build. Pinned by .gitattributes; asserted here because a build that
// breaks only on Windows is the kind of trap that survives for months.
check(`${ENV_PROD} is LF-only`, !envProdRaw.includes('\r'),
  'a captured CR turns "true" into "true\\r" and the guard rejects it');
check('.gitattributes pins that file to LF',
  /^\.env\.production\s+text\s+eol=lf\s*$/m.test(read('.gitattributes')),
  'without the pin, `* text=auto` hands Windows a CRLF copy');
check('.gitignore carries the negation that keeps it tracked',
  /^!\.env\.production\s*$/m.test(read('.gitignore')),
  'the `.env.*` glob on line 3 swallows it otherwise');

const envProdKeys = envProdRaw
  .split(/\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'))
  .map((line) => (line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/) || [])[1])
  .filter(Boolean);

const unexpected = envProdKeys.filter((k) => !ENV_PROD_ALLOWED.includes(k));
check(`${ENV_PROD} contains ONLY the approved public mode flags`,
  unexpected.length === 0,
  unexpected.length
    ? `unexpected key(s): ${unexpected.join(', ')} — this file is committed; secrets belong in the hosting dashboard`
    : `keys: ${envProdKeys.join(', ')}`);

// Values, not just presence: "TRUE", "1" and "yes" are all falsy to the guard.
const envProdValue = (key) => {
  const m = envProdRaw.match(new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*(.*)$`, 'm'));
  return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : undefined;
};
const ENV_PROD_EXPECTED = {
  VITE_USE_LOCAL_AUTH: 'false',
  VITE_STANDALONE_LOCAL: 'false',
  VITE_USE_SERVER_AUTH: 'true',
  VITE_USE_D1_API: 'false',
};
for (const [key, expected] of Object.entries(ENV_PROD_EXPECTED)) {
  check(`${ENV_PROD} sets ${key} to the exact string ${JSON.stringify(expected)}`,
    envProdValue(key) === expected,
    `value=${JSON.stringify(envProdValue(key))}`);
}

// ── Result ─────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`probe-standalone-deploy: ${pass} passed, ${fail} failed`);
console.log(`\n${fail === 0 ? 'PASSED' : 'FAILED'}: ${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log(`  · ${f}`));
  process.exit(1);
}
