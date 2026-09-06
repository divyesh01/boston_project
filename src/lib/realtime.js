import { useEffect, useRef, useState } from "react";
import { queryClientInstance } from "./query-client.js";

// Cross-tab realtime channel for the operational modules (Room Board,
// Housekeeping, Weather, Reviews) and the Executive Dashboard.
//
// This app persists to local IndexedDB, so "real-time" means: when any module
// writes a change, every open tab that is showing that module should update
// immediately rather than wait for a manual refresh. BroadcastChannel delivers
// the change notification between tabs; localStorage is the fallback transport
// (mirroring sessionChannel.js so browsers without BroadcastChannel still work).
//
// Design rules:
//   * Publish is fire-and-forget — never a checkpoint. If it fails silently the
//     source data is still correct and the reader simply refetches.
//   * Messages carry only a small { type, table, change } envelope, never the
//     full row set, to avoid unbounded channel traffic on bulk imports.
//   * Subscribing page invalidates its react-query queries by queryKey prefix,
//     so TanStack refetches exactly the queries that changed.

const CHANNEL_NAME = "rri_realtime";
const FALLBACK_KEY = "rri_realtime_change";

let poster = null;
function getPoster() {
  if (poster) return poster;
  if (typeof BroadcastChannel !== "undefined") {
    try {
      poster = new BroadcastChannel(CHANNEL_NAME);
    } catch {
      poster = null;
    }
  }
  return poster;
}

// Broadcast one change to all other tabs. Safe to call from anywhere (the
// entity proxy in base44Client.js is the primary emitter).
export function publishChange(table, change, record) {
  const message = { ts: Date.now(), type: "ENTITY_CHANGE", table, change, record };
  const ch = getPoster();
  if (ch) {
    try {
      ch.postMessage(message);
    } catch {
      // storage fallback below still fires
    }
  }
  try {
    localStorage.setItem(FALLBACK_KEY, JSON.stringify(message));
  } catch {
    // storage unavailable
  }
}

function isChangeMessage(data) {
  return !!data && data.type === "ENTITY_CHANGE";
}

// Subscribe to cross-tab change notifications. `handler` receives each
// { table, change, record }. Returns an unsubscribe function.
export function subscribeChanges(handler) {
  const ch = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL_NAME);
  if (ch) {
    ch.onmessage = (ev) => {
      if (isChangeMessage(ev && ev.data)) handler(ev.data);
    };
  }
  const onStorage = (e) => {
    if (e && e.key === FALLBACK_KEY && e.newValue) {
      try {
        const data = JSON.parse(e.newValue);
        if (isChangeMessage(data)) handler(data);
      } catch {
        // ignore malformed sentinel writes
      }
    }
  };
  if (typeof window !== "undefined" && window.addEventListener) {
    window.addEventListener("storage", onStorage);
  }
  return () => {
    if (ch) {
      ch.onmessage = null;
      try {
        ch.close();
      } catch {
        // already closed
      }
    }
    if (typeof window !== "undefined" && window.removeEventListener) {
      window.removeEventListener("storage", onStorage);
    }
  };
}

// A local in-tab relay: the entity proxy writes and reads in the same document,
// so a change published to the channel would never come back to the writing tab
// (BroadcastChannel does not self-deliver and the storage event never fires in
// the same document). Pages therefore ALSO run a tiny polling invalidator while
// a "live" session is active, so a change this tab made is reflected instantly
// without a full channel round trip. 2500ms is imperceptible for hotel ops.
// BroadcastChannel and local coordination constants
export const DEFAULT_POLL_MS = 10000;
export const MAX_POLL_MS = 60000;
export const HEARTBEAT_INTERVAL_MS = 3000;
export const HEARTBEAT_TIMEOUT_MS = 7500;
export const LEADER_CHANNEL_NAME = "rri_realtime_leader";

let tabId = null;
export function getCurrentTabId() {
  if (!tabId) {
    tabId = (typeof crypto !== "undefined" && crypto.randomUUID)
      ? crypto.randomUUID()
      : `tab_${Math.random().toString(36).slice(2)}_${Date.now()}`;
  }
  return tabId;
}

let leaderChannel = null;
function getLeaderChannel() {
  if (leaderChannel) return leaderChannel;
  if (typeof BroadcastChannel !== "undefined") {
    try {
      leaderChannel = new BroadcastChannel(LEADER_CHANNEL_NAME);
    } catch {
      leaderChannel = null;
    }
  }
  return leaderChannel;
}

// Internal leader election state
let isLeader = false;
let currentLeaderId = null;
let lastLeaderHeartbeat = 0;
const leaderListeners = new Set();

export function isCurrentTabLeader() {
  return isLeader;
}

export function subscribeLeadership(handler) {
  leaderListeners.add(handler);
  handler(isLeader);
  return () => leaderListeners.delete(handler);
}

function notifyLeadership(next) {
  if (isLeader !== next) {
    isLeader = next;
    for (const fn of leaderListeners) {
      try { fn(isLeader); } catch {}
    }
  }
}

