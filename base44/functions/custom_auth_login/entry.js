import { createClientFromRequest } from "npm:@base44/sdk@^0.8.41";
import { secrets } from "base44:runtime";
import crypto from "node:crypto";

const PBKDF2_ITERATIONS = 300000;
const SALT_BYTES = 32;
const KEY_BYTES = 32;
const DERIVATION_ROUNDS = 2;

function deriveKey(password, saltHex, iterations) {
  return new Promise((resolve, reject) => {
    const salt = Buffer.from(saltHex, 'hex');
    crypto.pbkdf2(password, salt, iterations, KEY_BYTES, 'sha256', (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

async function hashPassword(password, saltHex) {
  let key = await deriveKey(password, saltHex, PBKDF2_ITERATIONS);
  for (let i = 1; i < DERIVATION_ROUNDS; i++) {
    const intermediateSalt = key.subarray(0, SALT_BYTES).toString('hex');
    key = await deriveKey(password, intermediateSalt, PBKDF2_ITERATIONS / DERIVATION_ROUNDS);
  }
  return key.toString('hex');
}

async function hashPasswordScrypt(password, saltHex) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, saltHex, 64, { N: 16384, r: 8, p: 1 }, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey.toString('hex'));
    });
  });
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(input) {
  const cleaned = input.toUpperCase().replace(/[^A-Z2-7]/g, "");
  const bits = [];
  for (const ch of cleaned) {
    const val = BASE32_ALPHABET.indexOf(ch);
    if (val < 0) continue;
    for (let b = 4; b >= 0; b--) bits.push((val >> b) & 1);
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let byte = 0;
    for (let b = 0; b < 8; b++) byte = (byte << 1) | bits[i + b];
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

function hotp(secretBytes, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", secretBytes).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return code % 1000000;
}

function totp(secretBytes, timestampMs = Date.now()) {
  const counter = Math.floor(timestampMs / 30000);
  return hotp(secretBytes, counter);
}

/**
 * The 30-second counter the code matched, or -1 for no match.
 *
 * Returns the counter rather than a boolean because a TOTP code is valid across
 * the whole ±1 window — about 90 seconds — and nothing here used to record which
 * counter had already been spent, so an accepted code could be presented again
 * inside that window and accepted again. Whoever reads a code over a shoulder,
 * or off a phishing page, gets a minute and a half to use it. The caller stores
 * the returned counter on the user and passes it back as `notBefore`, which
 * makes each code single-use.
 */
function verifyTotpToken(secretBase32, token, { window = 1, notBefore = -Infinity } = {}) {
  const secretBytes = base32Decode(secretBase32);
  const provided = String(token).replace(/\s/g, "");
  if (!/^\d{6}$/.test(provided)) return -1;
  const counter = Math.floor(Date.now() / 30000);
  for (let w = -window; w <= window; w++) {
    const candidate = counter + w;
    if (candidate <= notBefore) continue;
    const expected = String(totp(secretBytes, candidate * 30000)).padStart(6, "0");
    // Both operands are always six ASCII digits, so this cannot hit the length
    // mismatch that hashesEqual() below exists for.
    if (crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) {
      return candidate;
    }
  }
  return -1;
}

/** The counter a stored value represents, or -Infinity if none is recorded. */
const lastUsedCounter = (user) =>
  Number.isFinite(user && user.mfa_last_counter) ? Number(user.mfa_last_counter) : -Infinity;

/**
 * Constant-time comparison that tolerates a length mismatch.
 *
 * crypto.timingSafeEqual THROWS RangeError ("Input buffers must have the same
 * byte length") when the two buffers differ, and that is reachable from
 * unauthenticated input: a stored hash without the '$scrypt$' prefix takes the
 * legacy branch, which yields exactly 64 hex characters, so any stored value of
 * another length threw out of the handler and into the catch that answers 500.
 * A wrong password on such an account became a server error instead of a
 * refusal — and the difference between 500 and 401 is itself an oracle telling
 * an anonymous caller which accounts are in an unusual state.
 *
 * Comparing lengths first leaks only the length of a derived hash, which is
 * fixed by the algorithm and is not a secret.
 */
function hashesEqual(actual, expected) {
  const a = Buffer.from(String(actual ?? ''), 'utf8');
  const b = Buffer.from(String(expected ?? ''), 'utf8');
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

function generateBase32Secret(length = 32) {
  let secret = '';
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    secret += BASE32_ALPHABET[bytes[i] % 32];
  }
  return secret;
}

// The fields a browser may see, as an ALLOWLIST.
//
// This used to be a denylist: it destructured the sensitive columns away and
// spread the rest, which made every column later added to the User entity public
// by default. That is how `mfa_secret_pending` got out. custom_auth_login writes
// a live TOTP enrolment seed to that column when it force-enrols an owner or
// admin, nobody thought to add it here, and so `list`, `search`, `getById`,
// `update`, `set_status` and the login response itself handed any admin the
// second-factor seed of every colleague mid-enrolment - with no audit row to
// show it had been read. An allowlist fails closed instead: a new column is
// invisible here until someone deliberately names it.
//
// Every entry below is either a field the UI provably reads (src/pages/Users.jsx,
// src/pages/Settings.jsx, src/lib/AuthContext.jsx, src/components/Layout.jsx,
// src/lib/launchPolicy.js, and mirrorRemoteUserIntoLocal in
// src/api/base44Client.js) or a non-secret operational field an admin screen
// needs to explain why an account is in the state it is in.
//
// Deliberately absent, and each one for a reason: password_hash and salt (the
// credential), mfa_secret and mfa_secret_pending (the second factor itself),
// mfa_last_counter (tells an observer when the factor was last used, and is only
// ever compared server-side), reset_token_hash and reset_token_expires_at (a
// live reset capability), session_created and session_expires (session bookkeeping
// the client already has in its cookie).
//
// Kept byte-identical to the copies in the other auth functions. The base44 host
// gives these functions no shared module they can all import, so
// scripts/probe-auth-hardening.mjs section 17 asserts the copies never drift
// and that no sensitive column from base44/entities/User.jsonc is ever named here.
const PUBLIC_USER_FIELDS = [
  'id', 'email', 'username', 'full_name', 'display_name', 'role',
  'property_access', 'permissions', 'is_active', 'is_locked',
  'must_change_password', 'mfa_enabled', 'email_confirmed',
  'last_login', 'failed_login_count', 'locked_until',
  'created_date', 'updated_date',
];

export function publicUser(user) {
  if (!user) return null;
  const safe = {};
  for (const field of PUBLIC_USER_FIELDS) {
    if (user[field] !== undefined) safe[field] = user[field];
  }
  return safe;
}

// ─── Pre-auth security events ───────────────────────────────────────────────
// A rejected login used to be the one security event this system could not
// record. base44/functions/audit_log requires a valid session cookie and refuses
// a payload whose user_id isn't the session's, so the browser's attempt to log a
// failed login 403s and src/lib/auditLogger.js swallows it into console.error.
// Brute force, credential stuffing and account lockouts left nothing behind but
// a line in the attacker's own browser console — and nothing recorded successful
// logins either, so even a visible attack could not be answered with the only
// question that matters afterwards: did they get in?
//
// It has to happen here, server-side. The obvious alternative — an
// unauthenticated audit endpoint the browser can post to — would hand anyone on
// the internet a way to write attacker-authored rows into the trail meant to
// convict them, and to flood out the real ones.
//
// Volume is bounded by the IP rate limiter above: at most ~6 rows per IP per
// 15-minute window, which is the shape you want for brute-force forensics.
//
// The base44 host offers no way to share a module between functions (every
// specifier is npm:, node: or base44:runtime), so the signed payload is spelled
// out here as it is in audit_log, custom_user_admin and audit_verify.
// scripts/probe-audit-chain.mjs asserts the four copies stay identical.

/** The submitted identifier is attacker-controlled and unbounded. */
const AUDIT_IDENTIFIER_MAX = 120;

async function writeSecurityAudit(base44, { action, user, identifier, result, detail, ip, device }) {
  try {
    // Deliberately the OPPOSITE call to custom_user_admin, which refuses a
    // privileged change it cannot record. Refusing every login when this is
    // unset would lock the staff — and the operator who has to fix it — out of a
    // running hotel mid-shift, and an unconfigured deployment is already loud
    // after B9: audit_log answers 503 and the audit page reports that it cannot
    // verify. An unrecorded login is the lesser harm, and writing an unhashed
    // row instead would be worse than writing none, because it would read as a
    // permanent chain break.
    const chainSecret = secrets.get('AUDIT_CHAIN_SECRET');
    if (!chainSecret) {
      console.error('[auth] AUDIT_CHAIN_SECRET is not configured — security event NOT recorded:', action);
      return;
    }

    const submitted = String(identifier ?? '').slice(0, AUDIT_IDENTIFIER_MAX);
    const subject = (user && (user.username || user.email)) || submitted || 'unknown';

    const lastEntries = await base44.asServiceRole.entities.AuditLog.filter({}, '-created_date', 1, 0);
    const lastRow = (lastEntries && lastEntries[0]) || null;
    const previousHash = (lastRow && lastRow.hash) || '0'.repeat(64);
    const nowIso = monotonicIso(lastRow && lastRow.created_date);

    // performed_by_id stays null for anything that FAILED. The request was
    // unauthenticated, so naming the account holder as the actor would assert
    // that they did this — a brute-force row must not accuse its own victim.
    // Only a completed login proves who was at the keyboard.
    const performedById = result === 'success' && user ? user.id : null;

    // AUDIT_CANONICAL_V1 = user_id,action,performed_by_id,performed_by,property_id,result,detail,created_date,previous_hash
    const canonical = JSON.stringify({
      user_id: (user && user.id) || null,
      action,
      performed_by_id: performedById,
      performed_by: submitted || subject,
      property_id: null,
      result,
      detail: detail || '',
      created_date: nowIso,
      previous_hash: previousHash,
    });
    const hash = crypto.createHash('sha256').update(`${chainSecret}:${canonical}`).digest('hex');

    await base44.asServiceRole.entities.AuditLog.create({
      user_id: (user && user.id) || null,
      username: subject,
      action,
      performed_by_id: performedById,
      performed_by: submitted || subject,
      ip_address: ip || 'unknown',
      device: String(device || '').slice(0, 200),
      property_id: null,
      result,
      detail: detail || '',
      created_date: nowIso,
      hash,
      previous_hash: previousHash,
    });
  } catch (err) {
    // An audit failure must never change the outcome of the login. This is the
    // one place where losing the record is preferable to losing the service.
    console.error('[auth] security audit write failed:', err);
  }
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

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json();
    const { email, username, password, mfa_token } = body;
    const identifier = email || username;

    if (!identifier || !password) {
      return Response.json({ error: "Email and password are required" }, { status: 400 });
    }

    const ip = req.headers.get("x-forwarded-for") || req.headers.get("remote-addr") || "unknown";
    const device = req.headers.get("user-agent") || "";
    const audit = (fields) => writeSecurityAudit(base44, { identifier, ip, device, ...fields });
    const now = Date.now();
    const rlRecords = await base44.asServiceRole.entities.RateLimit.filter({ ip, action: 'login' }, null, 1, 0);
    let rl = rlRecords[0];
    if (rl) {
      if (new Date(rl.reset_at).getTime() < now) {
        rl.count = 1;
        rl.reset_at = new Date(now + 15 * 60 * 1000).toISOString();
        await base44.asServiceRole.entities.RateLimit.update(rl.id, { count: rl.count, reset_at: rl.reset_at });
      } else {
        if (rl.count >= 5) {
          const resetAtTime = new Date(rl.reset_at).getTime();
          const retryAfter = isNaN(resetAtTime) ? 900 : Math.max(1, Math.ceil((resetAtTime - now) / 1000));
          return Response.json(
            { error: "Too many login attempts. Please try again later." },
            { status: 429, headers: { "Retry-After": String(retryAfter) } }
          );
        }
        rl.count += 1;
        await base44.asServiceRole.entities.RateLimit.update(rl.id, { count: rl.count });
        // Record the throttle ONCE, on the attempt that fills the window, rather
        // than on each refusal after it — every later attempt in this window
        // returns 429 above without touching the counter, so logging there would
        // let one IP append audit rows for free until the window expires. The
        // trail has to stay readable during an attack, not just complete.
        if (rl.count >= 5) {
          await audit({
            action: 'Login Rate Limit Reached',
            result: 'failed',
            detail: `5 login attempts from ${ip} within 15 minutes; further attempts in this window are refused`,
          });
        }
      }
    } else {
      await base44.asServiceRole.entities.RateLimit.create({ ip, action: 'login', count: 1, reset_at: new Date(now + 15 * 60 * 1000).toISOString() });
    }

    // Use service role to access User entity securely
    const normalized = String(identifier).toLowerCase();
    let users = await base44.asServiceRole.entities.User.filter({ email: normalized }, null, 1, 0);
    let user = users[0];
    if (!user) {
      users = await base44.asServiceRole.entities.User.filter({ username: normalized }, null, 1, 0);
      user = users[0];
    }
    if (!user) {
      // Fall back to a case-insensitive scan (usernames are stored as typed).
      const allUsers = await base44.asServiceRole.entities.User.filter({}, null, 1000, 0);
      user = allUsers.find(
        (u) =>
          (u.username || '').toLowerCase() === normalized ||
          (u.email || '').toLowerCase() === normalized
      ) || null;
    }

    if (!user) {
      // Recorded even though no account matched: a burst of these IS the
      // credential-stuffing signal, and the submitted identifier is the only
      // evidence of what the attacker was guessing at. The RESPONSE stays
      // generic so it still gives nothing away about which accounts exist.
      await audit({
        action: 'Failed Login',
        result: 'failed',
        detail: 'no account matches the submitted identifier',
      });
      // Return generic message to prevent user enumeration
      return Response.json({ error: "Invalid email or password" }, { status: 401 });
    }

    if (user.is_locked) {
      await audit({
        action: 'Failed Login',
        user,
        result: 'failed',
        detail: 'account is locked',
      });
      return Response.json({ error: "Account is locked" }, { status: 403 });
    }

    if (!user.is_active) {
      await audit({
        action: 'Failed Login',
        user,
        result: 'failed',
        detail: 'account is inactive',
      });
      return Response.json({ error: "Account is inactive" }, { status: 403 });
    }

    /**
     * Count one failed authentication attempt against the account, lock at ten,
     * and put both events on the record.
     *
     * Shared by the wrong-password branch and both MFA branches. Before this
     * existed only a wrong PASSWORD counted, so an attacker who had already
     * obtained the password — the exact situation the second factor is there to
     * survive — could submit six-digit codes forever without ever tripping the
     * lockout. A million guesses at 000000..999999 costs nothing if nobody is
     * counting. The per-IP limiter above does not close this: it is keyed on the
     * source address, so a distributed attempt slips past it while the account
     * itself has no ceiling.
     */
    const recordFailure = async ({ action, detail, status, body }) => {
      const failed = (user.failed_login_count || 0) + 1;
      const updates = { failed_login_count: failed };
      if (failed >= 10) {
        updates.is_locked = true;
      }
      await base44.asServiceRole.entities.User.update(user.id, updates);
      await audit({
        action,
        user,
        result: 'failed',
        detail: `${detail} (${failed} consecutive ${failed === 1 ? 'failure' : 'failures'})`,
      });
      // The lockout is its own row, not a footnote in the one above: it is the
      // event a supervisor is asked about ("why can't I sign in?") and the one
      // that has to be greppable on its own.
      if (updates.is_locked) {
        await audit({
          action: 'Account Locked',
          user,
          result: 'failed',
          detail: `locked automatically after ${failed} consecutive failed authentication attempts`,
        });
      }
      return Response.json(body, { status });
    };

    const credentialsRefused = (detail) =>
      recordFailure({
        action: 'Failed Login',
        detail,
        status: 401,
        body: { error: "Invalid email or password" },
      });

    // Verify password
    const expectedHash = user.password_hash;

    // A stored record with no hash or no salt cannot authenticate anyone, and
    // reaching the comparison with one used to throw — either dereferencing
    // undefined here, or RangeError out of timingSafeEqual on a length mismatch
    // — which the catch turned into a 500. That made "this account is broken"
    // distinguishable from "wrong password" to anyone who can reach the form.
    // Treated as a credential failure instead: refused identically, counted
    // toward the lockout, and named precisely in the trail so an operator can
    // find and repair the record.
    if (!expectedHash || !user.salt) {
      return credentialsRefused(
        `account has no usable stored credential (${!expectedHash ? 'password_hash' : 'salt'} is missing)`
      );
    }

    const isLegacy = !expectedHash.startsWith('$scrypt$');

    let actualHash;
    if (isLegacy) {
      actualHash = await hashPassword(password, user.salt);
    } else {
      actualHash = '$scrypt$' + await hashPasswordScrypt(password, user.salt);
    }

    // Constant time compare, length-tolerant (see hashesEqual).
    if (!hashesEqual(actualHash, expectedHash)) {
      return credentialsRefused('incorrect password');
    }

    // Upgrade hash to scrypt if legacy
    if (isLegacy) {
      const newSalt = crypto.randomBytes(16).toString('hex');
      const newHash = '$scrypt$' + await hashPasswordScrypt(password, newSalt);
      await base44.asServiceRole.entities.User.update(user.id, {
        password_hash: newHash,
        salt: newSalt
      });
    }

    // If MFA is enabled, verify token
    if (user.mfa_enabled) {
      if (!mfa_token) {
        return Response.json({ require_mfa: true }, { status: 200 });
      }
      const counter = user.mfa_secret
        ? verifyTotpToken(user.mfa_secret, mfa_token, { notBefore: lastUsedCounter(user) })
        : -1;
      if (counter < 0) {
        // A wrong code AFTER a correct password is a different event from a wrong
        // password: it means someone holds working credentials but not the second
        // factor. Recording it as a plain "Failed Login" would bury the most
        // urgent signal the trail can carry.
        return recordFailure({
          action: 'Failed MFA',
          detail: 'correct password, invalid authentication code',
          status: 401,
          body: { error: "Invalid authentication code" },
        });
      }
      // Burn the counter before the session is issued, so the code that just
      // worked cannot work a second time inside its ±1 window.
      await base44.asServiceRole.entities.User.update(user.id, { mfa_last_counter: counter });
    } else if (user.role === 'owner' || user.role === 'admin') {
      let secretBase32 = user.mfa_secret_pending;
      if (!secretBase32) {
        secretBase32 = generateBase32Secret(32);
        await base44.asServiceRole.entities.User.update(user.id, { mfa_secret_pending: secretBase32 });
      }
      const appName = "RRI Executive";
      const uri = `otpauth://totp/${encodeURIComponent(appName)}:${encodeURIComponent(user.email || user.username)}?secret=${secretBase32}&issuer=${encodeURIComponent(appName)}`;

      if (mfa_token) {
        // notBefore is not carried over from any previous secret: this is a fresh
        // enrolment, and a counter recorded against an older secret would refuse
        // a legitimate first code. The counter this code consumes is stored in
        // the same update that turns MFA on, so the enrolment code is spent too.
        const counter = verifyTotpToken(secretBase32, mfa_token);
        if (counter >= 0) {
          await base44.asServiceRole.entities.User.update(user.id, {
            mfa_enabled: true,
            mfa_secret: secretBase32,
            mfa_secret_pending: null,
            mfa_last_counter: counter
          });
        } else {
          return recordFailure({
            action: 'Failed MFA',
            detail: 'correct password, invalid authentication code during MFA enrolment',
            status: 401,
            body: { error: "Invalid authentication code" },
          });
        }
      } else {
        return Response.json({ require_mfa_setup: true, secret: secretBase32, uri }, { status: 200 });
      }
    }

    // Reset failed logins
    if (user.failed_login_count > 0) {
      await base44.asServiceRole.entities.User.update(user.id, { failed_login_count: 0 });
    }

    // ─── Launch policy: all-property accounts only ───
    // Every entity read in this app is Dexie/IndexedDB in the user's own
    // browser, so per-property scoping is enforced client-side and cannot hold
    // against someone with devtools. Until entity reads move behind server-side
    // authorization, only accounts already entitled to every property may sign
    // in — for them there is no confidentiality boundary left to breach.
    //
    // LAUNCH_POLICY_V1 = owner | admin | property_access === 'all'
    // This is the authoritative copy. src/lib/launchPolicy.js mirrors it for the
    // offline dev shim and for revoking a session that outlived a downgrade;
    // keep the two in step.
    //
    // Checked AFTER password and MFA on purpose: refusing earlier would tell an
    // unauthenticated caller which accounts exist and which are restricted.
    const isAllProperties =
      user.role === 'owner' ||
      user.role === 'admin' ||
      user.property_access === 'all';
    if (!isAllProperties) {
      // No session is created, so this is a refusal, not a login. Recorded
      // because "valid credentials presented for an account that may not sign
      // in" is exactly the kind of event that has to be visible afterwards —
      // it is either a misconfigured account or someone using staff
      // credentials they should not hold.
      await audit({
        action: 'Failed Login',
        user,
        result: 'failed',
        detail: 'correct password, account is not authorised for all properties (launch policy)',
      });
      return Response.json({
        error: 'This account is limited to specific properties. This release supports accounts with access to all properties only — ask an owner to widen this account.',
        // Login.jsx flattens every other login error to "Invalid email or
        // password" so it cannot enumerate accounts. This code is how it knows
        // to show the message above verbatim instead. Must stay in step with
        // ALL_PROPERTY_REQUIRED_CODE in src/lib/launchPolicy.js.
        code: 'ALL_PROPERTY_ACCESS_REQUIRED',
      }, { status: 403 });
    }

    // Create session
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    // 7 days expiry
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    await base44.asServiceRole.entities.Session.create({
      user_id: user.id,
      token_hash: tokenHash,
      expires_at: expiresAt,
      ip_address: req.headers.get("x-forwarded-for") || "",
      user_agent: req.headers.get("user-agent") || "",
      is_revoked: false
    });

    // Create secure HTTP-only cookie
    const isProd = process.env.NODE_ENV === 'production' || req.url.startsWith('https');
    const cookie = `base44_session=${token}; HttpOnly; Path=/; SameSite=Lax${isProd ? '; Secure' : ''}; Max-Age=${7 * 24 * 60 * 60}`;

    // Successes matter as much as failures. A trail of failed attempts with no
    // successes in it cannot answer whether an attack eventually worked, which is
    // the first thing anyone asks. Logged after the session exists so the row
    // records a login that actually completed.
    await audit({
      action: 'Login',
      user,
      result: 'success',
      detail: user.mfa_enabled ? 'password and authentication code accepted' : 'password accepted',
    });

    return Response.json({ success: true, user: publicUser(user) }, {
      headers: {
        'Set-Cookie': cookie
      }
    });

  } catch (err) {
    console.error("Login error:", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
