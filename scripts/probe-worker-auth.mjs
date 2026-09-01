// scripts/probe-worker-auth.mjs — INDEPENDENT adversarial proof of
// worker/auth.js (Cloudflare Access RS256 JWT validation, fail-closed).
//
// Synthetic keys only. REAL Cloudflare Access verification is BLOCKED/UNPROVEN.
// Run: node scripts/probe-worker-auth.mjs   (exits non-zero on ANY failure)
//
// JWKS FETCH DISCIPLINE (Agent D findings F1). worker/auth.js caches the JWKS in
// MODULE scope keyed by the certs URL, so cache warmth is process-global. Every
// fetch-count assertion below therefore uses its OWN dedicated certs URL, which
// makes "cold cache" a property of the test rather than of the file's execution
// order. Governing contract asserted here:
//   * cold/expired cache  -> EXACTLY ONE upstream fetch, then DENY on unknown kid
//                            (no cold-cache double-fetch)
//   * warm cache + unknown kid INSIDE JWKS_MIN_REFRESH_INTERVAL_MS (5 min)
//                          -> ZERO upstream fetches, DENY (anti-amplification
//                             throttle; supersedes the earlier "always exactly
//                             one refresh" behaviour — strictly fewer upstream
//                             requests, still fail-closed)
//   * after the throttle interval -> a genuinely rotated kid IS fetchable again
//                                   (the throttle must not permanently blind it)
//   * certs endpoint erroring -> DENY (fail closed)

import { authenticate } from "../worker/auth.js";
import {
  generateRsaKey,
  makeJwks,
  makeJwksFetch,
  signRs256,
  makeAlgNoneToken,
  makeHs256Token,
  tamperPayload,
  reqWithToken,
  withFakeNow,
  makeRunner,
  assert,
  assertEqual,
} from "./_worker-testkit.mjs";

const r = makeRunner("probe-worker-auth");

const AUD = "aud-synthetic-tag";
const TEAM = "team.cloudflareaccess.com";
const ISS = "https://team.cloudflareaccess.com";

const nowSec = () => Math.floor(Date.now() / 1000);
const goodPayload = (over = {}) => ({
  aud: AUD,
  iss: ISS,
  exp: nowSec() + 3600,
  iat: nowSec() - 10,
  email: "clerk@hotel.example",
  sub: "access-sub-001",
  ...over,
});
const envFor = (certsUrl, fetchImpl) => ({
  ACCESS_AUD: AUD,
  ACCESS_TEAM_DOMAIN: TEAM,
  ACCESS_CERTS_URL: certsUrl,
  FETCH: fetchImpl,
});

// Primary signing key (kid-1), served in the synthetic JWKS.
const key1 = await generateRsaKey("kid-1");

// ===========================================================================
// F1 REGRESSION 1 — COLD cache + unknown kid => EXACTLY ONE upstream fetch.
// Dedicated certs URL: this cache entry cannot have been warmed by any other
// check in this process, so coldness is guaranteed independent of test order.
// ===========================================================================
await r.check("COLD cache + unknown kid => EXACTLY ONE upstream JWKS fetch, then DENY", async () => {
  const { fetchImpl, state } = makeJwksFetch(makeJwks(key1.publicJwk));
  const env = envFor("https://synthetic.jwks/certs-cold-unknown", fetchImpl);
  assertEqual(state.calls, 0, "precondition: cache is cold, zero fetches so far");
  const token = await signRs256({ privateKey: key1.privateKey, kid: "kid-never-issued", payload: goodPayload() });
  const res = await authenticate(reqWithToken(token), env);
  assert(res.ok === false, "unknown kid must be denied");
  assertEqual(state.calls, 1, "cold cache must fetch exactly ONCE (1, not 2 — no double-fetch)");
});

// ===========================================================================
// F1 REGRESSION 2 — certs endpoint erroring on a cold cache => DENY (closed).
// ===========================================================================
await r.check("certs endpoint erroring on a cold cache => DENY (fail closed)", async () => {
  const { fetchImpl, state } = makeJwksFetch(makeJwks(key1.publicJwk));
  state.fail = true;
  const env = envFor("https://synthetic.jwks/certs-broken", fetchImpl);
  const token = await signRs256({ privateKey: key1.privateKey, kid: "kid-1", payload: goodPayload() });
  const res = await authenticate(reqWithToken(token), env);
  assert(res.ok === false, "an unavailable JWKS must never authenticate anyone");
  assertEqual(state.calls, 1, "one attempt, no retry storm");
});

