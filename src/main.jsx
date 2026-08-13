import React from 'react'
import ReactDOM from 'react-dom/client'
import App from '@/App.jsx'
import '@/index.css'

const rootElement = document.getElementById('root');
if (!rootElement) {
  document.body.innerHTML = '<div style="padding:20px;color:red;font-family:monospace">Error: Root element (#root) not found in DOM</div>';
} else {
  ReactDOM.createRoot(rootElement).render(<App />);
}
