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
    if (!actor || !actor.is_active || actor.is_locked) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (actor.role !== 'owner' && actor.role !== 'admin') {
      return Response.json({ error: "Forbidden: Only owners and admins can clear audit logs" }, { status: 403 });
    }

    const csrfHeader = req.headers.get('x-csrf-token');
    const csrfCookieMatch = cookieHeader.match(/csrf_token=([^;]+)/);
    const csrfCookie = csrfCookieMatch ? csrfCookieMatch[1] : null;

    if (!csrfHeader || !csrfCookie || csrfHeader !== csrfCookie) {
      return Response.json({ error: "Invalid CSRF token" }, { status: 403 });
    }

    // Since this is a serverless function, we should delete all audit logs.
    // We can list and delete.
    let deleted = 0;
    const PAGE = 500;
    let guard = 0;
    while (guard++ < 1000) {
      const records = await base44.asServiceRole.entities.AuditLog.filter({}, null, PAGE, 0);
      if (!records || !records.length) break;
      for (const r of records) {
        try {
          await base44.asServiceRole.entities.AuditLog.delete(r.id);
          deleted++;
        } catch (e) {}
      }
      if (records.length < PAGE) break;
    }

    // Log the clear action
    try {
      await base44.asServiceRole.entities.AuditLog.create({
        user_id: actor.id,
        username: actor.username || actor.email || 'unknown',
        action: 'Audit Log Cleared',
        performed_by_id: actor.id,
        performed_by: actor.username || actor.email || 'unknown',
        result: 'success',
        detail: `Cleared ${deleted} audit logs.`,
        created_date: new Date().toISOString(),
      });
    } catch {}

    return Response.json({ success: true, recordsDeleted: deleted });

  } catch (err) {
    console.error("Audit clear error:", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
