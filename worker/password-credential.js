// Versioned, Cloudflare-compatible password credentials.
// The per-user salt and verifier are stored together; the pepper remains a
// Worker secret and is never written to D1 or source control.

const CREDENTIAL_VERSION = 1;
const PEPPER_VERSION = 1;
const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 32;
const VERIFIER_BYTES = 32;

// ---------------------------------------------------------------------------
// What this module will still VERIFY, as opposed to what it now CREATES
// ---------------------------------------------------------------------------
//
// parseCredential() used to demand `v=1$i=100000$p=1` exactly. That made every
// parameter in the envelope a one-way door: the moment PBKDF2_ITERATIONS or
// PEPPER_VERSION changed, every stored credential became unparseable,
// verifyCredential() returned false for the correct password, and every user was
// locked out with no recovery path short of an admin reset for each one.
//
// The envelope already carries its own parameters, so the fix is to verify with
// the parameters the credential DECLARES and to create with the parameters
// configured NOW. The sets below are the accepted range; anything outside them
// still fails closed.
//
// The iteration bound is a RANGE and not an enumeration on purpose. A floor
// stops a rewritten `i=1` row from turning verification into a cheap oracle, a
// ceiling stops an `i=999999999` row from turning one login into a Worker
// CPU-time exhaustion, and between them a future increase needs no code edit —
// which is exactly the property whose absence was the defect. The floor is the
// current cost, so today nothing weaker than production parity verifies at all.
const SUPPORTED_CREDENTIAL_VERSIONS = new Set([1]);
const MIN_SUPPORTED_ITERATIONS = 100_000;
const MAX_SUPPORTED_ITERATIONS = 1_000_000;
const MAX_PEPPER_VERSION = 8;

const encoder = new TextEncoder();
const DUMMY_SALT = new Uint8Array([
  0x7f, 0x1e, 0x4a, 0x9c, 0x3d, 0x8b, 0x22, 0x10,
  0x55, 0x6a, 0xfe, 0x01, 0xd4, 0x99, 0x33, 0xaa,
  0x44, 0x88, 0xcc, 0xee, 0x11, 0x22, 0x33, 0x44,
  0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc,
]);
const DUMMY_VERIFIER = new Uint8Array(VERIFIER_BYTES);

/**
 * A fixed pepper used ONLY to keep the derivation cost of a doomed verification
 * identical to a real one. It is never accepted: the caller has already decided
 * the attempt fails before this value is reached.
 */
const DUMMY_PEPPER = "unconfigured-pepper-placeholder-32b+";

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
  if (!SUPPORTED_CREDENTIAL_VERSIONS.has(version)) return null;
  if (!Number.isInteger(iterations) || iterations < MIN_SUPPORTED_ITERATIONS || iterations > MAX_SUPPORTED_ITERATIONS) return null;
  if (!Number.isInteger(pepperVersion) || pepperVersion < 1 || pepperVersion > MAX_PEPPER_VERSION) return null;
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

/**
 * The pepper version new credentials are minted at. Defaults to 1, so with no
 * new configuration this module behaves exactly as it did before.
 *
 * A rotation is therefore: publish PASSWORD_PEPPER_V2 as a second Worker secret,
 * set PASSWORD_PEPPER_CURRENT_VERSION=2, and KEEP V1. V1 credentials still
 * verify against V1 and are re-derived to V2 on their owner's next successful
 * login; V1 may be deleted once no `p=1` rows remain. Deleting V1 first is what
 * locks users out, and nothing here can rescue that — which is why both secrets
 * must overlap for the length of the rotation.
 *
 * @param {Record<string, unknown> | undefined} env
 */
export function currentPepperVersion(env) {
  const raw = Number(env?.PASSWORD_PEPPER_CURRENT_VERSION ?? PEPPER_VERSION);
  return Number.isInteger(raw) && raw >= 1 && raw <= MAX_PEPPER_VERSION ? raw : PEPPER_VERSION;
}

