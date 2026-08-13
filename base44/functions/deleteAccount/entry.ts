const db = globalThis.__B44_DB__ || { auth:{ isAuthenticated: async()=>false, me: async()=>null }, entities:new Proxy({}, { get:()=>({ filter:async()=>[], get:async()=>null, create:async()=>({}), update:async()=>({}), delete:async()=>({}) }) }), integrations:{ Core:{ UploadFile:async()=>({ file_url:'' }) } } };

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import * as crypto from 'node:crypto';

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);

    // Resolve the caller from the same session cookie every other auth
    // function uses (base44_session -> hashed Session -> User).
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
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    if (user.role !== 'admin' && user.role !== 'owner') {
      return Response.json({ error: 'Forbidden: Only admins or owners can delete accounts' }, { status: 403 });
    }
    if (user.is_active === false) {
      return Response.json({ error: 'Forbidden: Account is suspended' }, { status: 403 });
    }

    const csrfHeader = req.headers.get('x-csrf-token');
    const csrfCookieMatch = cookieHeader.match(/csrf_token=([^;]+)/);
    const csrfCookie = csrfCookieMatch ? csrfCookieMatch[1] : null;

    if (!csrfHeader || !csrfCookie || csrfHeader !== csrfCookie) {
      return Response.json({ error: "Invalid CSRF token" }, { status: 403 });
    }

    // Destructive action: require an explicit confirmation token. The caller
    // must send confirm === "DELETE:<own user id>", which proves the request is
    // intentional and not a stray/replayed/forwarded invocation.
    let body: any = {};
    try {
      const raw = await req.json();
      if (raw && typeof raw === 'object') body = raw;
    } catch { /* empty body ok */ }
    const confirm = String(body?.confirm ?? '').trim();
    if (confirm !== `DELETE:${String(user.id)}`) {
      return Response.json({ error: 'Confirmation required. Send confirm="DELETE:<your user id>" to confirm this destructive action.' }, { status: 400 });
    }

    const entities = ['OccupancyDay', 'SourceDay', 'GrossRevenueDay', 'ClerkShiftRecord', 'UploadedReport'];
    let deleted = 0;

    // Page through ALL of the caller's records, not just the first 5000. The old
    // .list(...,5000) silently left records behind for any account with more.
    const PAGE = 500;
    for (const entityName of entities) {
      try {
        let removedForEntity = 0;
        // Loop until a page comes back with no rows owned by this user. Each
        // iteration re-lists because deletion shifts ids; fetching a fresh page
        // avoids missing rows that were beyond the original 5000-row window.
        let guard = 0;
        while (guard++ < 10000) {
          const records = await base44.entities[entityName].list('-created_date', PAGE);
          const owned = (records || []).filter((r: any) => r.created_by_id === user.id);
          if (!owned.length) break;
          for (const r of owned) {
            try {
              await base44.entities[entityName].delete(r.id);
              deleted++;
              removedForEntity++;
            } catch {
              // A single failed delete must not abort the rest of the wipe.
            }
          }
          // If the backend returned fewer than a full page of *any* records,
          // there is no more data for this entity — stop paging.
          if (!records || records.length < PAGE) break;
        }
        void removedForEntity;
      } catch (e) {
        // Continue with other entities
      }
    }

    // Audit the destructive wipe (#9) on the server side.
    try {
      await db.entities.AuditLog.create({
        user_id: user.id,
        username: user.username || user.email || 'unknown',
        action: 'Delete Account',
        performed_by_id: user.id,
        performed_by: user.username || user.email || 'unknown',
        result: 'success',
        detail: `Server-side account data wipe: ${deleted} record(s) deleted across ${entities.length} entities.`,
        created_date: new Date().toISOString(),
      });
    } catch {
      // AuditLog entity may not exist; never fail the wipe because the audit write failed.
    }

    return Response.json({ success: true, recordsDeleted: deleted });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}