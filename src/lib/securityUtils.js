// Security utilities for XSS prevention, input sanitization, and rate limiting.

import { constantTimeEqual } from '@/lib/security';
import localDb from '@/api/localDb';

// ─── Rate Limiting ───

const RATE_LIMIT_KEY_PREFIX = 'rri_rate_limit_';
const DEFAULT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const DEFAULT_MAX_REQUESTS = 5;

class RateLimiter {
  constructor(key, options = {}) {
    this.key = RATE_LIMIT_KEY_PREFIX + key;
    this.windowMs = options.windowMs || DEFAULT_WINDOW_MS;
    this.maxRequests = options.maxRequests || DEFAULT_MAX_REQUESTS;
    this.blockDurationMs = options.blockDurationMs || 60 * 60 * 1000; // 1 hour block
  }

  _getStore() {
    try {
      const raw = localStorage.getItem(this.key);
      if (!raw) return { requests: [], blockedUntil: 0 };
      return JSON.parse(raw);
    } catch {
      return { requests: [], blockedUntil: 0 };
    }
  }

  _setStore(store) {
    try {
      localStorage.setItem(this.key, JSON.stringify(store));
    } catch (e) {
      // Quota exceeded or storage disabled — silently drop the write
    }
  }

  _cleanOldRequests(store, now) {
    const cutoff = now - this.windowMs;
    store.requests = store.requests.filter((ts) => ts > cutoff);
  }

  check() {
    const now = Date.now();
    const store = this._getStore();

    if (store.blockedUntil > now) {
      return {
        allowed: false,
        remaining: 0,
        resetAt: store.blockedUntil,
        blocked: true,
        retryAfter: Math.ceil((store.blockedUntil - now) / 1000),
      };
    }

    this._cleanOldRequests(store, now);

    if (store.requests.length >= this.maxRequests) {
      store.blockedUntil = now + this.blockDurationMs;
      this._setStore(store);
      return {
        allowed: false,
        remaining: 0,
        resetAt: store.blockedUntil,
        blocked: true,
        retryAfter: Math.ceil(this.blockDurationMs / 1000),
      };
    }

    store.requests.push(now);
    this._setStore(store);

    return {
      allowed: true,
      remaining: this.maxRequests - store.requests.length,
      resetAt: now + this.windowMs,
      blocked: false,
    };
  }

  reset() {
    try {
      localStorage.removeItem(this.key);
    } catch {}
  }

  getStatus() {
    const now = Date.now();
    const store = this._getStore();
    this._cleanOldRequests(store, now);
    return {
      used: store.requests.length,
      remaining: Math.max(0, this.maxRequests - store.requests.length),
      blocked: store.blockedUntil > now,
      resetAt: store.blockedUntil > now ? store.blockedUntil : now + this.windowMs,
    };
  }
}

// Pre-configured limiters
export const loginRateLimiter = new RateLimiter('login', {
  windowMs: 15 * 60 * 1000, // 15 minutes
  maxRequests: 5,           // 5 attempts per window
  blockDurationMs: 30 * 60 * 1000, // 30 minute block
});

export const sensitiveActionRateLimiter = new RateLimiter('sensitive_action', {
  windowMs: 60 * 60 * 1000, // 1 hour
  maxRequests: 10000,        // effectively unlimited for now
  blockDurationMs: 60 * 60 * 1000,
});

export const apiRateLimiter = new RateLimiter('api', {
  windowMs: 60 * 1000,      // 1 minute
  maxRequests: 60,          // 60 requests per minute
  blockDurationMs: 5 * 60 * 1000,
});

// ─── Input Sanitization ───

// HTML entity encoding for XSS prevention
export function escapeHtml(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\//g, '&#x2F;');
}

// Sanitize string for safe use in HTML attributes
export function escapeAttr(str) {
  if (typeof str !== 'string') return str;
  return escapeHtml(str);
}

// Sanitize for use in JavaScript context
export function escapeJs(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/</g, '\\u003C')
    .replace(/>/g, '\\u003E');
}

