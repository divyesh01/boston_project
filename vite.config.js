
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import base44 from '@base44/vite-plugin'
import sri from './sriPlugin.js'

// Security headers for production-like preview.
//
// This must stay in step with vercel.json, which is what real users get. Two
// directives here are load-bearing rather than decorative:
//   · connect-src blob: — UploadFile() hands the parser a blob: URL
//     (base44Client.js:1200) and csvParser.js / DataIntelligence.jsx fetch() it.
//     'self' does not cover blob:, so without this every CSV import fails.
//   · worker-src blob: — the CSV parser runs in a module Worker.
const CSP_PROD = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob: https:; connect-src 'self' blob: https://base44.app https://*.base44.app; worker-src 'self' blob:; manifest-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none';"

const securityHeaders = {
  'Content-Security-Policy': CSP_PROD,
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
}

// Dev-server headers: Vite injects an inline React refresh preamble, so
// 'unsafe-inline' is required for scripts in dev (kept strict in preview), and
// HMR needs a plain ws: socket to 127.0.0.1.
const devHeaders = {
  ...securityHeaders,
  'Content-Security-Policy': CSP_PROD
    .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
    .replace("connect-src 'self' blob:", "connect-src 'self' blob: ws: wss:"),
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    sri(),
    base44({
      legacySDKImports: process.env.BASE44_LEGACY_SDK_IMPORTS === 'true',
      hmrNotifier: true,
      navigationNotifier: true,
      analyticsTracker: true,
      visualEditAgent: true
    }),
    react(),
  ],
  server: {
    host: '127.0.0.1',
    headers: devHeaders,
    hmr: {
      overlay: false,
    },
  },
  preview: {
    headers: securityHeaders,
  },
  // Keep debug chatter out of the shipped bundle.
  //
  // `pure` marks these calls as side-effect-free, so the minifier removes them
  // from a production build while `vite dev` — which does not minify — still
  // prints everything. That is the reason for `pure` rather than
  // `drop: ['console']`: drop is unconditional and would also take
  // console.warn and console.error, which are how an operator or whoever is
  // helping them finds out that an import was rejected or a save failed. Tests
  // are unaffected either way; vitest.config.js is a separate config.
  //
  // Two call sites had to change before this was safe, because a stripped call
  // is a *removed* call: SendEmail (base44Client.js) and fireAlert
  // (alertEngine.js) had console.log as their only side effect, and are now at
  // warn level. Every remaining console.log argument is a plain string or a
  // template literal over identifiers — no function calls — so removal cannot
  // discard work. scripts/probe-deploy-config.mjs re-checks both properties.
  esbuild: {
    pure: ['console.log', 'console.debug', 'console.info'],
    drop: ['debugger'],
  },
  build: {
    rollupOptions: {
      output: {
        // Prevent caching of HTML for security updates
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]',
        // Vendor chunks are assigned by PACKAGE DIRECTORY, and the two shared
        // virtual helper modules are pinned explicitly. This replaced the object
        // form ('react-vendor': ['react', 'react-dom', 'react-router-dom'], and
        // so on), which was measured mis-assigning three things in the build of
        // 2026-08-23. scripts/probe-build-chunks.mjs now gates all of it by
        // reading the emitted graph in dist/:
        //
        //   · Vite's ~2 kB __vitePreload helper landed in pdf-vendor. The entry
        //     chunk lazy-loads every route, so it had to import that helper, and
        //     all 594,722 bytes of jspdf + html2canvas came with it into
        //     index.html's modulepreload list — 34% of a 1,728,124-byte
        //     first-paint payload, for a library no first paint uses.
        //   · react's own CJS module landed in ui-vendor (which is why ui-vendor
        //     exported requireReact) while react/jsx-runtime landed in
        //     query-vendor, so the two chunks imported each other. That was the
        //     "Circular chunk: query-vendor -> ui-vendor -> query-vendor" warning.
        //   · react-vendor, chart-vendor and data-vendor all imported ui-vendor
        //     for the commonjs interop helpers, so no vendor chunk could be
        //     cached independently of the icon library.
        //
        // One root cause behind all three: the object form resolves each listed
        // string to that package's ENTRY module and walks static dependencies
        // from there. React is CJS, so its real code lives behind ids carrying
        // ?commonjs-* suffixes; react/jsx-runtime is a second entry point that no
        // walk from react/index.js ever reaches; and rollup's virtual modules are
        // not packages, so they cannot be named in that form at all. Everything
        // the walk misses is placed by rollup's automatic algorithm, wherever it
        // happens to land. Matching on the package directory inside the id covers
        // the suffixed ids and the secondary entry points, because both still
        // live under node_modules/<pkg>/.
        //
        // There is deliberately no 'map-vendor' case. It used to read
        // ['leaflet', 'react-leaflet'] and the chunk was always empty: the only
        // file importing react-leaflet (src/components/propertyMap.jsx) is
        // imported by nothing, so neither package is in the module graph.
        // manualChunks only groups modules that are already there — it never
        // pulls them in — so dropping it changes no output. Restore it if the map
        // is ever wired up. (An earlier version of this comment claimed leaflet
        // was undeclared and present only as react-leaflet's auto-installed peer.
        // That was wrong: package.json declares leaflet ^1.9.4, react-leaflet
        // ^4.2.1 and @types/leaflet ^1.9.22. Nothing needs installing.)
        manualChunks(id) {
          const norm = id.split('\\').join('/');

          // Rollup's commonjs interop helpers and Vite's preload helper. Both are
          // leaves — they import nothing — and nearly every chunk needs them,
          // which is exactly why leaving them unassigned dragged a lazy 594 kB
          // chunk into the entry. react-vendor is the correct home because every
          // member listed below depends only on other members (react-dom ->
          // scheduler, react-router-dom -> react-router -> cookie and
          // set-cookie-parser), making that chunk a sink in the import graph: it
          // imports no other chunk, so nothing it exports can complete a cycle.
          if (norm.includes('vite/preload-helper') || norm.includes('commonjsHelpers')) {
            return 'react-vendor';
          }

          // Greedy prefix, so a nested copy is attributed to the package that
          // actually contains it rather than to the outermost one. Scoped names
          // keep both segments. The classes stop at ? and # so query-suffixed
          // ids match too.
          const pkg = /^.*\/node_modules\/(@[^/]+\/[^/?#]+|[^/?#]+)/.exec(norm)?.[1];
          if (!pkg) return; // application code — leave route-level splitting alone

          switch (pkg) {
            case 'react':
            case 'react-dom':
            case 'scheduler':
            case 'react-router':
            case 'react-router-dom':
            case 'cookie':
            case 'set-cookie-parser':
              return 'react-vendor';
            case 'recharts':
              return 'chart-vendor';
            case 'lucide-react':
            case 'framer-motion':
            case 'clsx':
            case 'tailwind-merge':
              return 'ui-vendor';
            case 'yjs':
            case 'y-websocket':
              return 'crdt-vendor';
            case '@tanstack/react-query':
              return 'query-vendor';
            case '@base44/sdk':
            case 'dexie':
            case 'otplib':
              return 'data-vendor';
            case 'jspdf':
            case 'html2canvas':
              return 'pdf-vendor';
            default:
              return; // rollup groups the rest by which chunks reach them
          }
        },
      },
    },
  },
})
