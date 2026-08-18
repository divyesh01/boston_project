const db = globalThis.__B44_DB__ || { auth:{ isAuthenticated: async()=>false, me: async()=>null }, entities:new Proxy({}, { get:()=>({ filter:async()=>[], get:async()=>null, create:async()=>({}), update:async()=>({}), delete:async()=>({}) }) }), integrations:{ Core:{ UploadFile:async()=>({ file_url:'' }) } } };

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import * as crypto from 'node:crypto';

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);

    // Resolve the caller from the session cookie (same as every auth function).
    const cookieHeader = req.headers.get('cookie') || '';
    const cookieMatch = cookieHeader.match(/base44_session=([^;]+)/);
    const token = cookieMatch ? cookieMatch[1] : null;
    if (!token) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const sessions = await base44.asServiceRole.entities.Session.filter({ token_hash: tokenHash }, null, 1, 0);
    const session = sessions[0];
    if (!session || session.is_revoked || new Date(session.expires_at) < new Date()) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const user = await base44.asServiceRole.entities.User.get(session.user_id);
    if (!user || !user.is_active || user.is_locked) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const _csrfHeader = req.headers.get('x-csrf-token');
    const _cookieHeader = req.headers.get('cookie') || '';
    const _csrfCookieMatch = _cookieHeader.match(/__Host-csrf_token=([^;]+)/);
    const _csrfCookie = _csrfCookieMatch ? _csrfCookieMatch[1] : null;
    if (!_csrfHeader || !_csrfCookie || _csrfHeader !== _csrfCookie) {
      return Response.json({ error: "Invalid CSRF token" }, { status: 403 });
    }

    const body = await req.json();
    const fileId = body.fileId;
    const fileName = body.fileName || fileId;
    if (!fileId) return Response.json({ error: 'fileId required' }, { status: 400 });

    // IDOR mitigation: the caller may only import a Drive file they are
    // authorized for. Prefer an explicit UploadedReport linkage (verified to
    // belong to a property the caller can access and to match fileId); otherwise
    // require a property the caller can access. Without an authorization
    // context we refuse (fail closed).
    const allowedPropertyIds =
      user.property_access === 'all' || !Array.isArray(user.property_access)
        ? null
        : user.property_access.map(String);

    const uploadedReportId = body.uploadedReportId;
    if (uploadedReportId) {
      const report = await base44.asServiceRole.entities.UploadedReport.get(uploadedReportId);
      if (!report) return Response.json({ error: 'Unknown uploaded report' }, { status: 404 });
      if (allowedPropertyIds && !allowedPropertyIds.includes(String(report.property_id))) {
        return Response.json({ error: 'Forbidden: not authorized for this report' }, { status: 403 });
      }
      if (report.drive_file_id && report.drive_file_id !== fileId) {
        return Response.json({ error: 'Forbidden: fileId does not match the referenced report' }, { status: 403 });
      }
    } else if (body.propertyId) {
      if (allowedPropertyIds && !allowedPropertyIds.includes(String(body.propertyId))) {
        return Response.json({ error: 'Forbidden: not authorized for this property' }, { status: 403 });
      }
    } else {
      return Response.json(
        { error: 'Authorization context required: provide uploadedReportId or propertyId' },
        { status: 400 },
      );
    }

    const { accessToken } = await db.asServiceRole.connectors.getConnection("googledrive");

    const driveRes = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    if (!driveRes.ok) {
      const err = await driveRes.json().catch(() => ({}));
      return Response.json({ error: err.error?.message || "Failed to download file" }, { status: driveRes.status });
    }

    const blob = await driveRes.blob();
    const contentType = driveRes.headers.get("content-type") || "application/octet-stream";
    const file = new File([blob], fileName, { type: contentType });
    const { file_url } = await db.integrations.Core.UploadFile({ file });

    return Response.json({ file_url, fileName });
  } catch (error) {
    console.error("Import Drive file error:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}