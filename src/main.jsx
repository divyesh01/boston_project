import React from 'react'
import ReactDOM from 'react-dom/client'
import App from '@/App.jsx'
import '@/index.css'

// Build-time safety guard (pre-launch hardening, item 5 of the security review).
// The in-browser local-auth fallback (VITE_USE_LOCAL_AUTH) trusts
// localStorage/IndexedDB as the source of truth, so on its own it is NOT a
// security boundary: the browser performs its own auth and MFA verification, and
// whoever controls the browser can bypass both.
//
// It is permitted in a production bundle for exactly one deployment shape - the
// STANDALONE build, where the app is served behind an upstream identity proxy
// (e.g. Cloudflare Access) that authenticates the request before this bundle is
// ever delivered. There the app's own login is a convenience lock over an
// IndexedDB the signed-in user already owns, and the real boundary sits at the
// edge. That shape must be declared on purpose, so it takes a SECOND flag: a
// stray production build with only VITE_USE_LOCAL_AUTH set still refuses to boot.
// NEVER set VITE_STANDALONE_LOCAL on a build that can be reached anonymously.
// The matching zero-trust gate lives in base44Client.js (USE_LOCAL_AUTH).
if (
  import.meta.env.PROD &&
  import.meta.env.VITE_USE_LOCAL_AUTH === 'true' &&
  import.meta.env.VITE_STANDALONE_LOCAL !== 'true'
) {
  document.body.innerHTML =
    '<div style="padding:20px;color:#f87171;font-family:monospace">Fatal: local-auth (VITE_USE_LOCAL_AUTH) is enabled in a production build without VITE_STANDALONE_LOCAL. Refusing to start.</div>';
  throw new Error('VITE_USE_LOCAL_AUTH in a production build requires VITE_STANDALONE_LOCAL=true (standalone deployment behind an identity proxy).');
}

// Global unhandled promise rejection guard (item E1 of the error‑handling review).
// Prevents unhandled rejections from silently falling through to console only.
window.addEventListener('unhandledrejection', (event) => {
  const error = event.reason;
  console.error('[unhandledrejection]', error);
  // Optional: surface critical errors via toast (uncomment to enable):
  // if (error?.message?.includes('Network error') || error?.message?.includes('failed')) {
  //   sonner.toast.error('Something went wrong. Please try again.');
}
);

const rootElement = document.getElementById('root');
if (!rootElement) {
  document.body.innerHTML = '<div style="padding:20px;color:red;font-family:monospace">Error: Root element (#root) not found in DOM</div>';
} else {
  ReactDOM.createRoot(rootElement).render(<App />);
}
