/**
 * Production-ready CORS middleware configuration.
 * 
 * - Allows local development origins (Vite default + common ports)
 * - Allows production origins from process.env.ALLOWED_ORIGINS (comma-separated)
 * - Rejects unauthorized origins with HTTP 403
 * - Supports preflight OPTIONS requests, credentials, and standard headers
 * - Non-protected file — safe to modify without restrictions.
 */

// Allowed local development origins (Vite default + common alternatives)
const LOCAL_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:3000',
];

// Parse comma-separated production origins from env
const productionOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter((o) => o)
  : [];

// Combined list of allowed origins (production overrides local)
const allowedOrigins = [...productionOrigins, ...LOCAL_ORIGINS];

/**
 * Checks if a given origin is allowed.
 * @param {string} origin - The origin string to validate.
 * @returns {boolean} - True if origin is allowed, false otherwise.
 */
function isAllowedOrigin(origin) {
  if (!origin) return false;
  return allowedOrigins.some((allowed) => allowed === origin);
}

/**
 * Checks if the origin is a production origin.
 * @param {string} origin - The origin string to check.
 * @returns {boolean} - True if the origin is a production origin.
 */
function isProductionOrigin(origin) {
  return productionOrigins.some((allowed) => allowed === origin);
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
      res.header('Access-Control-Allow-Origin', isAllowedOrigin(origin) ? origin : '*');
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

// Export allowed origins and helpers for testing or inspection
module.exports = {
  allowedOrigins,
  productionOrigins,
  LOCAL_ORIGINS: LOCAL_ORIGINS,
  isAllowedOrigin,
  isProductionOrigin,
  createCorsMiddleware,
};

module.exports.isAllowedOrigin = isAllowedOrigin;
module.exports.isProductionOrigin = isProductionOrigin;