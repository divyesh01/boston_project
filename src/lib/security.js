// Password hashing & validation utilities.
// Uses PBKDF2-HMAC-SHA256 via the Web Crypto API with a random per-user salt.
// Passwords are never stored in plain text anywhere in the app.

const PBKDF2_ITERATIONS = 150000;
const SALT_BYTES = 16;
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
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  return toHex(salt);
}

export async function hashPassword(password, saltHex) {
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: fromHex(saltHex), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    KEY_BITS
  );
  return toHex(new Uint8Array(bits));
}

export async function verifyPassword(password, saltHex, expectedHashHex) {
  if (!password || !saltHex || !expectedHashHex) return false;
  const actual = await hashPassword(password, saltHex);
  return actual === expectedHashHex;
}

export function isCryptoAvailable() {
  return typeof crypto !== "undefined" && !!crypto.subtle && typeof crypto.subtle.deriveBits === "function";
}

// Minimum complexity: 8+ chars with upper, lower, digit
export function validatePasswordStrength(password) {
  if (typeof password !== "string" || password.length < 8) return "Password must be at least 8 characters.";
  if (!/[a-z]/.test(password)) return "Password must include at least one lowercase letter.";
  if (!/[A-Z]/.test(password)) return "Password must include at least one uppercase letter.";
  if (!/[0-9]/.test(password)) return "Password must include at least one number.";
  return "";
}

// Random temporary password used for admin-initiated resets (shown once)
export function generateTemporaryPassword() {
  const lower = "abcdefghjkmnpqrstuvwxyz";
  const upper = "ABCDEFGHJKMNPQRSTUVWXYZ";
  const digits = "23456789";
  const pick = (set) => set[Math.floor(Math.random() * set.length)];
  let pw = pick(upper) + pick(lower) + pick(digits);
  const all = lower + upper + digits;
  for (let i = 0; i < 9; i++) pw += pick(all);
  return pw.split("").sort(() => Math.random() - 0.5).join("");
}

export function generateToken() {
  const arr = new Uint8Array(24);
  crypto.getRandomValues(arr);
  return toHex(arr);
}