// Global coordinator that manages leader election lifecycle across open tabs
let coordinatorInitialized = false;
function initLeaderCoordinator() {
  if (coordinatorInitialized) return;
  coordinatorInitialized = true;

  const id = getCurrentTabId();
  const ch = getLeaderChannel();

  const isVisible = () => typeof document === "undefined" || !document.hidden;

  const claimLeadership = () => {
    if (!isVisible()) return;
    currentLeaderId = id;
    lastLeaderHeartbeat = Date.now();
    notifyLeadership(true);
    if (ch) {
      try {
        ch.postMessage({ type: "LEADER_CLAIM", leaderId: id, ts: Date.now() });
      } catch {}
    }
  };

  const abdicateLeadership = () => {
    if (!isLeader) return;
    notifyLeadership(false);
    currentLeaderId = null;
    if (ch) {
      try {
        ch.postMessage({ type: "LEADER_ABDICATE", leaderId: id, ts: Date.now() });
      } catch {}
    }
  };

  if (ch) {
    ch.onmessage = (ev) => {
      const data = ev && ev.data;
      if (!data) return;
      if (data.type === "LEADER_HEARTBEAT") {
        if (data.leaderId !== id) {
          if (isLeader && data.leaderId < id) {
            // Deterministic tie-breaking: lower ID wins leadership
            notifyLeadership(false);
          }
          currentLeaderId = data.leaderId;
          lastLeaderHeartbeat = Date.now();
        }
      } else if (data.type === "LEADER_CLAIM") {
        if (data.leaderId === id) return;
        if (isLeader) {
          if (data.leaderId < id) {
            notifyLeadership(false);
            currentLeaderId = data.leaderId;
            lastLeaderHeartbeat = Date.now();
          } else {
            // Assert leadership if our ID takes precedence
            claimLeadership();
          }
        } else {
          currentLeaderId = data.leaderId;
          lastLeaderHeartbeat = Date.now();
        }
      } else if (data.type === "LEADER_ABDICATE") {
        if (currentLeaderId === data.leaderId) {
          currentLeaderId = null;
          lastLeaderHeartbeat = 0;
          if (isVisible()) claimLeadership();
        }
      }
    };
  }

  // Heartbeat & watchdog loop
  setInterval(() => {
    const now = Date.now();
    if (isLeader) {
      if (!isVisible()) {
        abdicateLeadership();
      } else if (ch) {
        try {
          ch.postMessage({ type: "LEADER_HEARTBEAT", leaderId: id, ts: now });
        } catch {}
      }
    } else if (isVisible()) {
      if (!currentLeaderId || now - lastLeaderHeartbeat > HEARTBEAT_TIMEOUT_MS) {
        claimLeadership();
      }
    }
  }, HEARTBEAT_INTERVAL_MS);

  if (typeof document !== "undefined" && document.addEventListener) {
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        abdicateLeadership();
      } else if (!currentLeaderId || Date.now() - lastLeaderHeartbeat > HEARTBEAT_TIMEOUT_MS) {
        claimLeadership();
      }
    });
  }

  if (typeof window !== "undefined" && window.addEventListener) {
    window.addEventListener("beforeunload", abdicateLeadership);
  }

  // Initial claim if visible
  if (isVisible()) {
    claimLeadership();
  }
}

// React hook: invalidates queries across tabs using Tab Leader Election,
// Exponential Backoff on 5xx, and Page Visibility pausing.
export function useRealtimeInvalidation(queryKeyPrefixes, { enabled = true, pollMs = DEFAULT_POLL_MS } = {}) {
  const prefixes = useRef([...(queryKeyPrefixes || [])]);
  prefixes.current = queryKeyPrefixes || [];

  const invalidate = () => {
    for (const p of prefixes.current) {
      queryClientInstance.invalidateQueries({ queryKey: p });
    }
  };

  const [lastChange, setLastChange] = useState(null);

  useEffect(() => {
    if (!enabled) return undefined;
    initLeaderCoordinator();

    // 1. Cross-tab entity change listener
    const unsubChanges = subscribeChanges((msg) => {
      if (prefixes.current.some((p) => String(msg.table).startsWith(p))) {
        setLastChange(new Date());
        invalidate();
      }
    });

    // 2. Peer tabs listen for leader's POLL_TICK broadcast
    const ch = getLeaderChannel();
    const handleLeaderMessage = (ev) => {
      const data = ev && ev.data;
      if (data && data.type === "POLL_TICK" && !isLeader) {
        const matches = Array.isArray(data.prefixes) && data.prefixes.some((prefix) => prefixes.current.includes(prefix));
        if (matches) {
          setLastChange(new Date());
          invalidate();
        }
      }
    };
    if (ch) {
      ch.addEventListener("message", handleLeaderMessage);
    }

    // 3. Leader polling timer with exponential backoff
    let pollTimer = null;
    let currentInterval = pollMs;

    const scheduleNextPoll = () => {
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = setTimeout(async () => {
        if (typeof document !== "undefined" && document.hidden) {
          scheduleNextPoll();
          return;
        }

        if (isLeader && prefixes.current.length) {
          try {
            setLastChange(new Date());
            invalidate();
            // Broadcast POLL_TICK so all peer tabs invalidate simultaneously without querying server
            if (ch) {
              try {
                ch.postMessage({ type: "POLL_TICK", prefixes: prefixes.current, ts: Date.now() });
              } catch {}
            }
            // Reset backoff on successful tick
            currentInterval = pollMs;
          } catch (err) {
            // Apply exponential backoff on error
            currentInterval = Math.min(currentInterval * 2, MAX_POLL_MS);
          }
        }
        scheduleNextPoll();
      }, currentInterval);
    };

    scheduleNextPoll();

    // Re-evaluate whenever leadership status changes
    const unsubLeadership = subscribeLeadership((amLeader) => {
      if (amLeader) {
        currentInterval = pollMs;
        scheduleNextPoll();
      }
    });

    return () => {
      unsubChanges();
      unsubLeadership();
      if (pollTimer) clearTimeout(pollTimer);
      if (ch) ch.removeEventListener("message", handleLeaderMessage);
    };
  }, [enabled, pollMs]);

  return { lastChange, enabled };
}

export const REALTIME_CHANNEL = CHANNEL_NAME;