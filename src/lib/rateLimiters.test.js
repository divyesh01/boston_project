import { describe, it, expect, beforeEach } from 'vitest';
import {
  RateLimiter,
  securityActionRateLimiter,
  destructiveActionRateLimiter,
  importRateLimiter,
  operationalActionRateLimiter,
} from './rateLimiters';
import { sensitiveActionRateLimiter } from './securityUtils';

describe('rateLimiters domain separation', () => {
  beforeEach(() => {
    localStorage.clear();
    securityActionRateLimiter.reset();
    destructiveActionRateLimiter.reset();
    importRateLimiter.reset();
    operationalActionRateLimiter.reset();
    sensitiveActionRateLimiter.reset();
  });

  it('allows importing when operational rate limit is exhausted', () => {
    // Burn operational limit (120 requests)
    for (let i = 0; i < 120; i++) {
      const res = operationalActionRateLimiter.check();
      expect(res.allowed).toBe(true);
    }
    const blockedOp = operationalActionRateLimiter.check();
    expect(blockedOp.allowed).toBe(false);
    expect(blockedOp.blocked).toBe(true);

    // Import domain MUST still be allowed and completely unblocked
    const importRes = importRateLimiter.check();
    expect(importRes.allowed).toBe(true);
    expect(importRes.blocked).toBe(false);
  });

  it('allows security operations when import rate limit is exhausted', () => {
    // Burn import limit (100 requests)
    for (let i = 0; i < 100; i++) {
      const res = importRateLimiter.check();
      expect(res.allowed).toBe(true);
    }
    const blockedImport = importRateLimiter.check();
    expect(blockedImport.allowed).toBe(false);
    expect(blockedImport.blocked).toBe(true);

    // Security actions (e.g. password change) MUST still be allowed
    const secRes = securityActionRateLimiter.check();
    expect(secRes.allowed).toBe(true);
    expect(secRes.blocked).toBe(false);

    // Destructive actions MUST also still be allowed
    const destRes = destructiveActionRateLimiter.check();
    expect(destRes.allowed).toBe(true);
    expect(destRes.blocked).toBe(false);
  });

  it('does NOT lock import domain when securityActionRateLimiter is exhausted', () => {
    // Burn security limit (50 requests on sensitiveActionRateLimiter)
    for (let i = 0; i < 50; i++) {
      const res = sensitiveActionRateLimiter.check();
      expect(res.allowed).toBe(true);
    }
    const blockedSec = sensitiveActionRateLimiter.check();
    expect(blockedSec.allowed).toBe(false);

    // Import domain MUST NOT receive a 60-minute block
    const importRes = importRateLimiter.check();
    expect(importRes.allowed).toBe(true);
    expect(importRes.blocked).toBe(false);

    // Operational domain MUST NOT receive a 60-minute block
    const opRes = operationalActionRateLimiter.check();
    expect(opRes.allowed).toBe(true);
    expect(opRes.blocked).toBe(false);
  });

  it('prevents 60 ordinary operations followed by Import All from causing a lockout', () => {
    // Simulate user editing 60 expense/setting items in rapid succession
    for (let i = 0; i < 60; i++) {
      const op = operationalActionRateLimiter.check();
      expect(op.allowed).toBe(true);
    }

    // Now user initiates Import All
    const batchImportCheck = importRateLimiter.check();
    expect(batchImportCheck.allowed).toBe(true);
    expect(batchImportCheck.remaining).toBe(99);

    // And password change / user admin is also NOT affected
    const userAdminCheck = securityActionRateLimiter.check();
    expect(userAdminCheck.allowed).toBe(true);
    expect(userAdminCheck.remaining).toBe(49);
  });

  it('resets domain limits independently', () => {
    importRateLimiter.check();
    destructiveActionRateLimiter.check();

    expect(importRateLimiter.getStatus().used).toBe(1);
    expect(destructiveActionRateLimiter.getStatus().used).toBe(1);

    importRateLimiter.reset();

    expect(importRateLimiter.getStatus().used).toBe(0);
    expect(destructiveActionRateLimiter.getStatus().used).toBe(1);
  });

  it('custom RateLimiter handles storage failures gracefully', () => {
    const limiter = new RateLimiter('test_fail_v1', { maxRequests: 2 });
    const originalSetItem = localStorage.setItem;
    try {
      localStorage.setItem = () => {
        throw new Error('QuotaExceededError');
      };
      // Should not throw even when storage throws
      const res = limiter.check();
      expect(res.allowed).toBe(true);
    } finally {
      localStorage.setItem = originalSetItem;
    }
  });
});
