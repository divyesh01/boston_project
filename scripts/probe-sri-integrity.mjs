// Probe: Subresource Integrity on the built index.html.
//
// WHY THIS EXISTS — measured 2026-08-23, in production.
// The deployed site rendered a blank dark page. Chrome's console:
//
//   Failed to find a valid digest in the 'integrity' attribute for resource
//   'https://divyeshpro.divyesh-boston.workers.dev/assets/index-Bbji4Ay-.js'
//   with computed SHA-384 integrity
//   '/A9VxDX7DYJHnERJ0MqnPHp3xc7n6N4FENU6B6Q5tMrXs8E42YIRZGkQxjLT8rWg'.
//   The resource has been blocked.
//
// A browser refuses to execute a subresource whose integrity hash does not
// match the bytes it fetched. The blocked file was the ENTRY chunk — the module
// that mounts React — so nothing rendered. The stylesheet's hash was correct,
// which is why the page painted the dark background and then stopped. Recomputing
// every digest in the local dist/index.html gave the same verdict offline:
// entry chunk MISMATCH, five vendor chunks and the CSS MATCH.
//
// This defect is invisible to every other gate in the repo, and that is the
// point of a dedicated probe:
//   · `vite dev` serves unhashed modules, so it cannot happen locally.
//   · lint and typecheck never look at build output.
//   · the app compiles, the build exits 0, the deploy succeeds, the HTML and CSS
//     are served correctly. Only the browser rejects it, at runtime, in prod.
//
// It is also the highest-severity failure shape this project has: a wrong hash
// takes down 100% of the app for 100% of users, and no amount of correct
// application code can survive it.
//
// WHAT IT CHECKS
//   1. sriPlugin.js hashes the bytes that actually ship (writeBundle, read from
//      disk) and re-verifies them after every other plugin has run (closeBundle).
//      Asserted against the source text, so it holds with or without a build.
//   2. The hazard that caused the original defect still exists in the installed
//      vite, so nobody "simplifies" the plugin back into transformIndexHtml.
//   3. If dist/ has been built: every declared digest is recomputed against the
//      file on disk and must match, and no /assets/ subresource may ship without
//      one.
//
// Run: node scripts/probe-sri-integrity.mjs

import crypto from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');

// Negative assertions run against source with comments stripped: this plugin
// documents the hook it moved away from, and a probe that fails because a file
// explains its own fix punishes the fix. The `[^:]` guard keeps `https://` out
// of the line-comment rule.
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

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

// Shared with sriPlugin.js by shape, not by import: the probe must be able to
// disagree with the plugin. A tag is a subresource when it carries both a
// src/href and, for our purposes, points under /assets/.
const TAG_RE = /<(script|link)\b([^>]*)>/g;
const URL_RE = /(?:href|src)=["']([^"']+)["']/;
const INTEGRITY_RE = /\sintegrity=["']([^"']+)["']/;
const ASSET_PREFIX = '/assets/';

// ── 1. the plugin hashes what ships ─────────────────────────────────────────
section('1. sriPlugin.js hashes the bytes that ship');

const pluginPath = 'sriPlugin.js';
check('sriPlugin.js exists', existsSync(path.join(ROOT, pluginPath)));

