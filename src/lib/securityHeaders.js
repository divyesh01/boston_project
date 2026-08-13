/**
 * Security Headers Helper
 * 
 * Generates Content Security Policy (CSP) strings and header objects for production deployment.
 * 
 * Customizable via:
 *   - apiDomain: backend API domain (defaults to process.env.VITE_BASE44_BACKEND_URL or 'self')
 *   - wsDomain: WebSocket domain (defaults to wss: + apiDomain)
 *   - cdnDomain: CDN/domain for static assets (defaults to 'self')
 * 
 * Outputs formatted snippets for:
 *   - Nginx configuration
 *   - Express/Helmet.js configuration
 *   - HTML meta tags (fallback)
 * 
 * This file is non-protected — safe to modify without restrictions.
 */

// Default domains (can be overridden via options)
const defaultApiDomain = process.env.VITE_BASE44_BACKEND_URL || 'self';
const defaultWsDomain = 'wss:';
const defaultCdnDomain = 'self';

// ---------------------------------------------------------------------------
// CSP Directive Builders
// ---------------------------------------------------------------------------

/**
 * Builds the CSP `default-src` directive string.
 * @param {string} apiDomain - Backend API domain
 * @param {string} wsDomain - WebSocket domain
 * @returns {string} CSP default-src directive
 */
function buildDefaultSrc(apiDomain, wsDomain) {
  const scheme = apiDomain.startsWith('https:') ? 'https:' : 'http:';
  return `default-src 'self' ${apiDomain} ${wsDomain} https: wss: data: 'unsafe-inline' 'unsafe-eval'`;
}

/**
 * Builds the CSP `script-src` directive string.
 * @param {string} apiDomain - Backend API domain
 * @returns {string} CSP script-src directive
 */
function buildScriptSrc(apiDomain) {
  return `script-src 'self' 'wasm-unsafe-eval' ${apiDomain} https: 'unsafe-inline'`;
}

/**
 * Builds the CSP `style-src` directive string.
 * @param {string} cdnDomain - CDN/domain for fonts/styles
 * @returns {string} CSP style-src directive
 */
function buildStyleSrc(cdnDomain) {
  return `style-src 'self' 'unsafe-inline' ${cdnDomain} https://fonts.googleapis.com`;
}

/**
 * Builds the CSP `font-src` directive string.
 * @param {string} cdnDomain - CDN/domain for fonts
 * @returns {string} CSP font-src directive
 */
function buildFontSrc(cdnDomain) {
  return `font-src 'self' ${cdnDomain} https://fonts.gstatic.com`;
}

/**
 * Builds the CSP `img-src` directive string.
 * @param {string} cdnDomain - CDN/domain for images
 * @returns {string} CSP img-src directive
 */
function buildImgSrc(cdnDomain) {
  return `img-src 'self' data: ${cdnDomain} https:`;
}

/**
 * Builds the CSP `connect-src` directive string.
 * @param {string} apiDomain - Backend API domain
 * @param {string} wsDomain - WebSocket domain
 * @returns {string} CSP connect-src directive
 */
function buildConnectSrc(apiDomain, wsDomain) {
  return `connect-src 'self' ${apiDomain} ${wsDomain} https: wss:`;
}

/**
 * Builds the CSP `frame-ancestors` directive string.
 * @returns {string} CSP frame-ancestors directive
 */
function buildFrameAncestors() {
  return `frame-ancestors 'none'`;
}

/**
 * Builds the CSP `base-uri` directive string.
 * @returns {string} CSP base-uri directive
 */
function buildBaseUri() {
  return `base-uri 'self'`;
}

/**
 * Builds the CSP `form-action` directive string.
 * @returns {string} CSP form-action directive
 */
function buildFormAction() {
  return `form-action 'self'`;
}

/**
 * Builds the CSP `object-src` directive string.
 * @returns {string} CSP object-src directive
 */
function buildObjectSrc() {
  return `object-src 'none'`;
}

/**
 * Builds the CSP `sandbox` directive string (optional).
 * @returns {string} CSP sandbox directive
 */
function buildSandbox() {
  return `sandbox 'self' allow-scripts allow-modals`;
}

// ---------------------------------------------------------------------------
// Header Objects for Express/Helmet.js
// ---------------------------------------------------------------------------

/**
 * Builds a complete set of security headers for Express/Helmet.js.
 * @param {object} options - Customization options.
 * @param {string} [options.apiDomain] - Backend API domain.
 * @param {string} [options.wsDomain] - WebSocket domain.
 * @param {string} [options.cdnDomain] - CDN/domain for static assets.
 * @returns {object} - HTTP response header key-value pairs.
 */
