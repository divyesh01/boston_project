// probe-sdk-analytics-off.mjs — the base44 SDK must not phone home.
//
// WHAT THE LIVE SITE SHOWED (2026-08-24, boston-project.divyesh-boston.workers.dev):
//   POST api/apps/6a7d6856ee1.../analytics/track/batch -> 405
//
// WHY. base44Client.js passes `serverUrl: import.meta.env?.VITE_BASE44_BACKEND_URL || ""`.
// That env var is unset in this deployment, so the SDK's analytics module builds
// `"" + "/api/apps/<appId>/analytics/track/batch"` — a SAME-ORIGIN url — and POSTs
// to our own Cloudflare Worker, which serves static assets and answers 405.
//
// It is not one stray request. createAnalyticsModule() at construction time
// enqueues an __initialization_event__, arms a 60s setInterval heartbeat that
// never stops, and registers a visibilitychange listener that sendBeacon()s the
// queue on tab hide. flush() ends in `catch { /* do nothing */ }`, so all of it
// fails SILENTLY — the console 405 is the only symptom the app ever produces.
//
// THE ORDERING THAT MAKES THIS HARD, AND WHY IT IS ASSERTED HERE
// `enabled` is read exactly once, inside createAnalyticsModule(); neither track()
// nor flush() re-checks it. So the flag must be false before createClient() runs,
// on the object the SDK is already holding. Measured against a real build of this
// app, there are two legitimate orderings and they need different handling:
//
//   * UNBUNDLED (vite dev, this harness): modules evaluate in import order, so the
//     seed runs before the SDK's analytics module exists and creates the slot.
//
//   * BUNDLED (production): the SDK lands in the `data-vendor` chunk, which the
//     entry chunk imports in its hoisted prologue (measured at offset 3,772 of
//     382,057 in dist/assets/index-*.js), so data-vendor's body runs before ANY
//     entry-chunk code. analytics.js creates its shared state at module scope with
//     enabled:true, so the seed arrives to an EXISTING slot and must mutate the
//     config object in place — the SDK's module-level const already points at it
//     and will never re-read the slot.
//
// Section 3 is that production ordering. An earlier version of this probe tested
// only the unbundled one, passed, and would have shipped a fix that did nothing on
// the live site. Section 4 covers the one genuinely broken ordering.
//
// This probe drives the REAL third-party module out of node_modules. It does not
// mock the thing under test.

import { installDomShims } from "./_dom-shims.mjs";

installDomShims({ userAgent: "harness" });

// ── shims the analytics module needs and _dom-shims.mjs does not provide ──────
if (!globalThis.location.search) globalThis.location.search = "";
globalThis.document.referrer = "https://harness.local/from";
globalThis.document.visibilityState = "visible";
const __ls = new Map();
globalThis.localStorage = {
  getItem: (k) => (__ls.has(k) ? __ls.get(k) : null),
  setItem: (k, v) => __ls.set(String(k), String(v)),
  removeItem: (k) => __ls.delete(String(k)),
  clear: () => __ls.clear(),
  key: (i) => [...__ls.keys()][i] ?? null,
  get length() { return __ls.size; },
};

