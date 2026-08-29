import fs from 'fs';
import path from 'path';

const classifications = [
  {
    category: "BUILD DEPENDENCY",
    items: [
      { file: "package.json", symbol: "@base44/vite-plugin", purpose: "Vite HMR notifier and visual edit plugin", whatBreaksRemoved: "Vite build/dev configuration plugins fail to load", whatBreaksRenamed: "npm cannot resolve package", replacement: "Standard @vitejs/plugin-react", difficulty: "Low", risk: "Low", action: "Retain until independence migration or replace with standard Vite plugins" },
      { file: "vite.config.js", symbol: "base44() plugin", purpose: "Configures Base44 dev/build plugins and CSP headers", whatBreaksRemoved: "None if replaced with standard config", whatBreaksRenamed: "Syntax error in vite config", replacement: "Standard vite plugins", difficulty: "Low", risk: "Low", action: "Keep during branding, remove in Plan C" }
    ]
  },
  {
    category: "RUNTIME DEPENDENCY",
    items: [
      { file: "package.json", symbol: "@base44/sdk", purpose: "Base44 client creation and backend function invocation", whatBreaksRemoved: "src/api/base44Client.js createClient import fails, breaking production function calls", whatBreaksRenamed: "npm module resolution fails", replacement: "Custom lightweight fetch/axios client for backend REST/RPC", difficulty: "Medium", risk: "Medium", action: "Wrap behind neutral client" },
      { file: "src/api/base44Client.js", symbol: "createClient from @base44/sdk", purpose: "Instantiates realClient for invoking cloud backend functions", whatBreaksRemoved: "Production cloud function invocation (custom_auth_*, audit_*) fails", whatBreaksRenamed: "Import error", replacement: "Native fetch client pointing to custom server", difficulty: "Medium", risk: "Medium", action: "Keep inside local wrapper" }
    ]
  },
  {
    category: "INTERNAL WRAPPER NAME ONLY",
    items: [
      { file: "src/api/base44Client.js", symbol: "base44Client.js filename & export const base44", purpose: "Primary application data and function access facade", whatBreaksRemoved: "Breaks 73 static and dynamic import sites across entire app", whatBreaksRenamed: "Breaks imports if not re-exported via compatibility shim", replacement: "src/api/appClient.js with base44Client.js as backward-compatible re-export", difficulty: "Low (with shim)", risk: "Zero with shim / High without", action: "Create appClient.js and re-export for 100% safety" },
      { file: "src/api/base44Client.js", symbol: "export const base44 = db", purpose: "Legacy SDK export alias", whatBreaksRemoved: "Any caller expecting `import { base44 }`", whatBreaksRenamed: "Named import breaks", replacement: "export { db, db as appClient }", difficulty: "Low", risk: "Low", action: "Retain export alias" }
    ]
  },
  {
    category: "AUTH DEPENDENCY",
    items: [
      { file: "base44/functions/custom_auth_*", symbol: "custom_auth_login, me, logout, register, reset", purpose: "Server-side password hashing, MFA verification, and HttpOnly session cookies", whatBreaksRemoved: "Production user authentication and session management", whatBreaksRenamed: "Function invoke names mismatch in backend", replacement: "Self-hosted Node/Express/Fastify auth service or standalone Deno functions", difficulty: "High", risk: "High", action: "Keep deployed functions in Base44 or migrate to standalone server" },
      { file: "src/api/base44Client.js", symbol: "refuseUrlSuppliedAccessToken", purpose: "Strips base44_access_token from URL/localStorage to prevent token injection", whatBreaksRemoved: "Removes guard against legacy bearer token injection", whatBreaksRenamed: "Nothing", replacement: "Neutral token sanitization function", difficulty: "Low", risk: "Zero", action: "Keep security guard intact" }
    ]
  },
  {
    category: "DATABASE DEPENDENCY",
    items: [
      { file: "base44/entities/*.jsonc", symbol: "16 entity JSONC schemas", purpose: "Defines database entity structure and sync with Base44 cloud backend", whatBreaksRemoved: "Base44 CLI deployment and cloud schema sync", whatBreaksRenamed: "Schema drift between local Dexie and Base44", replacement: "JSON Schema / Prisma / Drizzle / Dexie schema files", difficulty: "Medium", risk: "Medium", action: "Maintain for Base44 deployment or convert to Prisma/Drizzle in Plan C" }
    ]
  },
  {
    category: "REMOTE SERVICE DEPENDENCY",
    items: [
      { file: "src/api/base44Client.js", symbol: "PRODUCTION_APP_ID (6a7d6856ee1cc714b1803c0e)", purpose: "Tenant identification header (X-App-Id) for cloud functions", whatBreaksRemoved: "All production cloud function requests rejected (HTTP 401/403)", whatBreaksRenamed: "Tenant mismatch with deployed backend", replacement: "Custom API key or tenant ID header", difficulty: "Low", risk: "High in production", action: "Do not delete without backend replacement" },
      { file: "base44/.app.jsonc", symbol: "app id configuration", purpose: "Links CLI deployments to Base44 app instance", whatBreaksRemoved: "CLI deployment fails", whatBreaksRenamed: "Deployment fails", replacement: "Custom deployment configuration", difficulty: "Low", risk: "High for CLI", action: "Keep while using Base44 CLI" },
      { file: "vite.config.js / vercel.json", symbol: "connect-src https://base44.app https://*.base44.app", purpose: "CSP allowlist for Base44 API and serverless functions", whatBreaksRemoved: "Browser blocks API calls in production due to CSP violation", whatBreaksRenamed: "CSP violation", replacement: "Allowlist for new backend domain", difficulty: "Low", risk: "High in production", action: "Keep until API domain changes" }
    ]
  },
  {
    category: "SAFE TO RENAME",
    items: [
      { file: "src/lib/app-params.js", symbol: "base44_${toSnakeCase(paramName)}", purpose: "Prefix for URL parameter storage keys", whatBreaksRemoved: "Parameter caching", whatBreaksRenamed: "Past cached parameters reset (harmless)", replacement: "app_${toSnakeCase(paramName)}", difficulty: "Low", risk: "Zero", action: "Safe to rename" }
    ]
  },
  {
    category: "SAFE TO REMOVE",
    items: [
      { file: "src/api/base44Client.js", symbol: "console.warn('[base44Client] ...')", purpose: "Internal debug logging strings", whatBreaksRemoved: "Nothing", whatBreaksRenamed: "Nothing", replacement: "console.warn('[AppClient] ...')", difficulty: "Low", risk: "Zero", action: "Safe to clean up" }
    ]
  }
];

console.log(JSON.stringify(classifications, null, 2));
