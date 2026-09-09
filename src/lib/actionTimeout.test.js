import { describe, expect, it, vi } from "vitest";
import { compensateLateCreate, withActionTimeout } from "./actionTimeout";

describe("withActionTimeout", () => {
  it("returns an operation that finishes before the deadline", async () => {
    await expect(withActionTimeout(Promise.resolve("ok"), 100)).resolves.toBe("ok");
  });

  it("marks a timeout and repairs a promise that resolves later", async () => {
    vi.useFakeTimers();
    try {
      /** @type {(value: any) => void} */
      let resolveOperation = () => {};
      const operation = new Promise((resolve) => { resolveOperation = resolve; });
      const onLateResolve = vi.fn();
      const raced = withActionTimeout(operation, 50, "too slow", { onLateResolve });

      const rejection = expect(raced).rejects.toMatchObject({ message: "too slow", code: "ACTION_TIMEOUT" });
      await vi.advanceTimersByTimeAsync(50);
      await rejection;

      resolveOperation({ importId: "imp_late" });
      await Promise.resolve();
      await Promise.resolve();
      expect(onLateResolve).toHaveBeenCalledWith({ importId: "imp_late" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("observes a rejection that arrives after the timeout", async () => {
    vi.useFakeTimers();
    try {
      /** @type {(reason: any) => void} */
      let rejectOperation = () => {};
      const operation = new Promise((_, reject) => { rejectOperation = reject; });
      const onLateReject = vi.fn();
      const raced = withActionTimeout(operation, 50, "too slow", { onLateReject });

      const rejection = expect(raced).rejects.toMatchObject({ code: "ACTION_TIMEOUT" });
      await vi.advanceTimersByTimeAsync(50);
      await rejection;

      const lateError = Object.assign(new Error("late failure"), { importId: "imp_late" });
      rejectOperation(lateError);
      await Promise.resolve();
      await Promise.resolve();
      expect(onLateReject).toHaveBeenCalledWith(lateError);
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes a late-created record through the injected entity proxy", async () => {
    const entity = { delete: vi.fn().mockResolvedValue({ success: true }) };
    await expect(compensateLateCreate({ id: 42 }, entity)).resolves.toBe(true);
    expect(entity.delete).toHaveBeenCalledWith(42);
    await expect(compensateLateCreate(null, entity)).resolves.toBe(false);
  });
});
