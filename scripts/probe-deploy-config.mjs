// Probe: the deploy configuration.
//
// This is the one area of the app where a defect is invisible in development
// and total in production, because none of it is exercised by `vite dev`:
//
//   · No SPA fallback in vercel.json + BrowserRouter = every deep link and
//     every hard refresh on a non-root route returns 404. The dev server
//     rewrites to index.html for you, so this cannot be caught locally.
//   · The CSP is served as a *header*. index.html also carried a <meta
//     http-equiv> CSP, and when a document has both, the browser enforces the
//     intersection. The meta tag allowed blob: and the header did not, so the
//     wider-looking meta tag was a decoy: UploadFile() returns a blob: URL
//     (base44Client.js:1200) which csvParser.js and DataIntelligence.jsx then
//     fetch(), and connect-src had no blob:.
//   · public/manifest.json had a line of JavaScript prepended to it by some
//     codemod, so it was not valid JSON and the browser discarded the whole
//     manifest.
//   · The favicon and both manifest icons pointed at https://db.com — a
//     third-party domain — so every load of a private hotel dashboard sent a
//     request to a host nobody here controls.
//
// Static probe: it asserts the shipped configuration files, which is what
// regresses. It does not start a browser, so it does not prove what Vercel
// serves — the deep-link hard-refresh test on a real preview is still required.
//
// Run: node scripts/probe-deploy-config.mjs

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');

// Negative assertions ("this string must be gone") run against source with
// comments stripped. Each fix here documents the configuration it replaced —
// crdt.jsx explains the `ws://localhost:1234` default it removed — and a probe
// that fails because a file explains its own defect punishes the fix. The
// `[^:]` guard keeps `https://` out of the line-comment rule.
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');
const readCode = (p) => stripComments(read(p));

// Every .js/.jsx file under a directory, recursively.
function walkJs(dir) {
  const out = [];
  (function rec(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) rec(full);
      else if (/\.jsx?$/.test(e.name)) out.push(full);
    }
  })(dir);
  return out;
}

