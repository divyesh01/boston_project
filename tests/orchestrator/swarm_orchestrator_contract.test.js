import { describe, it, expect } from 'vitest';
import {
  getSwarmOrchestratorVersion,
  getActiveActiveProviderTopology,
  verifySwarmInvariants,
  getLiveWorkerCapabilities,
} from '../../src/lib/swarmOrchestratorContract.js';

describe('Swarm Orchestrator Contract & Telemetry Invariant Suite', () => {
  it('exports semantic versioning matching Active-Active Swarm standard', () => {
    const version = getSwarmOrchestratorVersion();
    expect(version).toHaveProperty('version');
    expect(version).toHaveProperty('architecture', 'ACTIVE_ACTIVE_HIGH_PARALLELISM_SWARM');
    expect(version.status).toBe('PRODUCTION_READY');
  });

  it('validates active-active provider topology with balanced Claude Opus routing', () => {
    const topology = getActiveActiveProviderTopology();
    expect(topology.primaryBrain).toBe('CLAUDE_OPUS');
    expect(topology.activeActiveProviders).toEqual(
      expect.arrayContaining(['TABITOKEN', 'GOROUTER'])
    );
    expect(topology.mode).toBe('ACTIVE_ACTIVE_CONCURRENT');
  });

  it('verifies deterministic invariants for safety, subscription quota, and mechanical application', () => {
    const invariants = verifySwarmInvariants();
    expect(invariants.codexQuotaUsage).toBe('0% (CONSERVED)');
    expect(invariants.antigravityAuthoring).toBe('BLOCKED (EXTERNAL API ONLY)');
    expect(invariants.sha256VerificationRequired).toBe(true);
    expect(invariants.protectedFilesLocked).toBe(true);
  });

  it('reports live worker capabilities across multi-disciplinary swarm', () => {
    const caps = getLiveWorkerCapabilities();
    expect(Array.isArray(caps.waves)).toBe(true);
    expect(caps.waves).toContain('WAVE_A_PARALLEL_CLAUDE_OPUS');
    expect(caps.waves).toContain('WAVE_B_SPECIALIST_REVIEWER_SWARM');
    expect(caps.waves).toContain('WAVE_C_AUTHORITATIVE_SYNTHESIS');
    expect(caps.activeProviders).toEqual(
      expect.arrayContaining(['TABITOKEN', 'GOROUTER', 'NARA'])
    );
  });
});
