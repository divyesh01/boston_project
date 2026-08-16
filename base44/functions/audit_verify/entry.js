import { createClientFromRequest } from "npm:@base44/sdk@^0.8.41";
import { secrets } from "base44:runtime";

// Server-authoritative audit chain verifier.
//
// The write path (base44/functions/audit_log/entry.js) recomputes the chain
// hash over a canonical payload using a SERVER-HELD secret, ignoring the
// client-supplied hash. This is the read-path counterpart: it recomputes the
// expected hash for every stored row using the SAME canonical fields and the
// SAME secret, then compares it to the stored `hash`. Any mismatch (or any
// row whose `previous_hash` doesn't equal the prior row's stored `hash`)
// proves the AuditLog table was tampered with via a DB admin interface —
// exactly the threat model the client-side `verifyAuditChain()` cannot catch
// (it reads from local IndexedDB, which may still hold the pre-tamper copy).
//
// CANONICAL PAYLOAD — must stay FIELD-FOR-FIELD identical to BOTH writers
// (base44/functions/audit_log/entry.js for client-originated events, and
// base44/functions/custom_user_admin/entry.js#writeAudit for privileged
// server-side events). If a writer adds/removes/renames a signed field, update
// the canonical object below in lockstep, or this verifier will misflag every
// healthy row as tampered. The base44 host offers no way to share a module
// between functions, so scripts/probe-audit-chain.mjs enforces the lockstep.
//
// Returns:
//   { valid: true,  count,  source: "server" }              when intact
//   { valid: false, reason: "chain_secret_missing", error,
//     source: "server" }                                     when unconfigured
//   { valid: false, tamperedAt, rowId, index, expected, actual,
//     reason: "hash_mismatch",   source: "server" }          when a row's own hash was changed
//   { valid: false, brokenAt,   rowId, index,
//     reason: "chain-break",     source: "server",
//     expectedPrevious, actualPrevious }                     when a row was inserted/removed/reordered
//
// The shape is compatible with src/lib/securityUtils.js#verifyAuditChain()'s
// return values (valid / tamperedAt / brokenAt → tamperedAt) so AuditLog.jsx
// can consume either source with the same rendering logic.

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);

    // ─── Authentication ─── (identical to audit_list/entry.js)
    const cookieHeader = req.headers.get("cookie") || "";
    const match = cookieHeader.match(/base44_session=([^;]+)/);
    const token = match ? match[1] : null;

    if (!token) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const crypto = await import("node:crypto");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const sessions = await base44.asServiceRole.entities.Session.filter({ token_hash: tokenHash }, null, 1, 0);
    const session = sessions[0];

    if (!session || session.is_revoked || new Date(session.expires_at) < new Date()) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const actor = await base44.asServiceRole.entities.User.get(session.user_id);
    // Audit-chain verification is admin-only: exposing the verification result
    // (especially the "where" of tampering) to a non-admin would leak forensic
    // detail. The AuditLog entity itself already restricts reads to admins.
    if (!actor || !actor.is_active || actor.is_locked || (actor.role !== "owner" && actor.role !== "admin")) {
      return Response.json({ error: "Forbidden: Only owners and admins can verify the audit chain" }, { status: 403 });
    }

    // ─── The secret is required to verify anything ───
    // FAIL CLOSED, and check BEFORE the empty-chain shortcut below. This used to
    // fall back to a hard-coded default that is published in this repository, so
    // an unconfigured deployment answered "chain verified" over rows whose
    // hashes anyone holding this source could recompute. "Cannot verify" is a
    // legitimate verdict and is returned as one — status 200 with valid:false,
    // exactly like the tamper verdicts below, so the client renders the reason
    // instead of treating it as a transport error and silently downgrading to
    // the weaker client-side check.
    const chainSecret = secrets.get("AUDIT_CHAIN_SECRET");
    if (!chainSecret) {
      console.error("[audit_verify] AUDIT_CHAIN_SECRET is not configured — cannot verify the audit chain");
      return Response.json({
        valid: false,
        reason: "chain_secret_missing",
        error: "Audit chain secret is not configured, so the audit trail cannot be verified. Set AUDIT_CHAIN_SECRET on this deployment.",
        source: "server",
      });
    }

    // ─── Load the full chain in ascending created_date order ───
    // Use a large page size so we verify the entire chain, not just the most
    // recent rows. created_date is the index audit_log/entry.js chains on, and
    // both writers keep it strictly increasing so this ordering matches the
    // order the rows were linked in.
    const PAGE = 100000;
    const rows = await base44.asServiceRole.entities.AuditLog.filter({}, "created_date", PAGE, 0);

    if (rows.length === 0) {
      return Response.json({ valid: true, count: 0, source: "server" });
    }

    let previousHash = "0".repeat(64);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];

      // Rebuild the EXACT canonical payload the writers hashed. Any drift here
      // would make every healthy row look tampered — so this object MUST stay
      // field-for-field identical to BOTH writers (audit_log/entry.js and
      // custom_user_admin/entry.js#writeAudit). The writers do NOT include
      // property_name/username/ip_address/device in the canonical payload
      // (they're written to the row but not signed), so we don't include them
      // here either. scripts/probe-audit-chain.mjs asserts the copies match.
      // AUDIT_CANONICAL_V1 = user_id,action,performed_by_id,performed_by,property_id,result,detail,created_date,previous_hash
      const canonical = JSON.stringify({
        user_id: row.user_id,
        action: row.action,
        performed_by_id: row.performed_by_id,
        performed_by: row.performed_by,
        property_id: row.property_id || null,
        result: row.result || "success",
        detail: row.detail || "",
        created_date: row.created_date,
        previous_hash: previousHash,
      });
      const expectedHash = crypto.createHash("sha256").update(`${chainSecret}:${canonical}`).digest("hex");

      // Constant-time comparison. X-ray attacks against the chain secret via a
      // timing oracle are out of scope (the only inputs an attacker controls
      // are the AuditLog rows themselves, which they can already read), but
      // ctEqual is cheap and keeps the audit path's security posture uniform.
      if (!ctEqual(expectedHash, row.hash || "")) {
        return Response.json({
          valid: false,
          tamperedAt: row.id,
          index: i,
          expected: expectedHash,
          actual: row.hash || null,
          reason: "hash_mismatch",
          source: "server",
        });
      }

      // Chain continuity: this row's previous_hash must equal the previous
      // row's stored hash. A mismatch means a row was inserted, removed,
      // reordered, or had its previous_hash mutated — all of which break the
      // forensic guarantee even if the row's own hash happens to validate.
      if (row.previous_hash !== previousHash) {
        return Response.json({
          valid: false,
          brokenAt: row.id,
          index: i,
          reason: "chain_break",
          expectedPrevious: previousHash,
          actualPrevious: row.previous_hash || null,
          source: "server",
        });
      }

      previousHash = row.hash;
    }

    return Response.json({ valid: true, count: rows.length, source: "server" });
  } catch (err) {
    console.error("Audit verify error:", err);
    return Response.json({ valid: false, error: err?.message || "Internal server error", source: "server" }, { status: 500 });
  }
}

// Constant-time string compare mirroring src/lib/security.js#constantTimeEqual.
// Defined inline (rather than imported) so this function has zero local imports
// and stays self-contained on the server runtime.
function ctEqual(a, b) {
  const aStr = String(a ?? "");
  const bStr = String(b ?? "");
  const maxLen = Math.max(aStr.length, bStr.length);
  let result = aStr.length ^ bStr.length;
  for (let i = 0; i < maxLen; i++) {
    result |= (aStr.charCodeAt(i) || 0) ^ (bStr.charCodeAt(i) || 0);
  }
  return result === 0;
}