// Strip potentially dangerous protocols from URLs
export function sanitizeUrl(url) {
  if (typeof url !== 'string') return '';
  const trimmed = url.trim().toLowerCase();
  if (trimmed.startsWith('javascript:') || trimmed.startsWith('data:') || trimmed.startsWith('vbscript:')) {
    return '';
  }
  return url.trim();
}

// Sanitize filename for safe file operations
export function sanitizeFilename(filename) {
  if (typeof filename !== 'string') return 'file';
  return filename
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/^\.+/, '_')
    .slice(0, 255);
}

// Validate and sanitize email
export function sanitizeEmail(email) {
  if (typeof email !== 'string') return '';
  const trimmed = email.trim().toLowerCase();
  // Basic email format validation
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return '';
  return trimmed;
}

// Validate alphanumeric string (for usernames, codes, etc.)
export function sanitizeAlphanumeric(str, maxLength = 50) {
  if (typeof str !== 'string') return '';
  return str.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, maxLength);
}

// Sanitize general text input (allow common punctuation, strip scripts)
export function sanitizeText(str, maxLength = 1000) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
    .replace(/on\w+\s*=/gi, 'data-on-=')
    .slice(0, maxLength);
}

// ─── CSV Formula Injection Defense ───

// Neutralize spreadsheet formula/DDE-injection payloads. Excel, Google Sheets
// and LibreOffice execute a cell as a formula/DDE link when its first character
// is one of =, +, -, @, tab, or CR — so those are checked against the raw value
// (never a trimmed copy, or tab/CR-prefixed payloads would evade detection).
// Whitespace-padded formulas (e.g. "  =1+1") are also caught because many CSV
// importers trim leading whitespace before evaluating. A single leading quote
// forces the cell to be read as literal text. Non-strings pass through
// untouched; the caller's original string is returned verbatim apart from the
// guard prefix so surrounding whitespace and casing are preserved.
export function neutralizeFormula(val) {
  if (typeof val !== 'string') return val;
  if (/^[\t\r ]*[=\-+@\t\r]/.test(val)) return "'" + val;
  return val;
}

// Alias kept for backwards compatibility with existing call sites.
export const sanitizeCsvCell = neutralizeFormula;

// ─── CSRF Protection ───

const CSRF_TOKEN_KEY = 'rri_csrf_token';
const CSRF_TOKEN_LENGTH = 32;

function generateCsrfToken() {
  const arr = new Uint8Array(CSRF_TOKEN_LENGTH);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(arr);
  } else {
    for (let i = 0; i < CSRF_TOKEN_LENGTH; i++) arr[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function safeSessionStorage() {
  try {
    if (typeof sessionStorage === "undefined") return null;
    sessionStorage.setItem("_rri_test_", "_test_");
    sessionStorage.removeItem("_rri_test_");
    return sessionStorage;
  } catch {
    return null;
  }
}

export function getCsrfToken() {
  const ss = safeSessionStorage();
  if (!ss) return generateCsrfToken();
  let token = ss.getItem(CSRF_TOKEN_KEY);
  if (!token) {
    token = generateCsrfToken();
    ss.setItem(CSRF_TOKEN_KEY, token);
  }
  return token;
}

export function rotateCsrfToken() {
  const token = generateCsrfToken();
  const ss = safeSessionStorage();
  if (ss) {
    try {
      ss.setItem(CSRF_TOKEN_KEY, token);
    } catch {}
  }
  return token;
}

export function validateCsrfToken(token) {
  const ss = safeSessionStorage();
  if (!ss) return false;
  const stored = ss.getItem(CSRF_TOKEN_KEY);
  return stored && stored === token;
}

// ─── Secure Storage Helpers ───

// Encrypt sensitive data before storing in localStorage
const ENCRYPTION_KEY_PREFIX = 'rri_enc_';

async function getEncryptionKey() {
  const ss = safeSessionStorage();
  if (!ss) {
    // Fallback: generate a per-session in-memory key
    const w = /** @type {any} */ (window);
    if (!w.__rri_enc_key) {
      const arr = new Uint8Array(32);
      if (typeof crypto !== "undefined" && crypto.getRandomValues) {
        crypto.getRandomValues(arr);
      } else {
        for (let i = 0; i < 32; i++) arr[i] = Math.floor(Math.random() * 256);
      }
      w.__rri_enc_key = Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('');
    }
    return w.__rri_enc_key;
  }
  let key = ss.getItem(ENCRYPTION_KEY_PREFIX + 'key');
  if (!key) {
    const arr = new Uint8Array(32);
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
      crypto.getRandomValues(arr);
    } else {
      for (let i = 0; i < 32; i++) arr[i] = Math.floor(Math.random() * 256);
    }
    key = Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('');
    try {
      ss.setItem(ENCRYPTION_KEY_PREFIX + 'key', key);
    } catch {}
  }
  return key;
}

async function importKey(keyHex) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(keyHex.match(/.{1,2}/g).map((byte) => parseInt(byte, 16))),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );
  return keyMaterial;
}

