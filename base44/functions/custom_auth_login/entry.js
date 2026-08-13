import { createClientFromRequest } from "npm:@base44/sdk@^0.8.41";
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

function verifyTotpToken(secretBase32, token, window = 1) {
  const secretBytes = base32Decode(secretBase32);
  const provided = String(token).replace(/\s/g, "");
  if (!/^\d{6}$/.test(provided)) return false;
  const counter = Math.floor(Date.now() / 30000);
  for (let w = -window; w <= window; w++) {
    const expected = String(totp(secretBytes, (counter + w) * 30000)).padStart(6, "0");
    if (crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) {
      return true;
    }
  }
  return false;
}

export function publicUser(user) {
  if (!user) return null;
  const { password_hash, salt, mfa_secret, reset_token_hash, reset_token_expires_at, session_created, session_expires, ...safe } = user;
  return safe;
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
          return Response.json({ error: "Too many login attempts. Please try again later." }, { status: 429 });
        }
        rl.count += 1;
        await base44.asServiceRole.entities.RateLimit.update(rl.id, { count: rl.count });
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
      // Return generic message to prevent user enumeration
      return Response.json({ error: "Invalid email or password" }, { status: 401 });
    }

    if (user.is_locked) {
      return Response.json({ error: "Account is locked" }, { status: 403 });
    }

    if (!user.is_active) {
      return Response.json({ error: "Account is inactive" }, { status: 403 });
    }

    // Verify password
    const expectedHash = user.password_hash;
    const isLegacy = !expectedHash.startsWith('$scrypt$');

    let actualHash;
    if (isLegacy) {
      actualHash = await hashPassword(password, user.salt);
    } else {
      actualHash = '$scrypt$' + await hashPasswordScrypt(password, user.salt);
    }

    // Constant time compare
    if (!crypto.timingSafeEqual(Buffer.from(actualHash), Buffer.from(expectedHash))) {
      // Increment failed logins
      const failed = (user.failed_login_count || 0) + 1;
      const updates = { failed_login_count: failed };
      if (failed >= 10) {
        updates.is_locked = true;
      }
      await base44.asServiceRole.entities.User.update(user.id, updates);
      return Response.json({ error: "Invalid email or password" }, { status: 401 });
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
      if (!user.mfa_secret || !verifyTotpToken(user.mfa_secret, mfa_token)) {
        return Response.json({ error: "Invalid authentication code" }, { status: 401 });
      }
    }

    // Reset failed logins
    if (user.failed_login_count > 0) {
      await base44.asServiceRole.entities.User.update(user.id, { failed_login_count: 0 });
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
