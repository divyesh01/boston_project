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
//
// IMPORTANT: these shims must stay INTERNALLY CONSISTENT. axios computes
//   hasBrowserEnv = typeof window !== 'undefined' && typeof document !== 'undefined'
//   const origin  = (hasBrowserEnv && window.location.href) || 'http://localhost'
// Every harness sets `globalThis.window = globalThis`, so defining `document`
// here flips hasBrowserEnv true and axios then dereferences window.location.href.
// If `location` is missing that throws
//   TypeError: Cannot read properties of undefined (reading 'href')
// at axios/lib/platform/common/utils.js:44, killing every suite before its
// first check. So whenever we claim to be a browser, also provide the globals a
// browser would have: location, plus no-op event listeners that
// @base44/sdk/dist/modules/analytics.js expects on window.
if (typeof globalThis.document === 'undefined') {
  globalThis.document = { cookie: '' };
}
if (typeof globalThis.location === 'undefined') {
  globalThis.location = {
    href: 'http://localhost/',
    origin: 'http://localhost',
    protocol: 'http:',
    host: 'localhost',
    hostname: 'localhost',
    port: '',
    pathname: '/',
    search: '',
    hash: '',
  };
}
if (typeof globalThis.addEventListener === 'undefined') {
  globalThis.addEventListener = () => {};
}
if (typeof globalThis.removeEventListener === 'undefined') {
  globalThis.removeEventListener = () => {};
}

// Web Worker shim. `csvParser.fetchCsvRows` offloads parsing to
// `src/lib/parser.worker.js` via `new Worker(new URL(...), {type:'module'})`.
// Node 22 has no global `Worker` (only node:worker_threads), so every suite that
// reaches the real fetch->parse path dies with `ReferenceError: Worker is not
// defined`.
//
// Rather than reimplement the parse (which would test harness code instead of
// production code), run the ACTUAL worker module in-process. parser.worker.js
// talks to `self.onmessage`/`self.postMessage` and its handler is fully
// synchronous, so a same-thread bridge is behaviourally equivalent — we lose
// only the off-main-thread property, which no assertion depends on.
//
// Limitation: `self.onmessage` is a single global slot, so this supports one
// worker script at a time. The repo has exactly one (parser.worker.js).
if (typeof globalThis.Worker === 'undefined') {
  if (typeof globalThis.self === 'undefined') globalThis.self = globalThis;
  let sink = null;
  globalThis.postMessage = (msg) => { if (sink) sink(msg); };
  const loaded = new Map();

  globalThis.Worker = class HarnessWorker {
    constructor(scriptUrl) {
      this._url = String(scriptUrl);
      this.onmessage = null;
      this.onerror = null;
    }

    postMessage(data) {
      if (!loaded.has(this._url)) loaded.set(this._url, import(this._url));
      loaded.get(this._url).then(() => {
        const handler = globalThis.self.onmessage;
        if (typeof handler !== 'function') {
          throw new Error(`harness Worker: ${this._url} never assigned self.onmessage`);
        }
        // Point postMessage at THIS instance for the duration of the (sync) call.
        sink = (msg) => { if (this.onmessage) this.onmessage({ data: msg }); };
        try { handler({ data }); } finally { sink = null; }
      }).catch((err) => {
        if (this.onerror) this.onerror(err);
        else throw err;
      });
    }

    terminate() {}
    addEventListener() {}
    removeEventListener() {}
  };
}

import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
register(new URL('./resolve-alias.mjs', import.meta.url));
