// Probe: app-configuration integrity.
//
// Two separate claims, both about src/api/base44Client.js, both measured rather
// than assumed.
//
// ─── 1. THE HARDCODED APP ID IS LOAD-BEARING, NOT A LEAK ───
//
// The launch audit filed `appId: import.meta.env?.VITE_BASE44_APP_ID ||
// "6a7d..."` as a hardcoded-secret defect and asked for the literal to be
// removed, or for the build to fail when the variable is unset. Both were
// measured before acting, and both are wrong for this repo:
//
//   - None of .env.development, .env.local or .env.production sets
//     VITE_BASE44_APP_ID (checked by key presence; values never printed). The
//     literal is therefore the real configuration of every build this repo
//     produces. Throwing on a missing variable would brick the deploy on the
//     first push, which is a worse outcome than the thing being fixed.
//   - An app id is not a secret. It ships inside the JS bundle and travels as
//     the X-App-Id header on every request, and the same value sits in
//     base44/.app.jsonc. Moving it out of source buys nothing for
//     confidentiality.
//
// So the real defect is narrower and entirely about legibility: the `||` idiom
// makes the production tenant id look like a throwaway dev fallback. A reader
// would reasonably assume production sets the variable (it does not), and
// anyone "cleaning up" the literal would break every deployment. The fix is to
// name it and say what it is. This section pins that, and pins that the
// fallback stays non-fatal.
//
// ─── 2. THE SDK BANKS A URL-SUPPLIED BEARER TOKEN ───
//
// This one is not in the audit, and it is the more serious of the two.
//
// @base44/sdk's createClient calls getAccessToken() during construction
// (node_modules/@base44/sdk/dist/client.js: `const accessToken = token ||
// getAccessToken()`), and getAccessToken (dist/utils/auth-utils.js) reads
// ?access_token= out of window.location.search, writes it to localStorage under
// BOTH "base44_access_token" and "token", and then hides its tracks with
// history.replaceState. Section 3 below demonstrates that against the real SDK
// module rather than describing it.
//
// It ships: the production bundle in dist/assets contains 4 occurrences of
// "base44_access_token". And base44Client.js calls createClient with no `token`
// option, so `token || getAccessToken()` takes the getAccessToken branch on
// every page load.
//
// Nothing in this app ever issues or reads a base44 bearer token. Every auth
// call goes through custom_auth_* against an HttpOnly cookie, and
// auth.setSessionToken is deliberately a no-op documented "for HttpOnly
// cookies". A value arriving in that parameter cannot be ours: it is a link the
// user was sent, and opening it pins someone else's token into their browser
// for the life of the origin — including the localStorage fallback, which
// outlives the URL the token arrived on.
//
// src/lib/authReturnTo.js already strips the parameter, but only out of
// ?returnTo=, which guards the post-login hop and nothing else. A direct link
// to any route reaches createClient() first. Its comment also attributed the
// persistence to src/lib/app-params.js, which is measurably not what happens —
// see section 5.
//
// ─── 3. src/lib/app-params.js IS DEAD CODE ───
//
// It exports `appParams`, whose getAppParamValue() prefers a URL query
// parameter over the configured default and persists it to localStorage, with
// no validation on app_id or functions_version (app_base_url alone gets a
// hostname allowlist). That would be a genuine repoint-the-client vulnerability
// if it ran. It does not: nothing imports the module, so Vite drops it. Measured
// against the built bundle, which is the only authority that settles a
// tree-shaking question:
//
//   base44_app_id            -> 0 occurrences in dist/
//   base44_functions_version -> 0 occurrences in dist/
//   base44_app_base_url      -> 0 occurrences in dist/
//   base44_from_url          -> 0 occurrences in dist/
//   rri_import_sessions      -> 1   (control: a key that IS live)
//   rr_local_session         -> 1   (control)
//
// Two consequences. The module is a landmine — one `import` away from being a
// live URL-override vulnerability — so section 5 fails if anything starts
// importing it. And VITE_BASE44_APP_BASE_URL / VITE_BASE44_FUNCTIONS_VERSION
// have no other consumer in src/, so both are inert: an operator who set
// VITE_BASE44_FUNCTIONS_VERSION to pin a deployed function version would change
// nothing at all. .env.example documented them as "Read at
// src/lib/app-params.js:53/55/64", which is true of the source and false of the
// program.
//
// Run: node scripts/probe-app-config.mjs

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const abs = (rel) => path.join(ROOT, rel);
const read = (rel) => (existsSync(abs(rel)) ? readFileSync(abs(rel), "utf8") : "");

