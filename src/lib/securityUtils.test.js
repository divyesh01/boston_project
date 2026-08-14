// @ts-nocheck
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";

// Pin Node WebCrypto like the other harness scripts (jsdom may lack subtle).
globalThis.crypto ??= await import("node:crypto").then((m) => m.webcrypto);
if (!globalThis.crypto?.subtle) globalThis.crypto = await import("node:crypto").then((m) => m.webcrypto);

const __store = new Map();
const __storage = {
  getItem: (k) => (__store.has(k) ? __store.get(k) : null),
  setItem: (k, v) => __store.set(k, String(v)),
  removeItem: (k) => __store.delete(k),
  clear: () => __store.clear(),
};
globalThis.localStorage = __storage;
globalThis.sessionStorage = __storage;
globalThis.window = globalThis;

const { secureStore, secureRetrieve } = await import("@/lib/securityUtils");

beforeEach(() => __store.clear());

describe("secureStore / secureRetrieve", () => {
  it("round-trips when IndexedDB is available", async () => {
    const ok = await secureStore("probe_idb", { value: 42 });
    expect(ok).toBe(true);
    const got = await secureRetrieve("probe_idb");
    expect(got).toEqual({ value: 42 });
  });

  it("round-trips even when IndexedDB is unavailable (fallback key)", async () => {
    // Simulate private-browsing / IndexedDB disabled: openCryptoDB must reject.
    const realIDB = globalThis.indexedDB;
    delete globalThis.indexedDB;
    try {
      const ok = await secureStore("probe_fallback", { value: 7 });
      expect(ok).toBe(true);
      const got = await secureRetrieve("probe_fallback");
      expect(got).toEqual({ value: 7 });
    } finally {
      globalThis.indexedDB = realIDB;
    }
  });
});