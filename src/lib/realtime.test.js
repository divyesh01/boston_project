import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { queryClientInstance } from "./query-client.js";

vi.mock("./query-client.js", () => ({
  queryClientInstance: {
    invalidateQueries: vi.fn().mockResolvedValue(undefined),
  },
}));

class MockBroadcastChannel {
  static instances = new Set();

  constructor(name) {
    this.name = name;
    this.onmessage = null;
    this.listeners = new Set();
    MockBroadcastChannel.instances.add(this);
  }

  postMessage(data) {
    for (const ch of MockBroadcastChannel.instances) {
      if (ch !== this && ch.name === this.name) {
        if (ch.onmessage) {
          ch.onmessage({ data });
        }
        for (const listener of ch.listeners) {
          listener({ data });
        }
      }
    }
  }

  addEventListener(type, fn) {
    if (type === "message") {
      this.listeners.add(fn);
    }
  }

  removeEventListener(type, fn) {
    if (type === "message") {
      this.listeners.delete(fn);
    }
  }

  close() {
    MockBroadcastChannel.instances.delete(this);
  }
}

describe("realtime module", () => {
  const originalBC = global.BroadcastChannel;
  // vi.mock typing keeps the real TanStack signature: reach the mock
  // state through one explicitly-any alias (repo /** @type {any} */ idiom).
  const invalidateMock = /** @type {any} */ (queryClientInstance.invalidateQueries);

  beforeEach(() => {
    vi.resetModules();
    MockBroadcastChannel.instances.clear();
    global.BroadcastChannel = /** @type {any} */ (MockBroadcastChannel);
    localStorage.clear();
    invalidateMock.mockReset();
    invalidateMock.mockResolvedValue(undefined);
    Object.defineProperty(document, "hidden", { value: false, writable: true, configurable: true });
  });

  afterEach(() => {
    global.BroadcastChannel = originalBC;
    vi.clearAllTimers();
  });

  it("guards subscriber BroadcastChannel constructor and falls back to storage when it throws", async () => {
    class ThrowingBroadcastChannel {
      constructor() {
        throw new Error("BroadcastChannel is disabled or unsupported");
      }
    }
    global.BroadcastChannel = /** @type {any} */ (ThrowingBroadcastChannel);

    const { useRealtimeInvalidation, FALLBACK_KEY } = await import("./realtime.js");

    const { unmount } = renderHook(() =>
      useRealtimeInvalidation(["rooms"], { enabled: true })
    );

    const changeData = {
      id: "err-test-id",
      type: "ENTITY_CHANGE",
      table: "rooms",
      change: "update",
      record: { id: 101 },
    };

    const storageEvent = typeof StorageEvent !== "undefined"
      ? new StorageEvent("storage", { key: FALLBACK_KEY, newValue: JSON.stringify(changeData) })
      : Object.assign(new Event("storage"), { key: FALLBACK_KEY, newValue: JSON.stringify(changeData) });

    window.dispatchEvent(storageEvent);

    expect(queryClientInstance.invalidateQueries).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ["rooms"] }),
      expect.objectContaining({ throwOnError: true })
    );

    unmount();
  });

  it("deduplicates messages delivered via both BroadcastChannel and storage", async () => {
    const { publishChange, subscribeChanges, FALLBACK_KEY } = await import("./realtime.js");

    const handler = vi.fn();
    const unsub = subscribeChanges(handler);

    publishChange("rooms", "update", { id: 202 });

    const storedValue = localStorage.getItem(FALLBACK_KEY);
    expect(storedValue).toBeTruthy();

    const storageEvent = typeof StorageEvent !== "undefined"
      ? new StorageEvent("storage", { key: FALLBACK_KEY, newValue: storedValue })
      : Object.assign(new Event("storage"), { key: FALLBACK_KEY, newValue: storedValue });

    window.dispatchEvent(storageEvent);

    expect(handler).toHaveBeenCalledTimes(1);
    unsub();
  });

  it("immediately invalidates queries when page transitions from hidden to visible", async () => {
    Object.defineProperty(document, "hidden", { value: true, writable: true, configurable: true });

    const { useRealtimeInvalidation, DEFAULT_POLL_MS } = await import("./realtime.js");

    const { unmount } = renderHook(() =>
      useRealtimeInvalidation(["rooms"], { enabled: true, pollMs: DEFAULT_POLL_MS })
    );

    invalidateMock.mockClear();

    Object.defineProperty(document, "hidden", { value: false, writable: true, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));

    expect(queryClientInstance.invalidateQueries).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ["rooms"] }),
      expect.objectContaining({ throwOnError: true })
    );

    unmount();
  });

  it("shares one poll timer across mounted hooks with no duplicate invalidations", async () => {
    vi.useFakeTimers();

    Object.defineProperty(document, "hidden", { value: false, writable: true, configurable: true });

    const { useRealtimeInvalidation } = await import("./realtime.js");

    invalidateMock.mockReset();
    invalidateMock.mockResolvedValue(undefined);

    const first = renderHook(() =>
      useRealtimeInvalidation(["rooms"], { enabled: true, pollMs: 10000 })
    );
    const second = renderHook(() =>
      useRealtimeInvalidation(["rooms", "staff"], { enabled: true, pollMs: 10000 })
    );

    await vi.advanceTimersByTimeAsync(10000);

    const roomsCalls = invalidateMock.mock.calls.filter(
      ([filter]) => JSON.stringify(filter?.queryKey) === JSON.stringify(["rooms"])
    );
    const staffCalls = invalidateMock.mock.calls.filter(
      ([filter]) => JSON.stringify(filter?.queryKey) === JSON.stringify(["staff"])
    );
    expect(roomsCalls.length).toBe(1);
    expect(staffCalls.length).toBe(1);

    second.unmount();
    invalidateMock.mockClear();
    await vi.advanceTimersByTimeAsync(10000);
    expect(queryClientInstance.invalidateQueries).toHaveBeenCalledTimes(1);

    first.unmount();
    invalidateMock.mockClear();
    await vi.advanceTimersByTimeAsync(30000);
    expect(queryClientInstance.invalidateQueries).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("applies exponential backoff on 5xx QueryObserver errors using throwOnError:true", async () => {
    vi.useFakeTimers();

    Object.defineProperty(document, "hidden", { value: false, writable: true, configurable: true });

    const { useRealtimeInvalidation } = await import("./realtime.js");

    invalidateMock.mockReset();
    invalidateMock.mockRejectedValue(new Error("500 Internal Server Error"));

    const { unmount } = renderHook(() =>
      useRealtimeInvalidation(["rooms"], { enabled: true, pollMs: 10000 })
    );

    const initialCalls = invalidateMock.mock.calls.length;

    await vi.advanceTimersByTimeAsync(20000);

    expect(invalidateMock.mock.calls.length).toBe(initialCalls + 1);
    // throwOnError is an invalidate OPTIONS key, not a filter key.
    expect(queryClientInstance.invalidateQueries).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ["rooms"] }),
      expect.objectContaining({ throwOnError: true })
    );

    unmount();
    vi.useRealTimers();
  });
});

