/**
 * Bound how long the UI waits without pretending the underlying promise was
 * cancelled. Optional late-settlement handlers repair side effects that finish
 * after the timeout (for example, an import that commits after its queue item
 * has already moved to the error state).
 */
export function withActionTimeout(promise, ms, message = "Operation timed out.", handlers = {}) {
  let timedOut = false;
  let timer = null;
  const observed = Promise.resolve(promise);

  const runLateHandler = (handler, value) => {
    if (typeof handler !== "function") return;
    Promise.resolve(handler(value)).catch((error) => {
      if (typeof handlers.onCleanupError === "function") {
        handlers.onCleanupError(error);
      } else {
        console.error("[actionTimeout] late-settlement cleanup failed:", error);
      }
    });
  };

  observed.then(
    (value) => {
      if (timedOut) runLateHandler(handlers.onLateResolve, value);
    },
    (error) => {
      if (timedOut) runLateHandler(handlers.onLateReject, error);
    }
  );

  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      const error = Object.assign(new Error(message), { code: "ACTION_TIMEOUT" });
      reject(error);
    }, ms);
  });

  return Promise.race([observed, timeout]).finally(() => {
    if (!timedOut && timer) clearTimeout(timer);
  });
}

/**
 * Compensate a create that becomes visible only after its caller timed out.
 * This is intentionally not a user-triggered destructive action: the user was
 * told the create failed, so retaining the late row would manufacture an
 * invisible duplicate. The entity proxy is injected to keep this helper generic.
 */
export async function compensateLateCreate(record, entityProxy) {
  if (record?.id == null) return false;
  if (typeof entityProxy?.delete !== "function") {
    throw new Error("Late-create compensation requires an entity delete function.");
  }
  await entityProxy.delete(record.id);
  return true;
}
