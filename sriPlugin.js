// Subresource Integrity for the built HTML.
//
// A browser refuses to execute a subresource whose `integrity` digest does not
// match the bytes it fetched. That makes a WRONG hash strictly worse than no
// hash at all: it does not degrade the page, it deletes the application. So
// every unexpected condition in here throws and fails the build rather than
// quietly skipping a tag.
//
// ── WHAT WENT WRONG, measured 2026-08-23 in production ─────────────────────
// The deployed site rendered a blank dark page. Chrome:
//
//   Failed to find a valid digest in the 'integrity' attribute for resource
//   '.../assets/index-Bbji4Ay-.js' with computed SHA-384 integrity
//   '/A9VxDX7DYJHnERJ0MqnPHp3xc7n6N4FENU6B6Q5tMrXs8E42YIRZGkQxjLT8rWg'.
//   The resource has been blocked.
//
// The blocked file was the ENTRY chunk — the module that mounts React — so
// nothing rendered. The stylesheet's digest was correct, which is why the page
// painted the dark background and then stopped. Recomputing every digest in
// dist/index.html reproduced it offline: entry chunk MISMATCH, five vendor
// chunks and the CSS MATCH.
//
// ── ROOT CAUSE: the hook this plugin used to run in ────────────────────────
// The previous version hashed `ctx.bundle[fileName].code` from inside
// `transformIndexHtml`. During a build, vite invokes every transformIndexHtml
// hook from `vite:build-html`'s generateBundle. Verified in the installed vite
// 6.4.3 (node_modules/vite/dist/node/chunks/dep-Dm0c1Wj2.js), resolvePlugins():
//
//   :42069   isBuild && buildHtmlPlugin(config)   <- runs our html hook here
//   :42075   ...postPlugins                      <- where enforce:'post' lands
//   :42076   ...buildPlugins.post  ->  :46131 buildImportAnalysisPlugin(config)
//
// and buildImportAnalysisPlugin's own generateBundle then does:
//
//   :45693   if (chunk.type === "chunk" && chunk.code.indexOf(preloadMarker) > -1)
//   :45868   chunk.code = s.toString();
//
// substituting the real preload dependency array for the `__VITE_PRELOAD__`
// marker. The chunk bytes were therefore rewritten AFTER we hashed them. Only
// chunks containing that marker are touched — i.e. only chunks with dynamic
// imports — which is exactly why the entry chunk, the one that lazy-loads the
// pages, was the single mismatch while the static vendor chunks were fine.
//
// `enforce: 'post'` does not help: it orders this hook among other HTML hooks,
// not against another plugin's generateBundle.
//
// ── THE FIX: hash the bytes that actually ship ─────────────────────────────
// `writeBundle` runs after rollup has written every file, so the file on disk
// IS the artifact the browser will fetch. Nothing downstream can invalidate a
// digest taken there. `closeBundle` then runs after EVERY plugin's writeBundle
// and re-verifies each digest against disk, so if anything rewrites an asset
// later the build fails instead of shipping another blank page.
//
// Gated by scripts/probe-sri-integrity.mjs.

import crypto from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const sha384 = (bytes) =>
  `sha384-${crypto.createHash('sha384').update(bytes).digest('base64')}`;

// Vite emits absolute URLs under `base`, which is '/' here, so build assets
// appear as `/assets/<name>-<hash>.<ext>`. If that ever stops matching — a
// `base` change, a relative-base build — `injected` stays 0 and the build
// throws, rather than silently shipping every subresource unprotected.
const TAG_RE = /<(script|link)\b([^>]*)>/g;
const URL_RE = /(?:href|src)=["']([^"']+)["']/;
const DECLARED_RE = /\sintegrity=["']([^"']+)["']/;
const STRIP_INTEGRITY_RE = /\s+integrity=["'][^"']*["']/g;
const ASSET_PREFIX = '/assets/';

export default function simpleSriPlugin() {
  // Populated by writeBundle, re-checked and cleared by closeBundle. Kept per
  // plugin instance so a watch-mode rebuild starts from an empty list.
  const stamped = [];

  return {
    name: 'simple-sri',
    enforce: 'post',
    apply: 'build',

    writeBundle(options, bundle) {
      const outDir = options.dir;
      if (!outDir) {
        throw new Error(
          '[simple-sri] rollup output.dir is not set, so the emitted assets cannot be located on disk to hash',
        );
      }

      const htmlFiles = Object.keys(bundle).filter((f) => f.endsWith('.html'));
      if (htmlFiles.length === 0) {
        throw new Error(
          '[simple-sri] the bundle emitted no .html file, so no integrity attribute could be written',
        );
      }

      for (const htmlFile of htmlFiles) {
        const htmlPath = path.join(outDir, htmlFile);
        let injected = 0;

        const html = readFileSync(htmlPath, 'utf8').replace(TAG_RE, (tag, name, attrs) => {
          const url = URL_RE.exec(attrs)?.[1];
          if (!url || !url.startsWith(ASSET_PREFIX)) return tag;

          const assetPath = path.join(outDir, url.slice(1));
          if (!existsSync(assetPath)) {
            throw new Error(
              `[simple-sri] ${htmlFile} references ${url} but ${assetPath} was not written; refusing to ship an unhashed subresource`,
            );
          }

          injected += 1;
          // Hash the file, not the bundle object. Strip any pre-existing
          // integrity so a re-run is idempotent instead of emitting two.
          return `<${name}${attrs.replace(STRIP_INTEGRITY_RE, '')} integrity="${sha384(readFileSync(assetPath))}">`;
        });

        if (injected === 0) {
          throw new Error(
            `[simple-sri] no <script>/<link> in ${htmlFile} pointed at ${ASSET_PREFIX}; every subresource would ship without an integrity digest`,
          );
        }

        writeFileSync(htmlPath, html);
        stamped.push({ htmlFile, htmlPath, outDir, injected });
      }
    },

    // Runs after every plugin's writeBundle. This is the part that makes the
    // build self-verifying: a stale digest cannot reach a deploy, because the
    // build that would produce it fails here.
    closeBundle() {
      const bad = [];

      for (const { htmlFile, htmlPath, outDir, injected } of stamped) {
        const html = readFileSync(htmlPath, 'utf8');
        let verified = 0;

        for (const [, , attrs] of html.matchAll(TAG_RE)) {
          const url = URL_RE.exec(attrs)?.[1];
          const declared = DECLARED_RE.exec(attrs)?.[1];
          if (!url || !url.startsWith(ASSET_PREFIX) || !declared) continue;

          verified += 1;
          const actual = sha384(readFileSync(path.join(outDir, url.slice(1))));
          if (actual !== declared) {
            bad.push(`${htmlFile} ${url}: declared ${declared}, on disk ${actual}`);
          }
        }

        if (verified !== injected) {
          bad.push(
            `${htmlFile}: wrote ${injected} integrity digests but ${verified} survived to disk`,
          );
        }
      }

      stamped.length = 0;

      if (bad.length > 0) {
        throw new Error(
          `[simple-sri] the shipped digests do not match the shipped files, so a browser would block them:\n  ${bad.join('\n  ')}`,
        );
      }
    },
  };
}