let pass = 0;
let fail = 0;
const T = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`); }
};

// Structural assertions run on comment-stripped source: a probe that fails
// because a file documents its own former defect punishes the fix. The [^:]
// guard keeps "https://" out of the line-comment rule.
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const CLIENT = "src/api/base44Client.js";
const rawClient = read(CLIENT);
const client = stripComments(rawClient);
const rawReturnTo = read("src/lib/authReturnTo.js");
const returnTo = stripComments(rawReturnTo);
const envExample = read(".env.example");

// Pull a whole `function name(...) { ... }` out of source by brace matching, so
// the probe can execute the real implementation instead of pattern-matching it.
function extractFunction(src, name) {
  const sig = `function ${name}(`;
  const start = src.indexOf(sig);
  if (start === -1) return null;
  const open = src.indexOf("{", start);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}

// A browser just real enough for auth-utils.js and for the guard under test:
// location with a mutable search, a localStorage, and a history.replaceState
// that actually rewrites the query string (so "did it clean the URL?" is
// observable rather than assumed).
function fakeBrowser(search) {
  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
  const win = {
    location: { origin: "https://app.example", pathname: "/dashboard", search, hash: "" },
    localStorage,
    history: {
      replaceState: (_state, _title, url) => {
        const s = String(url);
        const q = s.indexOf("?");
        const h = s.indexOf("#");
        win.location.search = q === -1 ? "" : (h === -1 ? s.slice(q) : s.slice(q, h));
      },
    },
  };
  return { win, store };
}

function installBrowser(win) {
  globalThis.window = win;
  globalThis.document = { title: "Red Roof Intelligence" };
  globalThis.localStorage = win.localStorage;
}

// ─── Load the REAL SDK helper, defensively ───
// Imported by file path, not by package name: scripts/stubs/base44-sdk.mjs
// shadows "@base44/sdk" in the harness, and a stub cannot tell us what the
// shipped code does. A missing file must surface as a failed assertion, never
// as a crash — scripts/verify-all.mjs classifies a crash-at-import as BROKEN,
// which reads like a passing suite with one fewer line.
const AUTH_UTILS = "node_modules/@base44/sdk/dist/utils/auth-utils.js";
let sdkGetAccessToken = null;
let sdkLoadError = null;
if (existsSync(abs(AUTH_UTILS))) {
  try {
    const mod = await import(pathToFileURL(abs(AUTH_UTILS)).href);
    sdkGetAccessToken = mod.getAccessToken;
  } catch (err) {
    sdkLoadError = err?.message || String(err);
  }
} else {
  sdkLoadError = `${AUTH_UTILS} not found`;
}

console.log("\n=== 1. The production app id is named, documented, and non-fatal ===\n");

const APP_ID = "6a7d6856ee1cc714b1803c0e";

T("base44Client.js still carries the production app id",
  rawClient.includes(APP_ID),
  "the literal is the real configuration of every build in this repo — none of the .env files sets VITE_BASE44_APP_ID, so removing it bricks the deploy");

T("the app id is a named constant, not an inline literal in the createClient call",
  /const\s+PRODUCTION_APP_ID\s*=\s*["']6a7d6856ee1cc714b1803c0e["']/.test(client),
  "expected `const PRODUCTION_APP_ID = \"...\"` so the value can be described as the production tenant rather than read as a dev placeholder");

const appIdLine = (client.match(/appId:\s*[^\n]*/) || [""])[0];
T("the createClient call references the constant, not a repeated literal",
  appIdLine.includes("PRODUCTION_APP_ID") && !appIdLine.includes(APP_ID),
  `appId line: ${appIdLine.trim() || "(not found)"}`);

