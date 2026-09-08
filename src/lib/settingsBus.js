// Reactive settings store. Bump the version whenever commission / CC / tax rates
// are saved so dependent widgets (Money Kept, OTA matrix, payment charts) recompute
// immediately instead of displaying stale cached numbers.

let version = 0;
const listeners = new Set();

export function getSettingsVersion() {
  return version;
}

export function subscribeSettingsChange(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifySettingsChanged() {
  version += 1;
  listeners.forEach((fn) => {
    try {
      fn(version);
    } catch (e) {
      console.error("[settingsBus]", e);
    }
  });
}

// Cross-tab synchronization within the same browser profile. When another tab
// writes to localStorage, the storage event fires in every other open tab.
if (typeof window !== "undefined" && window.addEventListener) {
  window.addEventListener("storage", (ev) => {
    if (ev && ev.key && ev.key.startsWith("rri_")) {
      notifySettingsChanged();
    }
  });
}