if (existsSync(path.join(ROOT, pluginPath))) {
  const raw = read(pluginPath);
  const src = stripComments(raw);

  check('the digest is computed in writeBundle, after rollup has written the files',
    /\bwriteBundle\s*\(/.test(src),
    'writeBundle is the earliest hook where the file on disk is the artifact the browser fetches');

  check('the digests are re-verified in closeBundle, after every plugin writeBundle',
    /\bcloseBundle\s*\(/.test(src),
    'without it, a plugin that rewrites an asset later re-creates the exact production defect');

  check('the hash is taken over bytes read back from disk',
    /readFileSync\s*\(/.test(src) && /createHash\s*\(\s*['"]sha384['"]\s*\)/.test(src),
    'hashing an in-memory bundle object is what shipped the stale hash');

  check('the rewritten index.html is written back to disk',
    /writeFileSync\s*\(/.test(src));

  // The regression this probe exists to prevent, stated as a negative.
  check('the plugin does NOT hash inside transformIndexHtml',
    !/transformIndexHtml/.test(src),
    'vite runs that hook from vite:build-html.generateBundle, BEFORE vite:build-import-analysis.generateBundle rewrites chunk.code');

  check('the plugin does NOT read chunk .code from the bundle object',
    !/\.code\b/.test(src) && !/ctx\.bundle/.test(src),
    'chunk.code is mutated after the html hooks run, so a hash taken from it is stale by construction');

  // A wrong hash is strictly worse than a missing hash: it takes the app down.
  // Every unexpected condition must therefore stop the build, not skip a tag.
  const throws = (src.match(/throw new Error/g) || []).length;
  check('unexpected conditions throw rather than silently skipping a tag',
    throws >= 4,
    `found ${throws} throw sites; expected at least 4 (no output dir, no html, missing asset, nothing injected)`);

  check('vite.config.js imports the plugin',
    /import\s+\w+\s+from\s+['"]\.\/sriPlugin\.js['"]/.test(stripComments(read('vite.config.js'))),
    'an SRI plugin that is not in the pipeline protects nothing');

  check('vite.config.js invokes the plugin in its plugins array',
    /\bsri\s*\(\s*\)/.test(stripComments(read('vite.config.js'))));
}

// ── 2. the hazard is still real in the installed vite ───────────────────────
section('2. the hazard that caused the defect still exists upstream');

// This is the "why" guard. The fix looks like an arbitrary hook choice unless
// you can see that vite really does rewrite chunk bytes after the html hooks.
// If a future vite removes the __VITE_PRELOAD__ substitution this check fails —
// which is the correct outcome: it means re-reading the pipeline before anyone
// simplifies the plugin.
const viteChunks = path.join(ROOT, 'node_modules', 'vite', 'dist', 'node', 'chunks');
if (existsSync(viteChunks)) {
  const files = readdirSync(viteChunks).filter((f) => f.endsWith('.js'));
  let marker = false;
  let mutation = false;
  for (const f of files) {
    const s = readFileSync(path.join(viteChunks, f), 'utf8');
    if (s.includes('__VITE_PRELOAD__')) marker = true;
    // vite:build-import-analysis.generateBundle: `chunk.code = s.toString();`
    if (/chunk\.code\s*=\s*s\.toString\(\)/.test(s)) mutation = true;
  }
  check('vite still emits a __VITE_PRELOAD__ marker into chunks with dynamic imports',
    marker,
    'if this is gone, re-read the plugin pipeline before changing sriPlugin.js');
  check('vite still rewrites chunk.code after the html hooks have run',
    mutation,
    'this assignment in vite:build-import-analysis.generateBundle is what invalidated the old hash');
} else {
  console.log('  SKIP  node_modules/vite not installed — upstream hazard not inspected');
}

// ── 3. the built artifact, if there is one ──────────────────────────────────
section('3. dist/index.html digests match the files on disk');

const distDir = path.join(ROOT, 'dist');
const distHtml = path.join(distDir, 'index.html');

if (!existsSync(distHtml)) {
  console.log('  SKIP  dist/index.html not present — run `npm run build` to gate the artifact too');
  console.log('        (the static contract in section 1 is what protects a clean checkout)');
} else {
  const html = readFileSync(distHtml, 'utf8');
  const subresources = [];

  for (const [, , attrs] of html.matchAll(TAG_RE)) {
    const url = URL_RE.exec(attrs)?.[1];
    if (!url || !url.startsWith(ASSET_PREFIX)) continue;
    subresources.push({ url, declared: INTEGRITY_RE.exec(attrs)?.[1] || null });
  }

  check('dist/index.html references at least one build asset',
    subresources.length > 0,
    `found ${subresources.length}`);

  for (const { url, declared } of subresources) {
    const assetPath = path.join(distDir, url.slice(1));

    if (!existsSync(assetPath)) {
      check(`${url} exists in dist/`, false, 'referenced but not emitted');
      continue;
    }

    if (!declared) {
      check(`${url} declares an integrity attribute`, false,
        'an unprotected subresource defeats the point of the CSP + SRI pair');
      continue;
    }

    const [algo, expected] = declared.split('-');
    if (!['sha256', 'sha384', 'sha512'].includes(algo)) {
      check(`${url} declares a digest algorithm a browser accepts`, false, `algo=${algo}`);
      continue;
    }

    const actual = crypto.createHash(algo).update(readFileSync(assetPath)).digest('base64');
    check(`${url} ${algo} digest matches the file on disk`,
      actual === expected,
      `declared ${expected.slice(0, 24)}… actual ${actual.slice(0, 24)}… — a browser BLOCKS this resource`);
  }
}

// ── Result ─────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`probe-sri-integrity: ${pass} passed, ${fail} failed`);
console.log(`\n${fail === 0 ? 'PASSED' : 'FAILED'}: ${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log(`  · ${f}`));
  process.exit(1);
}
