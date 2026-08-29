/**
 * Contract tests for src/lib/swarmOrchestratorContract.js
 *
 * This module exists to stop topology/version facts from drifting across the
 * orchestrator, the router, the probes, and the ledgers. These tests are the
 * enforcement half of that guarantee:
 *
 *  1. Declared values are pinned, so a change to the contract is a deliberate,
 *     reviewable diff rather than an accident.
 *  2. Cross-declaration consistency is asserted, so adding a provider to the
 *     topology without adding it to worker capabilities fails here instead of
 *     diverging silently.
 *  3. Accessors are proven to return fresh, independently mutable values, so a
 *     consumer cannot corrupt another consumer's view.
 *  4. `timestamp` is proven to be the only non-deterministic field, which is
 *     the precondition every evidence digest relies on.
 *
 * Harness note: uses global `describe`/`test`/`expect` (jest, or vitest with
 * `globals: true`). Under vitest without globals, add:
 *   import { describe, test, expect } from 'vitest';
 */

import {
  getSwarmOrchestratorVersion,
  getActiveActiveProviderTopology,
  verifySwarmInvariants,
  getLiveWorkerCapabilities,
} from '../../src/lib/swarmOrchestratorContract.js';

describe('getSwarmOrchestratorVersion', () => {
  test('pins version identity fields', () => {
    const v = getSwarmOrchestratorVersion();
    expect(v.version).toBe('2.0.0');
    expect(v.architecture).toBe('ACTIVE_ACTIVE_HIGH_PARALLELISM_SWARM');
    expect(v.status).toBe('PRODUCTION_READY');
  });

  test('emits a parseable ISO-8601 UTC timestamp', () => {
    const { timestamp } = getSwarmOrchestratorVersion();
    expect(typeof timestamp).toBe('string');
    expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Number.isNaN(Date.parse(timestamp))).toBe(false);
  });

  test('timestamp is the only field that may vary across calls', () => {
    const a = getSwarmOrchestratorVersion();
    const b = getSwarmOrchestratorVersion();
    const { timestamp: _a, ...stableA } = a;
    const { timestamp: _b, ...stableB } = b;
    expect(stableA).toEqual(stableB);
  });

  test('exposes exactly the four documented keys', () => {
    expect(Object.keys(getSwarmOrchestratorVersion()).sort()).toEqual([
      'architecture',
      'status',
      'timestamp',
      'version',
    ]);
  });
});

describe('getActiveActiveProviderTopology', () => {
  test('pins the declared topology', () => {
    expect(getActiveActiveProviderTopology()).toEqual({
      primaryBrain: 'CLAUDE_OPUS',
      activeActiveProviders: ['TABITOKEN', 'GOROUTER'],
      mode: 'ACTIVE_ACTIVE_CONCURRENT',
      balancingPolicy: 'DYNAMIC_HEALTH_AND_WORKLOAD_BALANCED',
    });
  });

  test('is fully deterministic across calls', () => {
    expect(getActiveActiveProviderTopology()).toEqual(
      getActiveActiveProviderTopology(),
    );
  });

  test('returns a fresh array that callers may mutate without side effects', () => {
    const first = getActiveActiveProviderTopology();
    first.activeActiveProviders.push('MUTATED');
    first.activeActiveProviders.sort();
    expect(getActiveActiveProviderTopology().activeActiveProviders).toEqual([
      'TABITOKEN',
      'GOROUTER',
    ]);
  });
});

describe('verifySwarmInvariants', () => {
  test('pins the declared invariant manifest', () => {
    expect(verifySwarmInvariants()).toEqual({
      codexQuotaUsage: '0% (CONSERVED)',
      antigravityAuthoring: 'BLOCKED (EXTERNAL API ONLY)',
      sha256VerificationRequired: true,
      protectedFilesLocked: true,
      qualityOverCost: true,
    });
  });

  test('is fully deterministic across calls', () => {
    expect(verifySwarmInvariants()).toEqual(verifySwarmInvariants());
  });

  test('returns an independent object per call', () => {
    const first = verifySwarmInvariants();
    first.protectedFilesLocked = false;
    expect(verifySwarmInvariants().protectedFilesLocked).toBe(true);
  });
});

