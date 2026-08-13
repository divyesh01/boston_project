import { createClientFromRequest } from "npm:@base44/sdk@^0.8.41";
import crypto from "node:crypto";

export default async function (req) {
  try {
  const _csrfHeader = req.headers.get('x-csrf-token');
  const _cookieHeader = req.headers.get('cookie') || '';
  const _csrfCookieMatch = _cookieHeader.match(/csrf_token=([^;]+)/);
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
    const users = await base44.asServiceRole.entities.User.filter({ email }, null, 1, 0);
    const user = users[0];

    // Always return success even if user not found (prevent enumeration)
    if (!user || !user.is_active || user.is_locked) {
      return Response.json({ success: true });
    }

    // Generate reset token
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 mins

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

    return Response.json({ success: true });

  } catch (err) {
    console.error("Password reset request error:", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
