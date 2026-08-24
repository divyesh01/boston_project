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
    // eslint-disable-next-line no-new-func
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
    // eslint-disable-next-line no-new-func
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

// ── Section 3: the local production env file agrees with the guard ──────────
console.log('\nSection 3: .env.production (LOCAL builds only — it is gitignored)');

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
  check('.env.production sets VITE_USE_LOCAL_AUTH=true',
    local === 'true', `value is ${local === undefined ? 'absent' : `<${String(local).length} chars>`}`);
  check('.env.production sets VITE_STANDALONE_LOCAL=true',
    standalone === 'true', `value is ${standalone === undefined ? 'absent' : `<${String(standalone).length} chars>`}`);
  if (evalGuard) {
    check('a build from .env.production would actually boot',
      evalGuard({ PROD: true, VITE_USE_LOCAL_AUTH: local, VITE_STANDALONE_LOCAL: standalone }) === false,
      'the file is fed to the real extracted condition');
  }
} else {
  check('.env.production exists', false, 'a local production build would have no flags at all');
}

// ── Section 4: the dashboard-discoverable template ─────────────────────────
console.log('\nSection 4: .env.example (the ONLY env file git tracks)');

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

  check('the refusal names both variables and where to set them',
    /VITE_USE_LOCAL_AUTH/.test(message) &&
    /VITE_STANDALONE_LOCAL/.test(message) &&
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

// The CI job builds from a checkout with no .env.production, so without these
// two lines the guard turns a passing job red. That is the correct failure —
// but the job is supposed to verify the shipped shape, so it must supply them.
const workflowPath = '.github/workflows/security.yml';
if (existsSync(path.join(ROOT, workflowPath))) {
  const wf = read(workflowPath);
  const stepIdx = wf.indexOf('Verify Production Build');
  const step = stepIdx >= 0 ? wf.slice(stepIdx, stepIdx + 900) : '';
  check('the CI production-build step exists', stepIdx >= 0);
  check('the CI production-build step sets VITE_USE_LOCAL_AUTH=true',
    /VITE_USE_LOCAL_AUTH:\s*'?true'?/.test(step),
    'otherwise the build the pipeline verifies is one that can never be deployed');
  check('the CI production-build step sets VITE_STANDALONE_LOCAL=true',
    /VITE_STANDALONE_LOCAL:\s*'?true'?/.test(step));
} else {
  check('.github/workflows/security.yml exists', false, 'the CI gate went missing');
}

// The whole premise of the guard is that the flags do NOT travel with the repo.
check('.env.production is still gitignored',
  /^\s*\.env\.production\s*$/m.test(read('.gitignore')),
  'if it were committed, the flags would ship to every checkout — including any fork');

// ── Result ─────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`probe-standalone-deploy: ${pass} passed, ${fail} failed`);
console.log(`\n${fail === 0 ? 'PASSED' : 'FAILED'}: ${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log(`  · ${f}`));
  process.exit(1);
}
