import { describe, it, expect } from 'vitest';
import {
  DOMAINS,
  CONFIDENCE_THRESHOLD,
  classifyPrompt,
  buildOrchestrationPlan,
} from '../autonomousOrchestrator.js';

describe('Autonomous Engineering Orchestrator', () => {
  it('classifies financial discrepancy prompts to FINANCIAL_TRUTH squad', () => {
    const classification = classifyPrompt('Revenue is wrong.');
    expect(classification.primaryDomain).toBe(DOMAINS.FINANCIAL_TRUTH);
    expect(classification.confidence).toBeGreaterThanOrEqual(CONFIDENCE_THRESHOLD);
    expect(classification.detectedKeywords).toContain('revenue');

    const plan = buildOrchestrationPlan(classification, 'Revenue is wrong.');
    expect(plan.claudeCheckpoints.some((c) => c.id === 'CP4')).toBe(true);
    expect(plan.claudeCheckpoints.some((c) => c.id === 'CP5')).toBe(true);
    expect(plan.nvidiaNim).not.toBeNull();
    expect(plan.researchSpecialist).not.toBeNull();
    expect(plan.deterministicProbes).toContain('scripts/probe-financial-invariant.mjs');
  });

  it('reconstructs context for ultra-terse vague prompts to VAGUE_AUTODETECT tribunal', () => {
    const classification = classifyPrompt('Fix this.', { recentTopic: 'Room board cross-property leak' });
    expect(classification.primaryDomain).toBe(DOMAINS.VAGUE_AUTODETECT);
    expect(classification.inferredContextDomain).toBe(DOMAINS.PROPERTY_ISOLATION);

    const plan = buildOrchestrationPlan(classification, 'Fix this.');
    expect(plan.claudeCheckpoints.some((c) => c.id === 'CP1')).toBe(true);
    expect(plan.claudeCheckpoints.some((c) => c.id === 'CP5')).toBe(true);
    expect(plan.deterministicProbes).toContain('scripts/audit-gate.mjs');
  });

  it('classifies CSV / ingestion issues to DATA_INGESTION_IMPORT squad', () => {
    const classification = classifyPrompt('Import missed some rows.');
    expect(classification.primaryDomain).toBe(DOMAINS.DATA_INGESTION_IMPORT);
    expect(classification.detectedKeywords).toContain('import');
    expect(classification.detectedKeywords).toContain('rows');

    const plan = buildOrchestrationPlan(classification, 'Import missed some rows.');
    expect(plan.claudeCheckpoints.some((c) => c.id === 'CP1')).toBe(true);
    expect(plan.claudeCheckpoints.some((c) => c.id === 'CP3')).toBe(true);
    expect(plan.researchSpecialist.role).toContain('RFC 4180');
    expect(plan.deterministicProbes).toContain('scripts/probe-csv-data-loss.mjs');
  });

  it('classifies cross-property leaks to PROPERTY_ISOLATION squad', () => {
    const classification = classifyPrompt('Property B numbers are showing in Property A.');
    expect(classification.primaryDomain).toBe(DOMAINS.PROPERTY_ISOLATION);

    const plan = buildOrchestrationPlan(classification, 'Property B numbers are showing in Property A.');
    expect(plan.claudeCheckpoints.some((c) => c.id === 'CP1')).toBe(true);
    expect(plan.claudeCheckpoints.some((c) => c.id === 'CP2')).toBe(true);
    expect(plan.claudeCheckpoints.some((c) => c.id === 'CP5')).toBe(true);
    expect(plan.adversarialSwarm).not.toBeNull();
    expect(plan.deterministicProbes).toContain('scripts/probe-property-isolation.mjs');
  });

  it('classifies layout and clarity confusion to UI_UX_ACCESSIBILITY squad', () => {
    const classification = classifyPrompt('This page is confusing.');
    expect(classification.primaryDomain).toBe(DOMAINS.UI_UX_ACCESSIBILITY);

    const plan = buildOrchestrationPlan(classification, 'This page is confusing.');
    expect(plan.claudeCheckpoints.some((c) => c.id === 'CP1')).toBe(true);
    expect(plan.researchSpecialist.role).toContain('WCAG');
    expect(plan.deterministicProbes).toContain('scripts/probe-ui-feedback.mjs');
  });

  it('classifies binary executable exploits to SECURITY_ACCESS squad', () => {
    const classification = classifyPrompt('Malicious user uploaded .exe disguised as report.');
    expect(classification.primaryDomain).toBe(DOMAINS.SECURITY_ACCESS);

    const plan = buildOrchestrationPlan(classification, 'Malicious user uploaded .exe disguised as report.');
    expect(plan.claudeCheckpoints.some((c) => c.id === 'CP3')).toBe(true);
    expect(plan.claudeCheckpoints.some((c) => c.id === 'CP6')).toBe(true);
    expect(plan.nvidiaNim.role).toContain('Security');
    expect(plan.deterministicProbes).toContain('scripts/probe-upload-guard.mjs');
  });

  it('classifies high-load lag to PERFORMANCE_SCALE squad', () => {
    const classification = classifyPrompt('Room board paging gets slow with 5000 rooms.');
    expect(classification.primaryDomain).toBe(DOMAINS.PERFORMANCE_SCALE);

    const plan = buildOrchestrationPlan(classification, 'Room board paging gets slow with 5000 rooms.');
    expect(plan.claudeCheckpoints.some((c) => c.id === 'CP2')).toBe(true);
    expect(plan.nvidiaNim.role).toContain('Performance');
    expect(plan.adversarialSwarm).not.toBeNull();
    expect(plan.deterministicProbes).toContain('scripts/probe-build-chunks.mjs');
  });

  it('fails safely to UNKNOWN_FAILSAFE squad for novel or unmatched tasks', () => {
    const classification = classifyPrompt('Quantum teleportation protocol integration for front desk keycards.');
    expect(classification.primaryDomain).toBe(DOMAINS.UNKNOWN_FAILSAFE);
    expect(classification.reclassificationRequired).toBe(true);

    const plan = buildOrchestrationPlan(classification, 'Quantum teleportation protocol integration for front desk keycards.');
    expect(plan.claudeCheckpoints.some((c) => c.id === 'CP1')).toBe(true);
    expect(plan.geminiSubagent).not.toBeNull();
    expect(plan.nvidiaNim.role).toContain('Guardian');
    expect(plan.deterministicProbes).toContain('scripts/audit-gate.mjs');
    expect(plan.deterministicProbes).toContain('scripts/verify-all.mjs');
    expect(plan.reclassificationRequired).toBe(true);
  });

  it('fails safely to UNKNOWN_FAILSAFE squad for low-confidence classifications', () => {
    const classification = classifyPrompt('something weird happened');
    expect(classification.primaryDomain).toBe(DOMAINS.UNKNOWN_FAILSAFE);
    expect(classification.reclassificationRequired).toBe(true);

    const plan = buildOrchestrationPlan(classification, 'something weird happened');
    expect(plan.primaryDomain).toBe(DOMAINS.UNKNOWN_FAILSAFE);
    expect(plan.claudeCheckpoints.some((c) => c.id === 'CP1')).toBe(true);
  });
});