/** The secret backing pepper version `version`, or "" when it is absent/too short. */
export function pepperForVersion(env, version) {
  if (!Number.isInteger(version) || version < 1 || version > MAX_PEPPER_VERSION) return "";
  const pepper = String(env?.[`PASSWORD_PEPPER_V${version}`] || "");
  return pepper.length >= 32 ? pepper : "";
}

/**
 * The pepper new credentials are minted with. Callers use a "" return as the
 * signal to fail the request (worker/app-auth.js answers 503), because deriving
 * against an empty pepper would silently produce credentials that stop verifying
 * the moment the secret is configured.
 */
export function credentialPepper(env) {
  return pepperForVersion(env, currentPepperVersion(env));
}

/** The parameter tuple this Worker mints at right now. */
export function currentCredentialParameters(env) {
  return {
    version: CREDENTIAL_VERSION,
    iterations: PBKDF2_ITERATIONS,
    pepperVersion: currentPepperVersion(env),
  };
}

/**
 * Mint a credential at EXPLICIT parameters. This is the primitive the rotation
 * path is built from, and it is also how a test mints a credential at retired
 * parameters without hand-rolling PBKDF2 — the alternative being a second,
 * unreviewed copy of the derivation inside the test harness.
 *
 * `pepper` must be the secret for `pepperVersion`; this function cannot check
 * that, so callers pass pepperForVersion(env, pepperVersion).
 *
 * @param {string} password
 * @param {string} pepper
 * @param {{ version?: number, iterations?: number, pepperVersion?: number, salt?: Uint8Array }} [parameters]
 * @returns {Promise<{ encoded: string, salt: string }>}
 */
export async function createCredentialWithParameters(password, pepper, parameters = {}) {
  const version = parameters.version ?? CREDENTIAL_VERSION;
  const iterations = parameters.iterations ?? PBKDF2_ITERATIONS;
  const pepperVersion = parameters.pepperVersion ?? PEPPER_VERSION;
  if (String(pepper || "").length < 32) {
    throw new Error(`PASSWORD_PEPPER_V${pepperVersion} is missing or too short.`);
  }
  if (!SUPPORTED_CREDENTIAL_VERSIONS.has(version)) throw new Error(`Unsupported credential version ${version}.`);
  if (!Number.isInteger(iterations) || iterations < MIN_SUPPORTED_ITERATIONS || iterations > MAX_SUPPORTED_ITERATIONS) {
    throw new Error(`Unsupported PBKDF2 iteration count ${iterations}.`);
  }
  if (!Number.isInteger(pepperVersion) || pepperVersion < 1 || pepperVersion > MAX_PEPPER_VERSION) {
    throw new Error(`Unsupported pepper version ${pepperVersion}.`);
  }
  const salt = parameters.salt || crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  if (!(salt instanceof Uint8Array) || salt.length !== SALT_BYTES) throw new Error("Credential salt must be exactly 32 bytes.");
  const verifier = await deriveVerifier(String(password), salt, iterations, String(pepper));
  return {
    encoded: `$rri-pbkdf2-sha256$v=${version}$i=${iterations}$p=${pepperVersion}$${base64Url(salt)}$${base64Url(verifier)}`,
    salt: base64Url(salt),
  };
}

/**
 * Mint at v=1/i=100000/p=1. Kept at its original signature because the
 * provisioning and migration scripts and the probe harness all call it this way,
 * and because a caller that supplies only a pepper means "the current one".
 */
export async function createCredential(password, pepper, suppliedSalt) {
  return createCredentialWithParameters(password, pepper, { salt: suppliedSalt });
}

/**
 * Mint at whatever this Worker is configured for, resolving the pepper itself.
 * Handlers that create or replace a credential use this so a pepper rotation
 * reaches every write path without each one repeating the version lookup.
 */
export async function createCredentialForEnv(password, env, suppliedSalt) {
  const parameters = currentCredentialParameters(env);
  const pepper = pepperForVersion(env, parameters.pepperVersion);
  return createCredentialWithParameters(password, pepper, { ...parameters, salt: suppliedSalt });
}