// ===========================================================================
// F1 REGRESSION 3 — unknown-kid STORM against a warm cache: ZERO extra fetches
// inside the throttle window, every request DENIES; and after the interval a
// genuinely rotated kid IS still fetchable (throttle does not blind the
// validator permanently). All on one dedicated certs URL.
// ===========================================================================
const key2 = await generateRsaKey("kid-rot-2");
const rot = makeJwksFetch(makeJwks(key1.publicJwk));
const rotEnv = envFor("https://synthetic.jwks/certs-rotate", rot.fetchImpl);

await r.check("warm the rotate-URL cache with a valid kid-1 token (1 fetch)", async () => {
  const token = await signRs256({ privateKey: key1.privateKey, kid: "kid-1", payload: goodPayload() });
  const res = await authenticate(reqWithToken(token), rotEnv);
  assert(res.ok === true, `warm-up token must authenticate, got ${JSON.stringify(res)}`);
  assertEqual(rot.state.calls, 1, "exactly one warm-up fetch");
});

await r.check("unknown-kid STORM (5 requests) inside throttle window => 0 extra fetches, all DENY", async () => {
  const before = rot.state.calls;
  for (let i = 0; i < 5; i++) {
    const token = await signRs256({ privateKey: key1.privateKey, kid: `kid-bogus-${i}`, payload: goodPayload() });
    const res = await authenticate(reqWithToken(token), rotEnv);
    assert(res.ok === false, `storm request ${i} must be denied fail-closed`);
  }
  assertEqual(rot.state.calls - before, 0, "throttle must hold: ZERO upstream certs fetches for the storm");
});

await r.check("rotated kid inside the throttle window is still DENIED with 0 fetches", async () => {
  rot.state.keys.push(key2.publicJwk); // Cloudflare rotated; upstream now has kid-rot-2
  const before = rot.state.calls;
  const token = await signRs256({ privateKey: key2.privateKey, kid: "kid-rot-2", payload: goodPayload() });
  const res = await authenticate(reqWithToken(token), rotEnv);
  assert(res.ok === false, "inside the window the un-discovered kid must fail closed");
  assertEqual(rot.state.calls - before, 0, "no fetch inside the throttle window");
});

await r.check("after JWKS_MIN_REFRESH_INTERVAL_MS elapses, the rotated kid IS fetched and ACCEPTED", async () => {
  const before = rot.state.calls;
  const token = await signRs256({
    privateKey: key2.privateKey,
    kid: "kid-rot-2",
    payload: goodPayload({ exp: nowSec() + 3600, email: "rotated@hotel.example", sub: "sub-rot" }),
  });
  // +6 min: past the 5-min refresh throttle, still inside the 1-hour TTL.
  const res = await withFakeNow(6 * 60 * 1000, () => authenticate(reqWithToken(token), rotEnv));
  assertEqual(rot.state.calls - before, 1, "exactly one refresh once the throttle window has passed");
  assert(res.ok === true, `rotated key must be usable after the throttle window, got ${JSON.stringify(res)}`);
  assertEqual(res.principal.email, "rotated@hotel.example", "principal from the rotated key's token");
});

// ===========================================================================
// CORE CONTRACT CHECKS (all previously-passing assertions retained).
// Shared certs URL; the first check warms this cache deliberately.
// ===========================================================================
const CERTS_URL = "https://synthetic.jwks/certs-auth";
const { fetchImpl, state } = makeJwksFetch(makeJwks(key1.publicJwk));
const env = envFor(CERTS_URL, fetchImpl);

await r.check("valid RS256 token accepted; principal.email == token email", async () => {
  const token = await signRs256({ privateKey: key1.privateKey, kid: "kid-1", payload: goodPayload() });
  const res = await authenticate(reqWithToken(token), env);
  assert(res.ok === true, `expected ok, got ${JSON.stringify(res)}`);
  assertEqual(res.principal.email, "clerk@hotel.example", "principal email");
  assertEqual(res.principal.subject, "access-sub-001", "principal subject");
});

