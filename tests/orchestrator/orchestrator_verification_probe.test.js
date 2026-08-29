import { describe, it, expect } from 'vitest';
import {
  verifyOrchestratorInvariants,
  getOrchestratorTelemetryContract,
  inspectActiveActiveRoutingHealth,
} from '../../src/lib/orchestratorVerificationProbe.js';

const ISO_8601_UTC_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe('Orchestrator Verification Probe Module Tests', () => {
  it('exports valid invariants matching contract', () => {
    const inv = verifyOrchestratorInvariants();
    expect(inv.status).toBe('VERIFIED');
    expect(inv.engine).toBe('API_FIRST_MULTI_AGENT');
    expect(inv.version).toBe('1.0.0');
  });

  it('exports correct telemetry contract', () => {
    const tel = getOrchestratorTelemetryContract();
    expect(tel.primaryBrain).toBe('CLAUDE_OPUS');
    expect(tel.reviewerSwarm).toContain('GEMINI');
    expect(tel.reviewerSwarm).toContain('NVIDIA');
    expect(tel.reviewerSwarm).toContain('NARA');
    expect(tel.reviewerSwarm).toContain('XKIRO');
    expect(tel.subscriptionQuotaSaved).toBe(true);
  });
});

describe('inspectActiveActiveRoutingHealth', () => {
  it('declares the full active-active routing contract', () => {
    const health = inspectActiveActiveRoutingHealth();
    expect(health.status).toBe('ACTIVE_ACTIVE_OPTIMAL');
    expect(health.primaryChannels).toEqual(['TABITOKEN', 'GOROUTER']);
    expect(health.balancingPolicy).toBe('DYNAMIC_LATENCY_AWARE');
    expect(health.workerAllocation).toBe('2_TABITOKEN_2_GOROUTER');
    expect(health.circuitBreaker).toBe('ENABLED');
  });

  it('declares exactly two primary channels', () => {
    // Length is asserted explicitly so a silently added third channel fails
    // here rather than downstream in the routing layer.
    expect(inspectActiveActiveRoutingHealth().primaryChannels).toHaveLength(2);
  });

  it('exposes exactly the contracted key set, guarding against drift', () => {
    expect(Object.keys(inspectActiveActiveRoutingHealth()).sort()).toEqual([
      'balancingPolicy',
      'circuitBreaker',
      'primaryChannels',
      'status',
      'timestamp',
      'workerAllocation',
    ]);
  });

  it('keeps workerAllocation consistent with primaryChannels', () => {
    // The allocation token is opaque to consumers, but this test owns the
    // encoding so that editing one field without the other fails loudly
    // instead of drifting silently.
    const { primaryChannels, workerAllocation } = inspectActiveActiveRoutingHealth();
    expect(workerAllocation.match(/[A-Z]+/g)).toEqual(primaryChannels);
    expect(workerAllocation.match(/\d+/g)).toHaveLength(primaryChannels.length);
  });

  it('emits a parseable, canonical ISO-8601 UTC timestamp', () => {
    const { timestamp } = inspectActiveActiveRoutingHealth();
    expect(typeof timestamp).toBe('string');
    expect(timestamp).toMatch(ISO_8601_UTC_MS);
    expect(Number.isNaN(Date.parse(timestamp))).toBe(false);
    // Round-trip guards against a well-formed but locale/offset-formatted
    // string slipping into the telemetry pipeline.
    expect(new Date(timestamp).toISOString()).toBe(timestamp);
  });

  it('keeps every field except timestamp stable across calls', () => {
    const { timestamp: _first, ...firstRest } = inspectActiveActiveRoutingHealth();
    const { timestamp: _second, ...secondRest } = inspectActiveActiveRoutingHealth();
    expect(firstRest).toEqual(secondRest);
  });

  it('isolates state between callers: mutating one result cannot affect another', () => {
    // This test fails if anyone "optimizes" the literals into module-level
    // constants, which is the specific regression this module guards against.
    const first = inspectActiveActiveRoutingHealth();
    const second = inspectActiveActiveRoutingHealth();

    expect(first).not.toBe(second);
    expect(first.primaryChannels).not.toBe(second.primaryChannels);

    first.status = 'DEGRADED';
    first.circuitBreaker = 'DISABLED';
    first.primaryChannels.push('ROGUE_CHANNEL');

    const third = inspectActiveActiveRoutingHealth();
    expect(second.status).toBe('ACTIVE_ACTIVE_OPTIMAL');
    expect(second.primaryChannels).toEqual(['TABITOKEN', 'GOROUTER']);
    expect(third.status).toBe('ACTIVE_ACTIVE_OPTIMAL');
    expect(third.circuitBreaker).toBe('ENABLED');
    expect(third.primaryChannels).toEqual(['TABITOKEN', 'GOROUTER']);
  });

  it('coexists with the pre-existing probes without cross-contamination', () => {
    const inv = verifyOrchestratorInvariants();
    const tel = getOrchestratorTelemetryContract();
    const health = inspectActiveActiveRoutingHealth();

    health.status = 'MUTATED';
    health.primaryChannels.length = 0;

    expect(inv.status).toBe('VERIFIED');
    expect(tel.subscriptionQuotaSaved).toBe(true);
    expect(verifyOrchestratorInvariants().status).toBe('VERIFIED');
    expect(getOrchestratorTelemetryContract().reviewerSwarm).toEqual([
      'GEMINI',
      'NVIDIA',
      'NARA',
      'XKIRO',
    ]);
  });
});