describe('getLiveWorkerCapabilities', () => {
  test('pins the declared capability envelope', () => {
    expect(getLiveWorkerCapabilities()).toEqual({
      waves: [
        'WAVE_A_PARALLEL_CLAUDE_OPUS',
        'WAVE_B_SPECIALIST_REVIEWER_SWARM',
        'WAVE_C_AUTHORITATIVE_SYNTHESIS',
      ],
      activeProviders: ['TABITOKEN', 'GOROUTER', 'NARA', 'LOCAL_DETERMINISTIC'],
      concurrencyModel: 'ASYNC_PROMISE_ALL_BOUNDED',
    });
  });

  test('declares exactly three ordered waves', () => {
    const { waves } = getLiveWorkerCapabilities();
    expect(waves).toHaveLength(3);
    expect(waves[0]).toBe('WAVE_A_PARALLEL_CLAUDE_OPUS');
    expect(waves[1]).toBe('WAVE_B_SPECIALIST_REVIEWER_SWARM');
    expect(waves[2]).toBe('WAVE_C_AUTHORITATIVE_SYNTHESIS');
  });

  test('keeps LOCAL_DETERMINISTIC last as the terminal fallback', () => {
    const { activeProviders } = getLiveWorkerCapabilities();
    expect(activeProviders[activeProviders.length - 1]).toBe(
      'LOCAL_DETERMINISTIC',
    );
  });

  test('returns fresh arrays that callers may mutate without side effects', () => {
    const first = getLiveWorkerCapabilities();
    first.waves.reverse();
    first.activeProviders.length = 0;
    const second = getLiveWorkerCapabilities();
    expect(second.waves[0]).toBe('WAVE_A_PARALLEL_CLAUDE_OPUS');
    expect(second.activeProviders).toHaveLength(4);
  });
});

describe('cross-declaration consistency', () => {
  test('worker providers are a superset of the active-active pair', () => {
    const { activeActiveProviders } = getActiveActiveProviderTopology();
    const { activeProviders } = getLiveWorkerCapabilities();
    for (const provider of activeActiveProviders) {
      expect(activeProviders).toContain(provider);
    }
  });

  test('the primary brain is not listed as a balanced provider', () => {
    const { primaryBrain, activeActiveProviders } =
      getActiveActiveProviderTopology();
    expect(activeActiveProviders).not.toContain(primaryBrain);
  });

  test('provider lists contain no duplicates', () => {
    const { activeActiveProviders } = getActiveActiveProviderTopology();
    const { activeProviders, waves } = getLiveWorkerCapabilities();
    expect(new Set(activeActiveProviders).size).toBe(
      activeActiveProviders.length,
    );
    expect(new Set(activeProviders).size).toBe(activeProviders.length);
    expect(new Set(waves).size).toBe(waves.length);
  });
});

describe('evidence-digest safety', () => {
  test('deterministic accessors serialize identically across calls', () => {
    expect(JSON.stringify(getActiveActiveProviderTopology())).toBe(
      JSON.stringify(getActiveActiveProviderTopology()),
    );
    expect(JSON.stringify(verifySwarmInvariants())).toBe(
      JSON.stringify(verifySwarmInvariants()),
    );
    expect(JSON.stringify(getLiveWorkerCapabilities())).toBe(
      JSON.stringify(getLiveWorkerCapabilities()),
    );
  });

  test('version identity is digest-stable once timestamp is excluded', () => {
    const digestInput = () => {
      const { timestamp, ...rest } = getSwarmOrchestratorVersion();
      return JSON.stringify(rest);
    };
    expect(digestInput()).toBe(digestInput());
  });
});