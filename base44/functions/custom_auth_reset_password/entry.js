import { createClientFromRequest } from "npm:@base44/sdk@^0.8.41";
import crypto from "node:crypto";

async function hashPasswordScrypt(password, saltHex) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, saltHex, 64, { N: 16384, r: 8, p: 1 }, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey.toString('hex'));
    });
  });
}

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
    const { token, newPassword } = body;

    if (!token || !newPassword) {
      return Response.json({ error: "Token and new password are required" }, { status: 400 });
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const users = await base44.asServiceRole.entities.User.filter({ reset_token_hash: tokenHash }, null, 1, 0);
    const user = users[0];

    if (!user || !user.is_active || user.is_locked || new Date(user.reset_token_expires_at) < new Date()) {
      return Response.json({ error: "Invalid or expired reset token" }, { status: 400 });
    }

    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = '$scrypt$' + await hashPasswordScrypt(newPassword, salt);

    await base44.asServiceRole.entities.User.update(user.id, {
      password_hash: passwordHash,
      salt: salt,
      reset_token_hash: null,
      reset_token_expires_at: null,
      must_change_password: false,
      failed_login_count: 0,
      is_locked: false
    });

    return Response.json({ success: true });

  } catch (err) {
    console.error("Password reset error:", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