// The argument list of every `fn(` call in a string, paren-balanced so nested
// calls and template literals come back whole.
function callArgs(src, fn) {
  const out = [];
  let i = 0;
  const needle = `${fn}(`;
  while ((i = src.indexOf(needle, i)) !== -1) {
    let depth = 0;
    let j = i + needle.length - 1;
    for (; j < src.length; j += 1) {
      if (src[j] === '(') depth += 1;
      else if (src[j] === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    out.push(src.slice(i + needle.length, j));
    i = j + 1;
  }
  return out;
}

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n── ${title}`);
}

// ── 1. vercel.json ──────────────────────────────────────────────────────────
section('1. vercel.json');

let vercel = null;
try {
  vercel = JSON.parse(read('vercel.json'));
  check('vercel.json is valid JSON', true);
} catch (e) {
  check('vercel.json is valid JSON', false, e.message);
}

let prodCsp = '';
// Hoisted out of the block below so section 3 can compare the other copies of
// the header set against the one that is actually served in production.
let prodHeaders = {};
if (vercel) {
  // The SPA fallback. Vercel checks the filesystem before applying rewrites, so
  // a catch-all cannot shadow /assets, /manifest.json or a real function route.
  const rewrites = vercel.rewrites || [];
  const spa = rewrites.find((r) => r.destination === '/index.html');
  check('a rewrite sends unmatched paths to /index.html',
    Boolean(spa),
    'BrowserRouter deep links (/transactions, /payroll) 404 on hard refresh without this');
  check('the SPA rewrite is a catch-all',
    Boolean(spa) && /^\/\(\.\*\)$|^\/\(\(\?!/.test(spa.source),
    `source is ${spa ? spa.source : 'absent'}`);

  const broad = (vercel.headers || []).find((h) => h.source === '/(.*)');
  check('a header rule covers every path', Boolean(broad));
  const H = Object.fromEntries((broad?.headers || []).map((h) => [h.key, h.value]));
  prodHeaders = H;
  prodCsp = H['Content-Security-Policy'] || '';

  for (const key of [
    'Strict-Transport-Security', 'X-Content-Type-Options', 'X-Frame-Options',
    'Referrer-Policy', 'Permissions-Policy', 'Content-Security-Policy',
    'Cross-Origin-Opener-Policy', 'Cross-Origin-Resource-Policy',
  ]) {
    check(`${key} is served`, Boolean(H[key]));
  }
  check('COOP is same-origin', H['Cross-Origin-Opener-Policy'] === 'same-origin');
  check('CORP is same-origin', H['Cross-Origin-Resource-Policy'] === 'same-origin');

  // Content-hashed filenames (vite.config.js: assets/[name]-[hash].[ext]) are
  // the precondition for immutable caching — without it a deploy would serve
  // stale JS for a year.
  const assets = (vercel.headers || []).find((h) => /assets/.test(h.source));
  const assetCache = assets?.headers?.find((h) => h.key === 'Cache-Control')?.value || '';
  check('/assets is cached immutably', /immutable/.test(assetCache) && /max-age=\d{7,}/.test(assetCache));
  check('the build actually content-hashes asset filenames',
    /assetFileNames:\s*'assets\/\[name\]-\[hash\]/.test(read('vite.config.js')),
    'immutable caching is only safe with hashed filenames');
}

// ── 2. The CSP has to permit what the app actually does ─────────────────────
section('2. CSP vs. the code it governs');
{
  const dir = (name) => {
    const m = prodCsp.match(new RegExp(`${name}\\s+([^;]+)`));
    return m ? m[1].trim() : '';
  };

  // Load-bearing, not decorative: this is the CSV import path.
  const client = read('src/api/base44Client.js');
  const usesBlobUrls = /createObjectURL/.test(client);
  check('UploadFile still hands out blob: URLs (premise of the next two checks)', usesBlobUrls);
  check('connect-src allows blob:',
    /\bblob:/.test(dir('connect-src')),
    'fetch() of the blob: URL from UploadFile is blocked, so every CSV import fails');
  check('worker-src allows self and blob:',
    /'self'/.test(dir('worker-src')) && /\bblob:/.test(dir('worker-src')),
    'the CSV parser runs in a Worker (csvParser.js:275)');
  check('img-src allows blob: and data:',
    /\bblob:/.test(dir('img-src')) && /\bdata:/.test(dir('img-src')),
    'html2canvas/jspdf render through canvas and blob URLs');
  check('font-src allows data:',
    /\bdata:/.test(dir('font-src')),
    'html2canvas inlines fonts as data URLs when exporting a PDF');

  // Tightened: connect-src was 'self' https: wss:, i.e. any host on the
  // internet, which is the directive that matters for exfiltration.
  check('connect-src is not a blanket https: allowlist',
    !/(^|\s)https:(\s|$)/.test(dir('connect-src')),
    `connect-src is "${dir('connect-src')}"`);
  check('connect-src still allows the base44 backend',
    /base44\.app/.test(dir('connect-src')),
    'the SDK calls https://base44.app');
  check('no unsafe-inline in script-src',
    !/'unsafe-inline'/.test(dir('script-src')));
  check('no unsafe-eval in script-src',
    !/'unsafe-eval'/.test(dir('script-src')));
  check('frame-ancestors is none', /'none'/.test(dir('frame-ancestors')));
  check('object-src is none', /'none'/.test(dir('object-src')));

  // A ws:// endpoint on an https page is blocked as mixed content whatever the
  // CSP says, and the old hardcoded default pointed at the viewer's own machine.
  const crdt = read('src/crdt.jsx');
  check('crdt.jsx has no hardcoded ws:// endpoint',
    !/ws:\/\/localhost/.test(readCode('src/crdt.jsx')),
    'every production page load opened a retrying socket to ws://localhost:1234');
  check('crdt.jsx reads its endpoint through import.meta.env',
    /import\.meta\.env\?\.VITE_WEBSOCKET_ENDPOINT/.test(crdt),
    'process.env is undefined in the browser and Vite does not substitute REACT_APP_*');
  check('crdt.jsx skips connecting when no endpoint is configured',
    /if\s*\(!ENDPOINT\)\s*return/.test(crdt));
}

// ── 3. One CSP, not two ────────────────────────────────────────────────────
section('3. Single source of truth for headers');
{
  const html = read('index.html');
  check('index.html carries no meta CSP',
    !/http-equiv=["']Content-Security-Policy/i.test(html),
    'two policies are enforced as their intersection, so a meta tag can only narrow the header');
  for (const meta of ['X-Frame-Options', 'X-Content-Type-Options', 'Referrer-Policy', 'Permissions-Policy']) {
    check(`index.html carries no meta ${meta}`,
      !new RegExp(`http-equiv=["']${meta}`, 'i').test(html),
      'ignored by browsers when set via meta, and it hides the fact that the header is the real control');
  }

  // vite preview / vite dev must enforce the same policy, or local testing
  // proves nothing about production.
  const vite = read('vite.config.js');
  const m = vite.match(/const CSP_PROD = "([^"]+)"/);
  check('vite.config.js defines the preview CSP in one place', Boolean(m));
  if (m && prodCsp) {
    check('the preview CSP is byte-identical to the deployed CSP',
      m[1] === prodCsp,
      'vite preview would not reproduce production');
  }
  const devBlock = vite.match(/const devHeaders = \{[\s\S]*?\n\}/);
  check('the dev CSP is derived from the production one, not written out again',
    Boolean(devBlock) && /CSP_PROD/.test(devBlock[0]),
    'a hand-copied dev policy drifts, and dev is where blob: was first missed');
  check('the dev CSP still allows the HMR socket',
    Boolean(devBlock) && /ws:/.test(devBlock[0]));

  // The third copy. base44/config.jsonc is not documentation — it carries
  // installCommand, buildCommand and outputDirectory, so base44 hosting serves
  // this app from it, and a policy that is only correct in vercel.json is only
  // correct on one of the two hosts this repo deploys to.
  //
  // The two had drifted in opposite directions at the same time, which is the
  // worst way for a policy to be wrong: base44's connect-src was
  // `'self' https: wss:`, so an injected script could post the whole ledger to
  // any origin on the internet, while it omitted `blob:` and had no worker-src
  // at all — and those two are load-bearing, not decorative (UploadFile() hands
  // the parser a blob: URL and the parser runs in a Worker built from a blob).
  // Loose about exfiltration and strict about the app's own plumbing manages to
  // be both unsafe and broken.
  //
  // Hand-copying is what failed, so this compares them key by key rather than
  // adding a codegen step. That is the pattern already used for the four copies
  // of publicUser() and the three copies of the audit payload: a probe that
  // fails loudly beats a build step nobody runs.
  let b44 = null;
  try {
    b44 = JSON.parse(stripComments(read('base44/config.jsonc')));
    check('base44/config.jsonc parses once comments are stripped', true);
  } catch (e) {
    check('base44/config.jsonc parses once comments are stripped', false, e.message);
  }
  const b44Rule = (b44?.site?.headers || []).find((h) => h.source === '**');
  check('base44/config.jsonc has a catch-all header rule',
    Boolean(b44Rule),
    'base44 hosting would serve a private hotel dashboard with no security headers at all');
  const B = Object.fromEntries((b44Rule?.headers || []).map((h) => [h.key, h.value]));

  // X-XSS-Protection is deliberately NOT in this list. vercel.json sets it and
  // this file must not copy it: the auditor it controlled was removed from every
  // current browser, so it is already a no-op there, and mirroring a no-op only
  // widens the surface that has to be kept identical.
  const CANONICAL_HEADERS = [
    'Content-Security-Policy', 'Strict-Transport-Security', 'X-Frame-Options',
    'X-Content-Type-Options', 'Referrer-Policy', 'Permissions-Policy',
    'Cross-Origin-Opener-Policy', 'Cross-Origin-Resource-Policy',
  ];
  for (const key of CANONICAL_HEADERS) {
    check(`base44/config.jsonc serves ${key} byte-identically to vercel.json`,
      Boolean(prodHeaders[key]) && B[key] === prodHeaders[key],
      `vercel="${prodHeaders[key] || '(absent)'}" base44="${B[key] || '(absent)'}"`);
  }
  // Pinning the value too, so that lowering it in both files at once still
  // fails. Byte-equality alone would call two matching downgrades correct.
  check('both hosts advertise the two-year HSTS max-age',
    /max-age=63072000/.test(B['Strict-Transport-Security'] || '')
      && /max-age=63072000/.test(prodHeaders['Strict-Transport-Security'] || ''),
    'a shorter max-age is a downgrade window for every returning front-desk browser');
  check('base44/config.jsonc adds no header vercel.json does not also set',
    Object.keys(B).every((k) => CANONICAL_HEADERS.includes(k)),
    `undeclared: ${Object.keys(B).filter((k) => !CANONICAL_HEADERS.includes(k)).join(', ')}`);

  // A fourth copy is what caused this item, so any other file that writes a
  // policy has to be declared here on purpose. base44/lib/securityHeaders.js
  // was that fourth copy, and it was deleted rather than corrected:
  //
  //   · Its output was unsafe. buildCompleteCsp() emitted 'unsafe-inline' and
  //     'unsafe-eval' plus a blanket https: in BOTH default-src and script-src
  //     — the primary XSS control switched off — with HSTS 31536000, no
  //     worker-src, and a bare unquoted `self` that is a hostname, not a keyword.
  //   · It could not run. package.json declares "type": "module" and there is no
  //     base44/package.json to override it, so the file's `module.exports = {…}`
  //     assigned to Node 22's global `module` function instead of throwing:
  //     importing it yielded zero exports, measured.
  //   · Nothing imported it, so its only reachable use was a human pasting
  //     buildNginxSnippet() output into a real server — a file that hands an
  //     operator a broken policy while looking authoritative.
  const POLICY_AUTHORS = new Set([
    'vercel.json', 'base44/config.jsonc', 'vite.config.js',
    'scripts/probe-deploy-config.mjs',
  ]);
  const configFiles = [];
  (function rec(dir, rel) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (/^(node_modules|dist|coverage|\.git)$/.test(e.name)) continue;
      const full = path.join(dir, e.name);
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) rec(full, relPath);
      else if (/\.(jsx?|mjs|cjs|jsonc?|html)$/.test(e.name)) configFiles.push([full, relPath]);
    }
  })(ROOT, '');
  // Prose is excluded by that extension filter on purpose: the audit reports
  // quote the policy, and a document describing a header is not a header.
  const policyWriters = configFiles
    .filter(([full]) => /default-src/.test(readFileSync(full, 'utf8')))
    .map(([, relPath]) => relPath)
    .filter((relPath) => !POLICY_AUTHORS.has(relPath));
  check('no undeclared file defines a Content-Security-Policy',
    policyWriters.length === 0,
    `${policyWriters.join(', ')} — each copy is kept in step by hand, so a new one is a new drift source`);
  // Premise: without this the check above passes for a walk that found nothing.
  check('the policy-author scan actually read the tree',
    configFiles.length > 50, `scanned ${configFiles.length} files`);
}

