
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
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          'chart-vendor': ['recharts'],
          'ui-vendor': ['lucide-react', 'framer-motion', 'clsx', 'tailwind-merge'],
          // No 'map-vendor' entry. It used to read ['leaflet', 'react-leaflet'],
          // which named `leaflet` — a package that is not declared in
          // package.json and exists in node_modules only because npm
          // auto-installs react-leaflet's peer. The one file that imports
          // react-leaflet (src/components/propertyMap.jsx) is imported by
          // nothing, so neither package is in the module graph and the chunk was
          // empty. manualChunks only groups modules, it never pulls them in, so
          // dropping it changes no output. If the map is ever wired up, run
          // `npm i leaflet@^1.9.4` first so the dependency is declared.
          'crdt-vendor': ['yjs', 'y-websocket'],
          'query-vendor': ['@tanstack/react-query'],
          'data-vendor': ['@base44/sdk', 'dexie', 'otplib'],
          'pdf-vendor': ['jspdf', 'html2canvas'],
        },
      },
    },
  },
})
