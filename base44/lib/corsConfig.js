/**
 * Production-ready CORS middleware configuration.
 * 
 * - Allows local development origins (Vite default + common ports)
 * - Allows production origins from the ALLOWED_ORIGINS env var (comma-separated),
 *   read lazily via Deno.env.get or process.env — never at module scope
 * - Rejects unauthorized origins with HTTP 403, preflight included
 * - Supports preflight OPTIONS requests, credentials, and standard headers
 * - Non-protected file — safe to modify without restrictions.
 */

// Allowed local development origins (Vite default + common alternatives)
const LOCAL_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:3000',
];

// FIXED 2026-08-22. This block used to be `const productionOrigins =
// process.env.ALLOWED_ORIGINS ? ... : []` evaluated at MODULE SCOPE. A bare
// `process` reference throws ReferenceError the instant the file is imported in
// any host that does not define it — a browser/Vite bundle, or a Deno serverless
// function running without the Node compatibility global. An import-time crash is
// the worst available failure mode for a CORS module: it takes down the very
// endpoint it was added to protect, before a single request is inspected.
// The read is now lazy, host-agnostic and memoised.
function readEnv(name) {
  // Deno first: base44 functions run on Deno, where Deno.env.get is native.
  try {
    if (typeof Deno !== 'undefined' && Deno.env && typeof Deno.env.get === 'function') {
      return Deno.env.get(name) || '';
    }
  } catch {
    // Deno.env.get throws when the function was granted no --allow-env
    // permission. That is a configuration state, not an error worth crashing
    // an import over; fall through to the Node path and then to "unset".
  }
  if (typeof process !== 'undefined' && process.env) return process.env[name] || '';
  return '';
}

let cachedProductionOrigins = null;

// Parse comma-separated production origins from env (resolved on first use)
function getProductionOrigins() {
  if (cachedProductionOrigins) return cachedProductionOrigins;
  const raw = readEnv('ALLOWED_ORIGINS');
  cachedProductionOrigins = raw
    ? raw.split(',').map((o) => o.trim()).filter((o) => o)
    : [];
  return cachedProductionOrigins;
}

// Combined list of allowed origins (production overrides local)
function getAllowedOrigins() {
  return [...getProductionOrigins(), ...LOCAL_ORIGINS];
}

/**
 * Checks if a given origin is allowed.
 * @param {string} origin - The origin string to validate.
 * @returns {boolean} - True if origin is allowed, false otherwise.
 */
function isAllowedOrigin(origin) {
  if (!origin) return false;
  return getAllowedOrigins().some((allowed) => allowed === origin);
}

/**
 * Checks if the origin is a production origin.
 * @param {string} origin - The origin string to check.
 * @returns {boolean} - True if the origin is a production origin.
 */
function isProductionOrigin(origin) {
  return getProductionOrigins().some((allowed) => allowed === origin);
}

/**
 * CORS middleware factory.
 * Creates a middleware function that can be used with Express, Fastify, or other Node.js frameworks.
 * 
 * @param {object} [options] - Optional configuration options.
 * @param {boolean} [options.credentials] - If true, sets Access-Control-Allow-Credentials to true.
 * @returns {function} - Express middleware function.
 */
function createCorsMiddleware(options = {}) {
  const { credentials } = options;

  return (req, res, next) => {
    const origin = req.headers.origin;

    // Allow origins for preflight OPTIONS requests
    if (req.method === 'OPTIONS') {
      // FIXED 2026-08-22. This used to be
      //   res.header('Access-Control-Allow-Origin', isAllowedOrigin(origin) ? origin : '*')
      // so an UNAUTHORIZED origin was answered with a wildcard grant plus the full
      // Allow-Methods list — the exact opposite of this file's documented contract
      // ("Rejects unauthorized origins with HTTP 403"). The follow-up request was
      // still refused below, so the practical exposure was limited, but a preflight
      // that approves GET/PUT/POST/DELETE for every origin on the internet is not a
      // thing to ship in a file named corsConfig.js. Unauthorized preflights now get
      // the same 403 an unauthorized request gets.
      if (!isAllowedOrigin(origin)) {
        res.status(403).json({ error: 'CORS policy: unauthorized origin' });
        return;
      }
      res.header('Access-Control-Allow-Origin', origin);
      res.header('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-CSRF-Token');
      res.header('Access-Control-Allow-Credentials', credentials ? 'true' : 'false');
      res.status(204).end();
      return;
    }

    // Set CORS headers for actual requests
    if (isAllowedOrigin(origin)) {
      res.header('Access-Control-Allow-Origin', origin);
    } else if (isProductionOrigin(origin)) {
      // Allow production origins from env
      res.header('Access-Control-Allow-Origin', origin);
    } else {
      // Reject unauthorized origin with 403
      res.status(403).json({ error: 'CORS policy: unauthorized origin' });
      return;
    }

    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-CSRF-Token');
    res.header('Access-Control-Allow-Credentials', credentials ? 'true' : 'false');
    next();
  };
}

// Export allowed origins and helpers for testing or inspection.
// `allowedOrigins` and `productionOrigins` are GETTERS, not plain arrays, so that
// consumers keep reading them as properties while the underlying env read stays
// lazy. Exporting the arrays directly would have re-introduced the module-scope
// evaluation this file was fixed to remove.
module.exports = {
  get allowedOrigins() { return getAllowedOrigins(); },
  get productionOrigins() { return getProductionOrigins(); },
  LOCAL_ORIGINS: LOCAL_ORIGINS,
  isAllowedOrigin,
  isProductionOrigin,
  createCorsMiddleware,
};

module.exports.isAllowedOrigin = isAllowedOrigin;
module.exports.isProductionOrigin = isProductionOrigin;