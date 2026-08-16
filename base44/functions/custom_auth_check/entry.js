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

    // DO NOT SLIDE EXPIRY. This is a read-only auth check.

    // Return sanitized user (NO password_hash, salt, or mfa_secret)
    const sanitizedUser = {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      is_active: user.is_active,
      is_locked: user.is_locked,
      mfa_enabled: user.mfa_enabled,
      property_access: user.property_access,
      failed_login_count: user.failed_login_count
    };

    return Response.json({ user: sanitizedUser });
  } catch (err) {
    return Response.json({ user: null }, { status: 500 });
  }
}