const literalCount = (client.match(new RegExp(APP_ID, "g")) || []).length;
T("the literal appears exactly once in the module (one place to change)",
  literalCount === 1, `found ${literalCount} occurrence(s) in comment-stripped source`);

T("the fallback is still non-fatal — no throw when the env var is unset",
  /\|\|\s*PRODUCTION_APP_ID/.test(client),
  "an unset VITE_BASE44_APP_ID must keep working: making it fatal would brick every current deployment, which is the opposite of a fix");

const appJsonc = read("base44/.app.jsonc");
T("the id matches base44/.app.jsonc (same tenant, one truth)",
  appJsonc.includes(APP_ID),
  "base44/.app.jsonc is what the base44 CLI deploys against; a mismatch means the client talks to a different tenant than the functions deploy to");

T(".env.example documents VITE_BASE44_APP_ID and its fallback",
  /VITE_BASE44_APP_ID/.test(envExample) && /not a secret/i.test(envExample),
  "the hazard is defaulting to the wrong tenant, not exposure — .env.example should say so");

console.log("\n=== 2. base44Client.js refuses a URL-supplied bearer token ===\n");

const guardSrc = extractFunction(client, "refuseUrlSuppliedAccessToken");

T("a guard named refuseUrlSuppliedAccessToken exists",
  guardSrc !== null,
  "the SDK reads ?access_token= during createClient() and persists it; nothing in this app issues base44 bearer tokens, so the parameter must be dropped before the SDK sees it");

const callMatch = client.match(/^[ \t]*refuseUrlSuppliedAccessToken\(\)\s*;/m);
const callIdx = callMatch ? client.indexOf(callMatch[0]) : -1;
const createIdx = client.indexOf("createClient({");
T("the guard is invoked at module scope",
  callIdx !== -1,
  "declaring it is not enough — getAccessToken() runs during construction");
T("the guard runs BEFORE createClient()",
  callIdx !== -1 && createIdx !== -1 && callIdx < createIdx,
  `guard call at ${callIdx}, createClient at ${createIdx} — module statements execute in order, so a guard after construction is a guard that never fired`);

let guard = null;
if (guardSrc) {
  try {
    guard = new Function(`${guardSrc}; return refuseUrlSuppliedAccessToken;`)();
  } catch (err) {
    T("the extracted guard evaluates", false, err?.message || String(err));
  }
}

console.log("\n=== 3. The real SDK, with and without the guard ===\n");

T("the shipped SDK helper loaded (this is the adversary, not a stub)",
  typeof sdkGetAccessToken === "function", sdkLoadError || "");

if (typeof sdkGetAccessToken === "function") {
  // Characterization: what the SDK does when nothing intervenes. This passes
  // before and after the fix — it is a fact about the dependency, recorded so
  // the reason for the guard cannot be argued away later.
  {
    const { win, store } = fakeBrowser("?access_token=attacker-token-abc123");
    installBrowser(win);
    const got = sdkGetAccessToken();
    T("UNGUARDED: the SDK returns the token supplied in the URL",
      got === "attacker-token-abc123", `returned ${JSON.stringify(got)}`);
    T("UNGUARDED: the SDK persists it to localStorage.base44_access_token",
      store.get("base44_access_token") === "attacker-token-abc123",
      "this is what outlives the link — clearing the URL does not clear the token");
    T("UNGUARDED: the SDK also persists it to localStorage.token",
      store.get("token") === "attacker-token-abc123",
      "a second key, written for platform-v2 compatibility");
    T("UNGUARDED: the SDK then hides the parameter from the URL",
      !win.location.search.includes("access_token"),
      "history.replaceState removes the evidence, so the user cannot see what happened");
  }

  // The fix: same adversary, guard first.
  if (typeof guard === "function") {
    const { win, store } = fakeBrowser("?access_token=attacker-token-abc123&tab=revenue");
    installBrowser(win);
    guard();
    const got = sdkGetAccessToken();
    T("GUARDED: the SDK finds no token",
      got === null || got === undefined, `returned ${JSON.stringify(got)}`);
    T("GUARDED: nothing was persisted under base44_access_token",
      !store.has("base44_access_token"), `store: ${JSON.stringify([...store.keys()])}`);
    T("GUARDED: nothing was persisted under token",
      !store.has("token"), `store: ${JSON.stringify([...store.keys()])}`);
    T("GUARDED: unrelated query parameters survive",
      win.location.search.includes("tab=revenue"),
      `search after guard: ${win.location.search} — the guard must not eat the app's own params`);

    // A browser poisoned by an earlier visit: the URL is clean, but the SDK's
    // localStorage fallback still hands the token over. A fix that only cleans
    // the URL leaves that browser compromised for as long as the key survives.
    const stale = fakeBrowser("");
    installBrowser(stale.win);
    stale.win.localStorage.setItem("base44_access_token", "stale-injected-token");
    stale.win.localStorage.setItem("token", "stale-injected-token");
    guard();
    const after = sdkGetAccessToken();
    T("GUARDED: a token banked by an earlier visit is cleared too",
      after === null || after === undefined,
      `returned ${JSON.stringify(after)} — nothing in this app writes these keys, so any value present is stale or injected`);

    // The guard must be inert on a normal page load.
    const clean = fakeBrowser("?tab=revenue");
    installBrowser(clean.win);
    clean.win.localStorage.setItem("rr_local_session", "keep-me");
    guard();
    T("GUARDED: an ordinary page load is left alone",
      clean.win.location.search === "?tab=revenue" && clean.store.get("rr_local_session") === "keep-me",
      `search: ${clean.win.location.search}, store: ${JSON.stringify([...clean.store.keys()])}`);
  } else {
    T("GUARDED: the guard could not be evaluated, so the fix is unverified", false,
      "refuseUrlSuppliedAccessToken was not found in src/api/base44Client.js");
  }
}

