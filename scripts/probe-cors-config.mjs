/**
 * probe-cors-config.mjs — guards base44/lib/corsConfig.js
 *
 * Two defects were fixed in that file on 2026-08-22:
 *
 *   1. `const productionOrigins = process.env.ALLOWED_ORIGINS ? ... : []` ran at
 *      MODULE SCOPE. A bare `process` reference throws ReferenceError the instant
 *      the file is imported in a host that does not define it (a browser/Vite
 *      bundle, or a Deno function without the Node compatibility global).
 *   2. A preflight OPTIONS request from an UNAUTHORIZED origin was answered with
 *      `Access-Control-Allow-Origin: *` plus the full Allow-Methods list.
 *
 * Neither defect is reachable today: the module has ZERO inbound edges in
 * graphify-out/graph.json — nothing in the repository imports it. That is exactly
 * why it needs a static guard. An unused file attracts no runtime evidence, so the
 * next agent to wire it into a serverless function is the one who finds out.
 *
 * The load tests use `vm` rather than `import()` deliberately. Node always defines
 * `process`, so importing the file here could never observe the crash it was fixed
 * to prevent. A bare vm context reproduces the hostile host exactly. The file makes
 * no `require()` calls, so it evaluates in such a context unmodified.
 *
 * Run: node scripts/probe-cors-config.mjs        (no loader needed)
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.join(ROOT, 'base44', 'lib', 'corsConfig.js');
const src = fs.readFileSync(TARGET, 'utf8');

let passed = 0;
let failed = 0;
function check(label, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`);
  }
}
function section(title) {
  console.log(`\n${title}`);
}

/**
 * Evaluate the CommonJS module in an isolated context.
 * @param {{process?: object, Deno?: object}} host globals to expose. Omit both to
 *        simulate a host with neither Node nor Deno env access.
 */
function loadIn(host = {}) {
  const mod = { exports: {} };
  const context = vm.createContext({ module: mod, exports: mod.exports, ...host });
  vm.runInContext(src, context, { filename: TARGET });
  return mod.exports;
}

/**
 * Strip comments so the static assertions below judge CODE, not prose.
 *
 * This is load-bearing, not tidiness. The fix in corsConfig.js documents itself by
 * quoting the defective line it replaced, so a naive substring search finds the old
 * wildcard grant and the old `process.env` read in the very comment explaining that
 * they are gone. The same trap cost a false FAIL in verify-money-kept.mjs on
 * 2026-08-22. Tracks quote state, because this file contains 'http://localhost:5173'
 * and a line-comment strip that ignored strings would cut it at the '//'.
 * @param {string} s
 * @returns {string}
 */
