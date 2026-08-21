// Password hashing & validation utilities.
// Uses PBKDF2-HMAC-SHA256 via the Web Crypto API with a random per-user salt.
// Passwords are never stored in plain text anywhere in the app.
//
// Argon2id is not available in the Web Crypto API, so this is PBKDF2 chained
// across two rounds. Be exact about what the chaining buys: it raises the CPU
// time an attacker pays per guess, and nothing else. PBKDF2 has no memory-cost
// parameter to turn up — that absence is the entire reason Argon2id exists — so a
// GPU or ASIC attacks 450,000 PBKDF2 iterations far more cheaply than it attacks
// Argon2id tuned to the same wall-clock cost. Read this as "the strongest thing
// the platform offers without shipping a WASM hash", not as memory-hard.

// THE DERIVATION SCHEDULE IS A STORED-DATA FORMAT, NOT A TUNABLE.
//
// Round 1 runs 300,000 iterations over the user's own salt. Round 2 runs 150,000
// over the first SALT_BYTES of round 1's output. Total: 450,000 iterations of
// PBKDF2-HMAC-SHA256 per password check.
//
// Every hash in the User table was produced by exactly these numbers, so
// hashPassword's output IS the stored credential. Changing an entry here, adding
// a round, removing one, or altering SALT_BYTES or KEY_BITS makes every existing
// hash unverifiable and locks every account out of the system on deploy. Raising
// the cost is a migration — verify under the old schedule, re-derive under the
// new one, persist a schedule version alongside the hash — not an edit to this
// array.
//
// Written as an explicit per-round list because the previous form computed round
// 2 as `PBKDF2_ITERATIONS / DERIVATION_ROUNDS`. That tied two unrelated numbers
// together and read as though every round cost the same 300,000: raising
// DERIVATION_ROUNDS to 3 to "add a round" would in fact have produced
// 300k + 100k + 100k = 500k, weakening rounds 2 and 3 while looking like a
// strengthening. The header also advertised 300,000 and described the chaining as
// simulating a memory-hard KDF; the real figure was 450,000 and the description
// was false.
//
// The same schedule is duplicated in base44/functions/custom_auth_login/entry.js
// and base44/functions/custom_user_admin/entry.js, because the base44 host
// resolves only npm:, node: and base44:runtime specifiers and so cannot import
// this module. scripts/probe-password-policy.mjs section 3 fails if the copies
// drift, and section 1 is a known-answer test that fails if the derived bytes
// change at all.
const PBKDF2_ROUND_ITERATIONS = Object.freeze([300000, 150000]);
const SALT_BYTES = 32;
const KEY_BITS = 256;

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
  if (typeof crypto === "undefined" || !crypto.getRandomValues) {
    throw new Error("Web Crypto API is required.");
  }
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
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
  // Round 1 derives from the caller's salt; every later round re-derives from the
  // previous round's output, so the rounds are strictly sequential and cannot be
  // reordered or run in parallel by an attacker.
  let key = await deriveKey(password, saltHex, PBKDF2_ROUND_ITERATIONS[0]);
  for (let i = 1; i < PBKDF2_ROUND_ITERATIONS.length; i++) {
    const intermediateSalt = toHex(key.slice(0, SALT_BYTES));
    key = await deriveKey(password, intermediateSalt, PBKDF2_ROUND_ITERATIONS[i]);
  }
  return toHex(key);
}

export async function verifyPassword(password, saltHex, expectedHashHex) {
  if (!password || !saltHex || !expectedHashHex) return false;
  const actual = await hashPassword(password, saltHex);
  // constantTimeEqual, not ===. Not because a JS string comparison is a practical
  // remote attack on its own, but because === returns the moment two characters
  // differ, so the time it takes leaks how many leading hex digits of the stored
  // hash a guess reproduced. That is the one measurement that turns "crack the
  // hash offline" into an online digit-at-a-time search against a live endpoint.
  // This file already declines to leak that for 6-digit TOTP codes; declining it
  // for the credential itself is the same rule applied to the higher-value secret.
  return constantTimeEqual(actual, expectedHashHex);
}

export function isCryptoAvailable() {
  return typeof crypto !== "undefined" && !!crypto.subtle && typeof crypto.subtle.deriveBits === "function";
}

