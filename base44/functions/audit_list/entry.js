import { createClientFromRequest } from "npm:@base44/sdk@^0.8.41";

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    
    // Check caller authentication
    const cookieHeader = req.headers.get("cookie") || "";
    const match = cookieHeader.match(/base44_session=([^;]+)/);
    const token = match ? match[1] : null;

    if (!token) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const crypto = await import('node:crypto');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const sessions = await base44.asServiceRole.entities.Session.filter({ token_hash: tokenHash }, null, 1, 0);
    const session = sessions[0];

    if (!session || session.is_revoked || new Date(session.expires_at) < new Date()) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const actor = await base44.asServiceRole.entities.User.get(session.user_id);
    if (!actor || !actor.is_active || actor.is_locked || (actor.role !== 'owner' && actor.role !== 'admin')) {
      return Response.json({ error: "Forbidden: Only owners and admins can list audit logs" }, { status: 403 });
    }

    const payload = await req.json();
    const filter = payload.filter || {};
    const limit = payload.limit || 500;

    const logs = await base44.asServiceRole.entities.AuditLog.filter(filter, null, limit, 0);

    return Response.json({ success: true, logs });

  } catch (err) {
    console.error("Audit list error:", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