function stripComments(s) {
  let out = '';
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const next = s[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') { out += next ?? ''; i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; continue; }
    if (c === '/' && next === '/') { while (i < s.length && s[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && next === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i++; continue; }
    out += c;
  }
  return out;
}
const code = stripComments(src);

// ---------------------------------------------------------------------------
section('1. No env read survives at module scope (static)');

check('readEnv() exists as the single env entry point', /function readEnv\s*\(/.test(code));

// Every `process.env` in the file must sit inside readEnv. Locating the function
// by braces is enough here because readEnv contains no nested function.
const readEnvStart = code.indexOf('function readEnv');
const readEnvEnd = code.indexOf('\n}', readEnvStart);
const insideReadEnv = code.slice(readEnvStart, readEnvEnd);
const totalProcessEnv = (code.match(/process\.env/g) || []).length;
const scopedProcessEnv = (insideReadEnv.match(/process\.env/g) || []).length;
check(
  'every process.env reference is inside readEnv()',
  totalProcessEnv > 0 && totalProcessEnv === scopedProcessEnv,
  `total=${totalProcessEnv} insideReadEnv=${scopedProcessEnv}`,
);

// Anchored on the assignment, so even with comments stripped the intent is exact.
check(
  'productionOrigins is not assigned from env at module scope',
  !/^\s*const\s+productionOrigins\s*=\s*process\.env/m.test(code),
);
check(
  'allowedOrigins is not a module-scope const built from productionOrigins',
  !/^\s*const\s+allowedOrigins\s*=\s*\[\s*\.\.\.productionOrigins/m.test(code),
);

// ---------------------------------------------------------------------------
section('2. Preflight no longer wildcards an unauthorized origin (static)');

// Bounded by the branch's own last statement rather than by a trailing comment,
// which stripComments() has already removed.
const optionsStart = code.indexOf("req.method === 'OPTIONS'");
const optionsBlock = code.slice(optionsStart, code.indexOf('res.status(204).end()', optionsStart));
check('the OPTIONS branch was located', optionsStart > 0 && optionsBlock.length > 0);
check(
  'the OPTIONS branch contains no wildcard grant',
  !/'\*'/.test(optionsBlock),
  optionsBlock.split('\n').find((l) => l.includes("'*'")) || '',
);
check('the OPTIONS branch refuses with 403', /status\(403\)/.test(optionsBlock));

// ---------------------------------------------------------------------------
section('3. Imports cleanly with NEITHER process NOR Deno defined');

let bare = null;
let bareError = null;
try {
  bare = loadIn();
} catch (e) {
  bareError = e;
}
check(
  'module evaluates without throwing',
  bareError === null,
  bareError ? `${bareError.name}: ${bareError.message}` : '',
);

if (bare) {
  check('isAllowedOrigin() is callable', typeof bare.isAllowedOrigin === 'function');
  check('a local origin is still allowed', bare.isAllowedOrigin('http://localhost:5173') === true);
  check('an unknown origin is refused', bare.isAllowedOrigin('https://evil.example') === false);
  check('an empty origin is refused', bare.isAllowedOrigin('') === false);
  check('productionOrigins reads as an empty array', Array.isArray(bare.productionOrigins) && bare.productionOrigins.length === 0);
  check('allowedOrigins still exposes the 3 local origins', bare.allowedOrigins.length === 3);
}

// ---------------------------------------------------------------------------
section('4. process.env is honoured when the host provides it');

const withProcess = loadIn({
  process: { env: { ALLOWED_ORIGINS: ' https://a.example , https://b.example ,, ' } },
});
check(
  'comma-separated origins are parsed, trimmed and de-blanked',
  JSON.stringify(withProcess.productionOrigins) === JSON.stringify(['https://a.example', 'https://b.example']),
  JSON.stringify(withProcess.productionOrigins),
);
check('an env origin is allowed', withProcess.isAllowedOrigin('https://a.example') === true);
check('isProductionOrigin() distinguishes env from local', withProcess.isProductionOrigin('https://a.example') === true
  && withProcess.isProductionOrigin('http://localhost:5173') === false);
check('env origins precede local ones in allowedOrigins', withProcess.allowedOrigins[0] === 'https://a.example');

// ---------------------------------------------------------------------------
section('5. Deno.env is honoured, and a permission failure does not crash');

const withDeno = loadIn({ Deno: { env: { get: (n) => (n === 'ALLOWED_ORIGINS' ? 'https://deno.example' : '') } } });
check('Deno.env.get() is used when present', withDeno.isAllowedOrigin('https://deno.example') === true);

// Deno.env.get throws when the function was granted no --allow-env permission.
const denoThrows = loadIn({
  Deno: { env: { get: () => { throw new Error('Requires env access'); } } },
  process: { env: { ALLOWED_ORIGINS: 'https://fallback.example' } },
});
check('a throwing Deno.env.get falls through to process.env', denoThrows.isAllowedOrigin('https://fallback.example') === true);

// No process at all, and Deno.env.get refuses. Wrapped because a REGRESSED file
// throws here at module scope, and a guard that stack-traces instead of naming the
// broken assertion is a worse guard. Observed while mutation-testing this probe
// against the pre-fix source on 2026-08-22: the crash landed here and silently
// skipped every remaining section.
let denoThrowsNoProcess = null;
try {
  denoThrowsNoProcess = loadIn({ Deno: { env: { get: () => { throw new Error('Requires env access'); } } } });
} catch { /* reported by the assertion below */ }
check('a throwing Deno.env.get with no process still yields local origins',
  denoThrowsNoProcess !== null && denoThrowsNoProcess.allowedOrigins.length === 3);

// ---------------------------------------------------------------------------
section('6. The middleware enforces the documented contract');

function fakeRes() {
  const res = { headers: {}, statusCode: null, body: null, ended: false };
  res.header = (k, v) => { res.headers[k] = v; return res; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; res.ended = true; return res; };
  res.end = () => { res.ended = true; return res; };
  return res;
}
function run(mw, method, origin) {
  const res = fakeRes();
  let nexted = false;
  mw({ method, headers: { origin } }, res, () => { nexted = true; });
  return { res, nexted };
}

const mw = withProcess.createCorsMiddleware({ credentials: true });

const badPreflight = run(mw, 'OPTIONS', 'https://evil.example');
check('unauthorized preflight is refused with 403', badPreflight.res.statusCode === 403);
check('unauthorized preflight sets no Allow-Origin header at all',
  badPreflight.res.headers['Access-Control-Allow-Origin'] === undefined,
  String(badPreflight.res.headers['Access-Control-Allow-Origin']));
check('unauthorized preflight advertises no methods',
  badPreflight.res.headers['Access-Control-Allow-Methods'] === undefined);

const goodPreflight = run(mw, 'OPTIONS', 'https://a.example');
check('authorized preflight returns 204', goodPreflight.res.statusCode === 204);
check('authorized preflight echoes the exact origin, never a wildcard',
  goodPreflight.res.headers['Access-Control-Allow-Origin'] === 'https://a.example');
check('authorized preflight advertises the method list',
  goodPreflight.res.headers['Access-Control-Allow-Methods'] === 'GET, PUT, POST, DELETE, OPTIONS');

const badGet = run(mw, 'GET', 'https://evil.example');
check('unauthorized request is refused with 403', badGet.res.statusCode === 403);
check('unauthorized request does not call next()', badGet.nexted === false);

const goodGet = run(mw, 'GET', 'https://a.example');
check('authorized request calls next()', goodGet.nexted === true);
check('authorized request echoes the origin', goodGet.res.headers['Access-Control-Allow-Origin'] === 'https://a.example');
check('credentials:true is propagated', goodGet.res.headers['Access-Control-Allow-Credentials'] === 'true');

const mwNoCreds = withProcess.createCorsMiddleware();
check('credentials defaults to false',
  run(mwNoCreds, 'GET', 'https://a.example').res.headers['Access-Control-Allow-Credentials'] === 'false');

// ---------------------------------------------------------------------------
section('7. The lazy read is memoised, not re-parsed per call');

const envObj = { ALLOWED_ORIGINS: 'https://first.example' };
const memo = loadIn({ process: { env: envObj } });
const before = memo.isAllowedOrigin('https://first.example');
envObj.ALLOWED_ORIGINS = 'https://second.example';
check('first origin still resolves after the env object mutates',
  before === true && memo.isAllowedOrigin('https://first.example') === true);
check('a late env change is not picked up (value cached once)',
  memo.isAllowedOrigin('https://second.example') === false);

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
