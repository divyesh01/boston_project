// ===========================================================================
// worker/auth.js — Cloudflare Access JWT validation (fail-closed).
//
// REAL Cloudflare Access verification is BLOCKED/UNPROVEN until Access is
// enabled on this Worker; the logic here is validated ONLY against synthetic
// JWKS/tokens (Agent C's harness). Workers-with-assets do NOT receive a
// pre-parsed `ctx.access`, so this module validates the `CF_Authorization`
// JWT itself with WebCrypto.
//
// Contract (fail closed on ANY deviation):
//   * Token from `CF_Authorization` cookie OR `Cf-Access-Jwt-Assertion` header.
//   * JWKS from `${ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs` (override via
//     `env.ACCESS_CERTS_URL`), cached in module scope with a HARD TTL; an
//     unknown `kid` triggers at most ONE throttled refresh, then denies. A key
//     set whose freshness cannot be re-established within JWKS_TTL_MS is
//     DISCARDED, not honored: a certs outage longer than the TTL denies auth
//     deliberately (fail closed), rather than pinning a possibly-revoked key.
//   * RS256 ONLY. The header's self-declared `alg` is checked to equal
//     'RS256' and is NEVER used to select the algorithm — RSASSA-PKCS1-v1_5 /
//     SHA-256 is hardcoded. `none`, `HS256`, anything else => deny.
//   * `aud` must contain `ACCESS_AUD` (string or array); `iss` must equal the
//     team domain issuer; `exp` present and future; `nbf`/`iat` honored — all
//     with ~60s clock-skew leeway.
//   * Identity comes ONLY from the verified `email`/`sub` claims, never from
//     the `Cf-Access-Authenticated-User-Email` header.
//
// No import from src/ — Cloudflare Workers runtime.
// ===========================================================================

/**
 * @typedef {import("./index.js").Env} Env
 * @typedef {import("./index.js").Principal} Principal
 */

/**
 * Result of an authentication attempt. Never throws into the caller: a failure
 * is a typed value, so a bug cannot be swallowed by a `catch` into an allow.
 * @typedef {{ ok: true, principal: Principal } | { ok: false, reason: string }} AuthResult
 */

/** Clock-skew leeway, in seconds, applied to exp/nbf/iat. */
const CLOCK_SKEW_SEC = 60;

/**
 * JWKS cache TTL: 1 hour. This is a HARD expiry on the last SUCCESSFUL fetch,
 * not a hint: once it lapses, the cached key set is no longer accepted, so a
 * rotated or REVOKED key set cannot be pinned forever — not even by an
 * unreachable certs endpoint (see getSigningKey).
 */
const JWKS_TTL_MS = 60 * 60 * 1000;

/**
 * Minimum interval between unknown-kid ROTATION PROBES against a cache that is
 * still FRESH (last successful fetch inside the TTL). In that state every
 * legitimate token still verifies, so refreshing is OPTIONAL — throttle it hard.
 * Bogus/unknown-kid requests arriving inside this window are denied WITHOUT a
 * fetch, so an attacker spamming random kids cannot amplify upstream traffic.
 * Well under the TTL so a genuine key rotation is still picked up promptly.
 */
const JWKS_MIN_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Minimum interval between RECOVERY attempts when the cache is EXPIRED or has
 * NEVER succeeded. That state is categorically different from the one above: we
 * can serve NOBODY, so every request is already being denied and recovery is
 * urgent. Reusing the 5-minute rotation throttle here would convert a 2-second
 * upstream blip into a 5-minute auth outage — a self-inflicted availability
 * cliff. Hence: throttle harder when we can still serve, retry faster when we
 * cannot.
 *
 * Amplification stays bounded. While the certs endpoint is down, 10k requests
 * per minute cause at most ~6 upstream fetches per minute (one per backoff
 * window), not 10k — a ~1600x reduction, in the one condition that actually
 * matters (an already-unhealthy upstream). Do NOT "tighten" this back toward
 * JWKS_MIN_REFRESH_INTERVAL_MS: the remaining amplification is negligible and
 * the cost of the cliff is a total auth outage.
 */
const JWKS_FAILURE_BACKOFF_MS = 10 * 1000;

/**
 * One cached JWKS document plus its two INDEPENDENT clocks.
 *   * `fetchedAt`      — last SUCCESSFUL fetch (0 = never succeeded). Governs
 *                        freshness/TTL, i.e. whether `keys` may be TRUSTED.
 *   * `lastAttemptAt`  — last ATTEMPT, success or failure. Governs the throttle,
 *                        i.e. whether another upstream fetch is ALLOWED.
 * Keeping them separate is what makes the throttle survive an upstream outage:
 * a failed fetch advances `lastAttemptAt` while leaving `fetchedAt` behind, so
 * the next request is throttled instead of amplifying 1:1 onto a broken origin.
 * @typedef {{ fetchedAt: number, lastAttemptAt: number, keys: Map<string, JsonWebKey> }} JwksCacheEntry
 */

