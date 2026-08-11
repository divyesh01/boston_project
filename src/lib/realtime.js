import { useEffect, useRef, useState } from "react";
import { queryClientInstance } from "@/lib/query-client";

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
export const DEFAULT_POLL_MS = 2500;

// React hook: whenever a change notification arrives (cross-tab) OR the poll
// ticks (same-tab), invalidate every query whose key starts with one of
// `queryKeyPrefixes`. Optionally gate polling behind an `enabled` live toggle so
// the dashboard is visibly "Live" before it starts self-refreshing.
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
    const unsub = subscribeChanges((msg) => {
      if (prefixes.current.some((p) => String(msg.table).startsWith(p))) {
        setLastChange(new Date());
        invalidate();
      }
    });
    const poll = setInterval(() => {
      if (prefixes.current.length) {
        setLastChange(new Date());
        invalidate();
      }
    }, pollMs);
    return () => {
      unsub();
      clearInterval(poll);
    };
  }, [enabled, pollMs]);

  return { lastChange, enabled };
}

export const REALTIME_CHANNEL = CHANNEL_NAME;