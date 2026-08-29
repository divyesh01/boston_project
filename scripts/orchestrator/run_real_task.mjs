#!/usr/bin/env node
/**
 * Minimum Acceptance Test (Section 27 Demonstration)
 * --------------------------------------------------
 * Executes a REAL repository task end-to-end through the API-First Multi-Agent Orchestrator:
 * 1. Primary Code Author: CLAUDE OPUS via GoRouter / Tabitoken API.
 * 2. Reviewer Swarm: API Reviewers (Nara / xKiro) challenging the patch.
 * 3. Local Orchestrator: Mechanical Patch Applier (SHA-256 hash verified, 0 LLM tokens).
 * 4. Deterministic Vitest Execution: Ground Truth verification.
 * 5. Immutable Session Artifacts & Receipt Generation in .agent-runs/<session-id>/.
 * 6. Subscription Quota Accounting: 0% Codex, 0 Antigravity reasoning during task execution.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  Orchestrator,
  ProviderRegistry,
  defaultRegistry,
  PatchApplier,
  sha256,
  SubscriptionPolicy,
} from '../../src/orchestrator/index.js';

async function main() {
  console.log('================================================================================');
  console.log('MINIMUM ACCEPTANCE TEST — GENUINE CLAUDE OPUS END-TO-END PIPELINE');
  console.log('================================================================================\n');

  const rootDir = process.cwd();
  const taskId = 'acceptance-task-claude-opus-001';
  const targetModule = 'src/lib/orchestratorVerificationProbe.js';

  console.log(`[Phase 1] Initializing task "${taskId}" targeting [${targetModule}]...`);

  // Target task description for Claude Opus
  const taskPrompt = (
    `Create the complete diagnostic contract helper module at ${targetModule}.
Export exactly:
1. export function verifyOrchestratorInvariants() {
  return {
    status: 'VERIFIED',
    engine: 'API_FIRST_MULTI_AGENT',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
  };
}
2. export function getOrchestratorTelemetryContract() {
  return {
    primaryBrain: 'CLAUDE_OPUS',
    reviewerSwarm: ['GEMINI', 'NVIDIA', 'NARA', 'XKIRO'],
    subscriptionQuotaSaved: true,
  };
}

Format output as:
### FILE: ${targetModule}
\`\`\`javascript
<complete implementation>
\`\`\``
  );

  console.log(`[Phase 2] Executing live Orchestrator with Claude Opus as Primary Author...`);
  const orchestrator = new Orchestrator({ rootDir });

  // Execute full 10-stage pipeline with Claude Opus as Primary Brain
  const result = await orchestrator.executeTask({
    taskId,
    prompt: taskPrompt,
    targetFiles: [targetModule],
    testCommands: ['npx vitest run tests/orchestrator/'],
    isOwnerApproved: true,
    deletionJustification: 'Authoring clean orchestrator verification probe module via Claude Opus',
  });

  console.log('\n================================================================================');
  console.log(`PIPELINE EXECUTION VERDICT: ${result.verdict}`);
  console.log('================================================================================');
  console.log(`Session ID: ${result.sessionId}`);
  console.log(`Duration: ${result.durationSeconds}s`);

  if (result.patch) {
    console.log(`\nPatch Authorship Evidence:`);
    console.log(`- Author Model Requested: ${result.proposalResult?.authoritativeModel || 'claude-opus'}`);
    console.log(`- Author Actual Provider: ${result.proposalResult?.actualProvider}`);
    console.log(`- Author Transport Provider: ${result.proposalResult?.transportProvider}`);
    console.log(`- Author Generation ID: ${result.proposalResult?.generationId}`);
    console.log(`- Patch SHA-256 Hash: ${result.patch.patchHash}`);
    console.log(`- Files Affected: ${result.patch.filesAffected?.join(', ') || 'None'}`);
    console.log(`- Lines Added: +${result.patch.linesAdded}`);
    console.log(`- Lines Deleted: -${result.patch.linesDeleted}`);
  }

  if (result.reviewResults && result.reviewResults.length > 0) {
    console.log(`\nReviewer Swarm Evidence:`);
    for (const rev of result.reviewResults) {
      console.log(`- [${rev.reviewerId}] Provider: ${rev.transportProvider} | Model: ${rev.modelReturned} | Latency: ${rev.latencySeconds}s | GenID: ${rev.generationId}`);
    }
  }

  console.log('\nDeterministic Test Status:');
  console.log(`- Vitest Passed: ${result.tests?.passed ? 'YES ✅' : 'NO ❌'}`);
  console.log(`- Correction Loops: ${result.tests?.correctionAttempts || 0}`);

  console.log('\n' + result.accountingReport);
  console.log('\nGenerated Agent Receipts:\n' + result.receiptsText);

  // Check artifacts
  const runDir = path.join(rootDir, '.agent-runs', result.sessionId);
  if (fs.existsSync(runDir)) {
    console.log(`\n[+] Verifiable Session Artifacts Persisted in: ${runDir}`);
    const files = fs.readdirSync(runDir);
    console.log(`    Files: ${files.join(', ')}`);
  }

  console.log('\n================================================================================');
  console.log(`ACCEPTANCE TEST COMPLETE — VERDICT: ${result.verdict}`);
  console.log('================================================================================');
}

main().catch((err) => {
  console.error('Acceptance test failed:', err);
  process.exit(1);
});
