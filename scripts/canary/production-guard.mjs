// scripts/canary/production-guard.mjs
// Strict production guard and secret redaction for RRI canary automation.

export class ProductionGuardError extends Error {
  /**
   * @param {string} message
   * @param {string} [code]
   */
  constructor(message, code = 'PRODUCTION_TARGET_FORBIDDEN') {
    super(message);
    this.name = 'ProductionGuardError';
    this.code = code;
  }
}

export const FORBIDDEN_HOSTNAMES = Object.freeze([
  'boston-project.divyesh-boston.workers.dev',
]);

export const FORBIDDEN_SERVICES = Object.freeze([
  'boston-project',
]);

export const FORBIDDEN_D1_NAMES = Object.freeze([
  'boston-project-production-auth',
]);

export const FORBIDDEN_D1_IDS = Object.freeze([
  'e9008126-d4b4-4588-841c-128eadd94c8d',
]);

/**
 * Extracts and normalizes hostname from a URL string.
 * @param {string} rawUrl
 * @returns {string}
 */
export function extractHostname(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  const trimmed = rawUrl.trim();
  const withProto = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(withProto).hostname.toLowerCase().replace(/\.+$/, '');
  } catch {
    return trimmed.toLowerCase().split('/')[0].split(':')[0].replace(/\.+$/, '');
  }
}

/**
 * Extracts, validates, and normalizes target URL, rejecting forbidden schemes, userinfo, and production hosts.
 * @param {string} rawUrl
 * @returns {{ url: URL, hostname: string }}
 */
export function validateTargetUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    throw new ProductionGuardError('Target URL must be a non-empty string', 'INVALID_CANARY_URL');
  }

  // Always check forbidden production hostnames first
  const host = extractHostname(rawUrl);
  for (const forbidden of FORBIDDEN_HOSTNAMES) {
    if (host === forbidden || host.endsWith(`.${forbidden}`)) {
      throw new ProductionGuardError(
        `Refusing to target production host: ${host}`,
        'PRODUCTION_TARGET_FORBIDDEN'
      );
    }
  }

  const trimmed = rawUrl.trim();
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed);
  const toParse = hasScheme ? trimmed : `https://${trimmed}`;
  let parsed;
  try {
    parsed = new URL(toParse);
  } catch {
    throw new ProductionGuardError(`Invalid URL structure: ${rawUrl}`, 'INVALID_CANARY_URL');
  }

  // Userinfo safety: reject credentials in target URL
  if (parsed.username || parsed.password || /@[^/]+/.test(rawUrl)) {
    throw new ProductionGuardError(`URL userinfo/embedded credentials are forbidden in target URL: ${rawUrl}`, 'INVALID_CANARY_URL');
  }

  // Scheme safety: strictly require https or local http
  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'https:' && protocol !== 'http:') {
    throw new ProductionGuardError(`Disallowed URL scheme '${protocol}': only HTTPS is permitted for canary targets`, 'INVALID_CANARY_URL');
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.+$/, '');
  if (protocol === 'http:' && hostname !== 'localhost' && hostname !== '127.0.0.1') {
    throw new ProductionGuardError(`Insecure HTTP scheme is only permitted for localhost/127.0.0.1, got: ${hostname}`, 'INVALID_CANARY_URL');
  }

  return { url: parsed, hostname };
}

/**
 * Validates that redirect destination is safe and reports whether credentials must be stripped.
 * @param {string} fromUrl
 * @param {string} locationHeader
 * @returns {{ resolvedUrl: string, isCrossOrigin: boolean }}
 */
export function assertSafeRedirect(fromUrl, locationHeader) {
  if (!locationHeader || typeof locationHeader !== 'string') {
    throw new ProductionGuardError('Missing or empty Location header on redirect', 'INVALID_REDIRECT');
  }
  let fromParsed;
  try {
    fromParsed = new URL(fromUrl);
  } catch {
    throw new ProductionGuardError(`Invalid redirect origin URL: ${fromUrl}`, 'INVALID_REDIRECT');
  }

  let resolved;
  try {
    resolved = new URL(locationHeader, fromParsed);
  } catch {
    throw new ProductionGuardError(`Invalid redirect location URL: ${locationHeader}`, 'INVALID_REDIRECT');
  }

  // Fully validate destination URL: scheme, userinfo, and forbidden production hosts
  validateTargetUrl(resolved.toString());

  const isCrossOrigin = resolved.origin.toLowerCase() !== fromParsed.origin.toLowerCase();
  return {
    resolvedUrl: resolved.toString(),
    isCrossOrigin,
  };
}

