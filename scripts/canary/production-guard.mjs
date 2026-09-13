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
  const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(withProto);
    return parsed.hostname.toLowerCase().replace(/\.+$/, '');
  } catch {
    return trimmed.toLowerCase().split('/')[0].split(':')[0].replace(/\.+$/, '');
  }
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
    const host = extractHostname(url);
    for (const forbidden of FORBIDDEN_HOSTNAMES) {
      if (host === forbidden || host.endsWith(`.${forbidden}`)) {
        throw new ProductionGuardError(
          `Refusing to target production host: ${host}`,
          'PRODUCTION_TARGET_FORBIDDEN'
        );
      }
    }
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
