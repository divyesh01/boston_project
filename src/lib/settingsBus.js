// Reactive settings store. Bump the version whenever commission / CC / tax rates
// are saved so dependent widgets (Money Kept, OTA matrix, payment charts) recompute
// immediately instead of displaying stale cached numbers.

let version = 0;
const listeners = new Set();

let channel = null;
if (typeof window !== "undefined" && "BroadcastChannel" in window) {
  try {
    channel = new BroadcastChannel("rri_settings_bus");
    channel.onmessage = (ev) => {
      const data = ev && ev.data;
      if (data && data.type === "SETTINGS_VERSION_BUMP") {
        version = Math.max(version, Number(data.version) || (version + 1));
        listeners.forEach((fn) => {
          try {
            fn(version);
          } catch (e) {
            console.error("[settingsBus]", e);
          }
        });
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

export function notifySettingsChanged(options = { broadcast: true }) {
  version += 1;
  listeners.forEach((fn) => {
    try {
      fn(version);
    } catch (e) {
      console.error("[settingsBus]", e);
    }
  });

  if (options?.broadcast !== false && channel) {
    try {
      channel.postMessage({ type: "SETTINGS_VERSION_BUMP", version, ts: Date.now() });
    } catch {}
  }
}

// Cross-tab synchronization within the same browser profile. When another tab
// writes to localStorage, the storage event fires in every other open tab.
if (typeof window !== "undefined" && window.addEventListener) {
  window.addEventListener("storage", (ev) => {
    if (ev && ev.key && ev.key.startsWith("rri_")) {
      notifySettingsChanged({ broadcast: false });
    }
  });
}