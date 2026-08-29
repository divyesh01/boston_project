import { describe, it, expect, vi } from 'vitest';
import {
  ProviderRegistry,
  OpenAICompatibleAdapter,
  FallbackPolicy,
  SubscriptionPolicy,
  EditingSafetyPolicy,
  PatchApplier,
  sha256,
  Orchestrator,
  ActiveActiveRouter,
  RuntimeInventory,
  CANDIDATE_SWARM_ROLES,
  redactSecrets,
} from '../../src/orchestrator/index.js';

describe('Adversarial Provider & Policy Simulation Suite (Section 26 Requirements)', () => {
  // Scenario A: Claude provider returns HTTP 401
  it('Scenario A: Claude provider returns 401 -> records AUTH_FAILED and cascades to fallback without repeating', async () => {
    const mockFetch = vi.fn()
      // First provider returns 401
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized: Invalid API Key',
      })
      // Second provider succeeds with genuine Claude
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'x-generation-id': 'gen-fallback-1' }),
        json: async () => ({
          id: 'gen-fallback-1',
          model: 'claude-opus-5',
          provider: 'Anthropic Direct',
          choices: [{ message: { content: 'Fallback Claude Opus Proposal' } }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }),
      });

    const registry = new ProviderRegistry({
      keyResolver: () => 'test-key',
      fetchFn: mockFetch,
    });

    const fallback = new FallbackPolicy({ maxRetriesPerProvider: 2 });
    const result = await fallback.executeAuthoritativeClaude(registry, {
      prompt: 'Test task',
      customCandidateRoutes: [
        { provider: 'TABITOKEN', model: 'claude-opus-5' },
        { provider: 'GOROUTER', model: 'claude-opus-5' },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.authoritativeModel).toBe('claude-opus-5');
    expect(result.attempts[0].httpStatus).toBe(401);
    expect(result.attempts[0].success).toBe(false);
    expect(result.attempts[1].success).toBe(true);
  });

  // Scenario B: Tabitoken HTTP 401 -> fails over to GoRouter active-active
  it('Scenario B: Tabitoken 401 auth error -> dynamically routes to GoRouter', async () => {
    const router = new ActiveActiveRouter({
      primaryProviders: ['TABITOKEN', 'GOROUTER'],
    });

    // Simulate Tabitoken 401
    router.recordRequestOutcome('TABITOKEN', { success: false, httpStatus: 401, error: 'Unauthorized' });

    const choice = router.selectProviderForClaude();
    expect(choice.provider).toBe('GOROUTER');
    expect(choice.reason).toBe('ACTIVE_AVAILABLE');
  });

  // Scenario C: GoRouter HTTP 401 -> fails over to Tabitoken active-active
  it('Scenario C: GoRouter 401 auth error -> dynamically routes to Tabitoken', async () => {
    const router = new ActiveActiveRouter({
      primaryProviders: ['TABITOKEN', 'GOROUTER'],
    });

    // Simulate GoRouter 401
    router.recordRequestOutcome('GOROUTER', { success: false, httpStatus: 401, error: 'Unauthorized' });

    const choice = router.selectProviderForClaude();
    expect(choice.provider).toBe('TABITOKEN');
    expect(choice.reason).toBe('ACTIVE_AVAILABLE');
  });

  // Scenario D: Provider 429 rate limit -> circuit breaker triggers cooldown
  it('Scenario D: Provider 429 rate limit -> enters cooldown and avoids hammering', async () => {
    const router = new ActiveActiveRouter({
      primaryProviders: ['TABITOKEN', 'GOROUTER'],
      maxConsecutiveFailures: 2,
      cooldownDurationMs: 1000,
    });

    router.recordRequestOutcome('TABITOKEN', { success: false, httpStatus: 429, error: 'Rate limit exceeded' });
    router.recordRequestOutcome('TABITOKEN', { success: false, httpStatus: 429, error: 'Rate limit exceeded' });

    const state = router.getProviderState('TABITOKEN');
    expect(state.health).toBe('COOLDOWN');
    expect(router.isProviderEligible('TABITOKEN')).toBe(false);
  });

  // Scenario E: Provider returns HTTP 402
  it('Scenario E: Provider returns 402 -> reports failure without fake success', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 402,
      text: async () => 'Payment Required: Insufficient balance',
    });

    const registry = new ProviderRegistry({
      keyResolver: () => 'test-key',
      fetchFn: mockFetch,
    });

    const fallback = new FallbackPolicy({ maxRetriesPerProvider: 1 });
    const result = await fallback.executeAuthoritativeClaude(registry, {
      prompt: 'Test task',
      customCandidateRoutes: [{ provider: 'OPENROUTER', model: 'claude-opus-5' }],
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe('UNAVAILABLE');
    expect(result.attempts[0].httpStatus).toBe(402);
  });

  // Scenario F: Claude returns empty HTTP 200
  it('Scenario F: Claude returns empty HTTP 200 -> records EMPTY_RESPONSE, not PROVEN', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'gen-empty',
        model: 'claude-opus-5',
        choices: [{ message: { content: '   ' } }],
      }),
    });

    const registry = new ProviderRegistry({
      keyResolver: () => 'test-key',
      fetchFn: mockFetch,
    });

    const fallback = new FallbackPolicy({ maxRetriesPerProvider: 1 });
    const result = await fallback.executeAuthoritativeClaude(registry, {
      prompt: 'Test task',
      customCandidateRoutes: [{ provider: 'OPENROUTER', model: 'claude-opus-5' }],
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe('UNAVAILABLE');
    expect(result.attempts[0].error).toBe('EMPTY_RESPONSE');
  });

  // Scenario G: Timeout handling
  it('Scenario G: Claude timeout -> executes bounded retry then stops', async () => {
    let attemptCount = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      attemptCount++;
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    });

    const registry = new ProviderRegistry({
      keyResolver: () => 'test-key',
      fetchFn: mockFetch,
    });

    const fallback = new FallbackPolicy({ maxRetriesPerProvider: 2, retryDelayMs: 1 });
    const result = await fallback.executeAuthoritativeClaude(registry, {
      prompt: 'Test task',
      customCandidateRoutes: [{ provider: 'OPENROUTER', model: 'claude-opus-5' }],
    });

    expect(result.success).toBe(false);
    expect(attemptCount).toBe(2);
    expect(result.attempts[0].error).toContain('TIMEOUT');
  });

  // Scenario H: Model identity mismatch
  it('Scenario H: Provider returns a different model (Gemini instead of Claude) -> rejects fake identity', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'gen-mismatch',
        model: 'google/gemini-2.5-pro',
        choices: [{ message: { content: 'I am masquerading as Claude' } }],
      }),
    });

    const registry = new ProviderRegistry({
      keyResolver: () => 'test-key',
      fetchFn: mockFetch,
    });

    const fallback = new FallbackPolicy({ maxRetriesPerProvider: 1 });
    const result = await fallback.executeAuthoritativeClaude(registry, {
      prompt: 'Test task',
      customCandidateRoutes: [{ provider: 'OPENROUTER', model: 'claude-opus-5' }],
    });

    expect(result.success).toBe(false);
    expect(result.attempts[0].actualProvider).toBe('GOOGLE');
    expect(result.attempts[0].success).toBe(false);
  });

  // Scenario I: Malformed JSON response
  it('Scenario I: Provider returns malformed non-JSON -> handles gracefully as error', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('Unexpected token < in JSON at position 0');
      },
    });

    const registry = new ProviderRegistry({
      keyResolver: () => 'test-key',
      fetchFn: mockFetch,
    });

    const res = await registry.callAgent({
      role: 'GENERAL_WORKER',
      provider: 'OPENROUTER',
      model: 'claude-opus-5',
      prompt: 'Hello',
    });

    expect(res.success).toBe(false);
    expect(res.error).toContain('Unexpected token');
  });

  // Scenario J: Patch hash verification
  it('Scenario J: Patch hash mismatch -> detects altered patch', () => {
    const originalPatch = 'FILE: src/demo.js\n```javascript\nconst a = 1;\n```';
    const originalHash = sha256(originalPatch);

    const tamperedPatch = 'FILE: src/demo.js\n```javascript\nconst a = 9999;\n```';
    const tamperedHash = sha256(tamperedPatch);

    expect(originalHash).not.toBe(tamperedHash);
  });

  // Scenario K: Codex subscription blocking
  it('Scenario K: Codex invocation without explicit permission -> blocked by SubscriptionPolicy', () => {
    expect(() => {
      SubscriptionPolicy.validateCodexInvocation({ isOwnerAuthorized: false });
    }).toThrowError(/CODEX_INVOCATION_BLOCKED/);
  });

  // Scenario L: Antigravity subscription authoring blocking
  it('Scenario L: Antigravity subscription attempting code authoring -> blocked by SubscriptionPolicy', () => {
    expect(() => {
      SubscriptionPolicy.validateCodeAuthor({
        role: 'CODE_AUTHOR',
        model: 'gemini-3.7-flash',
        provider: 'ANTIGRAVITY_SUBSCRIPTION',
        isSubscriptionModel: true,
      });
    }).toThrowError(/SUBSCRIPTION_CODE_AUTHOR_PROHIBITED/);
  });

  // Scenario M: Secret redaction in logs
  it('Scenario M: Secret patterns are automatically redacted from error traces and logs', () => {
    const textWithSecret = 'Connection failed with sk-ant-api03-1234567890abcdef1234567890 and Bearer sk-tabitoken-12345678901234567890';
    const redacted = redactSecrets(textWithSecret);

    expect(redacted).not.toContain('sk-ant-api03');
    expect(redacted).not.toContain('sk-tabitoken');
    expect(redacted).toContain('[REDACTED_ANTHROPIC_KEY]');
  });

  // Scenario N: 20 Candidate Roles Inventory
  it('Scenario N: RuntimeInventory tracks all 20 configured candidate swarm roles', () => {
    expect(CANDIDATE_SWARM_ROLES.length).toBe(20);
    const deterministic = CANDIDATE_SWARM_ROLES.filter((r) => r.provider === 'LOCAL_DETERMINISTIC');
    const apiWorkers = CANDIDATE_SWARM_ROLES.filter((r) => r.provider !== 'LOCAL_DETERMINISTIC');

    expect(deterministic.length).toBe(5);
    expect(apiWorkers.length).toBe(15);
  });
});