console.log("\n=== 4. authReturnTo.js keeps stripping the bootstrap params ===\n");

for (const p of ["access_token", "clear_access_token", "app_id", "app_base_url", "functions_version", "from_url"]) {
  T(`safeReturnTo() still strips ?${p}`, returnTo.includes(`"${p}"`),
    "defence in depth: this list guards the post-login hop even though the guard in base44Client.js now covers the direct-link case");
}

T("the comment no longer credits app-params.js with persisting these",
  !/app-params\.js persists these from the URL/.test(rawReturnTo),
  "the module is tree-shaken out, so that attribution is false — and a false reason is what gets a real protection deleted later");

T("the comment names the mechanism that actually does it",
  /auth-utils|client\.js|@base44\/sdk|getAccessToken/.test(rawReturnTo),
  "the live persistence is the SDK's getAccessToken(), called during createClient()");

console.log("\n=== 5. app-params.js stays unreferenced, and .env.example says so ===\n");

// Walk src/ for anything importing the dead module. A single import turns its
// unvalidated URL override of app_id / functions_version into live code.
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(js|jsx|ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

const importers = [];
try {
  for (const file of walk(abs("src"))) {
    if (path.basename(file) === "app-params.js") continue;
    const body = stripComments(readFileSync(file, "utf8"));
    if (/\bfrom\s+["'][^"']*app-params["']|\bimport\s*\(\s*["'][^"']*app-params["']|\brequire\s*\(\s*["'][^"']*app-params["']/.test(body)) {
      importers.push(path.relative(ROOT, file));
    }
  }
} catch (err) {
  T("src/ could be walked for importers", false, err?.message || String(err));
}

T("nothing imports src/lib/app-params.js",
  importers.length === 0,
  `importers: ${importers.join(", ")}\n          If this module is genuinely needed, do NOT just import it: getAppParamValue() prefers a URL query parameter over the configured value and persists it, and only app_base_url is validated. app_id and functions_version would become attacker-settable.`);

T(".env.example no longer presents the app-params.js reads as live",
  envExample !== "" && !/Read at src\/lib\/app-params\.js/.test(envExample),
  "VITE_BASE44_APP_BASE_URL and VITE_BASE44_FUNCTIONS_VERSION have no consumer outside that dead module, so documenting them as read is documenting a setting that does nothing");

T(".env.example marks those two variables as currently having no effect",
  /no effect|inert|not read|unused/i.test(envExample),
  "an operator pinning VITE_BASE44_FUNCTIONS_VERSION today changes nothing — that has to be stated where they would look");

console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