// ── assertion plumbing ───────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
function ok(label, cond, detail = "") {
  if (cond) { pass += 1; return; }
  fail += 1;
  console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
}
function eq(label, actual, expected) {
  ok(label, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

const readFile = async (rel) => (await import("node:fs/promises")).readFile(
  new URL(rel, import.meta.url), "utf8",
);

// A recording axios stand-in. The SDK only calls `.request({method,url,data})` on
// it for analytics, so anything that reaches the network shows up here.
function makeRecorder() {
  const calls = [];
  return {
    calls,
    client: {
      request: async (cfg) => { calls.push(cfg); return { data: {} }; },
      defaults: { baseURL: "" },
    },
  };
}

// Count timers WITHOUT breaking them: the heartbeat must stay observable, and any
// interval that does get created has to be cleared or the probe never exits.
const realSetInterval = globalThis.setInterval;
const liveIntervals = [];
let intervalCount = 0;
globalThis.setInterval = (fn, ms, ...rest) => {
  intervalCount += 1;
  const id = realSetInterval(fn, ms, ...rest);
  liveIntervals.push(id);
  return id;
};

let listenerCount = 0;
const realAddEventListener = globalThis.addEventListener;
globalThis.addEventListener = (type, ...rest) => {
  if (type === "visibilitychange") listenerCount += 1;
  return realAddEventListener?.call(globalThis, type, ...rest);
};

const realWarn = console.warn;
let warnings = [];
console.warn = (...args) => { warnings.push(args.join(" ")); };

const settle = () => new Promise((r) => realSetInterval(r, 50));

const APP_ID = "6a7d6856ee1probe";
const SDK_ANALYTICS = "../node_modules/@base44/sdk/dist/modules/analytics.js";
const SEED = "../src/lib/sdkAnalyticsOff.js";

// Both modules are singletons keyed by url, so every scenario needs a genuinely
// fresh instance — hence the cache-busting query. Deleting
// window.base44SharedInstances is what makes a fresh analytics module re-run its
// shared-state factory.
const freshAnalytics = (tag) => import(`${SDK_ANALYTICS}?probe=${tag}`);
const freshSeed = (tag) => import(`${SEED}?probe=${tag}`);

function resetWorld() {
  delete globalThis.window.base44SharedInstances;
  intervalCount = 0;
  listenerCount = 0;
  warnings = [];
  globalThis.localStorage.clear();
}

const makeModule = (mod, rec) => mod.createAnalyticsModule({
  axiosClient: rec.client,
  serverUrl: "",
  appId: APP_ID,
  userAuthModule: { me: async () => ({ id: "u1", email: "owner@probe.local" }) },
});

console.log("\n1. Reproduction: untouched, the SDK starts talking to our own origin");
let defectUrl = null;
{
  resetWorld();
  const rec = makeRecorder();
  const mod = await freshAnalytics("defect");
  const analytics = makeModule(mod, rec);

  ok("a live track() is returned (not a no-op)", typeof analytics.track === "function");
  eq("a heartbeat interval is armed", intervalCount, 1);
  eq("a visibilitychange listener is registered", listenerCount, 1);

  await settle();
  ok("something was actually sent", rec.calls.length >= 1, `recorded ${rec.calls.length}`);

  const post = rec.calls[0];
  if (post) {
    defectUrl = post.url;
    eq("it is a POST", post.method, "POST");
    eq("to the analytics batch endpoint", post.url, `/apps/${APP_ID}/analytics/track/batch`);
    ok("carrying the initialization event",
      JSON.stringify(post.data ?? {}).includes("__initialization_event__"),
      JSON.stringify(post.data ?? {}).slice(0, 120));
  } else {
    fail += 3;
    console.log("  FAIL  no request recorded, so the payload could not be inspected");
  }

  // Ties the probe to the observed console error rather than to my description.
  const sdkSrc = await readFile(SDK_ANALYTICS);
  ok("the url the SDK builds is same-origin when serverUrl is empty",
    sdkSrc.includes("`${serverUrl}/api/apps/${appId}/analytics/track/batch`"),
    "the SDK's url template changed — re-read modules/analytics.js");

  // Proves the localStorage write path is real, which is what gives the matching
  // "stayed null" assertions below their meaning.
  ok("it stamped an analytics session id into localStorage",
    typeof globalThis.localStorage.getItem("base44_analytics_session_id") === "string");

  analytics.cleanup();
}

console.log("\n2. Unbundled ordering (vite dev): the seed gets there first");
{
  resetWorld();
  const rec = makeRecorder();
  const seed = await freshSeed("unbundled");
  eq("the seed reports it applied", seed.SDK_ANALYTICS_DISABLED, true);
  ok("it created the shared slot",
    globalThis.window.base44SharedInstances?.analytics?.instance?.config?.enabled === false);

  const mod = await freshAnalytics("unbundled");
  const analytics = makeModule(mod, rec);

  eq("no heartbeat interval is armed", intervalCount, 0);
  eq("no visibilitychange listener is registered", listenerCount, 0);
  analytics.track({ eventName: "probe_event" });
  analytics.track({ eventName: "probe_event_2" });
  await settle();
  eq("track() sends nothing", rec.calls.length, 0);
  eq("nothing is left queued for a later flush",
    globalThis.window.base44SharedInstances.analytics.instance.requestsQueue.length, 0);
  eq("no session id was written", globalThis.localStorage.getItem("base44_analytics_session_id"), null);
  eq("no warning was emitted (this ordering is normal)", warnings.length, 0);
  ok("cleanup() is still callable (the client calls it unconditionally)",
    (() => { try { analytics.cleanup(); return true; } catch { return false; } })());
}

console.log("\n3. Bundled ordering (production): the SDK's state already exists");
{
  resetWorld();
  const rec = makeRecorder();

  // This is what the hoisted data-vendor chunk does before any entry-chunk code:
  // evaluate analytics.js, whose module scope creates the shared state.
  const mod = await freshAnalytics("bundled");

  // Non-vacuity: the scenario is only meaningful if analytics really is ON here.
  eq("the SDK has already created its slot with analytics ENABLED",
    globalThis.window.base44SharedInstances?.analytics?.instance?.config?.enabled, true);
  eq("but it has not started yet (createClient has not run)", intervalCount, 0);

  // Now the entry chunk body begins, and the seed is main.jsx's first import.
  const seed = await freshSeed("bundled");
  eq("the seed reports it applied", seed.SDK_ANALYTICS_DISABLED, true);
  eq("no warning was emitted (this ordering is normal too)", warnings.length, 0);
  eq("it mutated the EXISTING config object in place",
    globalThis.window.base44SharedInstances.analytics.instance.config.enabled, false);

  // Then base44Client.js calls createClient(), which calls this.
  const analytics = makeModule(mod, rec);
  eq("no heartbeat interval is armed", intervalCount, 0);
  eq("no visibilitychange listener is registered", listenerCount, 0);
  analytics.track({ eventName: "probe_event" });
  await settle();
  eq("track() sends nothing", rec.calls.length, 0);
  eq("no session id was written", globalThis.localStorage.getItem("base44_analytics_session_id"), null);
  analytics.cleanup();
}

console.log("\n4. Misordered: analytics already started, so the seed says so out loud");
{
  resetWorld();
  const rec = makeRecorder();
  const mod = await freshAnalytics("misordered");
  const analytics = makeModule(mod, rec);
  eq("the real module started", intervalCount, 1);
  await settle();
  const sentBefore = rec.calls.length;
  ok("and sent something", sentBefore >= 1);

  const seed = await freshSeed("misordered");
  eq("the seed refuses to claim success", seed.SDK_ANALYTICS_DISABLED, false);
  eq("exactly one warning is emitted", warnings.length, 1);
  ok("the warning names the file and the requirement",
    /sdkAnalyticsOff/.test(warnings[0]) && /FIRST import/.test(warnings[0]), warnings[0]);
  eq("the config is still forced off",
    globalThis.window.base44SharedInstances.analytics.instance.config.enabled, false);
  eq("the pending queue was emptied",
    globalThis.window.base44SharedInstances.analytics.instance.requestsQueue.length, 0);

  // Partial mitigation, asserted honestly: the live closures cannot be recalled,
  // so this checks that the timed drain is blocked (startAnalyticsProcessor bails
  // while isProcessing is true), NOT that the module became a no-op. A
  // visibilitychange beacon calls flush() directly and would still fire; the real
  // guard against this whole scenario is the import order asserted in section 5.
  analytics.track({ eventName: "after_seed" });
  await settle();
  ok("the timed drain no longer reaches the network", rec.calls.length === sentBefore,
    `sent ${rec.calls.length - sentBefore} more after the seed`);
  eq("the processor slot is held so no new drain loop can start",
    globalThis.window.base44SharedInstances.analytics.instance.isProcessing, true);
  analytics.cleanup();
}

console.log("\n5. The contracts this fix rests on, asserted in the source");
{
  const sdkSrc = await readFile(SDK_ANALYTICS);
  ok("track() does not re-check enabled (so late seeding cannot work)",
    /const track = \(params\) => \{\s*if \(analyticsSharedState\.requestsQueue\.length >= maxQueueSize\)/.test(sdkSrc),
    "track() changed shape — re-verify whether ordering is still load-bearing");
  ok("enabled is still checked only at construction",
    /if \(!\(\(_a = analyticsSharedState\.config\).*enabled\).*\|\| isReactNative\)/.test(sdkSrc),
    "the construction-time gate moved — re-read createAnalyticsModule");
  ok("the SDK still creates its shared state at MODULE scope",
    /^const analyticsSharedState = getSharedInstance\(/m.test(sdkSrc),
    "if this became lazy, the bundled ordering in section 3 would change");
  ok("its default is still enabled", /enabled: true/.test(sdkSrc));

  const sharedSrc = await readFile("../node_modules/@base44/sdk/dist/utils/sharedInstance.js");
  ok("the SDK still keys off window.base44SharedInstances[name].instance",
    sharedSrc.includes("windowObj.base44SharedInstances[name]") && sharedSrc.includes(".instance"),
    "getSharedInstance() changed shape — the seed's wrapper may no longer match");
  ok("and still skips its factory when the slot exists",
    sharedSrc.includes("if (!windowObj.base44SharedInstances[name])"));

  const main = await readFile("../src/main.jsx");
  const firstImport = main.match(/^\s*import\s.*$/m)?.[0] ?? "";
  ok("the seed is the FIRST import in src/main.jsx", /sdkAnalyticsOff/.test(firstImport),
    `first import is: ${firstImport.trim()}`);
  ok("imported for side effects only (no binding that a linter could drop)",
    /^import\s+['"]@\/lib\/sdkAnalyticsOff(\.js)?['"]/.test(firstImport.trim()),
    firstImport.trim());

  // If the seed imported anything that reached base44Client, that import would be
  // evaluated first and createClient() would win the race.
  const seedSrc = await readFile(SEED);
  eq("the seed module imports nothing", (seedSrc.match(/^\s*import\s/gm) ?? []).length, 0);
  ok("it writes the shared-instance slot the SDK reads", seedSrc.includes("base44SharedInstances"));
  ok("it sets enabled to false", /enabled:\s*false/.test(seedSrc));
  ok("it also neutralises the heartbeat interval", /heartBeatInterval:\s*0/.test(seedSrc));

  // A bare side-effect import is exactly what a bundler is entitled to delete, and
  // two build settings decide whether this fix survives a production build. Both
  // would fail silently — the app would look identical and the 405 would return.
  const pkg = await readFile("../package.json");
  ok("package.json does not declare the app side-effect-free",
    !/"sideEffects"\s*:\s*false/.test(pkg),
    'a "sideEffects": false declaration lets Rollup drop the seed import entirely');

  const viteCfg = await readFile("../vite.config.js");
  ok("no treeshake override that could drop module side effects",
    !/moduleSideEffects/.test(viteCfg),
    "vite.config.js now overrides moduleSideEffects — re-verify the seed survives a build");

  // esbuild's `pure` list marks calls as removable. console.warn is the ONLY symptom
  // a misordered import produces, so it must not join console.log there.
  const pureList = viteCfg.match(/pure:\s*\[([^\]]*)\]/)?.[1] ?? "";
  ok("console.warn is not in esbuild's pure list", !/console\.warn/.test(pureList),
    `pure: [${pureList}] — stripping console.warn would silence the misordering warning`);
}

console.log("\n6. The 405 is same-origin because serverUrl defaults to empty");
{
  // Read-only assertion against a PROTECTED file. Documents why the request hits
  // our Worker instead of base44, and fails if that default ever becomes a real
  // host — the point at which telemetry would start leaving the machine.
  const client = await readFile("../src/api/base44Client.js");
  ok("serverUrl still defaults to an empty string",
    /serverUrl:\s*import\.meta\.env\?\.VITE_BASE44_BACKEND_URL\s*\|\|\s*""/.test(client),
    "base44Client.js changed — if a real backend url is now default, analytics would leave the origin");
  eq("the recorded defect url was the app-relative batch path",
    defectUrl, `/apps/${APP_ID}/analytics/track/batch`);
}

for (const id of liveIntervals) clearInterval(id);
globalThis.setInterval = realSetInterval;
console.warn = realWarn;

console.log("\n" + "─".repeat(70));
console.log(`PASS ${pass}   FAIL ${fail}\n`);
if (fail > 0) {
  console.log(`FAILED: ${pass} passed, ${fail} failed`);
  process.exit(1);
}
console.log(`PASSED: ${pass} passed, 0 failed`);
process.exit(0);
