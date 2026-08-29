import { describe, it, expect, beforeEach } from 'vitest';
import {
  ActiveActiveRouter,
  PROVIDER_HEALTH_STATE,
} from '../../src/orchestrator/routing/ActiveActiveRouter.js';

describe('ActiveActiveRouter', () => {
  let router;

  beforeEach(() => {
    router = new ActiveActiveRouter({
      primaryProviders: ['TABITOKEN', 'GOROUTER'],
      cooldownDurationMs: 50,
      maxConsecutiveFailures: 2,
    });
  });

  describe('Balanced Active-Active Selection', () => {
    it('alternates between Tabitoken and GoRouter when both are healthy and under equal load', () => {
      const choice1 = router.selectProviderForClaude();
      const choice2 = router.selectProviderForClaude();
      const choice3 = router.selectProviderForClaude();
      const choice4 = router.selectProviderForClaude();

      expect([choice1.provider, choice2.provider]).toEqual(
        expect.arrayContaining(['TABITOKEN', 'GOROUTER'])
      );
      expect(choice1.provider).not.toEqual(choice2.provider);
      expect(choice3.provider).not.toEqual(choice4.provider);
    });

    it('routes to the provider with fewer active requests when load is unequal', () => {
      // Tabitoken has 2 active requests, GoRouter has 0
      router.recordRequestStart('TABITOKEN');
      router.recordRequestStart('TABITOKEN');

      const choice = router.selectProviderForClaude();
      expect(choice.provider).toBe('GOROUTER');
    });

    it('plans interleaved parallel wave assignments for N workers', () => {
      const wave4 = router.planParallelClaudeWave(4);
      expect(wave4).toHaveLength(4);
      expect(wave4[0].provider).toBe('TABITOKEN');
      expect(wave4[1].provider).toBe('GOROUTER');
      expect(wave4[2].provider).toBe('TABITOKEN');
      expect(wave4[3].provider).toBe('GOROUTER');
      expect(wave4.every((w) => w.mode === 'ACTIVE_ACTIVE_CONCURRENT')).toBe(true);
    });
  });

  describe('Health States, Circuit Breaker & Failover', () => {
    it('transitions to DEGRADED on single transient failure, but remains eligible', () => {
      router.recordRequestOutcome('TABITOKEN', {
        success: false,
        httpStatus: 500,
        error: 'Internal Server Error',
      });

      const state = router.getProviderState('TABITOKEN');
      expect(state.health).toBe(PROVIDER_HEALTH_STATE.DEGRADED);
      expect(router.isProviderEligible('TABITOKEN')).toBe(true);
    });

    it('transitions to COOLDOWN after maxConsecutiveFailures and fails over to healthy provider', () => {
      router.recordRequestOutcome('TABITOKEN', { success: false, httpStatus: 500, error: 'Fail 1' });
      router.recordRequestOutcome('TABITOKEN', { success: false, httpStatus: 500, error: 'Fail 2' });

      const tabiState = router.getProviderState('TABITOKEN');
      expect(tabiState.health).toBe(PROVIDER_HEALTH_STATE.COOLDOWN);
      expect(router.isProviderEligible('TABITOKEN')).toBe(false);

      // Next call must dynamically route to GOROUTER
      const choice = router.selectProviderForClaude();
      expect(choice.provider).toBe('GOROUTER');
    });

    it('transitions to UNAVAILABLE immediately on 401 auth failure', () => {
      router.recordRequestOutcome('TABITOKEN', { success: false, httpStatus: 401, error: 'Unauthorized' });

      const state = router.getProviderState('TABITOKEN');
      expect(state.health).toBe(PROVIDER_HEALTH_STATE.UNAVAILABLE);
      expect(router.isProviderEligible('TABITOKEN')).toBe(false);
    });

    it('progressively recovers after cooldown period expires and successful call occurs', async () => {
      router.recordRequestOutcome('TABITOKEN', { success: false, httpStatus: 500, error: 'Fail 1' });
      router.recordRequestOutcome('TABITOKEN', { success: false, httpStatus: 500, error: 'Fail 2' });

      expect(router.getProviderState('TABITOKEN').health).toBe(PROVIDER_HEALTH_STATE.COOLDOWN);

      // Wait for cooldown
      await new Promise((r) => setTimeout(r, 60));

      const refreshed = router.getProviderState('TABITOKEN');
      expect(refreshed.health).toBe(PROVIDER_HEALTH_STATE.RECOVERING);

      // Successful trial call restores to HEALTHY
      router.recordRequestOutcome('TABITOKEN', { success: true });
      expect(router.getProviderState('TABITOKEN').health).toBe(PROVIDER_HEALTH_STATE.HEALTHY);
    });
  });

  describe('Balance Metrics Calculation', () => {
    it('reports BALANCED when both Tabitoken and GoRouter have successful calls', () => {
      router.recordRequestOutcome('TABITOKEN', { success: true, usage: { prompt_tokens: 1000, completion_tokens: 200 } });
      router.recordRequestOutcome('GOROUTER', { success: true, usage: { prompt_tokens: 1000, completion_tokens: 200 } });

      const metrics = router.getBalanceMetrics();
      expect(metrics.status).toBe('BALANCED');
      expect(metrics.totalClaudeCalls).toBe(2);
      expect(metrics.totalClaudeInputTokens).toBe(2000);
    });

    it('reports FAILOVER MODE when one provider fails and the other carries load', () => {
      router.recordRequestOutcome('TABITOKEN', { success: false, httpStatus: 401, error: 'Auth failed' });
      router.recordRequestOutcome('GOROUTER', { success: true, usage: { prompt_tokens: 1500, completion_tokens: 300 } });

      const metrics = router.getBalanceMetrics();
      expect(metrics.status).toBe('FAILOVER MODE');
    });
  });
});
