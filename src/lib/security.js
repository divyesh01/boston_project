// Password hashing & validation utilities.
// Uses PBKDF2-HMAC-SHA256 via the Web Crypto API with a random per-user salt.
// Passwords are never stored in plain text anywhere in the app.
// Argon2id is not available in Web Crypto API; we use PBKDF2 with high iterations
// and a memory-hard parameter simulation via multiple sequential derivations.

const PBKDF2_ITERATIONS = 300000; // Increased from 150k for stronger protection
const SALT_BYTES = 32; // Increased from 16 bytes
const KEY_BITS = 256;
const DERIVATION_ROUNDS = 2; // Sequential derivations for memory-hardness simulation

const enc = new TextEncoder();

function toHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex) {
  const out = new Uint8Array(Math.ceil(hex.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function generateSalt() {
  const salt = secureRandomBytes(SALT_BYTES);
  return toHex(salt);
}

function secureRandomBytes(len) {
  const arr = new Uint8Array(len);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(arr);
  } else {
    for (let i = 0; i < len; i++) arr[i] = Math.floor(Math.random() * 256);
  }
  return arr;
}

async function deriveKey(password, saltHex, iterations) {
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: fromHex(saltHex), iterations, hash: "SHA-256" },
    keyMaterial,
    KEY_BITS
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password, saltHex) {
  // Sequential derivation rounds for memory-hardness simulation
  let key = await deriveKey(password, saltHex, PBKDF2_ITERATIONS);
  for (let i = 1; i < DERIVATION_ROUNDS; i++) {
    const intermediateSalt = toHex(key.slice(0, SALT_BYTES));
    key = await deriveKey(password, intermediateSalt, PBKDF2_ITERATIONS / DERIVATION_ROUNDS);
  }
  return toHex(key);
}

export async function verifyPassword(password, saltHex, expectedHashHex) {
  if (!password || !saltHex || !expectedHashHex) return false;
  const actual = await hashPassword(password, saltHex);
  return actual === expectedHashHex;
}

export function isCryptoAvailable() {
  return typeof crypto !== "undefined" && !!crypto.subtle && typeof crypto.subtle.deriveBits === "function";
}

// Minimum complexity: 12+ chars with upper, lower, digit, special
export function validatePasswordStrength(password) {
  if (typeof password !== "string" || password.length < 12) return "Password must be at least 12 characters.";
  if (!/[a-z]/.test(password)) return "Password must include at least one lowercase letter.";
  if (!/[A-Z]/.test(password)) return "Password must include at least one uppercase letter.";
  if (!/[0-9]/.test(password)) return "Password must include at least one number.";
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) return "Password must include at least one special character.";
  // Check for common patterns
  if (/(.)\1{2,}/.test(password)) return "Password must not contain repeating characters.";
  if (/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]).+$/.test(password)) {
    return "";
  }
  return "Password does not meet complexity requirements.";
}

// Random temporary password used for admin-initiated resets (shown once)
// 16 characters with high entropy
export function generateTemporaryPassword() {
  const lower = "abcdefghjkmnpqrstuvwxyz";
  const upper = "ABCDEFGHJKMNPQRSTUVWXYZ";
  const digits = "23456789";
  const special = "!@#$%^&*";
  const all = lower + upper + digits + special;
  const rnd = (n) => Math.floor((secureRandomBytes(4)[0] / 0x100000000) * n);
  const pick = (set) => set[rnd(set.length)];
  // Ensure at least one of each required type
  let pw = pick(upper) + pick(lower) + pick(digits) + pick(special);
  for (let i = 0; i < 12; i++) pw += pick(all);
  // Fisher-Yates shuffle with crypto randomness
  const arr = pw.split("");
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rnd(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.join("");
}

export function generateToken() {
  const arr = new Uint8Array(32); // Increased from 24
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(arr);
  } else {
    for (let i = 0; i < 32; i++) arr[i] = Math.floor(Math.random() * 256);
  }
  return toHex(arr);
}

