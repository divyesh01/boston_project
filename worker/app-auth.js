// Server-backed application authentication for independent browser profiles.
// Passwords are verified in the Worker; only a random, revocable session token
// is returned, and it is returned solely as an HttpOnly cookie.

import { queryAll, queryFirst } from "./db.js";
import {
  createCredentialForEnv,
  credentialPepper,
  isSupportedCredential,
  PBKDF2_ITERATIONS,
  verifyCredentialForEnv,
} from "./password-credential.js";
import { verifyTotp } from "./totp.js";

const COOKIE_NAME = "__Host-rri_session";
const MFA_COOKIE_NAME = "__Host-rri_mfa";
const SESSION_MS = 12 * 60 * 60 * 1000;
const REMEMBER_SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const LOCK_AFTER_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;
const MFA_CHALLENGE_MS = 5 * 60 * 1000;
const encoder = new TextEncoder();

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function hex(bytes) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(value) {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

function parseNamedCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return "";
}

function parseCookie(request) { return parseNamedCookie(request, COOKIE_NAME); }

function sessionCookie(token, remember) {
  const maxAge = remember ? `; Max-Age=${Math.floor(REMEMBER_SESSION_MS / 1000)}` : "";
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict${maxAge}`;
}

function expiredCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

function mfaCookie(token) {
  return `${MFA_COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(MFA_CHALLENGE_MS / 1000)}`;
}

function sameOriginMutation(request) {
  if (request.headers.get("X-Requested-With") !== "XMLHttpRequest") return false;
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}

async function recordFailure(env, user, now) {
  const nowIso = now.toISOString();
  const lockedUntil = new Date(now.getTime() + LOCK_MS).toISOString();
  await env.DB.prepare(
    `UPDATE user
        SET failed_login_count=CASE WHEN locked_until IS NOT NULL AND locked_until<=? THEN 1 ELSE COALESCE(failed_login_count,0)+1 END,
            locked_until=CASE
              WHEN (CASE WHEN locked_until IS NOT NULL AND locked_until<=? THEN 1 ELSE COALESCE(failed_login_count,0)+1 END)>=? THEN ?
              ELSE NULL
            END,
            updated_date=?
      WHERE id=?`,
  ).bind(nowIso, nowIso, LOCK_AFTER_FAILURES, lockedUntil, nowIso, user.id).run();
}

async function login(request, env) {
  if (!sameOriginMutation(request)) return json({ error: "forbidden" }, 403);
  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid JSON body" }, 400); }
  const identifier = String(body?.identifier || "").trim().toLowerCase();
  const password = String(body?.password || "");
  const mfaSubmission = typeof body?.totpToken === "string" && body.totpToken.trim().length > 0;
  if (!identifier || (!mfaSubmission && !password) || identifier.length > 254 || password.length > 1024) {
    return json({ error: "Invalid email/username or password." }, 401);
  }
  const pepper = credentialPepper(env);
  if (!pepper) return json({ error: "authentication service unavailable" }, 503);

  const now = new Date();
  const nowIso = now.toISOString();
  const challengeToken = body?.totpToken ? parseNamedCookie(request, MFA_COOKIE_NAME) : "";
  const challengeHash = challengeToken ? await sha256(challengeToken) : "";
  let challenge = null;
  if (challengeHash) {
    challenge = await queryFirst(
      env,
      `SELECT c.id challenge_id,c.expires_at,u.*
         FROM app_mfa_challenge c JOIN user u ON u.id=c.user_id
        WHERE c.token_hash=? AND c.expires_at>? AND (lower(u.email)=? OR lower(u.username)=?) LIMIT 1`,
      [challengeHash, nowIso, identifier, identifier],
    );
  }
  let user = challenge;
  if (!user) {
    const candidates = await queryAll(
      env,
      "SELECT * FROM user WHERE lower(email)=? OR lower(username)=? LIMIT 2",
      [identifier, identifier],
    );
    user = candidates.length === 1 ? candidates[0] : null;
  }
  const lockedUntil = user?.locked_until ? Date.parse(String(user.locked_until)) : 0;
  // Unknown and disabled accounts still perform one full PBKDF2 derivation so
  // response timing does not become an account-enumeration oracle.
  const stored = String(user?.password_hash || "");
  const supportedCredential = isSupportedCredential(stored, env);
  const eligible = !!user && user.is_active !== 0 && user.is_locked !== 1 && lockedUntil <= now.getTime();
  // The MFA-challenge branch has already proven the password step; it holds a
  // single-use server-side challenge row instead of the plaintext, so there is
  // nothing to derive and nothing to upgrade.
  const verification = challenge
    ? { ok: supportedCredential, needsUpgrade: false }
    : await verifyCredentialForEnv(password, stored, env);
  const credentialMatches = verification.ok;
  if (!eligible || !credentialMatches) {
    if (eligible) await recordFailure(env, user, now);
    return json({ error: "Invalid email/username or password." }, 401);
  }

  if (user.mfa_enabled === 1) {
    if (!body?.totpToken) {
      const token = randomToken();
      const expiresAt = new Date(now.getTime() + MFA_CHALLENGE_MS).toISOString();
      await env.DB.batch([
        env.DB.prepare("DELETE FROM app_mfa_challenge WHERE expires_at<=? OR user_id=?").bind(nowIso, user.id),
        env.DB.prepare("INSERT INTO app_mfa_challenge (id,user_id,token_hash,expires_at) VALUES (?,?,?,?)")
          .bind(crypto.randomUUID(), user.id, await sha256(token), expiresAt),
      ]);
      return json(
        { require_mfa: true, userId: "mfa_pending", username: identifier },
        200,
        { "set-cookie": mfaCookie(token), "cache-control": "no-store" },
      );
    }
    const acceptedCounter = await verifyTotp(user.mfa_secret, body.totpToken, now.getTime());
    if (acceptedCounter === null || acceptedCounter <= Number(user.mfa_last_counter ?? -1)) {
      await recordFailure(env, user, now);
      return json({ error: "Invalid authentication code." }, 401);
    }
    const result = await env.DB.prepare(
      "UPDATE user SET mfa_last_counter=? WHERE id=? AND COALESCE(mfa_last_counter,-1)<?",
    ).bind(acceptedCounter, user.id, acceptedCounter).run();
    const changed = Number(result?.meta?.changes ?? result?.changes ?? 0);
    if (changed !== 1) return json({ error: "Invalid authentication code." }, 401);
    if (challenge?.challenge_id) {
      await env.DB.prepare("DELETE FROM app_mfa_challenge WHERE id=?").bind(challenge.challenge_id).run();
    }
  }

  // ---------------------------------------------------------------------------
  // Upgrade-on-login
  // ---------------------------------------------------------------------------
  // The plaintext is in hand and proven correct exactly once per successful sign
  // in, which is the only moment a stored credential can be re-derived at newer
  // parameters without asking its owner for anything. Rotating PASSWORD_PEPPER_V1
  // or raising the iteration count therefore drains the old population as people
  // sign in, instead of locking every one of them out at once.
  //
  // The UPDATE is a compare-and-swap on the credential we just verified. A
  // password change or a concurrent login that already upgraded the row changes
  // password_hash, the WHERE no longer matches, and this write does nothing
  // rather than overwriting the newer credential with one derived from a password
  // that is no longer current.
  //
  // A failure here NEVER fails the sign-in: the caller authenticated correctly
  // against what was stored, and re-deriving is an optimisation of the record,
  // not part of the authentication decision.
  if (verification.needsUpgrade && password) {
    try {
      const upgraded = await createCredentialForEnv(password, env);
      const upgradedResult = await env.DB.prepare(
        "UPDATE user SET password_hash=?,salt=?,updated_date=? WHERE id=? AND password_hash=?",
      ).bind(upgraded.encoded, upgraded.salt, nowIso, user.id, stored).run();
      if (Number(upgradedResult?.meta?.changes ?? upgradedResult?.changes ?? 0) === 1) {
        user.password_hash = upgraded.encoded;
      }
    } catch {
      /* keep the existing credential; the next sign-in will try again */
    }
  }

  const remember = body?.remember === true;
  const token = randomToken();
  const tokenHash = await sha256(token);
  const expiresAt = new Date(now.getTime() + (remember ? REMEMBER_SESSION_MS : SESSION_MS)).toISOString();
  const expectedCredential = String(user.password_hash || stored);
  const sessionId = crypto.randomUUID();
  const results = await env.DB.batch([
    env.DB.prepare("DELETE FROM app_session WHERE expires_at<=?").bind(now.toISOString()),
    env.DB.prepare(
      "UPDATE user SET failed_login_count=0,locked_until=NULL,last_login=?,updated_date=? WHERE id=? AND password_hash=? AND (is_active IS NULL OR is_active<>0) AND COALESCE(is_locked,0)=0 AND (locked_until IS NULL OR locked_until<=?)",
    ).bind(nowIso, nowIso, user.id, expectedCredential, nowIso),
    env.DB.prepare(
      "INSERT INTO app_session (id,user_id,token_hash,created_at,expires_at,last_seen_at,remember) SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM user WHERE id=? AND password_hash=? AND (is_active IS NULL OR is_active<>0) AND COALESCE(is_locked,0)=0 AND (locked_until IS NULL OR locked_until<=?))",
    ).bind(sessionId, user.id, tokenHash, nowIso, expiresAt, nowIso, remember ? 1 : 0, user.id, expectedCredential, nowIso),
  ]);
  const inserted = results?.[2];
  if (Number(inserted?.meta?.changes ?? inserted?.changes ?? 0) !== 1) {
    return json({ error: "Invalid email/username or password." }, 401);
  }
  return json({ authenticated: true }, 200, { "set-cookie": sessionCookie(token, remember), "cache-control": "no-store" });
}

async function logout(request, env) {
  if (!sameOriginMutation(request)) return json({ error: "forbidden" }, 403);
  const token = parseCookie(request);
  if (token) await env.DB.prepare("DELETE FROM app_session WHERE token_hash=?").bind(await sha256(token)).run();
  return json({ success: true }, 200, { "set-cookie": expiredCookie(), "cache-control": "no-store" });
}

/**
 * @returns {Promise<{ ok: false } | { ok: true, principal: import("./index.js").Principal }>}
 */
export async function authenticateAppSession(request, env) {
  const token = parseCookie(request);
  if (!token) return { ok: false };
  const tokenHash = await sha256(token);
  const now = new Date().toISOString();
  const row = await queryFirst(
    env,
    `SELECT s.id session_id,s.expires_at,s.remember,s.last_seen_at,u.id,u.email,u.is_active,u.is_locked,u.locked_until
       FROM app_session s JOIN user u ON u.id=s.user_id
      WHERE s.token_hash=? LIMIT 1`,
    [tokenHash],
  );
  if (!row || String(row.expires_at) <= now || row.is_active === 0 || row.is_locked === 1 || (row.locked_until && String(row.locked_until) > now)) {
    if (row?.session_id) {
      try {
        await env.DB.prepare("DELETE FROM app_session WHERE id=?").bind(row.session_id).run();
      } catch {}
    }
    return { ok: false };
  }
  const nowMs = Date.now();
  const lastSeenMs = row.last_seen_at ? new Date(row.last_seen_at).getTime() : 0;
  // 15-minute sliding-session hysteresis: decouple rapid polling from D1 writes
  if (nowMs - lastSeenMs >= 15 * 60 * 1000) {
    const slidingExpiry = new Date(nowMs + SESSION_MS).toISOString();
    try {
      await env.DB.prepare(
        "UPDATE app_session SET last_seen_at=?,expires_at=CASE WHEN remember=0 THEN ? ELSE expires_at END WHERE id=?",
      ).bind(now, slidingExpiry, row.session_id).run();
    } catch (touchError) {
      console.warn("Non-blocking session heartbeat update failed", touchError);
      // Fail-silent telemetry: allow authenticated read to continue even if heartbeat write fails
    }
  }
  return {
    ok: true,
    principal: {
      subject: String(row.id),
      email: String(row.email),
      sessionId: String(row.session_id),
    },
  };
}

export async function handleAppAuthRequest(request, env, pathname) {
  if (pathname === "/api/auth/login" && request.method === "POST") return login(request, env);
  if (pathname === "/api/auth/logout" && request.method === "POST") return logout(request, env);
  return json({ error: "not found" }, 404);
}

export function appSessionCookiePresent(request) { return !!parseCookie(request); }
export { COOKIE_NAME, PBKDF2_ITERATIONS, sameOriginMutation };
