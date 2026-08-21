import { createClientFromRequest } from "npm:@base44/sdk@^0.8.41";
import crypto from "node:crypto";

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

    try {
      await base44.asServiceRole.integrations.Core.SendEmail({
        to: user.email,
        subject: "Password Reset Request",
        body: `You requested a password reset. Use this token: ${token}`
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