function buildSecurityHeaders(options = {}) {
  const {
    apiDomain = defaultApiDomain,
    wsDomain = defaultWsDomain,
    cdnDomain = defaultCdnDomain,
  } = options;

  return {
    'Content-Security-Policy': buildCompleteCsp(apiDomain, wsDomain, cdnDomain),
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
  };
}

/**
 * Builds a complete CSP string from all directives.
 * @param {string} apiDomain - Backend API domain.
 * @param {string} wsDomain - WebSocket domain.
 * @param {string} cdnDomain - CDN/domain for static assets.
 * @returns {string} Complete CSP string.
 */
function buildCompleteCsp(apiDomain, wsDomain, cdnDomain) {
  return [
    buildDefaultSrc(apiDomain, wsDomain),
    buildScriptSrc(apiDomain),
    buildStyleSrc(cdnDomain),
    buildFontSrc(cdnDomain),
    buildImgSrc(cdnDomain),
    buildConnectSrc(apiDomain, wsDomain),
    buildFrameAncestors(),
    buildBaseUri(),
    buildFormAction(),
    buildObjectSrc(),
  ].join('; ');
}

// ---------------------------------------------------------------------------
// Nginx Configuration Snippets
// ---------------------------------------------------------------------------

/**
 * Returns an Nginx `location` block snippet with security headers.
 * @param {object} options - Same options as `buildSecurityHeaders`.
 * @returns {string} Nginx configuration snippet.
 */
function buildNginxSnippet(options) {
  const headers = buildSecurityHeaders(options);
  const lines = [];
  Object.entries(headers).forEach(([key, value]) => {
    lines.push(`add_header ${key} "${value}" always;`);
  });
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Documentation Output
// ---------------------------------------------------------------------------

/**
 * Returns the full documentation content for `SECURITY_HEADERS_DEPLOY.md`.
 * @param {object} options - Customization options (same as `buildSecurityHeaders`).
 * @returns {string} Markdown documentation content.
 */
function buildDocsContent(options) {
  const { apiDomain, wsDomain, cdnDomain } = options;
  const csp = buildCompleteCsp(apiDomain, wsDomain, cdnDomain);
  const headers = buildSecurityHeaders(options);

  const lines = [
    '# Security Headers Deployment Guide',
    '',
    '## Generated CSP Directive',
    `CSP: ${csp}`,
    '',
    '## HTTP Security Headers',
    '',
    '| Header | Value |',
    '| -------- | ------ |',
    ...Object.entries(headers).map(([key, value]) => [`key`, value].map((v) => `"${v}"`)),
    '',
    '## Nginx Configuration Snippet',
    '',
    `<location />`,
    `  ${buildNginxSnippet(options)}`,
    `}`,
    '',
    '## Express/Helmet.js Configuration',
    '',
    '```javascript',
    '// This is illustrative; actual helmet usage depends on version.',
    'const helmet = require("helmet");',
    '// helmet.contentSecurityPolicy({ ... });',
    '// helmet.frameDeny();',
    '// helmet.hsts({ maxAge: 31536000, includeSubDomains: true, preload: true });',
    '// helmet.xssFilter();',
    '// helmet.noSniff();',
    '// helmet.referrerPolicy({ policy: "strict-origin-when-cross-origin" });',
    '```',
    '',
    '## Example: Custom Domains',
    '',
    `apiDomain: "${apiDomain}",
    wsDomain: "${wsDomain}",
    cdnDomain: "${cdnDomain}"`,
    '',
    '## Deployment Notes',
    '',
    "- Ensure `frame-ancestors 'none'` prevents clickjacking attacks.",
    '- `Strict-Transport-Security` with `preload` submits your domain to browser preload lists.',
    "- Adjust `script-src` and `style-src` `'unsafe-inline'` only after migrating to build-time CSS/JS bundling.",
    '',
    '---',
  ];

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Export API
// ---------------------------------------------------------------------------

module.exports = {
  buildSecurityHeaders,
  buildCompleteCsp,
  buildNginxSnippet,
  buildDocsContent,
  defaultApiDomain,
  defaultWsDomain,
  defaultCdnDomain,
  buildDefaultSrc,
  buildScriptSrc,
  buildStyleSrc,
  buildFontSrc,
  buildImgSrc,
  buildConnectSrc,
  buildFrameAncestors,
  buildBaseUri,
  buildFormAction,
  buildObjectSrc,
};

// ---------------------------------------------------------------------------
// Export for direct usage in documentation generation
// ---------------------------------------------------------------------------

// Export the full markdown documentation for immediate use
module.exports. documentation = buildDocsContent({
  apiDomain: defaultApiDomain,
  wsDomain: defaultWsDomain,
  cdnDomain: defaultCdnDomain,
});