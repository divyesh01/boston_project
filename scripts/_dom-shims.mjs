// One place that makes plain Node look enough like a browser to import the app's
// client modules.
//
// WHY THIS FILE EXISTS — the same bug, twice, for the same reason.
//
// axios decides whether it is running in a browser like this
// (node_modules/axios/lib/platform/common/utils.js):
//
//     hasBrowserEnv = typeof window !== 'undefined' && typeof document !== 'undefined'
//     const origin  = (hasBrowserEnv && window.location.href) || 'http://localhost'
//
// Every harness in this repo sets `globalThis.window = globalThis` so the app's
// modules can load. The moment one of them ALSO defines `document`, axios concludes
// it is in a browser and reads `window.location.href` — and if `location` was not
// defined too, that throws
//
//     TypeError: Cannot read properties of undefined (reading 'href')
//
// at module-load time. Not in a test: during the import of src/api/base44Client.js.
// So the suite dies before its first assertion, which reads as "the app is broken"
// rather than "the harness is inconsistent".
//
// This happened in scripts/_loader-boot.mjs (recorded as B11 in
// LAUNCH_READINESS_CHECKLIST.md) and was fixed there. Then it happened AGAIN in
// scripts/acceptance-harness.mjs, because that harness predates the shared
// bootstrap and shimmed the DOM itself — two copies of the same delicate rule, one
// of them fixed. The same duplication also cost that harness the `Worker` shim, so
// after the axios crash was fixed it died on `ReferenceError: Worker is not
// defined` instead.
//
// So the rule now lives once, here, and both call it. The invariant it enforces:
//
//     IF YOU CLAIM TO BE A BROWSER, PROVIDE WHAT A BROWSER PROVIDES.
//     window + document + location + event listeners, together, or none of them.
//
// scripts/probe-harness-shims.mjs fails if any harness defines `document` without
// going through this module.
//
// It is written to MERGE rather than overwrite, because callers legitimately need
// their own extras — acceptance-harness needs `document.createElement` for the
// export path, others only need `document.cookie` for CSRF. Anything a caller has
// already set is left exactly as it is.

/**
 * Install the browser globals the app's client modules need, without clobbering
 * anything the caller has already defined.
 *
 * @param {{ userAgent?: string }} [opts]
 */
export function installDomShims({ userAgent = 'harness' } = {}) {
  // window must be the global object itself, so `window.foo = 1` and `foo` are the
  // same binding — a separate object would silently split state.
  if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;

  if (typeof globalThis.navigator === 'undefined') {
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent, language: 'en-US' },
      configurable: true,
    });
  }

  // document: create it if absent, and top up the one property the app actually
  // reads (cookie, for the CSRF token) if a caller built a partial one.
  if (typeof globalThis.document === 'undefined') {
    globalThis.document = { cookie: '' };
  } else if (!('cookie' in globalThis.document)) {
    globalThis.document.cookie = '';
  }

  // location: REQUIRED whenever document exists. See the axios note above.
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

  // @base44/sdk/dist/modules/analytics.js registers listeners on window.
  if (typeof globalThis.addEventListener === 'undefined') globalThis.addEventListener = () => {};
  if (typeof globalThis.removeEventListener === 'undefined') globalThis.removeEventListener = () => {};

  installWorkerShim();
}

/**
 * Web Worker shim.
 *
 * `csvParser.fetchCsvRows` offloads parsing to `src/lib/parser.worker.js` via
 * `new Worker(new URL(...), { type: 'module' })`. Node has no global `Worker` (only
 * node:worker_threads), so every suite that reaches the real fetch→parse path dies
 * with `ReferenceError: Worker is not defined`.
 *
 * Rather than reimplement the parse — which would test harness code instead of
 * production code — this runs the ACTUAL worker module in-process.
 * parser.worker.js talks to `self.onmessage` / `self.postMessage` and its handler
 * is fully synchronous, so a same-thread bridge is behaviourally equivalent; the
 * only property lost is running off the main thread, which no assertion depends on.
 *
 * Limitation, stated rather than hidden: `self.onmessage` is a single global slot,
 * so this supports one worker script at a time. The repo has exactly one.
 */
export function installWorkerShim() {
  if (typeof globalThis.Worker !== 'undefined') return;

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

export default installDomShims;