export async function secureStore(key, value) {
  try {
    const keyHex = await getEncryptionKey();
    const cryptoKey = await importKey(keyHex);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(JSON.stringify(value));
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      cryptoKey,
      encoded
    );
    const combined = new Uint8Array(iv.length + encrypted.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(encrypted), iv.length);
    const ls = safeLocalStorage();
    if (ls) {
      try { ls.setItem(ENCRYPTION_KEY_PREFIX + key, Array.from(combined).map((b) => b.toString(16).padStart(2, '0')).join('')); } catch {}
    }
    return true;
  } catch (e) {
    console.error('[secureStore] failed:', e);
    return false;
  }
}

export async function secureRetrieve(key) {
  try {
    const ls = safeLocalStorage();
    if (!ls) return null;
    const stored = ls.getItem(ENCRYPTION_KEY_PREFIX + key);
    if (!stored) return null;
    const keyHex = await getEncryptionKey();
    const cryptoKey = await importKey(keyHex);
    const combined = new Uint8Array(stored.match(/.{1,2}/g).map((byte) => parseInt(byte, 16)));
    const iv = combined.slice(0, 12);
    const encrypted = combined.slice(12);
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      cryptoKey,
      encrypted
    );
    return JSON.parse(new TextDecoder().decode(decrypted));
  } catch (e) {
    console.error('[secureRetrieve] failed:', e);
    return null;
  }
}

export function secureRemove(key) {
  try { localStorage.removeItem(ENCRYPTION_KEY_PREFIX + key); } catch {}
}

// ─── Audit Log Helpers ───

const AUDIT_CHAIN_KEY = 'rri_audit_chain';

function safeLocalStorage() {
  try {
    if (typeof localStorage === "undefined") return null;
    localStorage.setItem("_rri_test_", "_test_");
    localStorage.removeItem("_rri_test_");
    return localStorage;
  } catch {
    return null;
  }
}

async function getChainSecret() {
  const ls = safeLocalStorage();
  if (!ls) {
    const w = /** @type {any} */ (window);
  if (!w.__rri_audit_chain) {
      const arr = new Uint8Array(32);
      if (typeof crypto !== "undefined" && crypto.getRandomValues) {
        crypto.getRandomValues(arr);
      } else {
        for (let i = 0; i < 32; i++) arr[i] = Math.floor(Math.random() * 256);
      }
      w.__rri_audit_chain = Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('');
    }
    return w.__rri_audit_chain;
  }
  let secret = ls.getItem(AUDIT_CHAIN_KEY);
  if (!secret) {
    const arr = new Uint8Array(32);
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
      crypto.getRandomValues(arr);
    } else {
      for (let i = 0; i < 32; i++) arr[i] = Math.floor(Math.random() * 256);
    }
    secret = Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('');
    try {
      ls.setItem(AUDIT_CHAIN_KEY, secret);
    } catch {}
  }
  return secret;
}

