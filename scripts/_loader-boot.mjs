// Node --import bootstrap: registers the @/ alias resolver before ANY module
// loads, so harnesses with static `import ... from '@/lib/...'` work without
// their own register() call (which is too late for hoisted static imports).
//
// These harnesses run without a bundler/backend, so opt into the local
// (offline) auth shim — mirroring `npm run dev` with VITE_USE_LOCAL_AUTH=true.
process.env.VITE_USE_LOCAL_AUTH ??= 'true';

// Minimal DOM shims so the client module graph can be imported in plain Node
// (no bundler/jsdom). The app code only touches document.cookie for the
// CSRF cookie; we provide a no-op so module load does not crash.
if (typeof globalThis.document === 'undefined') {
  globalThis.document = { cookie: '' };
}

import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
register(new URL('./resolve-alias.mjs', import.meta.url));