// THE PASSWORD POLICY. Twelve characters or more, with a lowercase letter, an
// uppercase letter, a digit and a special character, no character three times in
// a row, and no line terminators.
//
// Returns "" for acceptable, or a message naming the ONE rule that was broken.
// Callers render the return value straight into the form, so a message that names
// no rule is a dead end for the person typing.
//
// WHY THE LINE-TERMINATOR RULE IS WRITTEN OUT. It used to be enforced by
// accident. The final check was
//
//     /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[<special>]).+$/
//
// whose four lookaheads re-tested the four conditions on the lines immediately
// above, which made it look like dead code guarding an unreachable message. It
// was not dead. JavaScript's `$` without the `m` flag matches only at the very
// end of input, and `.` never matches a line terminator, so the regex failed for
// any password containing U+000A, U+000D, U+2028 or U+2029 — including the
// trailing newline that comes free with a paste out of a text file or a password
// manager. Those passwords were refused with "does not meet complexity
// requirements" while every rule the user could see was satisfied, which is
// unactionable. Refusing them is right; refusing them for a stated reason is the
// fix, and the redundant regex then has nothing left to do.
//
// Tabs and spaces ARE matched by `.` and remain acceptable. That is deliberate:
// this rule is about line breaks, not whitespace, and widening it would reject
// passphrases that were previously valid.
//
// The same policy is enforced server-side in
// base44/functions/custom_user_admin/entry.js and
// base44/functions/custom_auth_reset_password/entry.js — the gates that actually
// count, since anything checked only here is a hint. Those copies were 8
// characters with three classes until 2026-08-20, so "Abcdefg1" was a valid
// password as far as the server was concerned. scripts/probe-password-policy.mjs
// section 7 evaluates both copies and fails if either decides ANY input
// differently from this function.
export function validatePasswordStrength(password) {
  if (typeof password !== "string" || password.length < 12) return "Password must be at least 12 characters.";
  if (!/[a-z]/.test(password)) return "Password must include at least one lowercase letter.";
  if (!/[A-Z]/.test(password)) return "Password must include at least one uppercase letter.";
  if (!/[0-9]/.test(password)) return "Password must include at least one number.";
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) return "Password must include at least one special character.";
  if (/(.)\1{2,}/.test(password)) return "Password must not contain repeating characters.";
  if (/[\n\r\u2028\u2029]/.test(password)) return "Password must not contain line breaks.";
  return "";
}

// Random temporary password used for admin-initiated resets (shown once).
// 16 characters, guaranteed to satisfy validatePasswordStrength.
export function generateTemporaryPassword() {
  const lower = "abcdefghjkmnpqrstuvwxyz";
  const upper = "ABCDEFGHJKMNPQRSTUVWXYZ";
  const digits = "23456789";
  const special = "!@#$%^&*";
  const all = lower + upper + digits + special;
  const rnd = (n) => {
    if (typeof crypto === "undefined" || !crypto.getRandomValues) throw new Error("Web Crypto API is required.");
    const arr = new Uint32Array(1);
    crypto.getRandomValues(arr);
    return Math.floor((arr[0] / (0xffffffff + 1)) * n);
  };
  const pick = (set) => set[rnd(set.length)];
  const draw = () => {
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
  };
  // Draw until the result satisfies the policy this file also defines.
  //
  // The construction guarantees one of each class but nothing in it prevents the
  // same character being drawn three times in a row, which
  // validatePasswordStrength refuses — measured at 11 rejections in 3000 draws
  // (0.37%) before this loop existed. Users.jsx validates the password it has
  // just generated, so those draws reached an administrator as a reset that
  // failed for no reason they could act on, roughly one in every 270.
  //
  // Redrawing rather than repairing: draws are independent and compliant with
  // probability ~0.996, so the expected cost is one draw and the bound is
  // unreachable in practice, while "repair" would mean editing a character and
  // reasoning about whether the edit broke the class guarantees. Throwing beats
  // returning a non-compliant password, because a temporary credential the app
  // will not accept is not a degraded result — it is a broken reset that looks
  // like a working one.
  for (let attempt = 0; attempt < 100; attempt++) {
    const candidate = draw();
    if (validatePasswordStrength(candidate) === "") return candidate;
  }
  throw new Error("Could not generate a temporary password satisfying the password policy.");
}

export function generateToken() {
  if (typeof crypto === "undefined" || !crypto.getRandomValues) {
    throw new Error("Web Crypto API is required.");
  }
  const arr = new Uint8Array(32); // Increased from 24
  crypto.getRandomValues(arr);
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
