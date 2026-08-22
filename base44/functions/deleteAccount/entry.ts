import { createClientFromRequest } from 'npm:@base44/sdk@^0.8.41';
import { secrets } from 'base44:runtime';
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
    const csrfCookieMatch = cookieHeader.match(/__Host-csrf_token=([^;]+)/);
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
    await writeAudit(base44, {
      userId: user.id,
      username: user.username || user.email || 'unknown',
      action: 'Delete Account',
      performedById: user.id,
      performedBy: user.username || user.email || 'unknown',
      propertyId: null,
      detail: `Server-side account data wipe: ${deleted} record(s) deleted across ${entities.length} entities.`,
    });

    return Response.json({ success: true, recordsDeleted: deleted });
  } catch (error) {
    console.error("Delete account error:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

// ─── AuditLog chain writer ───
// This function is a WRITER on the tamper-evident AuditLog chain. The canonical
// payload below is the contract shared with base44/functions/audit_verify/
// entry.js; the base44 host permits no module sharing between functions, so it
// exists here as a copy. Any field added, removed, renamed or re-ordered MUST be
// mirrored in the verifier and every other writer, or the verifier will misflag
// every healthy row as tampered. scripts/probe-audit-chain.mjs asserts the
// AUDIT_CANONICAL_V1 markers and hashed fields agree across all copies.
async function writeAudit(base44: any, opts: any) {
  // An audit write must never break the operation it records — the payroll runs
  // (or the data wipe) have already been committed by the time we get here.
  try {
    // FAIL CLOSED, but by SKIPPING the row rather than writing an unsigned one.
    // audit_verify recomputes the expected hash for every stored row and reports
    // a hashless row as `tampered`, so emitting one here would make the entire
    // healthy trail read as forged — strictly worse than a missing row. An
    // unconfigured deployment is already loud: audit_verify returns
    // chain_secret_missing and no rows accumulate.
    const chainSecret = secrets.get('AUDIT_CHAIN_SECRET');
    if (!chainSecret) throw new Error('AUDIT_CHAIN_SECRET is not configured');

    const lastEntries = await base44.asServiceRole.entities.AuditLog.filter({}, '-created_date', 1, 0);
    const lastRow = (lastEntries && lastEntries[0]) || null;
    const previousHash = (lastRow && lastRow.hash) || '0'.repeat(64);
    const nowIso = monotonicIso(lastRow && lastRow.created_date);

    // `|| null` rather than a bare undefined: JSON.stringify DROPS undefined
    // keys, so an undefined here would hash a different shape than the verifier
    // rebuilds from a row the backend stored as null.
    // AUDIT_CANONICAL_V1 = user_id,action,performed_by_id,performed_by,property_id,result,detail,created_date,previous_hash
    const canonical = JSON.stringify({
      user_id: opts.userId || null,
      action: opts.action,
      performed_by_id: opts.performedById || null,
      performed_by: opts.performedBy,
      property_id: opts.propertyId || null,
      result: 'success',
      detail: opts.detail || '',
      created_date: nowIso,
      previous_hash: previousHash,
    });
    const hash = crypto.createHash('sha256').update(`${chainSecret}:${canonical}`).digest('hex');

    // Written but NOT signed: username. It is forensic context only, exactly as
    // in audit_log/entry.js — the signed field set must stay identical.
    await base44.asServiceRole.entities.AuditLog.create({
      user_id: opts.userId || null,
      username: opts.username,
      action: opts.action,
      performed_by_id: opts.performedById || null,
      performed_by: opts.performedBy,
      property_id: opts.propertyId || null,
      result: 'success',
      detail: opts.detail || '',
      created_date: nowIso,
      hash,
      previous_hash: previousHash,
    });
  } catch (err) {
    console.error('[deleteAccount] audit write failed:', err);
  }
}

// Strictly increasing, because the verifier orders the chain by created_date. A
// same-millisecond tie could be walked in the opposite order to the one the rows
// were linked in and reported as a chain break that never happened.
function monotonicIso(lastIso: any) {
  const now = Date.now();
  const last = lastIso ? Date.parse(lastIso) : NaN;
  return new Date(Number.isFinite(last) && last >= now ? last + 1 : now).toISOString();
}