/**
 * Module-scope JWKS cache, keyed by certs URL.
 * @type {Map<string, JwksCacheEntry>}
 */
const jwksCache = new Map();

/**
 * Authenticate a request against Cloudflare Access.
 * @param {Request} request
 * @param {Env} env
 * @returns {Promise<AuthResult>}
 */
export async function authenticate(request, env) {
  try {
    const token = extractToken(request);
    if (!token) return deny("missing token");
    if (!env || !env.ACCESS_AUD || !env.ACCESS_TEAM_DOMAIN) {
      return deny("access not configured");
    }

    const parts = token.split(".");
    if (parts.length !== 3) return deny("malformed token");
    const [rawHeader, rawPayload, rawSig] = parts;

    /** @type {{ alg?: string, kid?: string, typ?: string }} */
    let header;
    try {
      header = JSON.parse(decodeUtf8(base64urlToBytes(rawHeader)));
    } catch {
      return deny("unparseable header");
    }
    // PIN the algorithm. Do NOT let the header choose it.
    if (header.alg !== "RS256") return deny(`unsupported alg: ${String(header.alg)}`);
    if (!header.kid) return deny("missing kid");

    // Resolve the signing key. getSigningKey performs AT MOST ONE upstream
    // fetch per request (no cold-cache double-fetch) and throttles ATTEMPTS —
    // including failed ones — so bogus tokens cannot amplify traffic to the
    // certs endpoint even while that endpoint is unhealthy. An unknown kid, or
    // a key set too old to be re-verified, fails closed.
    const key = await getSigningKey(env, header.kid);
    if (!key) return deny("unknown or unverifiable kid");

    // Verify the signature over the exact ASCII bytes `header.payload`.
    const signedData = new TextEncoder().encode(`${rawHeader}.${rawPayload}`);
    let sigBytes;
    try {
      sigBytes = base64urlToBytes(rawSig);
    } catch {
      return deny("bad signature encoding");
    }
    const valid = await crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5" },
      key,
      /** @type {BufferSource} */ (sigBytes),
      /** @type {BufferSource} */ (signedData),
    );
    if (!valid) return deny("bad signature");

    /** @type {Record<string, unknown>} */
    let payload;
    try {
      payload = JSON.parse(decodeUtf8(base64urlToBytes(rawPayload)));
    } catch {
      return deny("unparseable payload");
    }

    const claimCheck = verifyClaims(payload, env);
    if (claimCheck.ok === false) return deny(claimCheck.reason);

    const email = typeof payload.email === "string" ? payload.email.trim() : "";
    const subject = typeof payload.sub === "string" ? payload.sub : "";
    if (!email) return deny("missing email claim");
    if (!subject) return deny("missing sub claim");

    return { ok: true, principal: { subject, email } };
  } catch (err) {
    // Any unexpected error is a denial, never an allow.
    return deny(`auth error: ${err instanceof Error ? err.message : "unknown"}`);
  }
}

/**
 * Validate the registered claims against the configured Access app.
 * @param {Record<string, unknown>} payload
 * @param {Env} env
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function verifyClaims(payload, env) {
  const nowSec = Math.floor(Date.now() / 1000);

  // aud may be a string or an array; ACCESS_AUD must be present in it.
  const aud = payload.aud;
  const audList = Array.isArray(aud) ? aud : typeof aud === "string" ? [aud] : [];
  if (!audList.includes(env.ACCESS_AUD)) return deny("aud mismatch");

  // iss must equal the team-domain issuer (with or without an explicit scheme).
  const iss = typeof payload.iss === "string" ? payload.iss : "";
  if (!acceptableIssuers(env.ACCESS_TEAM_DOMAIN).includes(iss)) return deny("iss mismatch");

  // exp is REQUIRED and must be in the future (with leeway).
  if (typeof payload.exp !== "number") return deny("missing exp");
  if (nowSec >= payload.exp + CLOCK_SKEW_SEC) return deny("token expired");

  // nbf / iat are optional; honor them with the same leeway if present.
  if (typeof payload.nbf === "number" && nowSec + CLOCK_SKEW_SEC < payload.nbf) {
    return deny("token not yet valid");
  }
  if (typeof payload.iat === "number" && nowSec + CLOCK_SKEW_SEC < payload.iat) {
    return deny("token issued in the future");
  }
  return { ok: true };
}

/**
 * Read the Access JWT from the cookie or the assertion header. Returns null if
 * neither is present.
 * @param {Request} request
 * @returns {string | null}
 */
