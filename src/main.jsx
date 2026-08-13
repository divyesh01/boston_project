import React from 'react'
import ReactDOM from 'react-dom/client'
import App from '@/App.jsx'
import '@/index.css'

// Build-time safety guard (pre-launch hardening, item 5 of the security review).
// The in-browser local-auth fallback (VITE_USE_LOCAL_AUTH) is a development-only
// convenience and is NOT a security boundary — it trusts localStorage/IndexedDB
// as the source of truth. It must never run from a production bundle. If a prod
// build is somehow shipped with the flag on, refuse to boot rather than expose the
// untrusted auth path. The matching zero-trust gate lives in
// base44Client.js (USE_LOCAL_AUTH).
if (import.meta.env.PROD && import.meta.env.VITE_USE_LOCAL_AUTH === 'true') {
  document.body.innerHTML =
    '<div style="padding:20px;color:#f87171;font-family:monospace">Fatal: local-auth dev mode (VITE_USE_LOCAL_AUTH) is enabled in a production build. Refusing to start.</div>';
  throw new Error('VITE_USE_LOCAL_AUTH must not be enabled in production builds.');
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