/**
 * Verify against a SINGLE known pepper. Retained unchanged for the provisioning
 * and migration scripts, which hold one pepper and mint the credential they then
 * check. Request paths should use verifyCredentialForEnv, which resolves the
 * pepper from the version the stored credential declares.
 */
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

/** True when `parsed` was minted at anything other than the parameters we mint now. */
function isBehindTarget(parsed, target) {
  if (parsed.version !== target.version) return true;
  if (parsed.pepperVersion !== target.pepperVersion) return true;
  // Strictly-less-than, never not-equal: a credential minted at a HIGHER cost
  // than today's configuration is stronger than what we would replace it with,
  // and re-deriving it would quietly downgrade the account.
  return parsed.iterations < target.iterations;
}

/**
 * Whether `encoded` should be re-derived. Exported so a probe can prove the
 * predicate on every axis (version, pepper version, iteration count) against an
 * explicit target, without changing the Worker's live parameters to do it.
 *
 * @param {string} encoded
 * @param {{ version?: number, iterations?: number, pepperVersion?: number }} [target]
 */
export function credentialNeedsUpgrade(encoded, target = {}) {
  const parsed = parseCredential(encoded);
  if (!parsed) return false;
  return isBehindTarget(parsed, {
    version: target.version ?? CREDENTIAL_VERSION,
    iterations: target.iterations ?? PBKDF2_ITERATIONS,
    pepperVersion: target.pepperVersion ?? PEPPER_VERSION,
  });
}

/**
 * Verify `password` against `encoded` using the pepper for the version the
 * credential itself declares, and report whether it is now behind the parameters
 * this Worker mints.
 *
 * Failure modes deliberately cost the same as success: an unparseable envelope, a
 * pepper version we no longer hold, and a wrong password all perform one full
 * PBKDF2 derivation, so response time does not separate "no such credential
 * shape" from "wrong password".
 *
 * @returns {Promise<{ ok: boolean, needsUpgrade: boolean, parameters: null | { version: number, iterations: number, pepperVersion: number } }>}
 */
export async function verifyCredentialForEnv(password, encoded, env) {
  const parsed = parseCredential(encoded);
  const pepper = parsed ? pepperForVersion(env, parsed.pepperVersion) : "";
  const usable = Boolean(parsed) && pepper.length >= 32;
  const actual = await deriveVerifier(
    String(password),
    parsed?.salt || DUMMY_SALT,
    parsed?.iterations || PBKDF2_ITERATIONS,
    usable ? pepper : DUMMY_PEPPER,
  );
  const ok = usable && constantTimeEqual(actual, parsed.verifier || DUMMY_VERIFIER);
  return {
    ok,
    needsUpgrade: ok && isBehindTarget(parsed, currentCredentialParameters(env)),
    parameters: parsed
      ? { version: parsed.version, iterations: parsed.iterations, pepperVersion: parsed.pepperVersion }
      : null,
  };
}

/**
 * Whether `encoded` is a credential this Worker can still verify. With `env`
 * supplied it also requires that we hold the pepper the credential names — a
 * `p=2` row is not "supported" on a Worker that has no PASSWORD_PEPPER_V2, and
 * treating it as such is how a caller that skips the derivation (the MFA
 * challenge branch in worker/app-auth.js) would accept a credential nothing can
 * actually check.
 */
export function isSupportedCredential(encoded, env) {
  const parsed = parseCredential(encoded);
  if (!parsed) return false;
  if (env === undefined) return true;
  return pepperForVersion(env, parsed.pepperVersion).length >= 32;
}

export {
  CREDENTIAL_VERSION,
  MAX_PEPPER_VERSION,
  MAX_SUPPORTED_ITERATIONS,
  MIN_SUPPORTED_ITERATIONS,
  PBKDF2_ITERATIONS,
  PEPPER_VERSION,
};
