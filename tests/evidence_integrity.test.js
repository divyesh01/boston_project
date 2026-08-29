import { describe, it, expect } from 'vitest';
import { DualPillarSolver } from '../src/lib/dualPillarSolver.js';
import { generateForensicReport } from '../src/lib/sessionForensicReport.js';

describe('Forensic Hardening & Evidence-Truth Invariant Suite', () => {
  // Mutation Test 1: No testSuiteResults but report is rendered -> must say NOT_MEASURED, not historical numbers
  it('Mutation 1: Renders NOT_MEASURED when testSuiteResults is omitted', () => {
    const report = generateForensicReport({
      userPrompt: 'Test Prompt',
      testSuiteResults: null,
    });

    expect(report.reportMarkdown).toContain('Vitest (NOT_MEASURED)');
    expect(report.reportMarkdown).toContain('Probes (NOT_MEASURED)');
    expect(report.reportMarkdown).toContain('TypeScript (NOT_MEASURED)');
    expect(report.reportMarkdown).toContain('ESLint (NOT_MEASURED)');
    expect(report.reportMarkdown).not.toContain('377 Vitest');
    expect(report.reportMarkdown).not.toContain('384 Vitest');
  });

  // Mutation Test 2: No sentinel result -> must say NOT_MEASURED, never default to PASS
  it('Mutation 2: Renders NOT_MEASURED when productionAudit is omitted', () => {
    const report = generateForensicReport({
      userPrompt: 'Test Prompt',
      productionAudit: null,
    });

    expect(report.reportMarkdown).toContain('Production Sentinel Status:** `NOT_MEASURED`');
    expect(report.reportMarkdown).toContain('Live HTML Mount:** `NOT_MEASURED`');
    expect(report.reportMarkdown).toContain('Live Bundle Size:** `NOT_MEASURED`');
    expect(report.reportMarkdown).not.toContain('Production Sentinel Status:** `PASS`');
  });

  // Mutation Test 3: Caller omits status -> defaults to UNPROVEN (or calculated status)
  it('Mutation 3: Defaults status to UNPROVEN when caller omits status and no tests exist', () => {
    const report = generateForensicReport({
      userPrompt: 'Test Prompt',
    });

    expect(report.finalStatus).toBe('UNPROVEN');
    expect(report.reportMarkdown).toContain('**Final Status:** `UNPROVEN`');
  });

  // Mutation Test 4: Caller sends PASS while mandatory component failed or unproven -> downgrades/rejects
  it('Mutation 4: Downgrades caller PASS to PASS (DETERMINISTIC_GATES_VERIFIED_AI_UNPROVEN) when AI is unproven', () => {
    const report = generateForensicReport({
      userPrompt: 'Test Prompt',
      status: 'PASS',
      testSuiteResults: {
        vitest: { passed: 384, failed: 0, testFiles: 47 },
      },
      dualPillarResults: {
        solutionA: { success: false, status: 'HTTP_402' },
        solutionB: { success: false, status: 'HTTP_402' },
      },
    });

    expect(report.finalStatus).toBe('PASS (DETERMINISTIC_GATES_VERIFIED_AI_UNPROVEN)');
    expect(report.reportMarkdown).toContain('PASS (DETERMINISTIC_GATES_VERIFIED_AI_UNPROVEN)');
  });

  // Mutation Test 5 & 7: Synthetic or unverified generation ID without successful invocation record -> UNPROVEN
  it('Mutation 5 & 7: Debate agent without authentic invocation record becomes UNPROVEN', () => {
    const report = generateForensicReport({
      userPrompt: 'Debate Test',
      debateResults: {
        round1_independentAnalysis: [
          {
            agentName: 'Debate Prosecutor',
            roleType: 'Root Cause Prosecutor',
            modelReturned: 'laguna-s-2.1',
            generationId: 'fake-gen-id-12345',
            analysis: 'Some analysis text',
            success: false,
          },
        ],
      },
      routerLedger: [], // No matching ledger entry
    });

    const prosecutor = report.participatingAgents.find((a) => a.agent === 'Debate Prosecutor');
    expect(prosecutor).toBeDefined();
    expect(prosecutor.status).toBe('UNPROVEN');
    expect(prosecutor.actualContribution).toContain('NO VERIFIED CONTRIBUTION');
  });

  // Mutation Test 6: Stale previous-session generation ID without matching routerLedger entry -> UNPROVEN
  it('Mutation 6: Stale generation ID from old session is rejected as UNPROVEN', () => {
    const report = generateForensicReport({
      userPrompt: 'Stale ID Test',
      debateResults: {
        round1_independentAnalysis: [
          {
            agentName: 'Debate Agent 1',
            roleType: 'Prosecutor',
            modelReturned: 'laguna-s-2.1',
            generationId: 'stale-chatcmpl-old-session',
            success: false,
          },
        ],
      },
      routerLedger: [],
    });

    const agent = report.participatingAgents.find((a) => a.agent === 'Debate Agent 1');
    expect(agent.status).toBe('UNPROVEN');
  });

  // Mutation Test 8: Mismatched provider/model between debate result and router ledger -> UNPROVEN
  it('Mutation 8: Mismatched model between debate result and ledger fails provenance verification', () => {
    const report = generateForensicReport({
      userPrompt: 'Mismatch Test',
      debateResults: {
        round1_independentAnalysis: [
          {
            agentName: 'Debate Agent 2',
            roleType: 'Architect',
            modelReturned: 'mistral-medium-3-5',
            generationId: 'gen-mismatch-1',
            success: false,
          },
        ],
      },
      routerLedger: [
        {
          generationId: 'gen-mismatch-1',
          model: 'tencent-hy3-free', // Mismatched!
          success: true,
        },
      ],
    });

    const agent = report.participatingAgents.find((a) => a.agent === 'Debate Agent 2');
    expect(agent.status).toBe('UNPROVEN');
  });

  // Mutation Test 9: Synthesis layer derives findings dynamically from model text (no hardcoded canned text)
  it('Mutation 9: Synthesis dynamically extracts from actual model text without canned findings', () => {
    const sampleA = {
      success: true,
      modelReturned: 'google/gemini-2.5-pro',
      generationId: 'gen-gemini-live-test',
      solutionText: 'The revenue discrepancy is caused by missing folio night-audit reconciliations. We must enforce atomic daily audits.',
    };

    const sampleB = {
      success: true,
      modelReturned: 'anthropic/claude-sonnet-5',
      generationId: 'gen-claude-live-test',
      solutionText: 'Discovered cross-property room drift in ledger. Require composite key indexing and integer cents arithmetic.',
    };

    const solver = new DualPillarSolver();
    const synthesis = solver.synthesizeDualSolutions(sampleA, sampleB, 'Revenue is wrong.');

    expect(synthesis.dualPillarSynthesisStatus).toBe('DUAL_PILLAR_SYNTHESIS_PROVEN');
    expect(synthesis.commonFindings.length).toBeGreaterThan(0);
    expect(synthesis.commonFindings[0].evidenceFromA).toContain('revenue discrepancy');
    expect(synthesis.commonFindings[0].evidenceFromB).toContain('cross-property');
    expect(synthesis.commonFindings[0].evidenceIds).toContain('gen-gemini-live-test');
    expect(synthesis.commonFindings[0].evidenceIds).toContain('gen-claude-live-test');
  });

  // Mutation Test 10: Unexecuted settling tests are listed under Recommended, NOT Executed & Proven
  it('Mutation 10: Unexecuted settling tests appear under Recommended, NOT Executed & Proven', () => {
    const report = generateForensicReport({
      userPrompt: 'Test Settling Tests',
      dualPillarResults: {
        synthesis: {
          settlingTestsRecommended: ['scripts/probe-property-isolation.mjs'],
          settlingTestsExecuted: [], // None executed
        },
      },
    });

    expect(report.reportMarkdown).toContain('Settling Tests Recommended:** `scripts/probe-property-isolation.mjs`');
    expect(report.reportMarkdown).toContain('Settling Tests Executed & Proven:** `NONE_EXECUTED_IN_THIS_SESSION`');
  });
});
