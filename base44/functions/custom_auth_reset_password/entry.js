import { createClientFromRequest } from "npm:@base44/sdk@^0.8.41";
import { secrets } from "base44:runtime";
import crypto from "node:crypto";

async function hashPasswordScrypt(password, saltHex) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, saltHex, 64, { N: 16384, r: 8, p: 1 }, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey.toString('hex'));
    });
  });
}

/**
 * The same rule every other password writer applies.
 *
 * This endpoint used to check nothing beyond "a value was supplied", so the one
 * path an unauthenticated caller can reach was also the only one that would
 * accept "abc" — and a password set here is a password that signs in everywhere.
 * Copied rather than imported because the base44 host resolves only npm:, node:
 * and base44:runtime specifiers; kept identical to
 * custom_user_admin/entry.js#validatePasswordStrength.
 */
function validatePasswordStrength(password) {
  if (!password || password.length < 8) return 'Password must be at least 8 characters.';
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
    return 'Password must contain uppercase, lowercase, and a number.';
  }
  return null;
}

// Next ISO timestamp strictly greater than the previous row's — created_date is
// what audit_verify orders the chain by, so a same-millisecond tie could be
// walked in the opposite order to the one the rows were linked in and reported as
// a chain break that never happened. Mirrors audit_log/entry.js#monotonicIso.
function monotonicIso(lastIso) {
  const now = Date.now();
  const last = lastIso ? Date.parse(lastIso) : NaN;
  return new Date(Number.isFinite(last) && last >= now ? last + 1 : now).toISOString();
}

/**
 * Record a completed reset on the tamper-evident chain.
 *
 * A password reset is a credential change made by someone holding a one-time
 * token and nothing else. It was previously invisible: no row anywhere, so an
 * account taken over through a hijacked reset mail left the trail showing only a
 * successful login afterwards, with nothing to explain how the password changed.
 *
 * Best-effort on a missing chain secret, following custom_auth_login rather than
 * custom_user_admin: the caller is by definition someone who cannot sign in, and
 * refusing the reset would strand them until an operator fixed the deployment.
 * An unconfigured deployment is already loud — audit_log answers 503 and the
 * audit page reports it cannot verify.
 *
 * The base44 host offers no way to share a module between functions, so the
 * signed payload is spelled out here as it is in audit_log, custom_user_admin,
 * custom_auth_login and audit_verify. scripts/probe-audit-chain.mjs asserts the
 * five copies stay identical.
 */
async function writeResetAudit(base44, { user, ip, device, detail }) {
  try {
    const chainSecret = secrets.get('AUDIT_CHAIN_SECRET');
    if (!chainSecret) {
      console.error('[auth] AUDIT_CHAIN_SECRET is not configured — password reset NOT recorded');
      return;
    }

    const subject = user.username || user.email || 'unknown';
    const lastEntries = await base44.asServiceRole.entities.AuditLog.filter({}, '-created_date', 1, 0);
    const lastRow = (lastEntries && lastEntries[0]) || null;
    const previousHash = (lastRow && lastRow.hash) || '0'.repeat(64);
    const nowIso = monotonicIso(lastRow && lastRow.created_date);

    // AUDIT_CANONICAL_V1 = user_id,action,performed_by_id,performed_by,property_id,result,detail,created_date,previous_hash
    const canonical = JSON.stringify({
      user_id: user.id,
      action: 'Password Reset',
      // The token proves control of the mailbox, which is what the reset flow is
      // designed to accept — so the account holder is named as the actor here,
      // unlike a failed login where the request proves nothing about who sent it.
      performed_by_id: user.id,
      performed_by: subject,
      property_id: null,
      result: 'success',
      detail: detail || '',
      created_date: nowIso,
      previous_hash: previousHash,
    });
    const hash = crypto.createHash('sha256').update(`${chainSecret}:${canonical}`).digest('hex');

    await base44.asServiceRole.entities.AuditLog.create({
      user_id: user.id,
      username: subject,
      action: 'Password Reset',
      performed_by_id: user.id,
      performed_by: subject,
      ip_address: ip || 'unknown',
      device: String(device || '').slice(0, 200),
      property_id: null,
      result: 'success',
      detail: detail || '',
      created_date: nowIso,
      hash,
      previous_hash: previousHash,
    });
  } catch (err) {
    // Losing the record must not undo a completed reset — the password has
    // already changed by the time this runs.
    console.error('[auth] password reset audit write failed:', err);
  }
}

export default async function (req) {
  try {
  const _csrfHeader = req.headers.get('x-csrf-token');
  const _cookieHeader = req.headers.get('cookie') || '';
  const _csrfCookieMatch = _cookieHeader.match(/csrf_token=([^;]+)/);
  const _csrfCookie = _csrfCookieMatch ? _csrfCookieMatch[1] : null;
  if (!_csrfHeader || !_csrfCookie || _csrfHeader !== _csrfCookie) {
    return Response.json({ error: "Invalid CSRF token" }, { status: 403 });
  }

    const base44 = createClientFromRequest(req);
    const body = await req.json();
    const { token, newPassword } = body;

    if (!token || !newPassword) {
      return Response.json({ error: "Token and new password are required" }, { status: 400 });
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const users = await base44.asServiceRole.entities.User.filter({ reset_token_hash: tokenHash }, null, 1, 0);
    const user = users[0];

    if (!user || !user.is_active || user.is_locked || new Date(user.reset_token_expires_at) < new Date()) {
      return Response.json({ error: "Invalid or expired reset token" }, { status: 400 });
    }

    // Checked AFTER the token is resolved but BEFORE anything is written, so a
    // password the rules refuse does not burn the token — otherwise a legitimate
    // user who types something too weak has to request a whole new email.
    const strengthErr = validatePasswordStrength(newPassword);
    if (strengthErr) {
      return Response.json({ error: strengthErr }, { status: 400 });
    }

    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = '$scrypt$' + await hashPasswordScrypt(newPassword, salt);

    await base44.asServiceRole.entities.User.update(user.id, {
      password_hash: passwordHash,
      salt: salt,
      reset_token_hash: null,
      reset_token_expires_at: null,
      must_change_password: false,
      failed_login_count: 0,
      is_locked: false
    });

    // A reset is most often a response to a suspected compromise. Sessions opened
    // under the old password have to end here, or the new password changes
    // nothing for whoever is already inside — nothing re-checks the credential
    // until a session expires on its own, up to seven days later.
    const sessions = await base44.asServiceRole.entities.Session.filter({ user_id: user.id }, null, 500, 0);
    for (const s of sessions) {
      if (s.is_revoked) continue;
      await base44.asServiceRole.entities.Session.update(s.id, { is_revoked: true });
    }

    await writeResetAudit(base44, {
      user,
      ip: req.headers.get('x-forwarded-for') || req.headers.get('remote-addr') || 'unknown',
      device: req.headers.get('user-agent') || '',
      detail: `Password reset using an emailed token; ${sessions.length} session(s) revoked`,
    });

    return Response.json({ success: true });

  } catch (err) {
    console.error("Password reset error:", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