function extractToken(request) {
  const headerToken = request.headers.get("Cf-Access-Jwt-Assertion");
  if (headerToken && headerToken.trim()) return headerToken.trim();

  const cookie = request.headers.get("Cookie") || "";
  for (const part of cookie.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name === "CF_Authorization") {
      const value = part.slice(eq + 1).trim();
      return value || null;
    }
  }
  return null;
}

/**
 * Fetch (and cache) the JWKS, then return an imported CryptoKey for `kid`.
 *
 * Fetch discipline (F1 — DoS amplification + "at most one fetch" contract):
 *   * Every upstream ATTEMPT — successful or failed — advances `lastAttemptAt`,
 *     so the throttle holds even while the certs endpoint is down. A failed cold
 *     fetch still records an entry (`fetchedAt: 0`, empty keys) purely to carry
 *     `lastAttemptAt`, which is what stops a bogus-kid flood from amplifying
 *     1:1 onto an already-unhealthy origin.
 *   * TWO windows, because the two situations have opposite urgency: an EXPIRED
 *     or never-populated cache serves nobody, so it retries on the short
 *     JWKS_FAILURE_BACKOFF_MS; a FRESH cache still serves every legitimate
 *     token, so its optional unknown-kid rotation probe waits the long
 *     JWKS_MIN_REFRESH_INTERVAL_MS.
 *   * A first-ever cold request (no entry at all) is never throttled: it gets
 *     exactly ONE population fetch.
 *   * At most ONE upstream fetch per request, and the two windows preserve it.
 *     The recovery attempt sets `lastAttemptAt = now`; if it SUCCEEDED the
 *     rotation gate then evaluates `now - now = 0`, inside the 5-minute window,
 *     so it cannot fire; if it FAILED the entry is still expired and the hard
 *     expiry below returns before the rotation gate is reached. No per-call flag
 *     is needed.
 *
 * Freshness discipline (F4 — no honoring an unverifiable key set):
 *   * `keys` are trusted ONLY while the last SUCCESSFUL fetch is within
 *     JWKS_TTL_MS. Past that, with no successful refresh, we return null =>
 *     DENY. A certs outage lasting longer than the TTL therefore causes auth
 *     denial, DELIBERATELY: a revoked key set must not keep validating tokens
 *     just because we cannot reach the issuer to learn it was revoked.
 *   * Any path ends fail-closed: unknown/unverifiable kid => null => DENY.
 * @param {Env} env
 * @param {string} kid
 * @returns {Promise<CryptoKey | null>}
 */
async function getSigningKey(env, kid) {
  const url = certsUrl(env);
  let entry = jwksCache.get(url);
  const now = Date.now();

  // Cold cache or lapsed TTL: we can serve NOBODY, so attempt recovery on the
  // SHORT backoff — throttled on the last ATTEMPT (never on the last success,
  // which was the amplification bug), but not for minutes at a time. A
  // first-ever request has no entry and is deliberately not throttled at all.
  if (isExpired(entry, now) && mayAttemptRecovery(entry, now)) {
    entry = await attemptJwksRefresh(env, url, entry, now);
  }

  // HARD expiry. We could not establish freshness, so we do not verify against
  // this key set at all — fail closed instead of honoring possibly-revoked keys.
  if (isExpired(entry, now)) return null;
  const fresh = /** @type {JwksCacheEntry} */ (entry);

  if (fresh.keys.has(kid)) {
    return importSigningKey(/** @type {JsonWebKey} */ (fresh.keys.get(kid)));
  }

  // Unknown kid on a FRESH cache: keys may have rotated. This probe is OPTIONAL
  // (every legitimate token still verifies), so it waits the LONG window — which
  // also guarantees we did not already fetch during this call.
  if (mayProbeRotation(fresh, now)) {
    const refreshed = await attemptJwksRefresh(env, url, fresh, now);
    if (!isExpired(refreshed, now) && refreshed.keys.has(kid)) {
      return importSigningKey(/** @type {JsonWebKey} */ (refreshed.keys.get(kid)));
    }
  }

  // Fail closed: unknown kid after the single allowed (or throttled) refresh.
  return null;
}

/**
 * True when there is no usable, in-TTL key set: the entry is absent, or its last
 * SUCCESSFUL fetch (0 = never) is older than JWKS_TTL_MS.
 * @param {JwksCacheEntry | undefined} entry
 * @param {number} now
 * @returns {boolean}
 */
function isExpired(entry, now) {
  return !entry || now - entry.fetchedAt > JWKS_TTL_MS;
}

/**
 * True when a RECOVERY fetch is permitted for an expired/never-populated cache:
 * no entry at all (first-ever cold request) or the last ATTEMPT is outside the
 * SHORT failure backoff. Short on purpose — while this is false we deny everyone.
 * @param {JwksCacheEntry | undefined} entry
 * @param {number} now
 * @returns {boolean}
 */