// ── 4. The manifest and icons ──────────────────────────────────────────────
section('4. Manifest and icons');
{
  const raw = read('public/manifest.json');
  check('manifest.json does not start with JavaScript',
    !/^\s*const\b/.test(raw),
    'a codemod prepended `const db = globalThis.__B44_DB__ …`, which made the file unparseable');
  let manifest = null;
  try {
    manifest = JSON.parse(raw);
    check('manifest.json is valid JSON', true);
  } catch (e) {
    check('manifest.json is valid JSON', false, e.message);
  }

  if (manifest) {
    check('manifest has a name and short_name', Boolean(manifest.name && manifest.short_name));
    check('manifest scope and start_url are the site root',
      manifest.start_url === '/' && manifest.scope === '/');
    // A dashboard with wide tables (RoomBoard, Transactions) locked to portrait
    // in an installed copy cannot be read on a tablet.
    check('manifest does not lock orientation to portrait', manifest.orientation !== 'portrait');
    check('manifest theme colour matches the document theme-color',
      manifest.theme_color === (read('index.html').match(/name="theme-color" content="([^"]+)"/) || [])[1]);

    const icons = manifest.icons || [];
    check('every manifest icon is a local path',
      icons.length > 0 && icons.every((i) => i.src.startsWith('/')),
      `third-party icon hosts: ${icons.filter((i) => !i.src.startsWith('/')).map((i) => i.src).join(', ')}`);
    for (const size of ['192x192', '512x512']) {
      check(`manifest declares a ${size} icon`, icons.some((i) => i.sizes === size));
    }
    check('at least one icon is maskable',
      icons.some((i) => /maskable/.test(i.purpose || '')));

    // Declared sizes have to match the actual files, or the install prompt is
    // rejected for a reason nobody can see.
    for (const icon of icons.filter((i) => i.src.endsWith('.png'))) {
      const file = path.join(ROOT, 'public', icon.src.replace(/^\//, ''));
      if (!existsSync(file)) {
        check(`${icon.src} exists`, false);
        continue;
      }
      const buf = readFileSync(file);
      const isPng = buf.slice(1, 4).toString('latin1') === 'PNG';
      const w = buf.readUInt32BE(16);
      const h = buf.readUInt32BE(20);
      check(`${icon.src} is a real PNG of ${icon.sizes}`,
        isPng && `${w}x${h}` === icon.sizes,
        `header says ${w}x${h}`);
    }
  }

  const html = read('index.html');
  check('the favicon is served from this origin',
    /<link rel="icon"[^>]+href="\/[^"]+"/.test(html),
    'the favicon pointed at https://db.com/logo_v2.svg');
  check('an apple-touch-icon is declared and present',
    /rel="apple-touch-icon"/.test(html) && existsSync(path.join(ROOT, 'public/apple-touch-icon.png')));
  check('no db.com reference is left in index.html or the manifest',
    !/db\.com/.test(html) && !/db\.com/.test(raw));
  check('public/favicon.svg exists', existsSync(path.join(ROOT, 'public/favicon.svg')));
}

// ── 5. Accessibility of the shell ──────────────────────────────────────────
section('5. Document shell');
{
  const html = read('index.html');
  const viewport = (html.match(/name="viewport" content="([^"]+)"/) || [])[1] || '';
  check('pinch-zoom is not disabled',
    !/user-scalable\s*=\s*no/.test(viewport),
    'WCAG 1.4.4 — someone reading a transaction row on a phone needs to zoom');
  check('maximum-scale does not pin the zoom level',
    !/maximum-scale\s*=\s*1/.test(viewport), `viewport is "${viewport}"`);
  check('viewport-fit=cover is kept for notched devices', /viewport-fit=cover/.test(viewport));
  check('the document declares a language', /<html lang="[a-z-]+"/.test(html));
}

// ── 6. Server-shaped modules must not reach the browser bundle ──────────────
section('6. No server-only module in the client graph');
{
  // corsConfig.js evaluates `process.env.ALLOWED_ORIGINS` at module scope.
  // `process` does not exist in the browser and Vite does not shim it, so
  // importing it from anything reachable by src/main.jsx is an immediate
  // ReferenceError — a white screen on load, not a degraded feature. Nothing
  // imports it today; this is the guard.
  //
  // It is guarded rather than trusted because it also cannot work as written:
  // package.json declares "type": "module", nothing under base44/ overrides
  // that, and the file assigns `module.exports`, so importing it yields zero
  // exports (measured). Its sibling securityHeaders.js had the same defect plus
  // an unsafe policy and was deleted — see section 3.
  const serverOnly = ['corsConfig'];
  check('base44/lib/securityHeaders.js has not come back',
    !existsSync(path.join(ROOT, 'base44/lib/securityHeaders.js')),
    "it emitted 'unsafe-inline' and 'unsafe-eval' in script-src and could not be imported at all — section 3");
  const files = [];
  (function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.jsx?$/.test(e.name)) files.push(full);
    }
  })(path.join(ROOT, 'src'));

  for (const mod of serverOnly) {
    const importers = files.filter((f) => {
      if (path.basename(f, path.extname(f)) === mod) return false;
      return new RegExp(`from\\s*['"][^'"]*${mod}['"]`).test(stripComments(readFileSync(f, 'utf8')));
    });
    check(`nothing in src/ imports ${mod}.js`,
      importers.length === 0,
      `imported by ${importers.map((f) => path.relative(ROOT, f)).join(', ')} — module-scope process.env is a ReferenceError in the browser`);
  }

  // Anything new with the same shape should be caught too.
  const offenders = files.filter((f) => {
    const src = stripComments(readFileSync(f, 'utf8'));
    return /^const .*=\s*process\.env\./m.test(src) && !serverOnly.includes(path.basename(f, path.extname(f)));
  });
  check('no other file reads process.env at module scope',
    offenders.length === 0,
    offenders.map((f) => path.relative(ROOT, f)).join(', '));
}