/**
 * Validates that the target is NOT a forbidden production endpoint.
 * @param {{
 *   url?: string,
 *   service?: string,
 *   d1Name?: string,
 *   d1Id?: string,
 *   bucketName?: string,
 * }} target
 * @throws {ProductionGuardError}
 */
export function assertNotProductionTarget(target = {}) {
  const { url, service, d1Name, d1Id, bucketName } = target;

  if (url) {
    validateTargetUrl(url);
  }

  if (service) {
    const normalizedService = service.trim().toLowerCase();
    for (const forbidden of FORBIDDEN_SERVICES) {
      if (normalizedService === forbidden.toLowerCase()) {
        throw new ProductionGuardError(
          `Refusing to target production service/worker: ${service}`,
          'PRODUCTION_TARGET_FORBIDDEN'
        );
      }
    }
  }

  if (d1Name) {
    const normalizedD1 = d1Name.trim().toLowerCase();
    for (const forbidden of FORBIDDEN_D1_NAMES) {
      if (normalizedD1 === forbidden.toLowerCase()) {
        throw new ProductionGuardError(
          `Refusing to target production D1 database name: ${d1Name}`,
          'PRODUCTION_TARGET_FORBIDDEN'
        );
      }
    }
  }

  if (d1Id) {
    const normalizedId = d1Id.trim().toLowerCase();
    for (const forbidden of FORBIDDEN_D1_IDS) {
      if (normalizedId === forbidden.toLowerCase()) {
        throw new ProductionGuardError(
          `Refusing to target production D1 database ID: ${d1Id}`,
          'PRODUCTION_TARGET_FORBIDDEN'
        );
      }
    }
  }

  if (bucketName) {
    const normalizedBucket = bucketName.trim().toLowerCase();
    if (normalizedBucket.includes('production') && !normalizedBucket.includes('canary')) {
      throw new ProductionGuardError(
        `Refusing to target potentially production bucket: ${bucketName}`,
        'PRODUCTION_TARGET_FORBIDDEN'
      );
    }
  }
}

/**
 * Validates that CANARY_CONFIRM_ISOLATED=YES is set in the environment.
 * @param {Record<string, string | undefined>} [env]
 * @throws {ProductionGuardError}
 */
export function assertIsolationConfirmed(env = process.env) {
  const flag = env.CANARY_CONFIRM_ISOLATED;
  if (flag !== 'YES') {
    throw new ProductionGuardError(
      'Canary execution blocked: CANARY_CONFIRM_ISOLATED=YES is required in environment/config to confirm isolation.',
      'ISOLATION_CONFIRMATION_REQUIRED'
    );
  }
}

/**
 * Comprehensive environment and target safety assertion.
 * @param {{
 *   url?: string,
 *   service?: string,
 *   d1Name?: string,
 *   d1Id?: string,
 *   bucketName?: string,
 * }} [target]
 * @param {Record<string, string | undefined>} [env]
 */
export function assertSafeCanaryEnvironment(target = {}, env = process.env) {
  assertIsolationConfirmed(env);
  if (target.url) {
    validateTargetUrl(target.url);
  }
  assertNotProductionTarget(target);
}

const SENSITIVE_KEY_REGEX = /^(authorization|cookie|set-cookie|x-auth-token|token|password|secret|apikey|api_key|cf_token)$/i;

/**
 * Recursively redacts sensitive values from strings, objects, or arrays.
 * @param {any} input
 * @returns {any}
 */
export function redactSecrets(input) {
  if (input == null) return input;

  if (typeof input === 'string') {
    let sanitized = input;
    // Redact Bearer tokens
    sanitized = sanitized.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[REDACTED]');
    // Redact Authorization headers
    sanitized = sanitized.replace(/(authorization\s*[:=]\s*)[^\r\n,;&]+/gi, '$1[REDACTED]');
    // Redact Cookie headers
    sanitized = sanitized.replace(/(cookie\s*[:=]\s*)[^\r\n]+/gi, '$1[REDACTED]');
    // Redact URL tokens/passwords
    sanitized = sanitized.replace(/([?&](?:token|auth|key|secret|password)=)[^&]+/gi, '$1[REDACTED]');
    return sanitized;
  }

  if (Array.isArray(input)) {
    return input.map(redactSecrets);
  }

  if (typeof input === 'object') {
    const copy = {};
    for (const [key, val] of Object.entries(input)) {
      if (SENSITIVE_KEY_REGEX.test(key)) {
        copy[key] = '[REDACTED]';
      } else if (typeof val === 'object' && val !== null) {
        copy[key] = redactSecrets(val);
      } else if (typeof val === 'string') {
        copy[key] = redactSecrets(val);
      } else {
        copy[key] = val;
      }
    }
    return copy;
  }

  return input;
}
