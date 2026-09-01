// Versioned, Cloudflare-compatible password credentials.
// The per-user salt and verifier are stored together; the pepper remains a
// Worker secret and is never written to D1 or source control.

const CREDENTIAL_VERSION = 1;
const PEPPER_VERSION = 1;
const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 32;
const VERIFIER_BYTES = 32;
const encoder = new TextEncoder();
const DUMMY_SALT = new Uint8Array([
  0x7f, 0x1e, 0x4a, 0x9c, 0x3d, 0x8b, 0x22, 0x10,
  0x55, 0x6a, 0xfe, 0x01, 0xd4, 0x99, 0x33, 0xaa,
  0x44, 0x88, 0xcc, 0xee, 0x11, 0x22, 0x33, 0x44,
  0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc,
]);
const DUMMY_VERIFIER = new Uint8Array(VERIFIER_BYTES);

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

function parseCredential(value) {
  const match = /^\$rri-pbkdf2-sha256\$v=(\d+)\$i=(\d+)\$p=(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(String(value || ""));
  if (!match) return null;
  const version = Number(match[1]);
  const iterations = Number(match[2]);
  const pepperVersion = Number(match[3]);
  const salt = fromBase64Url(match[4]);
  const verifier = fromBase64Url(match[5]);
  if (version !== CREDENTIAL_VERSION || iterations !== PBKDF2_ITERATIONS || pepperVersion !== PEPPER_VERSION) return null;
  if (salt?.length !== SALT_BYTES || verifier?.length !== VERIFIER_BYTES) return null;
  return { version, iterations, pepperVersion, salt, verifier };
}

async function deriveVerifier(password, salt, iterations, pepper) {
  const passwordKey = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const stretched = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    passwordKey,
    VERIFIER_BYTES * 8,
  );
  const pepperKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", pepperKey, stretched));
}

function constantTimeEqual(left, right) {
  const nativeEqual = Reflect.get(crypto.subtle, "timingSafeEqual");
  if (typeof nativeEqual === "function" && left.length === right.length) {
    return Boolean(nativeEqual.call(crypto.subtle, left, right));
  }
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) difference |= (left[index] || 0) ^ (right[index] || 0);
  return difference === 0;
}

export function credentialPepper(env) {
  const pepper = String(env?.PASSWORD_PEPPER_V1 || "");
  return pepper.length >= 32 ? pepper : "";
}

export async function createCredential(password, pepper, suppliedSalt) {
  if (String(pepper || "").length < 32) throw new Error("PASSWORD_PEPPER_V1 is missing or too short.");
  const salt = suppliedSalt || crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  if (!(salt instanceof Uint8Array) || salt.length !== SALT_BYTES) throw new Error("Credential salt must be exactly 32 bytes.");
  const verifier = await deriveVerifier(String(password), salt, PBKDF2_ITERATIONS, String(pepper));
  return {
    encoded: `$rri-pbkdf2-sha256$v=${CREDENTIAL_VERSION}$i=${PBKDF2_ITERATIONS}$p=${PEPPER_VERSION}$${base64Url(salt)}$${base64Url(verifier)}`,
    salt: base64Url(salt),
  };
}

export async function verifyCredential(password, encoded, pepper) {
  if (String(pepper || "").length < 32) return false;
  const parsed = parseCredential(encoded);
  const actual = await deriveVerifier(
    String(password),
    parsed?.salt || DUMMY_SALT,
    parsed?.iterations || PBKDF2_ITERATIONS,
    String(pepper),
  );
  return !!parsed && constantTimeEqual(actual, parsed.verifier || DUMMY_VERIFIER);
}

export function isSupportedCredential(encoded) {
  return parseCredential(encoded) !== null;
}

export { CREDENTIAL_VERSION, PBKDF2_ITERATIONS, PEPPER_VERSION };