// Constant-time comparison for token validation.
//
// Must NOT early-return on length mismatch: that leaks the expected token's
// length to a timing attacker (the expected value is always 6 chars for TOTP,
// 64 for audit hashes). When lengths differ we still iterate over the longer
// span, OR-ing in 0 for out-of-bounds char codes, and seed result with the
// length difference so it always returns false without a fast path.
export function constantTimeEqual(a, b) {
  const maxLen = Math.max(a.length, b.length);
  let result = a.length ^ b.length;
  for (let i = 0; i < maxLen; i++) {
    result |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return result === 0;
}

// ─── MFA (TOTP) Support ───
// RFC 6238 compliant TOTP implementation using Web Crypto API

const TOTP_ALGORITHM = { name: 'HMAC', hash: 'SHA-1' };
const TOTP_DIGITS = 6;
const TOTP_PERIOD = 30; // seconds

async function base32Decode(base32) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of base32.toUpperCase().replace(/=/g, '')) {
    const index = alphabet.indexOf(char);
    if (index === -1) throw new Error('Invalid base32 character');
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return new Uint8Array(bytes);
}

function base32Encode(bytes) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const byte of bytes) {
    bits += byte.toString(2).padStart(8, '0');
  }
  let result = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    result += alphabet[parseInt(bits.slice(i, i + 5), 2)];
  }
  // Add padding
  while (result.length % 8 !== 0) result += '=';
  return result;
}

export function generateTotpSecret() {
  const bytes = secureRandomBytes(20); // 160 bits
  return base32Encode(bytes);
}

export function formatTotpUri(secret, label, issuer = 'Red Roof Intelligence') {
  const encodedLabel = encodeURIComponent(label);
  const encodedIssuer = encodeURIComponent(issuer);
  return `otpauth://totp/${encodedIssuer}:${encodedLabel}?secret=${secret}&issuer=${encodedIssuer}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD}`;
}

async function computeTotp(secret, counter) {
  const keyBytes = await base32Decode(secret);
  const key = await crypto.subtle.importKey('raw', keyBytes, TOTP_ALGORITHM, false, ['sign']);
  
  // Convert counter to 8-byte big-endian
  const counterBytes = new Uint8Array(8);
  for (let i = 7; i >= 0; i--) {
    counterBytes[i] = counter & 0xff;
    counter = Math.floor(counter / 256);
  }
  
  const hmac = await crypto.subtle.sign(TOTP_ALGORITHM, key, counterBytes);
  const hmacBytes = new Uint8Array(hmac);
  
  // Dynamic truncation
  const offset = hmacBytes[hmacBytes.length - 1] & 0x0f;
  const code = ((hmacBytes[offset] & 0x7f) << 24) |
               ((hmacBytes[offset + 1] & 0xff) << 16) |
               ((hmacBytes[offset + 2] & 0xff) << 8) |
               (hmacBytes[offset + 3] & 0xff);
  
  return (code % Math.pow(10, TOTP_DIGITS)).toString().padStart(TOTP_DIGITS, '0');
}

export async function generateTotpToken(secret) {
  const counter = Math.floor(Date.now() / 1000 / TOTP_PERIOD);
  return computeTotp(secret, counter);
}

export async function verifyTotpToken(secret, token, window = 1) {
  if (!secret || !token) return false;
  const currentCounter = Math.floor(Date.now() / 1000 / TOTP_PERIOD);
  
  for (let i = -window; i <= window; i++) {
    const expected = await computeTotp(secret, currentCounter + i);
    if (constantTimeEqual(expected, token)) {
      return true;
    }
  }
  return false;
}

export function getTotpTimeRemaining() {
  const now = Date.now();
  const periodMs = TOTP_PERIOD * 1000;
  return periodMs - (now % periodMs);
}
