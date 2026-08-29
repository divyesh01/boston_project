import { describe, it, expect } from 'vitest';
import { ExecutionLedger } from '../../src/orchestrator/core/ExecutionLedger.js';

describe('Executive Dashboard Formatting Suite', () => {
  it('formats Comparison Box, Contribution Box, and Run Summary Box with clean alignment', () => {
    const ledger = new ExecutionLedger('test-session-box-format');

    ledger.recordCall({
      agentNumber: 1,
      role: 'CLAUDE_OPUS_REPO_ARCHITECT',
      transportProvider: 'TABITOKEN',
      modelRequested: 'claude-opus-5',
      modelReturned: 'claude-opus-5',
      inputTokens: 14761,
      outputTokens: 3449,
      latencySeconds: 66.3,
      success: true,
      contribution: 'Found repository architecture and root implementation path',
      findingUsed: 'YES',
    });

    ledger.recordCall({
      agentNumber: 2,
      role: 'CLAUDE_OPUS_INDEPENDENT_ARCHITECT',
      transportProvider: 'GOROUTER',
      modelRequested: 'claude-opus-5',
      modelReturned: 'claude-opus-5',
      inputTokens: 15755,
      outputTokens: 3621,
      latencySeconds: 76.4,
      success: true,
      contribution: 'Independent architecture verification',
      findingUsed: 'YES',
    });

    ledger.recordCall({
      agentNumber: 5,
      role: 'ADVERSARIAL_CRITIC',
      transportProvider: 'NARA',
      modelRequested: 'tencent-hy3-free',
      modelReturned: 'tencent-hy3-free',
      inputTokens: 12102,
      outputTokens: 500,
      latencySeconds: 16.7,
      success: true,
      contribution: 'Found edge cases',
      findingUsed: 'YES',
    });

    ledger.recordCall({
      agentNumber: 10,
      role: 'CLAUDE_OPUS_AUTHORITATIVE_SYNTHESIS',
      transportProvider: 'TABITOKEN',
      modelRequested: 'claude-opus-5',
      modelReturned: 'claude-opus-5',
      inputTokens: 38947,
      outputTokens: 3462,
      latencySeconds: 60.5,
      success: true,
      contribution: 'Combined everything and authored final patch',
      findingUsed: 'FINAL',
    });

    const comparisonBox = ledger.getComparisonBox();
    expect(comparisonBox).toContain('MULTI-AGENT COMPARISON');
    expect(comparisonBox).toContain('Repo Architect');
    expect(comparisonBox).toContain('Tabitoken');
    expect(comparisonBox).toContain('GoRouter');
    expect(comparisonBox).toContain('✅ PASS');

    const contribBox = ledger.getContributionBox();
    expect(contribBox).toContain('MAIN CONTRIBUTION');
    expect(contribBox).toContain('Found repository architecture and root implementation path');
    expect(contribBox).toContain('✅ YES');
    expect(contribBox).toContain('✅ FINAL');

    const summaryBox = ledger.getRunSummaryBox({
      testsText: '504 / 504 PASS ✅',
      finalStatus: 'PASS ✅',
      waveABalance: '2 Tabitoken + 2 GoRouter ✅',
    });
    expect(summaryBox).toContain('RUN SUMMARY');
    expect(summaryBox).toContain('Tabitoken Opus workers:');
    expect(summaryBox).toContain('GoRouter Opus workers:');
    expect(summaryBox).toContain('Active-Active Wave A:');
    expect(summaryBox).toContain('Estimated API cost:');
    expect(summaryBox).toContain('PASS ✅');

    const fullDashboard = ledger.getExecutiveDashboard({
      testsText: '504 / 504 PASS ✅',
      finalStatus: 'PASS ✅',
      waveABalance: '2 Tabitoken + 2 GoRouter ✅',
    });
    expect(fullDashboard).toContain('MULTI-AGENT COMPARISON');
    expect(fullDashboard).toContain('MAIN CONTRIBUTION');
    expect(fullDashboard).toContain('RUN SUMMARY');
  });
});