await r.check("alg 'none' rejected", async () => {
  const token = makeAlgNoneToken({ kid: "kid-1", payload: goodPayload() });
  const res = await authenticate(reqWithToken(token), env);
  assert(res.ok === false, "alg none must be denied");
});

await r.check("alg 'HS256' rejected even with a valid HMAC body", async () => {
  const token = await makeHs256Token({ kid: "kid-1", payload: goodPayload(), secret: "attacker-secret" });
  const res = await authenticate(reqWithToken(token), env);
  assert(res.ok === false, "HS256 must be denied (alg is pinned, never selected from header)");
});

await r.check("tampered payload / bad signature rejected", async () => {
  const token = await signRs256({ privateKey: key1.privateKey, kid: "kid-1", payload: goodPayload() });
  const forged = tamperPayload(token, goodPayload({ email: "attacker@evil.example" }));
  const res = await authenticate(reqWithToken(forged), env);
  assert(res.ok === false, "tampered payload must fail signature verification");
});

await r.check("wrong aud rejected", async () => {
  const token = await signRs256({ privateKey: key1.privateKey, kid: "kid-1", payload: goodPayload({ aud: "some-other-app" }) });
  const res = await authenticate(reqWithToken(token), env);
  assert(res.ok === false, "aud mismatch must be denied");
});

await r.check("wrong iss rejected", async () => {
  const token = await signRs256({ privateKey: key1.privateKey, kid: "kid-1", payload: goodPayload({ iss: "https://evil.cloudflareaccess.com" }) });
  const res = await authenticate(reqWithToken(token), env);
  assert(res.ok === false, "iss mismatch must be denied");
});

await r.check("expired exp (beyond 60s skew) rejected", async () => {
  const token = await signRs256({ privateKey: key1.privateKey, kid: "kid-1", payload: goodPayload({ exp: nowSec() - 120 }) });
  const res = await authenticate(reqWithToken(token), env);
  assert(res.ok === false, "expired token must be denied");
});

await r.check("exp just inside 60s skew is accepted (per contract)", async () => {
  const token = await signRs256({ privateKey: key1.privateKey, kid: "kid-1", payload: goodPayload({ exp: nowSec() - 10 }) });
  const res = await authenticate(reqWithToken(token), env);
  assert(res.ok === true, `token within skew must be accepted, got ${JSON.stringify(res)}`);
});

await r.check("missing token (no cookie, no header) rejected 401-shaped", async () => {
  const res = await authenticate(new Request("https://api.test/api/properties"), env);
  assert(res.ok === false, "no credential must be denied");
});

await r.check("CF_Authorization cookie is an accepted credential carrier", async () => {
  const token = await signRs256({ privateKey: key1.privateKey, kid: "kid-1", payload: goodPayload() });
  const req = new Request("https://api.test/api/properties", { headers: { Cookie: `other=x; CF_Authorization=${token}` } });
  const res = await authenticate(req, env);
  assert(res.ok === true, `cookie-borne token must authenticate, got ${JSON.stringify(res)}`);
});

await r.check("warm cache + unknown kid inside throttle window => DENY with 0 fetches", async () => {
  const before = state.calls;
  const token = await signRs256({ privateKey: key1.privateKey, kid: "kid-unknown", payload: goodPayload() });
  const res = await authenticate(reqWithToken(token), env);
  assert(res.ok === false, "unknown kid must be denied");
  assertEqual(state.calls - before, 0, "throttled: no upstream fetch, and never an unbounded refetch loop");
});

await r.check("spoofed Cf-Access-Authenticated-User-Email with no JWT rejected", async () => {
  const req = new Request("https://api.test/api/properties", {
    headers: { "Cf-Access-Authenticated-User-Email": "admin@hotel.example" },
  });
  const res = await authenticate(req, env);
  assert(res.ok === false, "identity must never come from the spoofable email header");
});

