import { describe, it, expect } from 'vitest';
import { verifyOrchestratorInvariants, getOrchestratorTelemetryContract } from '../../src/lib/orchestratorVerificationProbe.js';

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
