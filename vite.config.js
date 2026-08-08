
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import base44 from '@base44/vite-plugin'

// Security headers for production-like preview
const securityHeaders = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' https: wss:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none';",
}

// Dev-server headers: Vite injects an inline React refresh preamble, so
// 'unsafe-inline' is required for scripts in dev (kept strict in preview).
const devHeaders = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' https: wss: ws:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none';",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [
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
    headers: devHeaders,
    hmr: {
      overlay: false,
    },
  },
  preview: {
    headers: securityHeaders,
  },
  build: {
    rollupOptions: {
      output: {
        // Prevent caching of HTML for security updates
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]',
      },
    },
  },
})
