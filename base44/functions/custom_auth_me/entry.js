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
    
    if (!user || !user.is_active || user.is_locked) {
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
    const timeRemaining = new Date(session.expires_at).getTime() - Date.now();
    if (timeRemaining < 3 * 24 * 60 * 60 * 1000) {
      const newExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      await base44.asServiceRole.entities.Session.update(session.id, { expires_at: newExpiry });
      // We don't necessarily need to resend the cookie since the client max-age is usually handled separately,
      // but it's good practice. For now, updating the DB is enough to keep it alive.
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

    return Response.json({ user: sanitizedUser });

  } catch (err) {
    console.error("Auth me error:", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
