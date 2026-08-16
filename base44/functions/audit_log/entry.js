import { createClientFromRequest } from "npm:@base44/sdk@^0.8.41";
import { secrets } from "base44:runtime";

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
    const csrfCookieMatch = cookieHeader.match(/__Host-csrf_token=([^;]+)/);
    const csrfCookie = csrfCookieMatch ? csrfCookieMatch[1] : null;

    if (!csrfHeader || !csrfCookie || csrfHeader !== csrfCookie) {
      return Response.json({ error: "Invalid CSRF token" }, { status: 403 });
    }

    const payload = await req.json();

    // Enforce that the user is only logging for themselves
    if (String(payload.user_id) !== String(session.user_id)) {
      return Response.json({ error: "Forbidden: Cannot log for another user" }, { status: 403 });
    }

    // Server-authoritative tamper-evident chain. The client-supplied hash is
    // IGNORED — we recompute the chain hash over trusted server fields using a
    // server-held secret, so the audit trail cannot be forged client-side
    // (previously the chain secret lived in localStorage / a window global).
    //
    // CANONICAL PAYLOAD — DO NOT MUTATE WITHOUT ALSO UPDATING THE VERIFIER.
    // This exact object shape is the contract shared with the server-side
    // verifier (base44/functions/audit_verify/entry.js). Any field added,
    // removed, renamed, or re-ordered here MUST be mirrored there, or the
    // verifier will misflag every healthy row as tampered.
    //
    // Intentionally NOT signed: ip_address and device. Both are written to the
    // row (below) for forensics, but they come from the client / a spoofable
    // proxy header and so are not part of the tamper-evident payload. The
    // client's own local chain (src/lib/securityUtils.js#hashEntry — a
    // PROTECTED file) DOES sign a broader field set including a fabricated
    // 'client-side' ip, with a PUBLIC salt; its chain therefore cannot produce
    // the same hex as the server chain even for the same logical event. This is
    // by design: the two chains are independent — the client's is a local
    // IndexedDB corruption guard, the server's (computed here + verified by
    // audit_verify) is the forensic source of truth against DB-admin tampering.
    // UI verification should call audit_verify for authoritative results.
    // FAIL CLOSED on a missing secret. This used to fall back to a hard-coded
    // default, which is published in this repository: an unconfigured
    // deployment produced hashes that anyone holding this source could
    // recompute, while audit_verify still reported a green chain. A trail that
    // reports "verified" but can be forged is worse than no trail, because it
    // is believed. Refuse the write instead — the operator sees it immediately,
    // because no rows accumulate and the audit page's verification says the
    // secret is missing.
    const chainSecret = secrets.get('AUDIT_CHAIN_SECRET');
    if (!chainSecret) {
      console.error('[audit_log] AUDIT_CHAIN_SECRET is not configured — refusing to write an unverifiable audit row');
      return Response.json({
        error: 'Audit chain secret is not configured. Set AUDIT_CHAIN_SECRET on this deployment before using it.',
        code: 'chain_secret_missing',
      }, { status: 503 });
    }
    const lastEntries = await base44.asServiceRole.entities.AuditLog.filter({}, '-created_date', 1, 0);
    const lastRow = (lastEntries && lastEntries[0]) || null;
    const previousHash = (lastRow && lastRow.hash) || '0'.repeat(64);
    // created_date is the column audit_verify orders the chain by, so it must be
    // STRICTLY increasing. Two rows written inside the same millisecond would
    // tie, and the verifier could then walk them in the opposite order to the
    // one they were linked in and report a chain break that never happened.
    // Nudging forward by 1ms costs nothing and removes that class of false
    // alarm — and a false alarm is indistinguishable from a real one.
    const nowIso = monotonicIso(lastRow && lastRow.created_date);
    // AUDIT_CANONICAL_V1 = user_id,action,performed_by_id,performed_by,property_id,result,detail,created_date,previous_hash
    const canonical = JSON.stringify({
      user_id: payload.user_id,
      action: payload.action,
      performed_by_id: payload.performed_by_id,
      performed_by: payload.performed_by,
      property_id: payload.property_id || null,
      result: payload.result || 'success',
      detail: payload.detail || '',
      created_date: nowIso,
      previous_hash: previousHash,
    });
    const serverHash = crypto.createHash('sha256').update(`${chainSecret}:${canonical}`).digest('hex');

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
      created_date: nowIso,
      hash: serverHash,
      previous_hash: previousHash,
    });

    return Response.json({ success: true, entry });

  } catch (err) {
    console.error("Audit log error:", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

// Next ISO timestamp that is strictly greater than the previous row's. Shared in
// spirit (not in code — the base44 host has no module sharing between functions)
// with base44/functions/custom_user_admin/entry.js, the other writer on this
// chain. See the note at the call site for why strict monotonicity matters.
function monotonicIso(lastIso) {
  const now = Date.now();
  const last = lastIso ? Date.parse(lastIso) : NaN;
  return new Date(Number.isFinite(last) && last >= now ? last + 1 : now).toISOString();
}