function mayAttemptRecovery(entry, now) {
  return !entry || now - entry.lastAttemptAt >= JWKS_FAILURE_BACKOFF_MS;
}

/**
 * True when an OPTIONAL unknown-kid rotation probe is permitted against a fresh
 * cache: the last ATTEMPT is outside the LONG refresh interval. Long on purpose —
 * while this is false we still serve every legitimate token.
 * @param {JwksCacheEntry} entry
 * @param {number} now
 * @returns {boolean}
 */
function mayProbeRotation(entry, now) {
  return now - entry.lastAttemptAt >= JWKS_MIN_REFRESH_INTERVAL_MS;
}

/**
 * Perform ONE upstream JWKS attempt and cache the outcome. `lastAttemptAt` is
 * recorded EITHER WAY, so a failure throttles the next request exactly like a
 * success does (on the shorter recovery backoff while the cache is unusable).
 * On failure the previous key set and its `fetchedAt` are kept verbatim (still
 * subject to the hard TTL); a failed cold attempt yields `fetchedAt: 0` with no
 * keys, which is expired by construction => DENY.
 * @param {Env} env
 * @param {string} url
 * @param {JwksCacheEntry | undefined} previous
 * @param {number} attemptAt
 * @returns {Promise<JwksCacheEntry>}
 */
async function attemptJwksRefresh(env, url, previous, attemptAt) {
  const keys = await fetchJwks(env, url);
  /** @type {JwksCacheEntry} */
  const entry = keys
    ? { fetchedAt: attemptAt, lastAttemptAt: attemptAt, keys }
    : {
        fetchedAt: previous ? previous.fetchedAt : 0,
        lastAttemptAt: attemptAt,
        keys: previous ? previous.keys : new Map(),
      };
  jwksCache.set(url, entry);
  return entry;
}

/**
 * Import a JWK as an RS256 verify key. Returns null (never throws) on failure.
 * @param {JsonWebKey} jwk
 * @returns {Promise<CryptoKey | null>}
 */
async function importSigningKey(jwk) {
  try {
    return await crypto.subtle.importKey(
      "jwk",
      { ...jwk, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
  } catch {
    return null;
  }
}

/**
 * Fetch the JWKS document and index its RSA signing keys by `kid`. Returns null
 * (never throws) on any failure. Deliberately timestamp-free: the caller owns
 * both cache clocks, so success and failure cannot disagree about "when".
 * @param {Env} env
 * @param {string} url
 * @returns {Promise<Map<string, JsonWebKey> | null>}
 */
async function fetchJwks(env, url) {
  const doFetch = env.FETCH || fetch;
  try {
    const res = await doFetch(url);
    if (!res || !res.ok) return null;
    const body = /** @type {{ keys?: (JsonWebKey & { kid?: string })[] }} */ (await res.json());
    if (!body || !Array.isArray(body.keys)) return null;
    /** @type {Map<string, JsonWebKey>} */
    const keys = new Map();
    for (const jwk of body.keys) {
      if (jwk && jwk.kty === "RSA" && typeof jwk.kid === "string") {
        keys.set(jwk.kid, jwk);
      }
    }
    return keys;
  } catch {
    return null;
  }
}

/**
 * The certs URL, honoring the `env.ACCESS_CERTS_URL` test override.
 * @param {Env} env
 * @returns {string}
 */
function certsUrl(env) {
  if (env.ACCESS_CERTS_URL) return env.ACCESS_CERTS_URL;
  return `${normalizeTeamDomain(env.ACCESS_TEAM_DOMAIN)}/cdn-cgi/access/certs`;
}

/**
 * Normalize the configured team domain to an origin with an explicit scheme
 * and no trailing slash.
 * @param {string} teamDomain
 * @returns {string}
 */
function normalizeTeamDomain(teamDomain) {
  const trimmed = String(teamDomain || "").replace(/\/+$/, "");
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

/**
 * The set of issuer strings we accept: the configured value verbatim and its
 * scheme-normalized origin.
 * @param {string} teamDomain
 * @returns {string[]}
 */
function acceptableIssuers(teamDomain) {
  const raw = String(teamDomain || "").replace(/\/+$/, "");
  const normalized = normalizeTeamDomain(teamDomain);
  return raw === normalized ? [normalized] : [raw, normalized];
}

/**
 * @param {string} reason
 * @returns {{ ok: false, reason: string }}
 */
function deny(reason) {
  return { ok: false, reason };
}

/**
 * Decode a base64url string to bytes.
 * @param {string} b64url
 * @returns {Uint8Array}
 */
function base64urlToBytes(b64url) {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const binary = atob(b64 + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function decodeUtf8(bytes) {
  return new TextDecoder().decode(bytes);
}
