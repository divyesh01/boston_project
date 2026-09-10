// Client-side rate limiters separated by domain.
//
// Addresses production defect where routine hotel operations (report imports,
// saving expenses, adjusting settings) shared sensitiveActionRateLimiter with
// security operations (password resets, user admin), causing ordinary users to
// receive false 60-minute blocks ("Too many requests. Try again in 58 minutes.").
//
// Domains:
// 1. SECURITY: password changes, user admin (delegates to sensitiveActionRateLimiter)
// 2. DESTRUCTIVE: clear all data, undo imports, permanent financial record deletes
// 3. IMPORT: report ingestion (single files and batch imports)
// 4. OPERATIONAL: routine hotel operations (expenses, manual entries, settings)
//
// Client-side limits are UX protections only; localStorage is never a security boundary.

import { sensitiveActionRateLimiter } from '@/lib/securityUtils';

const RATE_LIMIT_KEY_PREFIX = 'rri_rate_limit_';
const DEFAULT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const DEFAULT_MAX_REQUESTS = 5;

export class RateLimiter {
  constructor(key, options = {}) {
    this.key = RATE_LIMIT_KEY_PREFIX + key;
    this.windowMs = options.windowMs || DEFAULT_WINDOW_MS;
    this.maxRequests = options.maxRequests || DEFAULT_MAX_REQUESTS;
    this.blockDurationMs = options.blockDurationMs || 15 * 60 * 1000;
  }

  _getStore() {
    try {
      if (typeof localStorage === 'undefined') return { requests: [], blockedUntil: 0 };
      const raw = localStorage.getItem(this.key);
      if (!raw) return { requests: [], blockedUntil: 0 };
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed?.requests)) return { requests: [], blockedUntil: 0 };
      return parsed;
    } catch {
      return { requests: [], blockedUntil: 0 };
    }
  }

  _setStore(store) {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(this.key, JSON.stringify(store));
    } catch {
      // Storage unavailable, quota exceeded, or disabled
    }
  }

  _cleanOldRequests(store, now) {
    const cutoff = now - this.windowMs;
    store.requests = store.requests.filter((ts) => typeof ts === 'number' && ts > cutoff);
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
      remaining: Math.max(0, this.maxRequests - store.requests.length),
      resetAt: now + this.windowMs,
      blocked: false,
    };
  }

  reset() {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(this.key);
      }
    } catch {}
  }

  getStatus() {
    const now = Date.now();
    const store = this._getStore();
    this._cleanOldRequests(store, now);
    const isBlocked = store.blockedUntil > now;
    return {
      used: store.requests.length,
      remaining: isBlocked ? 0 : Math.max(0, this.maxRequests - store.requests.length),
      blocked: isBlocked,
      resetAt: isBlocked ? store.blockedUntil : now + this.windowMs,
    };
  }
}

// 1. SECURITY domain: password changes, account administration
// Uses existing sensitiveActionRateLimiter instance (from protected securityUtils)
export const securityActionRateLimiter = sensitiveActionRateLimiter;

// 2. DESTRUCTIVE domain: irreversible deletions, wiping imported history, undoing imports
export const destructiveActionRateLimiter = new RateLimiter('destructive_action_v1', {
  windowMs: 15 * 60 * 1000, // 15 minutes
  maxRequests: 30,          // 30 destructive actions per 15 minutes
  blockDurationMs: 15 * 60 * 1000,
});

// 3. IMPORT domain: file scans, single imports, batch "Import All" actions
export const importRateLimiter = new RateLimiter('import_action_v1', {
  windowMs: 15 * 60 * 1000, // 15 minutes
  maxRequests: 100,         // Generous ceiling for rapid single or batch report uploads
  blockDurationMs: 15 * 60 * 1000,
});

// 4. OPERATIONAL domain: routine non-destructive operations (expenses, daily manual entry, settings)
export const operationalActionRateLimiter = new RateLimiter('operational_action_v1', {
  windowMs: 15 * 60 * 1000, // 15 minutes
  maxRequests: 120,         // Routine day-to-day hotel data entry & configuration
  blockDurationMs: 15 * 60 * 1000,
});
