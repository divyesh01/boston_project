// Turns off the base44 SDK's analytics module before it can start.
//
// MUST BE THE FIRST IMPORT IN src/main.jsx. Not a style preference — a hard
// requirement, asserted by scripts/probe-sdk-analytics-off.mjs.
//
// WHY THIS FILE EXISTS
// The SDK's analytics module is enabled by default and has no supported
// off-switch: CreateClientOptions carries exactly one field (`onError`), and the
// only documented control is a `?analytics-enable=false` url param that deletes
// itself from the address bar and is never persisted. On construction the module
// enqueues an __initialization_event__, arms a 60s setInterval heartbeat, and
// registers a visibilitychange listener that sendBeacon()s its queue whenever the
// tab is hidden. Its flush() ends in `catch { /* do nothing */ }`, so every one of
// those requests fails silently.
//
// This deployment passes `serverUrl: ""` (base44Client.js), so the SDK builds a
// SAME-ORIGIN url — `/api/apps/<appId>/analytics/track/batch` — and POSTs it to
// our own Cloudflare Worker, which serves static assets and answers 405. Observed
// on the live site 2026-08-24 as a repeating console error: one failed POST per
// minute per open tab, forever, each one a billable Worker invocation.
//
// Cost and noise are the small reason. The real one: if anyone ever sets
// VITE_BASE44_BACKEND_URL, that same code starts shipping every page view, session
// duration and 60s heartbeat of the owner's activity to a third party — while
// src/pages/PrivacyPolicy.jsx tells the user their data stays on their machine.
// This app has no cloud backend and no use for telemetry, so the module is
// switched off rather than pointed somewhere.
//
// HOW IT WORKS, AND WHY IT MUTATES RATHER THAN JUST SEEDS
// createAnalyticsModule() reads `enabled` EXACTLY ONCE, when it is called, and
// returns `{track: noop, cleanup: noop}` if it is false. Neither track() nor
// flush() ever re-checks it. So the flag only has to be false at the moment
// createClient() runs — but it has to be false on the OBJECT the SDK already
// holds, and there are two different orderings to satisfy:
//
//   * Unbundled (vite dev, node harness): modules evaluate in import order, so
//     this file runs before the SDK's analytics module exists. The shared slot is
//     absent and we create it.
//
//   * Bundled (production): measured against a real build of this app. The SDK
//     lands in the `data-vendor` chunk, which the entry chunk imports in its
//     hoisted prologue, so data-vendor's body runs BEFORE any entry-chunk code.
//     analytics.js creates its shared state at module scope
//     (`const state = getSharedInstance("analytics", () => ({...enabled: true})))`),
//     so by the time this file runs the slot ALREADY EXISTS with analytics on.
//     Creating it is therefore not enough; the existing config object must be
//     mutated in place, because the SDK's module-level `const` already points at
//     it and will never re-read the slot.
//
// Both orderings are normal. What is NOT normal is arriving after
// createAnalyticsModule() has already run, because its closures cannot be
// recalled — that is the one case this file warns about, and it is detectable
// because the SDK's factory initialises `wasInitializationTracked` and
// `isHeartBeatProcessing` to false and only the running module sets them true.
//
// KEEP THIS FILE IMPORT-FREE. Anything it imported would be evaluated before it,
// and if that chain reached base44Client.js, createClient() would win the race.

const SLOT = "base44SharedInstances";
const NAME = "analytics";

// The subset of the SDK's config that switches analytics off. `enabled: false` is
// the actual gate; `heartBeatInterval: 0` and `maxQueueSize: 0` are defence in
// depth, so that even if a future SDK version moved or dropped the `enabled`
// check, startHeartBeatProcessor() would still bail (it requires >= 10) and
// track() would still refuse to queue.
function disabledConfig() {
  return {
    enabled: false,
    heartBeatInterval: 0,
    maxQueueSize: 0,
    throttleTime: 1000,
    batchSize: 30,
  };
}

// Mirrors the shape of the SDK's own shared state (modules/analytics.js), for the
// case where we get there first. `wasInitializationTracked` is deliberately left
// false, matching the SDK's factory, so that a true value remains a reliable
// signal that the real module has run.
function disabledState() {
  return {
    requestsQueue: [],
    isProcessing: false,
    isHeartBeatProcessing: false,
    wasInitializationTracked: false,
    sessionContext: null,
    sessionStartTime: null,
    config: disabledConfig(),
  };
}

function applyDisable() {
  // `window` is absent under SSR and in some harnesses; there the SDK falls back
  // to a throwaway object, never reaches the network, and there is nothing to do.
  if (typeof window === "undefined") return false;

  if (!window[SLOT]) window[SLOT] = {};

  const existing = window[SLOT][NAME];
  if (!existing || !existing.instance) {
    window[SLOT][NAME] = { instance: disabledState() };
    return true;
  }

  // The bundled ordering. Mutate the object the SDK is already holding.
  const state = existing.instance;
  const alreadyRunning = state.isHeartBeatProcessing === true || state.wasInitializationTracked === true;

  state.config = { ...(state.config || {}), ...disabledConfig() };
  if (Array.isArray(state.requestsQueue)) state.requestsQueue.length = 0;

  if (alreadyRunning) {
    // createAnalyticsModule() has already run, which means the import order in
    // src/main.jsx has been changed. Its interval and listener closures cannot be
    // recalled from here, and its track() captured maxQueueSize by value, so it
    // will keep queueing. What CAN be stopped is the drain: startAnalyticsProcessor()
    // returns immediately while `isProcessing` is true, so claiming that slot and
    // never releasing it means no queued event is ever flushed on a timer.
    // (A visibilitychange beacon calls flush() directly and would still fire, so
    // this is partial — the real guard is the import order, not this branch.)
    state.isProcessing = true;
    // Announced rather than swallowed: a silent half-fix is exactly how the
    // original 405 went unnoticed in the first place.
    console.warn(
      "[sdkAnalyticsOff] base44 analytics had already started; " +
      "sdkAnalyticsOff must be the FIRST import in src/main.jsx.",
    );
    return false;
  }

  state.isProcessing = false;
  return true;
}

export const SDK_ANALYTICS_DISABLED = applyDisable();
