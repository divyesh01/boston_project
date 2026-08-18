import "@testing-library/jest-dom/vitest";

// jsdom does not implement ResizeObserver, which Radix UI primitives (e.g. the
// Checkbox used on the Login page) rely on. Provide a no-op stub.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = globalThis.ResizeObserver || ResizeObserverStub;

// Polyfill WebCrypto and localStorage for Node/JSDOM test environments
if (!globalThis.crypto?.subtle) {
  import("node:crypto").then((m) => {
    globalThis.crypto = m.webcrypto;
  });
}

if (!globalThis.localStorage) {
  const __store = new Map();
  const __storage = {
    getItem: (k) => (__store.has(k) ? __store.get(k) : null),
    setItem: (k, v) => __store.set(k, String(v)),
    removeItem: (k) => __store.delete(k),
    clear: () => __store.clear(),
  };
  globalThis.localStorage = __storage;
  globalThis.sessionStorage = __storage;
}