await r.check("spoofed email header does NOT override a validated principal", async () => {
  const token = await signRs256({ privateKey: key1.privateKey, kid: "kid-1", payload: goodPayload({ email: "real@hotel.example" }) });
  const req = reqWithToken(token, { "Cf-Access-Authenticated-User-Email": "attacker@evil.example" });
  const res = await authenticate(req, env);
  assert(res.ok === true, "valid token should authenticate");
  assertEqual(res.principal.email, "real@hotel.example", "email must come from the JWT, not the header");
});

// ===========================================================================
// DURABLE REGRESSION COVERAGE FOR THE JWKS FETCH-DISCIPLINE FIXES.
//
// Every case below owns a DEDICATED certs URL, because worker/auth.js's JWKS
// cache lives in MODULE scope keyed by that URL and is therefore process-global:
// sharing a URL would make "cold cache" depend on file execution order.
//
// NON-VACUITY GUARD, applied to every denial that is supposed to happen inside
// getSigningKey: assert `res.reason === "unknown or unverifiable kid"`. A
// placeholder/malformed token is rejected earlier, at header parsing
// ("malformed token" / "unparseable header" / "missing kid"), and NEVER reaches
// the key resolver — which would make every fetch-count assertion here pass
// vacuously. Pinning the reason makes that failure mode impossible to
// reintroduce silently, and the non-zero fetch assertions do the same from the
// other side.
// ===========================================================================
const KID_DENY = "unknown or unverifiable kid";

// --- A1: failing upstream must NOT restore 1:1 amplification ---------------
// The throttle records the last ATTEMPT, not the last SUCCESS. Pre-fix it keyed
// off the last successful fetch, so a DOWN certs endpoint never advanced the
// throttle clock and 10 bogus requests produced 10 upstream fetches.
await r.check("10 real unknown-kid tokens vs a FAILING certs endpoint => EXACTLY ONE upstream fetch, all DENIED", async () => {
  const { fetchImpl, state } = makeJwksFetch(makeJwks(key1.publicJwk));
  state.fail = true;
  const env = envFor("https://synthetic.jwks/certs-fail-amplify", fetchImpl);
  assertEqual(state.calls, 0, "precondition: dedicated URL, cache is cold");
  // REAL signatures with REAL kids — see the NON-VACUITY GUARD note above.
  const tokens = [];
  for (let i = 0; i < 10; i++) {
    tokens.push(
      await signRs256({ privateKey: key1.privateKey, kid: `kid-amp-${i}`, payload: goodPayload() }),
    );
  }
  await withFakeNow(0, async () => {
    for (let i = 0; i < 10; i++) {
      const res = await authenticate(reqWithToken(tokens[i]), env);
      assert(res.ok === false, `request ${i} must fail closed while certs are unreachable`);
      assertEqual(res.reason, KID_DENY, `request ${i} must be denied INSIDE getSigningKey (non-vacuity)`);
    }
  });
  assertEqual(
    state.calls,
    1,
    "a DOWN certs endpoint must still throttle: 10 requests => 1 upstream fetch (pre-fix: 10)",
  );
});

// --- A2: sustained outage stays bounded, one fetch per backoff window -------
await r.check("60 requests over ~60 simulated seconds vs a FAILING endpoint => <= 6 fetches, not 60", async () => {
  const { fetchImpl, state } = makeJwksFetch(makeJwks(key1.publicJwk));
  state.fail = true;
  const env = envFor("https://synthetic.jwks/certs-fail-sustained", fetchImpl);
  const token = await signRs256({
    privateKey: key1.privateKey,
    kid: "kid-sustained",
    payload: goodPayload(),
  });
  const REQUESTS = 60;
  const WINDOW_MS = 10 * 1000; // JWKS_FAILURE_BACKOFF_MS
  for (let i = 0; i < REQUESTS; i++) {
    // One request per simulated second across a 60s outage.
    const res = await withFakeNow(i * 1000, () => authenticate(reqWithToken(token), env));
    assert(res.ok === false, `second ${i} must fail closed`);
    assertEqual(res.reason, KID_DENY, `second ${i} must be denied INSIDE getSigningKey (non-vacuity)`);
  }
  const ceiling = Math.ceil((REQUESTS * 1000) / WINDOW_MS); // 6
  assert(state.calls >= 1, "non-vacuity: the outage window must have produced at least one real attempt");
  assert(
    state.calls <= ceiling,
    `sustained outage must cost at most one fetch per ${WINDOW_MS}ms window (<= ${ceiling}); ` +
      `saw ${state.calls} for ${REQUESTS} requests`,
  );
});

