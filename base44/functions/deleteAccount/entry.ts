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

    // DELETION RULES (established before any code change):
    //   DELETE  — every record where created_by_id === user.id, across all listed
    //             entities, regardless of how many records other users own.
    //   RETAIN  — records owned by any other user; the loop must never touch them.
    //   RETAIN  — the AuditLog entry written below (forensic evidence of this wipe).
    //
    // PREVIOUS BUG (lines 68–82 before this patch):
    //   base44.entities[entityName].list('-created_date', PAGE) fetched the
    //   PAGE newest records ACROSS ALL USERS, then filtered client-side.
    //   If another user owned ≥ PAGE records that were all newer than the target
    //   user's records, those target records never appeared in any page — the
    //   owned array was always empty on the first iteration and the loop exited
    //   immediately, leaving every one of the target user's records behind.
    //   The stop condition (records.length < PAGE) made it worse: 501 records by
    //   the other user fills a full page of 500, so the loop would not even reach
    //   that check — it broke at the `!owned.length` guard on line 70.
    //
    // FIX: use .filter({created_by_id: user.id}, ...) so the backend evaluates
    //   the predicate server-side and returns ONLY the target user's rows.
    //   Offset-based pagination then guarantees we walk every page even when
    //   other users own far more records. Offset advances by PAGE each round;
    //   the loop exits when a page returns fewer than PAGE rows (no more data).
    //   Because we delete as we go, we re-fetch from offset 0 each round so
    //   we do not skip rows that shifted into earlier positions after a delete.
    const entities = ['OccupancyDay', 'SourceDay', 'GrossRevenueDay', 'ClerkShiftRecord', 'UploadedReport'];
    let deleted = 0;
    let failedDeletes = 0;

    // PRE-FLIGHT AUDIT CHECK: log a warning if AUDIT_CHAIN_SECRET is missing
    // before starting the destructive loop. The wipe still proceeds — the
    // user's data must be deletable even when audit is misconfigured — but the
    // operator is informed. writeAudit() below skips the row when the secret is
    // absent (fail-closed policy documented on the writeAudit function).
    if (!secrets.get('AUDIT_CHAIN_SECRET')) {
      console.error('[deleteAccount] AUDIT_CHAIN_SECRET is not configured — wipe will proceed but will not be recorded in the audit chain.');
    }

    const PAGE = 500;
    // STALL GUARD: if CONSECUTIVE_NO_PROGRESS_MAX consecutive rounds return
    // records but delete 0 of them (e.g. repeated server rejections), the loop
    // is stalled on undeletable records. Break and log rather than burning all
    // remaining guard iterations. See deletion-manifest.json §stallGuard.
    const CONSECUTIVE_NO_PROGRESS_MAX = 3;
    for (const entityName of entities) {
      try {
        // Re-fetch from offset 0 every round: deleting rows shifts the remainder
        // forward, so an advancing offset would skip the records that moved into
        // already-seen positions. Restarting from 0 is safe because every
        // successfully deleted row is gone and will not re-appear.
        let guard = 0;
        let consecutiveNoProgress = 0;
        while (guard++ < 10000) {
          // .filter() with created_by_id scoped server-side: other users' records
          // are never returned, so the loop is guaranteed to terminate once this
          // user's rows are exhausted regardless of how many rows others own.
          const page = await base44.entities[entityName].filter(
            { created_by_id: user.id },
            '-created_date',
            PAGE,
            0,
          );
          if (!page || page.length === 0) {
            break; // all records for this entity are deleted, or none existed
          }

          let deletedInBatch = 0;
          for (const r of page) {
            try {
              await base44.entities[entityName].delete(r.id);
              deleted++;
              deletedInBatch++;
            } catch {
              // A single failed delete must not abort the rest of the wipe.
              // Count failures so the audit entry and response are honest.
              failedDeletes++;
            }
          }

          if (deletedInBatch === 0 && page.length > 0) {
            consecutiveNoProgress++;
            if (consecutiveNoProgress >= CONSECUTIVE_NO_PROGRESS_MAX) {
              console.error(`[deleteAccount] LOOP_STALLED: ${CONSECUTIVE_NO_PROGRESS_MAX} consecutive rounds made zero deletion progress for ${entityName}. Breaking to prevent wasted iterations.`);
              break;
            }
          } else {
            consecutiveNoProgress = 0;
          }

          // Fewer than a full page means this was the last page.
          if (page.length < PAGE) break;
        }
      } catch (e) {
        // Entity-level error (e.g. network failure). Continue with remaining
        // entities so a single bad entity does not leave others un-wiped.
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
      detail: `Server-side account data wipe: ${deleted} record(s) deleted, ${failedDeletes} failed across ${entities.length} entities.`,
    });

    return Response.json({ success: true, recordsDeleted: deleted, recordsFailed: failedDeletes });
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