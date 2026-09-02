// worker/totp.js — RFC 6238 time-based one-time passwords for the Worker.
//
// This code was private to worker/app-auth.js, where it served the sign-in step.
// The credential-lifecycle endpoints in worker/users.js must verify a TOTP code
// too (enrolment confirmation), and the replay guard only works if BOTH paths
// agree on what a counter is: sign-in refuses a counter it has already seen, so
// an enrolment check that computed counters differently would either reject valid
// codes or hand sign-in a counter it cannot compare against.
//
// One implementation, imported by both, is therefore a correctness requirement
// and not tidiness. worker/app-auth.js re-exports nothing from here; it imports
// what it needs.
//
// SHA-1 is not a choice this module gets to make. RFC 6238's default HMAC-SHA1 is
// what every authenticator app implements, and its security here rests on the
// 30-second window and the shared secret, not on collision resistance.

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** TOTP time step, in seconds. Fixed at the RFC 6238 default every app assumes. */
export const TOTP_PERIOD_SECONDS = 30;

/**
 * How many steps either side of "now" are accepted, to absorb clock skew between
 * the phone and Cloudflare's edge. One step each way is a 90-second window in
 * total; wider would make a shoulder-surfed code useful for longer.
 */
export const TOTP_WINDOW_STEPS = 1;

/** @param {Uint8Array} bytes */
export function base32Encode(bytes) {
  let bits = "";
  for (const byte of bytes) bits += byte.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i < bits.length; i += 5) {
    out += BASE32_ALPHABET[Number.parseInt(bits.slice(i, i + 5).padEnd(5, "0"), 2)];
  }
  return out;
}

/**
 * Decode base32 to bytes, ignoring case, padding and separators — an operator
 * reading a secret off a screen may retype it with spaces or dashes. Returns an
 * EMPTY array on any character outside the alphabet, which every caller treats as
 * "no usable secret" and therefore as a failed verification.
 *
 * @param {unknown} value
 */
export function base32Decode(value) {
  const clean = String(value || "").toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = "";
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) return new Uint8Array();
    bits += index.toString(2).padStart(5, "0");
  }
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(Number.parseInt(bits.slice(i, i + 8), 2));
  return new Uint8Array(out);
}

/**
 * A fresh 160-bit secret, base32-encoded to 32 characters. 160 bits is RFC 4226's
 * recommended HMAC-SHA1 key length, and 32 base32 characters carry it exactly.
 */
export function generateTotpSecret() {
  return base32Encode(crypto.getRandomValues(new Uint8Array(20)));
}

/**
 * The otpauth:// URI an authenticator app scans. It CONTAINS THE SECRET, so it is
 * returned to the enrolling user over their authenticated session and never
 * logged, stored, or included in an audit record.
 *
 * @param {string} secret
 * @param {string} label
 * @param {string} [issuer]
 */
export function totpUri(secret, label, issuer = "Red Roof Intelligence") {
  return `otpauth://totp/${encodeURIComponent(`${issuer}:${label}`)}?secret=${secret}`
    + `&issuer=${encodeURIComponent(issuer)}&period=${TOTP_PERIOD_SECONDS}&digits=6&algorithm=SHA1`;
}

/**
 * The 6-digit code for `secret` at a specific counter. Returns "" when the secret
 * does not decode, so a corrupt or absent secret produces a code no token can
 * equal rather than throwing out of a verification path.
 *
 * @param {string} secret base32
 * @param {number} counter Unix time / TOTP_PERIOD_SECONDS
 * @returns {Promise<string>}
 */
export async function totpAt(secret, counter) {
  const keyBytes = base32Decode(secret);
  if (!keyBytes.length) return "";
  const counterBytes = new Uint8Array(8);
  let remaining = BigInt(counter);
  for (let i = 7; i >= 0; i -= 1) {
    counterBytes[i] = Number(remaining & 255n);
    remaining >>= 8n;
  }
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, counterBytes));
  const offset = digest[digest.length - 1] & 15;
  const binary = (((digest[offset] & 127) << 24)
    | (digest[offset + 1] << 16)
    | (digest[offset + 2] << 8)
    | digest[offset + 3]) >>> 0;
  return String(binary % 1_000_000).padStart(6, "0");
}

/** Length-independent string comparison, so a token never leaks by response time. */
function equalToken(left, right) {
  const a = String(left || "");
  const b = String(right || "");
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) difference |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return difference === 0;
}

/** The counter for a moment in time. */
export function counterForTime(nowMs) {
  return Math.floor(nowMs / (TOTP_PERIOD_SECONDS * 1000));
}

/**
 * Verify `token` and return the counter it matched, or null.
 *
 * Returning the COUNTER rather than a boolean is what makes single-use possible:
 * the caller persists it and refuses anything less than or equal to it next time,
 * so a code observed inside its ±1 window cannot be replayed. `notBefore` lets a
 * caller refuse an already-spent counter before doing the comparison at all.
 *
 * @param {string} secret base32
 * @param {unknown} token
 * @param {number} nowMs
 * @param {{ notBefore?: number }} [options]
 * @returns {Promise<number | null>}
 */
export async function verifyTotp(secret, token, nowMs, options = {}) {
  if (!/^\d{6}$/.test(String(token || ""))) return null;
  const notBefore = Number.isFinite(options.notBefore) ? Number(options.notBefore) : -Infinity;
  const counter = counterForTime(nowMs);
  for (let step = -TOTP_WINDOW_STEPS; step <= TOTP_WINDOW_STEPS; step += 1) {
    const candidate = counter + step;
    if (candidate <= notBefore) continue;
    if (equalToken(await totpAt(secret, candidate), token)) return candidate;
  }
  return null;
}