// --- A3: HARD TTL expiry fails CLOSED, and costs exactly one attempt --------
// Pre-fix, an expired key set was still consulted, so a REVOKED key set kept
// validating tokens for as long as the certs endpoint stayed unreachable.
const TTL_MS = 60 * 60 * 1000; // JWKS_TTL_MS
const BACKOFF_MS = 10 * 1000; // JWKS_FAILURE_BACKOFF_MS
// exp far enough out that time-travelling past the TTL cannot expire the TOKEN;
// otherwise a denial would prove nothing about the key set.
const longLived = (over = {}) => goodPayload({ exp: nowSec() + 7 * 24 * 3600, ...over });

await r.check("expired JWKS + FAILING refresh => DENY (fail closed), exactly ONE refresh attempt", async () => {
  const ttl = makeJwksFetch(makeJwks(key1.publicJwk));
  const ttlEnv = envFor("https://synthetic.jwks/certs-hard-ttl", ttl.fetchImpl);
  const token = await signRs256({ privateKey: key1.privateKey, kid: "kid-1", payload: longLived() });

  // Warm the cache while the endpoint is healthy.
  const warm = await authenticate(reqWithToken(token), ttlEnv);
  assert(warm.ok === true, `warm-up must authenticate, got ${JSON.stringify(warm)}`);
  assertEqual(ttl.state.calls, 1, "one warm-up fetch");

  // NON-VACUITY CONTROL: the very same token, at the very same simulated time,
  // on a HEALTHY dedicated URL, still authenticates. So the denial below is
  // caused by the unverifiable key set, not by exp/nbf/iat drifting.
  const ctl = makeJwksFetch(makeJwks(key1.publicJwk));
  const ctlEnv = envFor("https://synthetic.jwks/certs-hard-ttl-control", ctl.fetchImpl);
  const control = await withFakeNow(TTL_MS + 1000, () => authenticate(reqWithToken(token), ctlEnv));
  assert(control.ok === true, `control: token itself must still be valid past the TTL, got ${JSON.stringify(control)}`);

  // Past the HARD TTL with a broken endpoint: the stale key set must be
  // DISCARDED, not honored.
  ttl.state.fail = true;
  const before = ttl.state.calls;
  const denied = await withFakeNow(TTL_MS + 1000, () => authenticate(reqWithToken(token), ttlEnv));
  assert(denied.ok === false, "an unverifiable (past-TTL) key set must NEVER validate a token");
  assertEqual(denied.reason, KID_DENY, "denial must come from the key resolver (non-vacuity)");
  assertEqual(ttl.state.calls - before, 1, "exactly ONE recovery attempt, no retry storm");

  // Inside the failure-backoff window: still denied, and ZERO extra fetches.
  const before2 = ttl.state.calls;
  const denied2 = await withFakeNow(TTL_MS + 1000 + BACKOFF_MS / 2, () =>
    authenticate(reqWithToken(token), ttlEnv),
  );
  assert(denied2.ok === false, "still fail-closed inside the backoff window");
  assertEqual(denied2.reason, KID_DENY, "denial still from the key resolver (non-vacuity)");
  assertEqual(ttl.state.calls - before2, 0, "throttled inside JWKS_FAILURE_BACKOFF_MS: zero extra fetches");
});