async function hashEntry(entry, previousHash) {
  const data = JSON.stringify({ ...entry, previous_hash: previousHash || '0'.repeat(64) });
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(await getChainSecret()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  return Array.from(new Uint8Array(signature)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function createAuditEntry(action, options = {}) {
  const baseEntry = {
    action,
    timestamp: new Date().toISOString(),
    ipAddress: options.ipAddress || getClientIpHint(),
    device: options.device || getDeviceFingerprint(),
    userId: options.userId || null,
    username: options.username || 'unknown',
    performedById: options.performedById || null,
    performedBy: options.performedBy || 'system',
    propertyId: options.propertyId || null,
    propertyName: options.propertyName || null,
    result: options.result || 'success',
    detail: options.detail || '',
  };

  // Get the last hash for chaining
  let previousHash = '0'.repeat(64);
  try {
    const logs = await localDb.AuditLog.orderBy('created_date').reverse().first();
    if (logs && logs.hash) {
      previousHash = logs.hash;
    }
  } catch {
    // No previous log
  }

  const hash = await hashEntry(baseEntry, previousHash);
  return { ...baseEntry, hash, previous_hash: previousHash };
}

export async function verifyAuditChain() {
  try {
    const logs = await localDb.AuditLog.orderBy('created_date').toArray();
    let previousHash = '0'.repeat(64);
    for (const log of logs) {
      // Rebuild the exact canonical payload that createAuditEntry hashed —
      // it was recorded in the DB with snake_case columns, so don't hash the
      // raw row (key naming would differ and the chain would always break).
      const entry = {
        action: log.action,
        timestamp: log.created_date,
        ipAddress: log.ip_address,
        device: log.device,
        userId: log.user_id,
        username: log.username,
        performedById: log.performed_by_id,
        performedBy: log.performed_by,
        propertyId: log.property_id,
        propertyName: log.property_name,
        result: log.result,
        detail: log.detail,
      };
      const { hash, previous_hash } = log;
      const expectedHash = await hashEntry(entry, previous_hash);
      if (!constantTimeEqual(hash, expectedHash)) {
        return { valid: false, tamperedAt: log.id, expected: expectedHash, actual: hash };
      }
      if (!constantTimeEqual(previous_hash, previousHash)) {
        return { valid: false, tamperedAt: log.id, reason: 'Chain break', expectedPrevious: previousHash, actualPrevious: previous_hash };
      }
      previousHash = hash;
    }
    return { valid: true, count: logs.length };
  } catch (e) {
    return { valid: false, error: e.message };
  }
}

export function getClientIpHint() {
  // In a real deployment, this would come from a trusted proxy header
  // For local/client-side, we can't reliably get the IP
  // This is a placeholder for server-side integration
  return 'client-side';
}

export function getDeviceFingerprint() {
  try {
    const ua = navigator.userAgent || '';
    const screen = `${window.screen.width}x${window.screen.height}`;
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const lang = navigator.language;
    const fp = `${ua}|${screen}|${tz}|${lang}`;
    // Simple hash for fingerprinting
    let hash = 0;
    for (let i = 0; i < fp.length; i++) {
      hash = ((hash << 5) - hash) + fp.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash).toString(16);
  } catch {
    return 'unknown';
  }
}

export function getCspNonce() {
  // Generate a nonce for inline scripts/styles if needed
  const arr = new Uint8Array(16);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(arr);
  } else {
    for (let i = 0; i < 16; i++) arr[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ─── Validation Helpers ───

export function validateRequired(fields) {
  const errors = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || String(value).trim() === '') {
      errors[key] = `${key} is required`;
    }
  }
  return Object.keys(errors).length > 0 ? errors : null;
}

export function validateNumeric(fields, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const errors = {};
  for (const [key, value] of Object.entries(fields)) {
    const num = Number(value);
    if (isNaN(num) || num < min || num > max) {
      errors[key] = `${key} must be a number between ${min} and ${max}`;
    }
  }
  return Object.keys(errors).length > 0 ? errors : null;
}

export function validateDate(fields) {
  const errors = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value && isNaN(Date.parse(value))) {
      errors[key] = `${key} must be a valid date`;
    }
  }
  return Object.keys(errors).length > 0 ? errors : null;
}