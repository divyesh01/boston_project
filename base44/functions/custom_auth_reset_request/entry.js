import { createClientFromRequest } from "npm:@base44/sdk@^0.8.41";
import crypto from "node:crypto";
import { secrets } from "base44:runtime";

// ─── APP_ORIGIN_V1 ───────────────────────────────────────────────────────────
// Where this app lives, for links inside outgoing email.
//
// THE BUG THIS REPLACES. The reset mail said only "Use this token: <64 hex
// characters>". There was no link at all, so a person who had forgotten their
// password had to know to open the app, find the reset page, and paste a 64-
// character string by hand. In practice that means they call the owner, and the
// owner reads the code down the phone — a credential spoken aloud, because the
// mail did not contain a link.
//
// WHY NOT JUST USE THE `Host` HEADER. Because `Host` is supplied by whoever makes
// the request, and this endpoint is UNAUTHENTICATED — anyone can trigger it for
// any address. Build the link from `Host` and an attacker sends
// `Host: evil.example` with a victim's email; the victim receives an ordinary-
// looking reset mail whose link delivers their live token to the attacker. This
// file has already been burned by trusting `Host` once: `isLocalHost` below used
// to be `.includes('localhost')`, which `localhost.evil.com` satisfied. The
// origin must come from configuration the operator controls.
//
// FAIL SOFT, LOUDLY: with no `APP_BASE_URL` the mail still carries the code, so a
// reset is still possible; the log says why the link is missing.
//
// KEEP IN LOCKSTEP with custom_auth_register/entry.js. The base44 host gives these
// functions no way to share a module, so this helper necessarily exists in two
// copies; scripts/probe-auth-email-links.mjs fails if they drift.
function appOrigin() {
  const raw = secrets.get('APP_BASE_URL');
  if (!raw) return null;
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null;
  return url.origin;
}

/**
 * Whether this request came from a local development server.
 *
 * The reply hands the raw reset token back when it did, which is a real
 * convenience while there is no mail provider wired up locally — and a full
 * account takeover if the test is wrong. It was
 * `host?.includes('localhost') || host?.includes('127.0.0.1')`, and the Host
 * header is supplied by the caller: `localhost.evil.com`, `evil.com/?localhost`
 * and `my-localhost-cdn.net` all satisfy it. Anyone who could reach the
 * deployment could ask for any user's token and be given it directly, no mailbox
 * required.
 *
 * Matched exactly instead, against the whole host with an optional port.
 */
function isLocalHost(hostHeader) {
  const host = String(hostHeader || '').trim().toLowerCase();
  const name = host.startsWith('[')
    ? host.slice(0, host.indexOf(']') + 1)   // bracketed IPv6 literal, e.g. [::1]:5173
    : host.split(':')[0];
  return name === 'localhost' || name === '127.0.0.1' || name === '[::1]' || name === '::1';
}

/**
 * Bounded attempts per key in a 15-minute window. Returns true when the caller
 * is over the limit.
 *
 * This endpoint mints a fresh token, overwrites the stored one, and sends mail —
 * all for an unauthenticated caller who only has to name an address. Unlimited,
 * that is a way to flood a real person's inbox, and to invalidate the token they
 * are in the middle of using by re-minting it out from under them. Mirrors the
 * limiter in custom_auth_login/entry.js.
 *
 * Two keys are counted: the source IP, and the target address. The IP bound stops
 * one caller working through a list of addresses; the per-address bound stops a
 * distributed attempt hammering one mailbox, which per-IP counting cannot see.
 */
async function overLimit(base44, key, action, max) {
  const now = Date.now();
  const rows = await base44.asServiceRole.entities.RateLimit.filter({ ip: key, action }, null, 1, 0);
  const bucket = rows[0];
  if (bucket && new Date(bucket.reset_at).getTime() > now) {
    if ((bucket.count || 0) >= max) return { throttled: true, resetAt: bucket.reset_at };
    await base44.asServiceRole.entities.RateLimit.update(bucket.id, { count: (bucket.count || 0) + 1 });
    return { throttled: false };
  }
  const reset_at = new Date(now + 15 * 60 * 1000).toISOString();
  if (bucket) {
    await base44.asServiceRole.entities.RateLimit.update(bucket.id, { count: 1, reset_at });
  } else {
    await base44.asServiceRole.entities.RateLimit.create({ ip: key, action, count: 1, reset_at });
  }
  return { throttled: false };
}

