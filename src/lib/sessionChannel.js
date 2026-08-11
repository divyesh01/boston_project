// Cross-tab session revocation channel.
//
// Coordinates instant logout/revocation across all open tabs/windows of the same
// origin. Two transports are used so the guard works even where BroadcastChannel
// is unavailable:
//   1. BroadcastChannel('rri_session')  — primary, low-latency, no self-delivery.
//   2. localStorage revocation sentinel — a `storage` event fires in every OTHER
//      tab when the sentinel value is written, covering browsers without
//      BroadcastChannel and same-document edge cases.
//
// Designed as a plain module (no React) so base44Client.js (the emitter) and
// AuthContext.jsx (the subscriber) can share it, and so the test harness can
// exercise the real implementation.

const CHANNEL_NAME = 'rri_session';
const REVOCATION_KEY = 'rri_session_revocation';

// Poster channel: created once, never listens. Shared across all callers.
let postChannel = null;

function getPostChannel() {
  if (postChannel) return postChannel;
  if (typeof BroadcastChannel === 'undefined') return null;
  try {
    postChannel = new BroadcastChannel(CHANNEL_NAME);
  } catch (e) {
    postChannel = null;
  }
  return postChannel;
}

function isRevocationMessage(data) {
  return !!data && (data.type === 'SESSION_REVOKED' || data.type === 'SESSION_REVOKED_ALL');
}

// Broadcast a revocation message to all other tabs. Safe to call anywhere; the
// sender's own tab never receives it via BroadcastChannel, and the storage
// fallback write only triggers `storage` events in other tabs.
export function postSessionRevoked(payload) {
  const message = { ts: Date.now(), ...payload };
  const ch = getPostChannel();
  if (ch) {
    try {
      ch.postMessage(message);
    } catch (e) {
      // BroadcastChannel failed; storage fallback below still fires.
    }
  }
  try {
    localStorage.setItem(REVOCATION_KEY, JSON.stringify(message));
  } catch (e) {
    // Storage unavailable; nothing more we can do here.
  }
}

// Subscribe to revocation messages. `handler` is invoked with the message object
// for every SESSION_REVOKED / SESSION_REVOKED_ALL received. Returns an
// unsubscribe function. Each subscription owns its own listener channel so
// multiple subscribers (multiple tabs) stay independent.
export function subscribeSessionRevoked(handler) {
  const ch = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL_NAME);
  if (ch) {
    ch.onmessage = (ev) => {
      if (isRevocationMessage(ev && ev.data)) handler(ev.data);
    };
  }

  const onStorage = (e) => {
    if (e && e.key === REVOCATION_KEY && e.newValue) {
      try {
        const data = JSON.parse(e.newValue);
        if (isRevocationMessage(data)) handler(data);
      } catch (err) {
        // Ignore malformed sentinel writes.
      }
    }
  };
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('storage', onStorage);
  }

  return () => {
    if (ch) {
      ch.onmessage = null;
      try {
        ch.close();
      } catch (e) {
        // Already closed.
      }
    }
    if (typeof window !== 'undefined' && window.removeEventListener) {
      window.removeEventListener('storage', onStorage);
    }
  };
}

export const SESSION_CHANNEL_NAME = CHANNEL_NAME;
export const SESSION_REVOCATION_STORAGE_KEY = REVOCATION_KEY;
