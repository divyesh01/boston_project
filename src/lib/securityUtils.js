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

export const sensitiveActionRateLimiter = new RateLimiter('sensitive_action_v2', {
  windowMs: 60 * 60 * 1000, // 1 hour
  maxRequests: 50,          // bumped to 50 for development to avoid quick lockouts
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
import DOMPurify from 'dompurify';

export function sanitizeText(str, maxLength = 1000) {
  if (typeof str !== 'string') return '';
  return DOMPurify.sanitize(str.slice(0, maxLength));
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
  if (typeof crypto === "undefined" || !crypto.getRandomValues) {
    throw new Error("Web Crypto API is required for secure operation.");
  }
  const arr = new Uint8Array(CSRF_TOKEN_LENGTH);
  crypto.getRandomValues(arr);
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

/**
 * Page-lifetime fallback holding the token this page was issued.
 *
 * sessionStorage is not always available: Safari's private/Lockdown modes, an
 * embedded webview with storage partitioned off, and any browser configured to
 * refuse site data all make safeSessionStorage() return null. Before this
 * existed, getCsrfToken() generated a NEW token on every call in that state and
 * persisted none of them, so no two calls agreed and validateCsrfToken() had
 * nothing to compare against.
 *
 * That is the whole reason the validator used to `return true` when storage was
 * missing. The comment there called it lockout prevention, and it was — but it
 * bought that by disabling the check for precisely the users whose browsers are
 * configured most defensively, and it did so silently, because a bypass and a
 * genuine match both return true.
 *
 * Giving the token a store that cannot be refused removes the reason to fail
 * open. It is weaker than sessionStorage in one respect only: it does not
 * survive a reload. That is correct rather than unfortunate — a reload
 * reconstructs the base44 client, which re-issues the header token anyway (see
 * CSRF_HEADER_TOKEN in src/api/base44Client.js).
 */
let memoryCsrfToken = null;

/** The token currently issued to this page, from whichever store holds it. */
function readStoredCsrfToken() {
  const ss = safeSessionStorage();
  if (ss) {
    const stored = ss.getItem(CSRF_TOKEN_KEY);
    if (stored) return stored;
  }
  return memoryCsrfToken;
}

/**
 * Record the issued token in every store that will accept it.
 *
 * The memory copy is assigned first and unconditionally, so a setItem that
 * throws after safeSessionStorage() probed the store as writable (quota
 * exhaustion, or an extension revoking access between the probe and the write)
 * cannot leave a token issued-but-unstored. With a default-closed validator any
 * such gap becomes a refused save, so the write that must not be skipped is the
 * one that cannot fail.
 */
function persistCsrfToken(token) {
  memoryCsrfToken = token;
  const ss = safeSessionStorage();
  if (ss) {
    try {
      ss.setItem(CSRF_TOKEN_KEY, token);
    } catch {
      // The memory copy above stands in for the rest of the page's life.
    }
  }
  return token;
}

// ─── CSRF Token ───
// Added security helpers for file upload

export const MAX_UPLOAD_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
export function validateFileSize(file, maxSize = MAX_UPLOAD_FILE_SIZE) {
  if (!file || typeof file.size !== 'number') return false;
  return file.size > 0 && file.size <= maxSize;
}


/**
 * Write the CSRF cookie the server functions compare the request header against.
 *
 * Single writer on purpose. getCsrfToken and rotateCsrfToken each built this
 * string by hand, so the two copies could drift — and one of them adding `Secure`
 * or changing SameSite without the other would produce a pair that never matches,
 * which every server function reports as "Invalid CSRF token" with no clue why.
 *
 * `Secure` only over https: adding it unconditionally would stop the cookie being
 * stored at all on http://localhost, breaking every mutating call in development.
 * The cookie is readable by script by design — it is the double-submit half that
 * the page has to be able to echo into a header, and it carries no authority on
 * its own.
 */
function writeCsrfCookie(token) {
  if (typeof document === "undefined") return token;
  document.cookie = `__Host-csrf_token=${token}; Path=/; SameSite=Lax; Secure`;
  return token;
}

/**
 * The exact token the SDK froze into its X-CSRF-Token header.
 *
 * Captured on the first getCsrfToken() call, which is the call that builds the
 * base44 client (src/api/base44Client.js). It is deliberately NOT updated by
 * rotateCsrfToken: the header cannot be changed after the client is constructed,
 * so this is the only value a server-side double-submit check can ever match.
 */
let csrfHeaderToken = null;

export function getCsrfToken() {
  let token = readStoredCsrfToken();
  if (!token) token = persistCsrfToken(generateCsrfToken());
  if (csrfHeaderToken === null) csrfHeaderToken = token;
  return writeCsrfCookie(token);
}

/**
 * Restore the cookie to the value the SDK's frozen header carries.
 *
 * The pages rotate the stored token after almost every save (see the
 * getCsrfToken / validateCsrfToken / rotateCsrfToken sequence in Users.jsx,
 * Settings.jsx, Import.jsx and the rest), which rewrites the cookie while the
 * header keeps the value it was constructed with. From the first rotation onward
 * the two disagreed and every server function refused the call with 403 "Invalid
 * CSRF token" — a user watching saves fail with no way to recover but a reload.
 *
 * Called immediately before each backend invoke. Rotation still does its job for
 * the in-page checks that read sessionStorage; this only keeps the pair the SERVER
 * compares in step.
 */
export function pinCsrfCookie() {
  if (csrfHeaderToken === null) return getCsrfToken();
  return writeCsrfCookie(csrfHeaderToken);
}

/**
 * Issue a fresh token for the in-page check.
 *
 * WHAT ROTATION DOES AND DOES NOT REACH, because this has been "fixed" the
 * wrong way once already. It replaces the stored token and the cookie. It does
 * NOT change the X-CSRF-Token header: the base44 SDK copies its headers object
 * once, at construction, into axios defaults, so the header value is frozen for
 * the life of the page and there is no supported way to vary it per request.
 * pinCsrfCookie() therefore restores the cookie to the frozen header value
 * before each backend invoke, and the pair the SERVER compares is deliberately
 * stable for the page's lifetime.
 *
 * That stability is not the weakness it looks like. Double-submit works because
 * a cross-site attacker can neither read the cookie nor set the header; a token
 * minted per page load already denies both. Rotating within a page would only
 * help against replay of a token the attacker has already captured, and
 * capturing it requires script execution on this origin, which defeats any CSRF
 * token regardless of how often it turns over. Meanwhile the last attempt to
 * make rotation reach the server left the cookie and the frozen header
 * mismatched, and every mutating call answered 403 "Invalid CSRF token" until
 * the tab was reloaded. Rotation is scoped to the client-side check on purpose.
 */
export function rotateCsrfToken() {
  return writeCsrfCookie(persistCsrfToken(generateCsrfToken()));
}

/**
 * Default closed: no issued token means no pass.
 *
 * This used to `return true` when sessionStorage was unavailable. See
 * memoryCsrfToken above for why that was load-bearing and why it no longer is —
 * readStoredCsrfToken() always has the page's token, so refusing an unmatched
 * call can no longer lock anyone out of a save.
 */
export function validateCsrfToken(token) {
  if (typeof token !== 'string' || token === '') return false;
  const stored = readStoredCsrfToken();
  if (typeof stored !== 'string' || stored === '') return false;
  // constantTimeEqual returns a strict boolean. The old `stored && stored ===
  // token` returned '' or null on its miss paths, so a caller written as
  // `if (validateCsrfToken(t) === false)` read a falsy non-false value as a pass.
  return constantTimeEqual(stored, token);
}

// ─── 10x Better Secure Storage Helpers (Web Crypto + IndexedDB) ───
//
// This layer provides true client-side secure storage using non-extractable Web Crypto keys
// backed by IndexedDB. Unlike sessionStorage or memory-based keys, the AES-GCM key material 
// cannot be extracted or stolen by XSS (extractable: false).

const ENCRYPTION_KEY_PREFIX = 'rri_enc_';
const DB_NAME = 'rri_crypto_store';
const STORE_NAME = 'keys';

// Volatile fallback key used only while IndexedDB is unavailable (private
// browsing, IDB disabled). Cached so a store/retrieve round-trip in the same
// page uses the SAME key — otherwise the store call would seal with key A and
// the retrieve call would try key B and every value would silently come back
// null. Like the pre-migration memory key, this is page-lifetime only; it
// cannot survive a reload, which is why it is a last-resort fallback.
let volatileFallbackKey = null;

// Wrap IndexedDB for storing the non-extractable CryptoKey
function openCryptoDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getOrGenerateCryptoKey() {
  if (typeof crypto === "undefined" || !crypto.subtle) {
    throw new Error("Web Crypto API is required for secure operation.");
  }
  try {
    const db = await openCryptoDB();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const existingKey = await new Promise((resolve, reject) => {
      const getReq = store.get('aes_gcm_key');
      getReq.onsuccess = () => resolve(getReq.result);
      getReq.onerror = () => reject(getReq.error);
    });
    
    if (existingKey) return existingKey;

    // Generate a new NON-EXTRACTABLE AES-GCM key
    const newKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false, // non-extractable!
      ['encrypt', 'decrypt']
    );

    // Save to IndexedDB
    const writeTx = db.transaction(STORE_NAME, 'readwrite');
    const writeStore = writeTx.objectStore(STORE_NAME);
    await new Promise((resolve, reject) => {
      const putReq = writeStore.put(newKey, 'aes_gcm_key');
      putReq.onsuccess = () => resolve();
      putReq.onerror = () => reject(putReq.error);
    });

    return newKey;
  } catch (e) {
    console.warn('[Crypto] Falling back to volatile key due to IDB failure:', e);
    if (!volatileFallbackKey) {
      volatileFallbackKey = await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      );
    }
    return volatileFallbackKey;
  }
}

export async function secureStore(key, value) {
  try {
    const cryptoKey = await getOrGenerateCryptoKey();
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
      ls.setItem(ENCRYPTION_KEY_PREFIX + key, Array.from(combined).map((b) => b.toString(16).padStart(2, '0')).join(''));
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
    
    const cryptoKey = await getOrGenerateCryptoKey();
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
//
// The AUTHORITATIVE tamper-evident audit trail is now written server-side in
// base44/functions/audit_log, which recomputes the chain HMAC over trusted
// fields using a server-held secret (AUDIT_CHAIN_SECRET). The client never
// holds the signing key, so the on-chain logs cannot be forged by anyone with
// browser/script access. The client-side helpers below keep a *local* chain
// purely as a guard against accidental edits (e.g. a corrupted IndexedDB row)
// and use a PUBLIC, non-secret salt — it conveys no trust. `verifyAuditChain()`
// here can detect accidental corruption; the server's chain is the forensic
// source of truth.

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

// The authoritative, tamper-evident audit chain is now computed SERVER-SIDE
// (base44/functions/audit_log) from a server-held secret, so the client never
// holds the signing key. The chain secret is therefore NO LONGER stored in
// localStorage or a window global (the original forgery risk). This constant is
// a public, non-secret salt used only for the local accidental-edit integrity
// check; it conveys no trust and cannot forge the server's chain.
const AUDIT_CHAIN_SALT = 'rri-local-audit-integrity-salt-v1';

async function getChainSecret() {
  return AUDIT_CHAIN_SALT;
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
  //
  // Deliberately raw localDb, not db.entities. The chain is one sequence over the
  // WHOLE table: linking to "the newest row this caller can see" would fork it
  // into a chain per property, and any reader with wider access would then see a
  // break at every fork. Second reason: this runs inside import transaction zones,
  // and the proxy's access lookup can await a macrotask and kill the zone (B6).
  // AuditLog is append-only for every caller (PROTECTED_IMMUTABLE_TABLES), and the
  // rows are never rendered from here, so reading the tip leaks nothing.
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
    // Raw localDb for the same reason as createAuditEntry: the integrity claim is
    // over every row in order. Verifying a filtered subset would report tampering
    // wherever a row was merely hidden, which is the opposite of useful.
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
  // ⚠️ SECURITY: this is a PLACEHOLDER, not a real IP. A browser cannot
  // reliably learn its own public IP, and this constant is written into audit
  // entries as if it were trustworthy. For any real audit, the IP must be read
  // from a trusted proxy header on the SERVER (e.g. req.headers.get('x-forwarded-for'))
  // and recorded in the server-side AuditLog row, not fabricated client-side.
  return 'client-side';
}

// SHA-256 content digest of an uploaded file. Used for duplicate-detection: a
// re-uploaded clerk/PMS file hashes identically, so we can cancel the duplicate
// import before it touches any financial calculation.
export async function sha256File(file) {
  try {
    if (!file || typeof file.arrayBuffer !== 'function') return null;
    const buf = await file.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

// SHA-256 hex digest of a string. Used to bind a session token to a user record
// WITHOUT storing the plaintext token at rest (see #13). The server holds the
// plaintext session; the local user row only ever stores this digest.
export async function sha256Hex(value) {
  try {
    const buf = new TextEncoder().encode(String(value ?? ''));
    const digest = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
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
  if (typeof crypto === "undefined" || !crypto.getRandomValues) {
    throw new Error("Web Crypto API is required.");
  }
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
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