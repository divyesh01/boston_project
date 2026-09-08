// Reactive settings store. Bump the version whenever commission / CC / tax rates
// are saved so dependent widgets (Money Kept, OTA matrix, payment charts) recompute
// immediately instead of displaying stale cached numbers.

let version = 0;
const listeners = new Set();
const conflictListeners = new Set();
let lastBroadcastReceivedTs = 0;
let microtaskScheduled = false;

function scheduleDispatch() {
  if (microtaskScheduled) return;
  microtaskScheduled = true;
  queueMicrotask(() => {
    microtaskScheduled = false;
    listeners.forEach((fn) => {
      try {
        fn(version);
      } catch (e) {
        console.error("[settingsBus]", e);
      }
    });
  });
}

let channel = null;
if (typeof window !== "undefined" && "BroadcastChannel" in window) {
  try {
    channel = new BroadcastChannel("rri_settings_bus");
    channel.onmessage = (ev) => {
      const data = ev && ev.data;
      if (data && data.type === "SETTINGS_VERSION_BUMP") {
        lastBroadcastReceivedTs = Date.now();
        version = Math.max(version, Number(data.version) || (version + 1));
        scheduleDispatch();
      }
    };
  } catch {}
}

export function getSettingsVersion() {
  return version;
}

export function subscribeSettingsChange(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function subscribeSettingsConflict(listener) {
  conflictListeners.add(listener);
  return () => {
    conflictListeners.delete(listener);
  };
}

export function notifySettingsConflict(conflictData) {
  conflictListeners.forEach((fn) => {
    try {
      fn(conflictData);
    } catch (e) {
      console.error("[settingsBus] conflict listener error:", e);
    }
  });
}

export function notifySettingsChanged(options = { broadcast: true }) {
  version += 1;
  if (options?.immediate) {
    listeners.forEach((fn) => {
      try {
        fn(version);
      } catch (e) {
        console.error("[settingsBus]", e);
      }
    });
  } else {
    scheduleDispatch();
  }

  if (options?.broadcast !== false && channel) {
    try {
      channel.postMessage({ type: "SETTINGS_VERSION_BUMP", version, ts: Date.now() });
    } catch {}
  }
}

// Cross-tab synchronization within the same browser profile. When another tab
// writes to localStorage, the storage event fires in every other open tab.
// Deduplicated against BroadcastChannel so tabs do not double-notify.
if (typeof window !== "undefined" && window.addEventListener) {
  window.addEventListener("storage", (ev) => {
    if (ev && ev.key && ev.key.startsWith("rri_")) {
      // If a BroadcastChannel event was just processed recently, skip redundant storage notification
      if (channel && Date.now() - lastBroadcastReceivedTs < 350) {
        return;
      }
      notifySettingsChanged({ broadcast: false });
    }
  });
}