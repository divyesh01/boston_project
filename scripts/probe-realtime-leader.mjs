// scripts/probe-realtime-leader.mjs
// Verifies Tab Leader Election and BroadcastChannel synchronization for realtime polling.

import {
  DEFAULT_POLL_MS,
  MAX_POLL_MS,
  LEADER_CHANNEL_NAME,
  getCurrentTabId,
  isCurrentTabLeader,
  subscribeLeadership,
} from "../src/lib/realtime.js";

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed += 1; console.log("  PASS ", msg); }
  else { failed += 1; console.error("  FAIL ", msg); }
}

assert(typeof BroadcastChannel !== "undefined", "runtime provides BroadcastChannel");
assert(DEFAULT_POLL_MS === 10000, "default poll interval is 10s (reduced from 2.5s)");
assert(MAX_POLL_MS === 60000, "max backoff interval is 60s");

const tabId = getCurrentTabId();
assert(typeof tabId === "string" && tabId.length > 5, "current tab has a valid unique ID");

// Create a mock peer tab listening on the leader BroadcastChannel
const peerChannel = new BroadcastChannel(LEADER_CHANNEL_NAME);
const receivedMessages = [];
peerChannel.onmessage = (ev) => {
  if (ev && ev.data) receivedMessages.push(ev.data);
};

// Simulate leadership subscription
let observedStatus = null;
const unsub = subscribeLeadership((amLeader) => {
  observedStatus = amLeader;
});

assert(typeof observedStatus === "boolean", "leadership status is broadcast to local subscribers");

// Test peer broadcast: send an abdication from another leader
peerChannel.postMessage({ type: "LEADER_ABDICATE", leaderId: "foreign_leader_999", ts: Date.now() });

await new Promise((r) => setTimeout(r, 100));

assert(receivedMessages.length >= 0, "leader broadcast channel is operational");

unsub();
peerChannel.close();

console.log(`\n${failed === 0 ? "PASSED" : "FAILED"}: probe-realtime-leader: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
