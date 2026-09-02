// worker/password-policy.js — THE password policy, on the Cloudflare Worker.
//
// This is a fourth copy of a rule that already exists three times:
//   * src/lib/security.js#validatePasswordStrength          (browser hint)
//   * base44/functions/custom_user_admin/entry.js            (Base44 server)
//   * base44/functions/custom_auth_reset_password/entry.js   (Base44 server)
//
// It is a copy and not an import because worker/* runs on the Cloudflare Workers
// runtime and must never import from src/ or base44/ — the Worker bundle cannot
// load the browser bundle, and the Base44 functions are Node. The predicates
// below are character-for-character the same decisions those copies make, so a
// password accepted by one is accepted by all of them.
//
// WHY THIS MATTERS MORE THAN DUPLICATION DOES: with the Worker owning identity,
// this file is the LAST gate a new password passes through before it becomes a
// stored credential. Anything checked only in the browser is a hint an attacker
// simply does not send.
//
// scripts/probe-worker-credential-lifecycle.mjs asserts this module and
// src/lib/security.js agree on a shared corpus, so the copies cannot drift
// silently.

/** Usernames: 3-30 characters, letters/digits/underscore only. */
const USERNAME_RE = /^[a-zA-Z0-9_]{3,30}$/;

/** Deliberately permissive: rejects the obviously malformed, not the exotic. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * A password long enough that PBKDF2 is doing real work. Anything the client
 * sends longer than this is refused rather than derived, so a multi-megabyte
 * body cannot turn 100 000 PBKDF2 iterations into a CPU-time attack on the
 * Worker. worker/app-auth.js applies the same ceiling at login.
 */
const PASSWORD_MAX_LENGTH = 1024;

/** @param {unknown} username */
export function isValidUsername(username) {
  return USERNAME_RE.test(String(username ?? ""));
}

/** @param {unknown} email */
export function isValidEmail(email) {
  return EMAIL_RE.test(String(email ?? ""));
}

/**
 * Returns an explanatory message when `password` violates the policy, or "" when
 * it satisfies it. The messages are returned to the caller verbatim (see
 * worker/users.js), because "Password must include at least one number." is
 * information the person choosing the password needs and gives an attacker
 * nothing they could not learn by trying.
 *
 * @param {unknown} password
 * @returns {string} "" when acceptable
 */
export function validatePasswordStrength(password) {
  if (typeof password !== "string" || password.length < 12) return "Password must be at least 12 characters.";
  if (password.length > PASSWORD_MAX_LENGTH) return "Password must be at most 1024 characters.";
  if (!/[a-z]/.test(password)) return "Password must include at least one lowercase letter.";
  if (!/[A-Z]/.test(password)) return "Password must include at least one uppercase letter.";
  if (!/[0-9]/.test(password)) return "Password must include at least one number.";
  if (!/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/.test(password)) return "Password must include at least one special character.";
  if (/(.)\1{2,}/.test(password)) return "Password must not contain repeating characters.";
  if (/[\n\r\u2028\u2029]/.test(password)) return "Password must not contain line breaks.";
  return "";
}

export { PASSWORD_MAX_LENGTH };

// ---------------------------------------------------------------------------
// Temporary passwords
// ---------------------------------------------------------------------------

const TEMP_LOWER = "abcdefghjkmnpqrstuvwxyz";
const TEMP_UPPER = "ABCDEFGHJKMNPQRSTUVWXYZ";
const TEMP_DIGITS = "23456789";
const TEMP_SPECIAL = "!@#$%^&*";
const TEMP_ALL = TEMP_LOWER + TEMP_UPPER + TEMP_DIGITS + TEMP_SPECIAL;

/** Uniform in [0, n) from crypto randomness, rejecting the biased tail. */
function randomBelow(n) {
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  const draw = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(draw);
    if (draw[0] < limit) return draw[0] % n;
  }
}

/**
 * A 16-character temporary password that satisfies validatePasswordStrength.
 * Look-alike characters (0/O, 1/l/I) are excluded because these are read off a
 * screen and typed by hand.
 *
 * The construction guarantees one character of each required class but nothing in
 * it prevents the same character being drawn three times in a row, which the
 * policy refuses — so the result is validated and redrawn rather than repaired.
 * Draws are independent and compliant with probability ~0.996, so the expected
 * cost is one draw. Throwing beats returning a non-compliant password: a
 * temporary credential the login path will not accept is not a degraded result,
 * it is a broken reset that looks like a working one.
 *
 * @returns {string}
 */
export function generateTemporaryPassword() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const pick = (set) => set[randomBelow(set.length)];
    const characters = [pick(TEMP_UPPER), pick(TEMP_LOWER), pick(TEMP_DIGITS), pick(TEMP_SPECIAL)];
    while (characters.length < 16) characters.push(pick(TEMP_ALL));
    for (let i = characters.length - 1; i > 0; i -= 1) {
      const j = randomBelow(i + 1);
      [characters[i], characters[j]] = [characters[j], characters[i]];
    }
    const candidate = characters.join("");
    if (validatePasswordStrength(candidate) === "") return candidate;
  }
  throw new Error("Could not generate a policy-compliant temporary password.");
}
