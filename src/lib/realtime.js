import { useEffect, useRef, useState } from "react";
import { queryClientInstance } from "./query-client.js";
import { pullRemoteSettings } from "./settingsStore.js";

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
//
// NOTE: Polling is coordinated one-per-tab (see the shared poll loop below);
// per-hook timers were removed because N mounted components produced N
// independent timer chains, N invalidations and N POLL_TICKs per interval.
// Cross-tab server pulls cannot collapse further: each tab owns an
// independent IndexedDB cache, so every tab must run its own lightweight
// feed check. The floor is one feed per tab per interval, not one per app.

const CHANNEL_NAME = "rri_realtime";
export const FALLBACK_KEY = "rri_realtime_change";

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

function generateMessageId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

// Broadcast one change to all other tabs. Safe to call from anywhere (the
// entity proxy in base44Client.js is the primary emitter).
export function publishChange(table, change, record) {
  const message = {
    id: generateMessageId(),
    ts: Date.now(),
    type: "ENTITY_CHANGE",
    table,
    change,
    record,
  };
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
  let ch = null;
  if (typeof BroadcastChannel !== "undefined") {
    try {
      ch = new BroadcastChannel(CHANNEL_NAME);
    } catch {
      ch = null;
    }
  }

  const seenIds = new Set();
  const handleMessage = (data) => {
    if (!isChangeMessage(data)) return;
    const msgId = data.id || `${data.ts}_${data.table}_${data.change}`;
    if (seenIds.has(msgId)) return;
    seenIds.add(msgId);
    if (seenIds.size > 1000) {
      const first = seenIds.values().next().value;
      seenIds.delete(first);
    }
    handler(data);
  };

  if (ch) {
    ch.onmessage = (ev) => {
      handleMessage(ev && ev.data);
    };
  }

  const onStorage = (e) => {
    if (e && e.key === FALLBACK_KEY && e.newValue) {
      try {
        const data = JSON.parse(e.newValue);
        handleMessage(data);
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
  const isVisible = () => typeof document === "undefined" || !document.hidden;
  const id = getCurrentTabId();
  const ch = getLeaderChannel();

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

  if (coordinatorInitialized) {
    if (isVisible() && !currentLeaderId) {
      claimLeadership();
    }
    return;
  }
  coordinatorInitialized = true;

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

// Union of every page-level prefix. Mounted once by the authenticated shell
// (Layout) so server synchronization no longer depends on which page happens
// to be open. Pages keep their own targeted hooks; those only register
// interest with the shared loop below.
export const APP_SYNC_PREFIXES = [
  "occupancy", "sources", "gross", "clerk", "payments", "expenses",
  "payroll", "anomaly-alerts", "rooms", "reservations", "weather",
  "daily-aggregates", "properties", "staff", "room-stays",
  "housekeeping", "reviews", "settings",
];

// Shared per-tab poll coordination. Each useRealtimeInvalidation instance
// registers its live prefix set; ONE timer performs ONE union invalidation
// plus ONE POLL_TICK per interval, gated once on the shared leader flag.
// Invalidation itself is unchanged — same queryClient calls, same order.
const pollClients = new Map();
let pollClientSeq = 0;
let sharedPollTimer = null;
let sharedBaseMs = DEFAULT_POLL_MS;
let sharedBackoffMs = DEFAULT_POLL_MS;

function prefixKey(p) {
  return String(Array.isArray(p) ? p[0] : p ?? "");
}

function unionPrefixes() {
  const out = [];
  const seen = new Set();
  for (const client of pollClients.values()) {
    for (const p of client.getPrefixes()) {
      const key = prefixKey(p);
      if (!seen.has(key)) {
        seen.add(key);
        out.push(p);
      }
    }
  }
  return out;
}

async function invalidatePrefixList(list) {
  for (const p of list) {
    // throwOnError lives in the OPTIONS argument only: TanStack v5
    // InvalidateQueryFilters has no such key, so placing it in the filter
    // object is a type error and dead at runtime.
    await queryClientInstance.invalidateQueries(
      { queryKey: Array.isArray(p) ? p : [p] },
      { throwOnError: true }
    );
  }
}

function scheduleSharedPoll() {
  if (sharedPollTimer) {
    clearTimeout(sharedPollTimer);
    sharedPollTimer = null;
  }
  if (pollClients.size === 0) return;
  sharedPollTimer = setTimeout(runSharedPoll, sharedBackoffMs);
}

// Visibility return / leadership gain: reset backoff and reschedule at base.
export function pokeSharedPoll() {
  sharedBackoffMs = sharedBaseMs;
  scheduleSharedPoll();
}

export function registerPollClient(client) {
  const id = ++pollClientSeq;
  pollClients.set(id, client);
  let base = 0;
  for (const c of pollClients.values()) base = base ? Math.min(base, c.pollMs) : c.pollMs;
  sharedBaseMs = base || DEFAULT_POLL_MS;
  scheduleSharedPoll();
  return () => {
    pollClients.delete(id);
    let next = 0;
    for (const c of pollClients.values()) next = next ? Math.min(next, c.pollMs) : c.pollMs;
    sharedBaseMs = next || DEFAULT_POLL_MS;
    scheduleSharedPoll();
  };
}

async function runSharedPoll() {
  sharedPollTimer = null;
  if (typeof document !== "undefined" && document.hidden) {
    scheduleSharedPoll();
    return;
  }
  if (isLeader) {
    const union = unionPrefixes();
    if (union.length) {
      try {
        for (const client of pollClients.values()) {
          try { client.notify(); } catch {}
        }
        await invalidatePrefixList(union);
        pullRemoteSettings().catch(() => {});
        const ch = getLeaderChannel();
        if (ch) {
          try {
            ch.postMessage({ type: "POLL_TICK", prefixes: union, ts: Date.now() });
          } catch {}
        }
        sharedBackoffMs = sharedBaseMs;
      } catch {
        sharedBackoffMs = Math.min(sharedBackoffMs * 2, MAX_POLL_MS);
      }
    }
  }
  scheduleSharedPoll();
}

// React hook: invalidates queries across tabs using Tab Leader Election,
// Exponential Backoff on 5xx, and Page Visibility pausing.
export function useRealtimeInvalidation(queryKeyPrefixes, { enabled = true, pollMs = DEFAULT_POLL_MS } = {}) {
  const prefixes = useRef([...(queryKeyPrefixes || [])]);
  prefixes.current = queryKeyPrefixes || [];

  const invalidate = async () => invalidatePrefixList(prefixes.current);

  const [lastChange, setLastChange] = useState(null);

  useEffect(() => {
    if (!enabled) return undefined;
    initLeaderCoordinator();

    // 1. Cross-tab entity change listener (case-insensitive table & prefix matching)
    const unsubChanges = subscribeChanges((msg) => {
      const table = String((msg && msg.table) || "").toLowerCase();
      if (prefixes.current.some((p) => {
        const prefix = String(Array.isArray(p) ? p[0] : p || "").toLowerCase();
        return table.startsWith(prefix) || prefix.startsWith(table);
      })) {
        setLastChange(new Date());
        invalidate().catch(() => {});
      }
    });

    // 2. Peer tabs listen for leader's POLL_TICK broadcast
    const ch = getLeaderChannel();
    const handleLeaderMessage = (ev) => {
      const data = ev && ev.data;
      if (data && data.type === "POLL_TICK" && !isLeader) {
        const matches = Array.isArray(data.prefixes) && data.prefixes.some((prefix) => {
          const normPrefix = String(Array.isArray(prefix) ? prefix[0] : prefix || "").toLowerCase();
          return prefixes.current.some((p) => {
            const normP = String(Array.isArray(p) ? p[0] : p || "").toLowerCase();
            return normPrefix === normP || normPrefix.startsWith(normP) || normP.startsWith(normPrefix);
          });
        });
        if (matches) {
          setLastChange(new Date());
          invalidate().catch(() => {});
        }
      }
    };
    if (ch) {
      ch.addEventListener("message", handleLeaderMessage);
    }

    // 3. Immediate invalidation when page transitions from hidden to visible
    const onVisibilityChange = () => {
      if (typeof document !== "undefined" && !document.hidden) {
        setLastChange(new Date());
        invalidate().catch(() => {});
        if (isLeader) pokeSharedPoll();
      }
    };
    if (typeof document !== "undefined" && document.addEventListener) {
      document.addEventListener("visibilitychange", onVisibilityChange);
    }

    // 4. Shared per-tab poll loop (one timer no matter how many hooks mount)
    const unregisterPoll = registerPollClient({
      getPrefixes: () => prefixes.current,
      notify: () => setLastChange(new Date()),
      pollMs,
    });

    // Re-evaluate whenever leadership status changes
    const unsubLeadership = subscribeLeadership((amLeader) => {
      if (amLeader) pokeSharedPoll();
    });

    return () => {
      unregisterPoll();
      unsubChanges();
      unsubLeadership();
      if (ch) ch.removeEventListener("message", handleLeaderMessage);
      if (typeof document !== "undefined" && document.removeEventListener) {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
    };
  }, [enabled, pollMs]);

  return { lastChange, enabled };
}

export const REALTIME_CHANNEL = CHANNEL_NAME;
export { queryClientInstance };