export default async function (req) {
  try {
  const _csrfHeader = req.headers.get('x-csrf-token');
  const _cookieHeader = req.headers.get('cookie') || '';
  const _csrfCookieMatch = _cookieHeader.match(/__Host-csrf_token=([^;]+)/);
  const _csrfCookie = _csrfCookieMatch ? _csrfCookieMatch[1] : null;
  if (!_csrfHeader || !_csrfCookie || _csrfHeader !== _csrfCookie) {
    return Response.json({ error: "Invalid CSRF token" }, { status: 403 });
  }

    const base44 = createClientFromRequest(req);
    const body = await req.json();
    const { identifier } = body;

    if (!identifier) {
      return Response.json({ error: "Email is required" }, { status: 400 });
    }

    const email = String(identifier).toLowerCase();

    // Throttled BEFORE the account is looked up, so being refused says nothing
    // about whether the address exists — the same reason the not-found case below
    // answers success.
    const ip = req.headers.get('x-forwarded-for') || req.headers.get('remote-addr') || 'unknown';
    const ipLimit = await overLimit(base44, `ip:${ip}`, 'reset_request', 5);
    const resultLimit = ipLimit.throttled ? ipLimit : await overLimit(base44, `email:${email.slice(0, 120)}`, 'reset_request', 5);
    if (resultLimit.throttled) {
      const resetAtTime = new Date(resultLimit.resetAt).getTime();
      const retryAfter = isNaN(resetAtTime) ? 900 : Math.max(1, Math.ceil((resetAtTime - Date.now()) / 1000));
      return Response.json(
        { error: "Too many reset requests. Try again in a few minutes." },
        { status: 429, headers: { "Retry-After": String(retryAfter) } }
      );
    }

    const users = await base44.asServiceRole.entities.User.filter({ email }, null, 1, 0);
    const user = users[0];

    // Always return success even if user not found (prevent enumeration)
    if (!user || !user.is_active || user.is_locked) {
      return Response.json({ success: true });
    }

    // Generate reset token
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

    await base44.asServiceRole.entities.User.update(user.id, {
      reset_token_hash: tokenHash,
      reset_token_expires_at: expiresAt
    });

    // See APP_ORIGIN_V1 at the top of this file: the origin comes from
    // configuration, never from the request's Host header.
    const origin = appOrigin();
    const resetPath = `/reset-password?token=${encodeURIComponent(token)}`;
    const emailBody = origin
      ? [
          `Someone asked to reset the password for this account.`,
          ``,
          `Reset it here (the link works once, and expires in 1 hour):`,
          `${origin}${resetPath}`,
          ``,
          `If that was not you, ignore this message — nothing has changed yet.`,
        ].join('\n')
      : [
          `Someone asked to reset the password for this account.`,
          ``,
          `Open the app, go to "Reset password", and paste this one-time code:`,
          token,
          ``,
          `It works once and expires in 1 hour.`,
          `If that was not you, ignore this message — nothing has changed yet.`,
        ].join('\n');

    if (!origin) {
      console.warn('[custom_auth_reset_request] APP_BASE_URL is not configured — reset email sent with a pasteable code instead of a link.');
    }

    try {
      await base44.asServiceRole.integrations.Core.SendEmail({
        to: user.email,
        subject: "Password Reset Request",
        body: emailBody,
      });
    } catch (emailErr) {
      console.error("Failed to send reset email:", emailErr);
    }

    return Response.json({ success: true, ...(isLocalHost(req.headers.get('host')) ? { token } : {}) });

  } catch (err) {
    console.error("Password reset request error:", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
