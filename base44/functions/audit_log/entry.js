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

    // CSRF Protection
    const csrfHeader = req.headers.get('x-csrf-token');
    const csrfCookieMatch = cookieHeader.match(/csrf_token=([^;]+)/);
    const csrfCookie = csrfCookieMatch ? csrfCookieMatch[1] : null;

    if (!csrfHeader || !csrfCookie || csrfHeader !== csrfCookie) {
      return Response.json({ error: "Invalid CSRF token" }, { status: 403 });
    }

    const payload = await req.json();

    // Enforce that the user is only logging for themselves
    if (String(payload.user_id) !== String(session.user_id)) {
      return Response.json({ error: "Forbidden: Cannot log for another user" }, { status: 403 });
    }

    // Write audit log entry securely on the server
    const entry = await base44.asServiceRole.entities.AuditLog.create({
      user_id: payload.user_id,
      username: payload.username,
      action: payload.action,
      performed_by_id: payload.performed_by_id,
      performed_by: payload.performed_by,
      ip_address: req.headers.get('x-forwarded-for') || 'unknown',
      device: payload.device || 'unknown',
      property_id: payload.property_id || null,
      property_name: payload.property_name || null,
      result: payload.result || 'success',
      detail: payload.detail || '',
      created_date: new Date().toISOString(),
      hash: payload.hash || null,
      previous_hash: payload.previous_hash || null,
    });

    return Response.json({ success: true, entry });

  } catch (err) {
    console.error("Audit log error:", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