// --- A4: recovery is seconds, not a 5-minute self-inflicted outage ----------
// Two windows on purpose: the SHORT failure backoff governs recovery when we can
// serve nobody; the LONG interval governs the optional rotation probe on a fresh
// cache. Reusing the long window for recovery would turn a 2s blip into a 5-min
// auth outage.
await r.check("cold cache + broken endpoint recovers within JWKS_FAILURE_BACKOFF_MS, not 5 minutes", async () => {
  const rec = makeJwksFetch(makeJwks(key1.publicJwk));
  const recEnv = envFor("https://synthetic.jwks/certs-recovery", rec.fetchImpl);
  rec.state.fail = true;
  const token = await signRs256({ privateKey: key1.privateKey, kid: "kid-1", payload: goodPayload() });

  const cold = await withFakeNow(0, () => authenticate(reqWithToken(token), recEnv));
  assert(cold.ok === false, "cold cache + broken endpoint must deny");
  assertEqual(cold.reason, KID_DENY, "denial from the key resolver (non-vacuity)");
  assertEqual(rec.state.calls, 1, "one cold attempt");

  const inside = await withFakeNow(BACKOFF_MS / 2, () => authenticate(reqWithToken(token), recEnv));
  assert(inside.ok === false, "inside the backoff window: still denied");
  assertEqual(rec.state.calls, 1, "inside the backoff window: no new fetch");

  // Endpoint recovers; one backoff window later a legitimate token works again.
  rec.state.fail = false;
  const after = await withFakeNow(BACKOFF_MS + 1000, () => authenticate(reqWithToken(token), recEnv));
  assertEqual(rec.state.calls, 2, "exactly one retry once the SHORT backoff elapsed");
  assert(
    after.ok === true,
    `recovery must take ~${BACKOFF_MS}ms, not JWKS_MIN_REFRESH_INTERVAL_MS; got ${JSON.stringify(after)}`,
  );
  assertEqual(after.principal.email, "clerk@hotel.example", "principal comes from the recovered key set");
});

// --- A5: at most ONE upstream fetch per request ACROSS BOTH windows ---------
// The only request shape in which both gates are reachable: the cache is
// EXPIRED (recovery gate opens), recovery SUCCEEDS (so the hard-expiry return is
// skipped), and the kid is STILL unknown (so the rotation gate is evaluated).
// The contract holds without a per-call flag only because the successful
// recovery sets lastAttemptAt = now, making the rotation gate's `now - now = 0`
// fall inside JWKS_MIN_REFRESH_INTERVAL_MS. Anything that evaluates the rotation
// gate against the PRE-refresh timestamp double-fetches here.
await r.check("expired cache + SUCCESSFUL recovery + unknown kid => ONE fetch total in that request", async () => {
  const both = makeJwksFetch(makeJwks(key1.publicJwk));
  const bothEnv = envFor("https://synthetic.jwks/certs-both-windows", both.fetchImpl);
  const good = await signRs256({ privateKey: key1.privateKey, kid: "kid-1", payload: longLived() });

  const warm = await authenticate(reqWithToken(good), bothEnv);
  assert(warm.ok === true, `warm-up must authenticate, got ${JSON.stringify(warm)}`);
  assertEqual(both.state.calls, 1, "one warm-up fetch");

  // Past the TTL, endpoint HEALTHY, kid genuinely unknown to the refreshed set.
  const unknown = await signRs256({
    privateKey: key1.privateKey,
    kid: "kid-not-in-any-jwks",
    payload: longLived(),
  });
  const before = both.state.calls;
  const denied = await withFakeNow(TTL_MS + 1000, () => authenticate(reqWithToken(unknown), bothEnv));
  assert(denied.ok === false, "unknown kid must still fail closed after a successful refresh");
  assertEqual(denied.reason, KID_DENY, "denial from the key resolver (non-vacuity)");
  assertEqual(
    both.state.calls - before,
    1,
    "EXACTLY ONE upstream fetch per request even when both the recovery and the rotation gate are reachable",
  );

  // That refresh left a FRESH cache: a legitimate token is now served with no
  // further upstream traffic at all.
  const before2 = both.state.calls;
  const accepted = await withFakeNow(TTL_MS + 1000, () => authenticate(reqWithToken(good), bothEnv));
  assert(accepted.ok === true, `refreshed cache must serve a legitimate token, got ${JSON.stringify(accepted)}`);
  assertEqual(both.state.calls - before2, 0, "ZERO extra fetches once the cache is fresh again");
});

r.done();
if (process.exitCode) process.exit(1);
console.log("PASSED: Worker Access-authentication contract completed.");
