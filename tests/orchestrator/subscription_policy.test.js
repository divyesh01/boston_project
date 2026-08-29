import { describe, it, expect } from 'vitest';
import {
  SubscriptionPolicy,
  USE_CODEX_BY_DEFAULT,
  REQUIRE_OWNER_PERMISSION_FOR_CODEX,
} from '../../src/orchestrator/policies/SubscriptionPolicy.js';

describe('SubscriptionPolicy Suite', () => {
  it('enforces USE_CODEX_BY_DEFAULT = false and REQUIRE_OWNER_PERMISSION_FOR_CODEX = true', () => {
    expect(USE_CODEX_BY_DEFAULT).toBe(false);
    expect(REQUIRE_OWNER_PERMISSION_FOR_CODEX).toBe(true);
  });

  it('blocks Codex invocation when owner authorization is missing', () => {
    expect(() => {
      SubscriptionPolicy.validateCodexInvocation({ isOwnerAuthorized: false });
    }).toThrowError(/POLICY_VIOLATION.*Codex/i);
  });

  it('allows Codex invocation when explicit owner authorization is granted', () => {
    const result = SubscriptionPolicy.validateCodexInvocation({
      isOwnerAuthorized: true,
      reason: 'Owner authorized specialized audit',
    });
    expect(result.allowed).toBe(true);
    expect(result.reason).toContain('Owner authorized');
  });

  it('prohibits Gemini/Antigravity subscription models from authoring code', () => {
    expect(() => {
      SubscriptionPolicy.validateCodeAuthor({
        role: 'CODE_AUTHOR',
        model: 'gemini-2.5-pro',
        provider: 'GEMINI_SUBSCRIPTION',
        isSubscriptionModel: true,
      });
    }).toThrowError(/SUBSCRIPTION_CODE_AUTHOR_PROHIBITED/);
  });

  it('prohibits Codex subscription from authoring code by default', () => {
    expect(() => {
      SubscriptionPolicy.validateCodeAuthor({
        role: 'CODE_AUTHOR',
        model: 'codex-davinci-002',
        provider: 'CODEX',
      });
    }).toThrowError(/CODEX_CODE_AUTHOR_PROHIBITED/);
  });

  it('allows authorized external API models to author code', () => {
    const result = SubscriptionPolicy.validateCodeAuthor({
      role: 'CODE_AUTHOR',
      model: 'claude-3-opus-20240229',
      provider: 'TABITOKEN',
      isSubscriptionModel: false,
    });
    expect(result.authorized).toBe(true);
  });

  it('generates accurate accounting report', () => {
    const policy = new SubscriptionPolicy();
    policy.recordUsage({
      antigravity: true,
      antigravityReason: 'Dashboard status viewing',
      codex: false,
    });

    const report = policy.generateAccountingReport();
    expect(report).toContain('ANTIGRAVITY SUBSCRIPTION');
    expect(report).toContain('Substantive reasoning / code authoring: YES');
    expect(report).toContain('Interface / launcher usage: YES');
    expect(report).toContain('CODEX SUBSCRIPTION');
    expect(report).toContain('Substantive reasoning / code authoring: NO (Conserved at 0% usage)');
  });
});