// ── 7. Debug output must not ship ───────────────────────────────────────────
section('7. Console stripping');
{
  const vite = read('vite.config.js');
  const esbuildBlock = (vite.match(/esbuild:\s*\{[\s\S]*?\n\s*\}/) || [])[0] || '';
  check('vite.config.js configures esbuild', Boolean(esbuildBlock));

  const pureList = (esbuildBlock.match(/pure:\s*\[([^\]]*)\]/) || [])[1] || '';
  for (const fn of ['console.log', 'console.debug', 'console.info']) {
    check(`${fn} is stripped from the production bundle`,
      pureList.includes(`'${fn}'`),
      'debug output on a shared front-desk browser is readable by anyone with the machine');
  }

  // The distinction matters. `pure` is dropped by the minifier, so dev keeps
  // the output; `drop: ['console']` is unconditional and takes warn and error
  // with it, which are how a failed import or save is reported at all.
  for (const fn of ['console.warn', 'console.error']) {
    check(`${fn} survives the production build`,
      !pureList.includes(`'${fn}'`),
      'operators need to see failures');
  }
  const dropList = (esbuildBlock.match(/drop:\s*\[([^\]]*)\]/) || [])[1] || '';
  check('drop does not blanket-remove console', !/console/.test(dropList), `drop is [${dropList}]`);
  check('debugger statements are dropped', /'debugger'/.test(dropList));

  // A stripped call is a *removed* call. If an argument does work, that work
  // disappears with it.
  const srcFiles = walkJs(path.join(ROOT, 'src'));
  const impure = [];
  let scanned = 0;
  for (const file of srcFiles) {
    const code = stripComments(readFileSync(file, 'utf8'));
    for (const fn of ['console.log', 'console.debug', 'console.info']) {
      for (const args of callArgs(code, fn)) {
        scanned += 1;
        // A call inside the arguments — `console.log(fmt(x))`, `${a.join(',')}`
        // — would be removed along with the log.
        if (/[A-Za-z_$][\w$]*\s*\(/.test(args)) {
          impure.push(`${path.relative(ROOT, file)}: ${fn}(${args.slice(0, 60)})`);
        }
      }
    }
  }
  // Premise: without this the check above passes for a parser that found
  // nothing. src/ still has the three ChannelManager traces.
  check('the argument scan actually parsed the remaining calls',
    scanned >= 3, `parsed ${scanned}`);
  check('no stripped console call has a function call in its arguments',
    impure.length === 0,
    impure.join(' | '));

  // The two sites where the console write *was* the whole side effect. Both are
  // now at warn level; regressing either to .log makes the function a no-op in
  // production while still looking correct in dev.
  const alertEngine = stripComments(read('src/lib/alertEngine.js'));
  check('fireAlert writes at warn level, not log',
    /console\.warn\(/.test(alertEngine) && !/console\.log\(/.test(alertEngine),
    'console.log is its only side effect, so stripping it would make firing an alert a no-op');

  const client = stripComments(read('src/api/base44Client.js'));
  const emailBody = (client.match(/async SendEmail\([\s\S]*?\n {4}\}/) || [])[0] || '';
  check('the SendEmail stub was located', Boolean(emailBody));
  check('the SendEmail stub reports at warn level',
    /console\.warn\(/.test(emailBody) && !/console\.log\(/.test(emailBody),
    'it is the only signal that a notification was never delivered');
  check('the SendEmail stub does not print the message body',
    !/\$\{body\}/.test(emailBody),
    'the anomaly alert body carries property names — not for a shared console');

  const debuggers = srcFiles.filter((f) => /(^|[;{\s])debugger\s*[;\n]/.test(stripComments(readFileSync(f, 'utf8'))));
  check('no debugger statement is left in src/',
    debuggers.length === 0,
    debuggers.map((f) => path.relative(ROOT, f)).join(', '));
}

// ── 8. Dependency supply chain ──────────────────────────────────────────────
section('8. Dependency supply chain');
{
  const pkg = JSON.parse(read('package.json'));
  const xlsxSpec = (pkg.dependencies || {}).xlsx || '';

  // The user chose the npm registry version for supply-chain integrity (npm audit,
  // lockfile integrity).  We accept that despite the known CVEs in 0.18.5,
  // because the registry is the only source and we have no newer version.
  // The lockfile provides integrity to prevent tampering.
  check('xlsx resolves to the npm registry (not a CDN tarball)',
    /^npm:/.test(xlsxSpec) || /^https:\/\/registry\.npmjs\.org/.test(xlsxSpec) || /^\^?\d+\.\d+\.\d+$/.test(xlsxSpec),
    `spec is "${xlsxSpec}" — expected npm registry`);
  const ver = (xlsxSpec.match(/(\d+)\.(\d+)\.(\d+)/) || []).slice(1).map(Number);
  check('the xlsx version is readable', ver.length === 3, xlsxSpec);
  // We do not enforce a minimum version because npm has no newer version.
  // A future upgrade would need to come from a fork or alternative.
  check('xlsx version is at least 0.18.5 (the npm version)',
    ver.length === 3 && (ver[0] > 0 || (ver[0] === 0 && (ver[1] > 18 || (ver[1] === 18 && ver[2] >= 5)))),
    `version ${ver.join('.')} — npm only has 0.18.5`);

  // The lockfile entry must have integrity to prevent tampering.
  const lock = JSON.parse(read('package-lock.json'));
  const lockEntry = (lock.packages || {})['node_modules/xlsx'] || {};
  check('the lockfile pins xlsx by integrity hash',
    /^sha(512|384|256)-/.test(lockEntry.integrity || ''),
    'without integrity, npm ci could install a tampered package');
  check('the lockfile and package.json resolve to the same version',
    Boolean(lockEntry.version) && lockEntry.version === (xlsxSpec.replace(/^[\^~]/, '')),
    `lock version="${lockEntry.version || '(absent)'}" pkg="${xlsxSpec}"`);
}

// ── 9. No committed credentials ────────────────────────────────────────────
//
// test-auth.cjs was a 50-line one-off puppeteer script at the repo root that
// hardcoded the owner's real email and real password. It was deleted 2026-08-21
// rather than patched: nothing referenced it (no package.json script, no import
// anywhere in the tracked tree) and `puppeteer` is neither declared in
// package.json nor present in node_modules, so the file could not run. The
// credential was the only live thing in it — and the `password` it defined was
// never even read by the function body below it.
//
// Why it survived so long is the finding worth keeping: a root-level .cjs file
// sits outside every gate this repo has. eslint.config.js ignores "*.cjs",
// jsconfig.json only type-checks src/, and scripts/verify-all.mjs only globs
// probe-*/verify-* under scripts/. No tool was ever going to read it. This
// section is the gate that file needed.
//
// These assertions deliberately do NOT contain the credential they defend
// against — CLAUDE.md section 6 forbids hardcoding one anywhere, a probe
// included. They match the SHAPE of a secret assignment instead.
check('the credential-carrying debug script has not come back',
  !existsSync(path.join(ROOT, 'test-auth.cjs')),
  'test-auth.cjs hardcoded the owner\'s real email and password, was referenced by nothing, and could not run — section 9');

const rootScripts = readdirSync(ROOT, { withFileTypes: true })
  .filter((e) => e.isFile() && /\.(cjs|mjs|js)$/.test(e.name))
  .map((e) => e.name);
// `password: process.env.X` is correct and must stay legal; a literal must not.
const SECRET_ASSIGN = /\b(password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]+\s*['"`][^'"`\n]{8,}['"`]/i;
const leakers = rootScripts.filter((n) => {
  const src = stripComments(read(n));
  return SECRET_ASSIGN.test(src) && !/process\.env/.test(src);
});
check('no root-level script hardcodes a credential literal',
  leakers.length === 0,
  leakers.length
    ? `${leakers.join(', ')} — read the value from process.env instead`
    : `scanned ${rootScripts.length} root-level scripts`);
check('the root-script scan actually had files to read',
  rootScripts.length > 3,
  `only ${rootScripts.length} matched, so a clean result here would mean nothing`);

// ── Result ─────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`probe-deploy-config: ${pass} passed, ${fail} failed`);
console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log(`  · ${f}`));
  process.exit(1);
}
