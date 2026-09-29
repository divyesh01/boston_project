import { createClientFromRequest } from 'npm:@base44/sdk@^0.8.41';
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

    // Authorization: listing Drive files connects to the organization's Google Drive.
    // The caller must:
    //   1. Be an active owner or admin (full access by design), OR
    //   2. Have the import_reports permission (or default role permitting import), AND
    //      have at least one authorized property assigned (fail-closed).
    const isRoot = user.role === 'owner' || user.role === 'admin';
    const hasImportPermission = isRoot || (
      user.permissions?.import_reports === true ||
      (user.permissions?.import_reports !== false && user.role !== 'read_only' && user.role !== 'accountant')
    );
    if (!hasImportPermission) {
      return Response.json({ error: 'Forbidden: import permission required' }, { status: 403 });
    }

    const hasPropertyAccess = isRoot || user.property_access === 'all' || (
      Array.isArray(user.property_access) && user.property_access.length > 0
    );
    if (!hasPropertyAccess) {
      return Response.json({ error: 'Forbidden: no property access assigned' }, { status: 403 });
    }

    const { accessToken } = await base44.asServiceRole.connectors.getConnection("googledrive");

    const url = new URL("https://www.googleapis.com/drive/v3/files");
    url.searchParams.set("q", "trashed=false and (mimeType contains 'spreadsheet' or mimeType='text/csv' or mimeType='application/vnd.ms-excel')");
    url.searchParams.set("fields", "files(id,name,mimeType,modifiedTime,size)");
    url.searchParams.set("orderBy", "modifiedTime desc");
    url.searchParams.set("pageSize", "50");

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return Response.json({ error: err.error?.message || "Failed to list Drive files" }, { status: res.status });
    }

    const data = await res.json();
    return Response.json({ files: data.files || [] });
  } catch (error) {
    console.error("List Drive files error:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}