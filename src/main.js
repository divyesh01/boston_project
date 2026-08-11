import { jsx as _jsx } from "react/jsx-runtime";
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from '@/App.jsx';
import '@/index.css';
// Global error handlers for debugging blank screen
window.addEventListener('error', (e) => {
    console.error('[Global Error]', e.error || e.message, e.filename, e.lineno, e.colno);
});
window.addEventListener('unhandledrejection', (e) => {
    console.error('[Unhandled Rejection]', e.reason);
});
// Diagnostic: Log when main.jsx executes
console.log('[main.jsx] Starting app initialization...');
const rootElement = document.getElementById('root');
if (!rootElement) {
    console.error('[main.jsx] Root element not found!');
    document.body.innerHTML = '<div style="padding:20px;color:red;font-family:monospace">Error: Root element (#root) not found in DOM</div>';
}
else {
    console.log('[main.jsx] Root element found, rendering App...');
    ReactDOM.createRoot(rootElement).render(_jsx(App, {}));
    console.log('[main.jsx] App rendered successfully');
}
