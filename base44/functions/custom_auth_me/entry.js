import { createClientFromRequest } from "npm:@base44/sdk@^0.8.41";
import crypto from "node:crypto";

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    
    // Parse cookies from headers
    const cookieHeader = req.headers.get("cookie") || "";
    const match = cookieHeader.match(/base44_session=([^;]+)/);
    const token = match ? match[1] : null;

    if (!token) {
      return Response.json({ user: null }, { status: 401 });
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    // Fetch session
    const sessions = await base44.asServiceRole.entities.Session.filter({ token_hash: tokenHash }, null, 1, 0);
    const session = sessions[0];

    if (!session || session.is_revoked || new Date(session.expires_at) < new Date()) {
      return Response.json({ user: null }, { status: 401 });
    }

    // Fetch user
    const user = await base44.asServiceRole.entities.User.get(session.user_id);
    
    if (!user) {
      return Response.json({ user: null }, { status: 401 });
    }

    // Check absolute session lifetime (max 30 days)
    const sessionAge = Date.now() - new Date(session.created_date).getTime();
    if (sessionAge > 30 * 24 * 60 * 60 * 1000) {
      // Session has reached absolute max lifetime, revoke it.
      await base44.asServiceRole.entities.Session.update(session.id, { is_revoked: true });
      return Response.json({ user: null }, { status: 401 });
    }

    // Slide expiry if less than 3 days left
    //
    // The browser's copy of the cookie was written at login with Max-Age=7d and
    // the browser deletes it on that schedule regardless of what the Session row
    // says. So sliding the row alone left the two disagreeing: the server
    // believed the session was good for another week while the cookie carrying it
    // expired on the original clock, and the user was signed out mid-shift by a
    // session the database still considered live. Re-issuing the cookie with the
    // same Max-Age is what actually keeps the session alive.
    let refreshedCookie = null;
    const timeRemaining = new Date(session.expires_at).getTime() - Date.now();
    if (timeRemaining < 3 * 24 * 60 * 60 * 1000) {
      const newExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      await base44.asServiceRole.entities.Session.update(session.id, { expires_at: newExpiry });
      // Same token, same flags, same window as custom_auth_login issues — this is
      // a renewal, not a new session, and the absolute 30-day cap above still
      // ends it on schedule no matter how many times it slides. Any weakening of
      // these attributes here would silently downgrade every long-lived session.
      //
      // Defaults to Secure when the request URL cannot be parsed: dropping the
      // flag would let the renewed cookie travel in clear text, so an unreadable
      // URL must fail toward the stricter cookie, not the looser one.
      let isProd = true;
      try {
        isProd = !new URL(req.url).hostname.includes('localhost');
      } catch {
        isProd = true;
      }
      refreshedCookie = `base44_session=${token}; HttpOnly; Path=/; SameSite=Lax${isProd ? '; Secure' : ''}; Max-Age=${7 * 24 * 60 * 60}`;
    }

    // Return sanitized user (NO password_hash, salt, or mfa_secret)
    const sanitizedUser = {
      id: user.id,
      email: user.email,
      username: user.username,
      full_name: user.full_name,
      role: user.role,
      is_active: user.is_active,
      is_locked: user.is_locked,
      mfa_enabled: user.mfa_enabled,
      created_date: user.created_date,
      must_change_password: user.must_change_password,
      property_access: user.property_access,
      permissions: user.permissions
    };

    return Response.json(
      { user: sanitizedUser },
      // Only when the session actually slid: a Set-Cookie on every poll would
      // rewrite the cookie continuously and make its real lifetime unauditable.
      refreshedCookie ? { headers: { 'Set-Cookie': refreshedCookie } } : undefined
    );

  } catch (err) {
    console.error("Auth me error:", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
