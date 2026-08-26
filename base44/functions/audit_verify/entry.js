import { createClientFromRequest } from "npm:@base44/sdk@^0.8.41";
import { secrets } from "base44:runtime";

// Server-authoritative audit chain verifier.
//
// The write path (base44/functions/audit_log/entry.js) recomputes the chain
// hash over a canonical payload using a SERVER-HELD secret, ignoring the
// client-supplied hash. This is the read-path counterpart: it recomputes the
// expected hash for every stored row using the SAME canonical fields and the
// SAME secret, then checks the links between rows. Any mismatch proves the
// AuditLog table was tampered with via a DB admin interface — exactly the threat
// model the client-side `verifyAuditChain()` cannot catch (it reads from local
// IndexedDB, which may still hold the pre-tamper copy).
//
// The chain is verified as a hash-linked DAG in four order-independent passes;
// the long note at the algorithm itself explains why, and what the two disclosed
// limits are. In short: a row's authenticity is proved by its own hash, a
// deletion is proved by an orphaned link, and rows that share a parent are
// concurrent writes rather than tampering.
//
// CANONICAL PAYLOAD — must stay FIELD-FOR-FIELD identical to ALL SIX writers
// (audit_log, custom_user_admin#writeAudit, custom_auth_login,
// custom_auth_reset_password, autoPayroll, deleteAccount). If a writer
// adds/removes/renames a signed field, update canonicalHash() below in lockstep,
// or this verifier will misflag every healthy row as tampered. The base44 host
// offers no way to share a module between functions, so
// scripts/probe-audit-chain.mjs enforces the lockstep.
//
// Returns:
//   { valid: true,  count, tips, source: "server" }            when intact
//   { valid: true,  count, tips, forks, warnings,
//     source: "server" }                                       when intact but writes overlapped
//   { valid: false, reason: "chain_secret_missing", error,
//     source: "server" }                                       when unconfigured
//   { valid: false, tamperedAt, rowId, index, expected, actual,
//     reason: "hash_mismatch",   source: "server" }            when a row's contents were changed
//   { valid: false, brokenAt,   rowId, index, detail,
//     reason: "chain_break",     source: "server",
//     expectedPrevious, actualPrevious }                       when a row was deleted
//   { valid: false, brokenAt,   rowId, index, detail,
//     reason: "unreachable",     source: "server" }             when a sub-chain doesn't reach genesis
//
// `warnings` is advisory: `valid` stays true, because every row in a fork
// verifies against the server secret. Callers that want to surface concurrency to
// an operator should render `warnings`; callers that only care about tampering can
// keep reading `valid` alone.
//
// The shape is compatible with src/lib/securityUtils.js#verifyAuditChain()'s
// return values (valid / tamperedAt / brokenAt → tamperedAt) so AuditLog.jsx
// can consume either source with the same rendering logic. NOTE: that client-side
// verifier still walks the chain linearly and so still misreports a concurrent
// fork; it was left untouched deliberately because securityUtils.js is listed in
// PROTECTED_FILES.md. It guards local IndexedDB only — this function is the
// forensic source of truth, and the UI should prefer it.

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

    // ─── Load the full chain ───
    // Ordered by created_date for stable, human-readable indices in the report.
    // The VERIFICATION no longer depends on this order — see the algorithm note
    // below. Use a large page size so the whole chain is checked, not just the
    // most recent rows.
    const PAGE = 100000;
    const rows = await base44.asServiceRole.entities.AuditLog.filter({}, "created_date", PAGE, 0);

    if (rows.length === 0) {
      return Response.json({ valid: true, count: 0, source: "server" });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // VERIFICATION ALGORITHM — rewritten 2026-08-19 (known problem #15).
    //
    // The chain is a hash-linked DAG, not an array. It used to be verified by
    // walking the rows in created_date order and recomputing each row's hash
    // over THE PREVIOUS ROW'S hash:
    //
    //     previousHash = rows[i-1].hash          // the WALK's idea of the parent
    //     expected = sha256(secret + canonical(row, previousHash))
    //     if (expected !== row.hash) -> "hash_mismatch"   // "this row was edited"
    //
    // That conflates two unrelated things: whether a row's contents are
    // authentic, and whether the rows came back in the order they were linked.
    // Concurrent writers make those diverge. Two invocations of audit_log that
    // overlap both read the same tail row, so both legitimately link to the same
    // parent — and both stamp the same created_date, because monotonicIso() can
    // only break a tie against a row it has already READ. Measured with three
    // simultaneous logins against the real function (scripts/probe-audit-chain-race.mjs):
    //
    //     seq-1   created=...06.907Z  hash=94e17ca0…  prev=00000000…
    //     race-a  created=...06.910Z  hash=4fcc1f42…  prev=94e17ca0…
    //     race-b  created=...06.910Z  hash=414c4d51…  prev=94e17ca0…   <- same parent
    //     race-c  created=...06.910Z  hash=54dc236e…  prev=94e17ca0…   <- same parent
    //
    // The old walk then reported:
    //
    //     { valid: false, reason: "hash_mismatch", tamperedAt: "auditlog_3" }
    //
    // i.e. "this audit row was rewritten" — the single most alarming verdict the
    // system can produce — about a row nobody touched, triggered by three people
    // logging in at once. The tracker rated this LOW on the assumption it would
    // surface as a chain break; it does not, it surfaces as a tampering
    // accusation, and it is permanent because the rows are append-only. A trail
    // that cries tamper is as useless as one that cannot detect tampering: both
    // end with the operator ignoring it.
    //
    // The fix is to verify the properties the hashes actually assert, each
    // independently of row order:
    //
    //   PASS 1  SELF-INTEGRITY. Recompute each row's hash over ITS OWN stored
    //           previous_hash. This is what proves the row's contents are
    //           authentic, and it needs no ordering whatsoever. Forging a row
    //           requires AUDIT_CHAIN_SECRET; without it no row can be altered,
    //           inserted or back-dated without failing here.
    //   PASS 2  LINKAGE. Every previous_hash must name a hash that exists (or
    //           genesis). An orphan means a row was DELETED — the guarantee the
    //           links exist to provide.
    //   PASS 3  FORKS. Rows sharing a parent are a fork. If every member passed
    //           pass 1 they were all written by something holding the secret, so
    //           a fork is evidence of CONCURRENT WRITES, not of tampering. It is
    //           reported as a warning, and the chain stays valid.
    //   PASS 4  REACHABILITY. Every row must reach genesis by following links, so
    //           a detached sub-chain cannot hide inside the table.
    //
    // Reordering is no longer treated as tampering, and correctly so: the chain's
    // structure lives in the hashes, not in the row order, and a storage engine is
    // free to return rows however it likes.
    //
    // DISCLOSED LIMITS (both are properties of an unanchored hash chain, not of
    // this implementation, and both existed before this rewrite):
    //   * Deleting the TIP is undetectable — nothing points at it. Unavoidable
    //     without an external anchor (e.g. publishing the tip hash off-system).
    //   * Deleting one entire branch of a genuine fork is undetectable, because
    //     the surviving branch still links validly to the shared parent. This is
    //     the narrow price of not calling concurrency "tampering". Pass 3 reports
    //     forks explicitly so the count is at least visible.
    // ─────────────────────────────────────────────────────────────────────────

    const GENESIS = "0".repeat(64);

    const canonicalHash = (row, previousHash) => {
      // Rebuild the EXACT canonical payload the writers hashed. Any drift here
      // would make every healthy row look tampered — so this object MUST stay
      // field-for-field identical to EVERY writer (audit_log, custom_user_admin,
      // custom_auth_login, custom_auth_reset_password, autoPayroll, deleteAccount).
      // The writers do NOT sign property_name/username/ip_address/device (they're
      // written to the row but not signed), so they are not included here either.
      // scripts/probe-audit-chain.mjs asserts the copies match.
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
      return crypto.createHash("sha256").update(`${chainSecret}:${canonical}`).digest("hex");
    };

    // ─── PASS 1: self-integrity ───
    // Order-independent. Reported first so the verdict for a genuinely edited row
    // is still "hash_mismatch" at its created_date index, unchanged from before.
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const storedPrevious = row.previous_hash || "";
      const expectedHash = canonicalHash(row, storedPrevious);

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
    }

    // ─── PASS 2: linkage ───
    // Every row's parent must exist. Because pass 1 already proved every stored
    // previous_hash is the one that was signed, an orphan cannot be a mutated
    // pointer — it can only be a parent that is no longer in the table.
    const knownHashes = new Set(rows.map((r) => r.hash));
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const parent = row.previous_hash || "";
      if (parent === GENESIS) continue;
      if (!knownHashes.has(parent)) {
        return Response.json({
          valid: false,
          brokenAt: row.id,
          index: i,
          reason: "chain_break",
          detail: "This row's parent is missing from the table, so an audit row was deleted.",
          expectedPrevious: parent,
          actualPrevious: parent,
          source: "server",
        });
      }
    }

    // ─── PASS 4 (computed before 3 so a detached loop is caught): reachability ───
    // Follow each row's parent pointers back to genesis. A cycle or a dead end
    // means a sub-chain that does not descend from the start of the log.
    const byHash = new Map(rows.map((r) => [r.hash, r]));
    for (let i = 0; i < rows.length; i++) {
      let cursor = rows[i];
      const seen = new Set();
      let reached = false;
      while (cursor) {
        if (seen.has(cursor.hash)) break; // cycle
        seen.add(cursor.hash);
        const parent = cursor.previous_hash || "";
        if (parent === GENESIS) { reached = true; break; }
        cursor = byHash.get(parent);
      }
      if (!reached) {
        return Response.json({
          valid: false,
          brokenAt: rows[i].id,
          index: i,
          reason: "unreachable",
          detail: "This row does not descend from the first entry in the log.",
          source: "server",
        });
      }
    }

    // ─── PASS 3: forks ───
    // Every member already passed pass 1, so every member was written by a holder
    // of the secret. That makes a shared parent concurrency, not tampering.
    const childrenOf = new Map();
    for (const row of rows) {
      const parent = row.previous_hash || "";
      if (!childrenOf.has(parent)) childrenOf.set(parent, []);
      childrenOf.get(parent).push(row);
    }
    const forks = [];
    for (const [parent, children] of childrenOf) {
      if (children.length > 1) {
        forks.push({
          parent_hash: parent,
          count: children.length,
          row_ids: children.map((r) => r.id),
          created_dates: children.map((r) => r.created_date),
        });
      }
    }
    // Rows nothing points at. A strictly linear chain has exactly one.
    const tips = rows.filter((r) => !childrenOf.has(r.hash)).map((r) => r.id);

    const response = {
      valid: true,
      count: rows.length,
      source: "server",
      tips,
    };
    if (forks.length) {
      const forked = forks.reduce((n, f) => n + f.count, 0);
      response.forks = forks;
      response.warnings = [{
        reason: "concurrent_append",
        message: `${forked} rows across ${forks.length} point(s) in the log share a parent, because audit writes overlapped in time. Every one of them verifies against the server secret, so this is concurrency and not tampering. Note that while a fork is open, deleting one of its branches would not be detectable.`,
      }];
    }
    return Response.json(response);

  } catch (err) {
    console.error("Audit verify error:", err);
    return Response.json({ valid: false, error: "Internal server error", source: "server" }, { status: 500 });
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
