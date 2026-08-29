#!/usr/bin/env node
/**
 * Real End-to-End Acceptance Test (Section 25 & 30 Requirements)
 * --------------------------------------------------------------
 * Executes a REAL engineering task through the Active-Active High-Parallelism Swarm Orchestrator:
 * 1. Wave A: Multiple Claude Opus workers execute in parallel across TABITOKEN and GOROUTER.
 * 2. Wave B: Multi-disciplinary specialist reviewers (NARA diverse models) execute in parallel.
 * 3. Wave C: Authoritative Claude Opus synthesis evaluates peer critiques and authors definitive patch.
 * 4. Local Patch Applier mechanically applies the patch with SHA-256 hash verification.
 * 5. Deterministic Vitest test runs and verifies ground truth.
 * 6. Generates full 30-field per-agent receipts, provider usage summary, active-active proof, and concurrency proof.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  Orchestrator,
  SubscriptionPolicy,
} from '../../src/orchestrator/index.js';

async function main() {
  console.log('================================================================================');
  console.log('ACTIVE-ACTIVE HIGH-PARALLELISM FULL-AGENT SWARM ACCEPTANCE RUN');
  console.log('================================================================================\n');

  const rootDir = process.cwd();
  const taskId = 'task-active-active-swarm-acceptance-001';
  const targetModule = 'src/lib/swarmOrchestratorContract.js';

  console.log(`[Phase 1] Initializing Swarm Task "${taskId}" targeting [${targetModule}]...`);

  const taskPrompt = (
    `Author the complete production contract and invariant diagnostic module at ${targetModule}.\n` +
    `The module must export exactly:\n` +
    `1. export function getSwarmOrchestratorVersion() {\n` +
    `  return {\n` +
    `    version: '2.0.0',\n` +
    `    architecture: 'ACTIVE_ACTIVE_HIGH_PARALLELISM_SWARM',\n` +
    `    status: 'PRODUCTION_READY',\n` +
    `    timestamp: new Date().toISOString(),\n` +
    `  };\n` +
    `}\n\n` +
    `2. export function getActiveActiveProviderTopology() {\n` +
    `  return {\n` +
    `    primaryBrain: 'CLAUDE_OPUS',\n` +
    `    activeActiveProviders: ['TABITOKEN', 'GOROUTER'],\n` +
    `    mode: 'ACTIVE_ACTIVE_CONCURRENT',\n` +
    `    balancingPolicy: 'DYNAMIC_HEALTH_AND_WORKLOAD_BALANCED',\n` +
    `  };\n` +
    `}\n\n` +
    `3. export function verifySwarmInvariants() {\n` +
    `  return {\n` +
    `    codexQuotaUsage: '0% (CONSERVED)',\n` +
    `    antigravityAuthoring: 'BLOCKED (EXTERNAL API ONLY)',\n` +
    `    sha256VerificationRequired: true,\n` +
    `    protectedFilesLocked: true,\n` +
    `    qualityOverCost: true,\n` +
    `  };\n` +
    `}\n\n` +
    `4. export function getLiveWorkerCapabilities() {\n` +
    `  return {\n` +
    `    waves: [\n` +
    `      'WAVE_A_PARALLEL_CLAUDE_OPUS',\n` +
    `      'WAVE_B_SPECIALIST_REVIEWER_SWARM',\n` +
    `      'WAVE_C_AUTHORITATIVE_SYNTHESIS',\n` +
    `    ],\n` +
    `    activeProviders: ['TABITOKEN', 'GOROUTER', 'NARA', 'LOCAL_DETERMINISTIC'],\n` +
    `    concurrencyModel: 'ASYNC_PROMISE_ALL_BOUNDED',\n` +
    `  };\n` +
    `}\n\n` +
    `Format output explicitly as:\n` +
    `### FILE: ${targetModule}\n` +
    `\`\`\`javascript\n` +
    `<complete implementation code>\n` +
    `\`\`\``
  );

  console.log(`[Phase 2] Launching Orchestrator multi-wave swarm pipeline...`);
  const orchestrator = new Orchestrator({ rootDir });

  const result = await orchestrator.executeTask({
    taskId,
    prompt: taskPrompt,
    targetFiles: [targetModule],
    testCommands: ['npx vitest run tests/orchestrator/swarm_orchestrator_contract.test.js'],
    isOwnerApproved: true,
    deletionJustification: 'Authoring active-active swarm orchestrator contract module via Claude Opus',
  });

  console.log('\n================================================================================');
  console.log(`PIPELINE EXECUTION VERDICT: ${result.verdict}`);
  console.log('================================================================================');
  console.log(`Session ID: ${result.sessionId}`);
  console.log(`Duration: ${result.durationSeconds}s`);

  if (result.patch) {
    console.log(`\nPatch Authorship Evidence:`);
    console.log(`- Author Model Requested: ${result.finalPatchCall?.authoritativeModel || 'claude-opus-5'}`);
    console.log(`- Author Actual Provider: ${result.finalPatchCall?.actualProvider}`);
    console.log(`- Author Transport Provider: ${result.finalPatchCall?.transportProvider}`);
    console.log(`- Author Generation ID: ${result.finalPatchCall?.generationId}`);
    console.log(`- Patch SHA-256 Hash: ${result.patch.patchHash}`);
    console.log(`- Files Affected: ${result.patch.filesAffected?.join(', ') || 'None'}`);
    console.log(`- Lines Added: +${result.patch.linesAdded}`);
    console.log(`- Lines Deleted: -${result.patch.linesDeleted}`);
  }

  console.log('\n' + result.activeActiveBalanceProof);
  console.log('\n' + result.concurrencyProof);
  console.log('\n' + result.providerUsageSummary);
  console.log('\n' + result.swarmExecutionSummary);

  console.log('\nContribution Scorecard:');
  console.table(result.contributionScorecard);

  console.log('\n' + result.accountingReport);

  console.log('\n====================================================');
  console.log('INDIVIDUAL AGENT USAGE RECEIPTS');
  console.log('====================================================\n');
  console.log(result.receiptsText);

  // Check saved artifacts
  const runDir = path.join(rootDir, '.agent-runs', result.sessionId);
  if (fs.existsSync(runDir)) {
    console.log(`\n[+] Verifiable Session Artifacts Persisted in: ${runDir}`);
    const files = fs.readdirSync(runDir);
    console.log(`    Files: ${files.join(', ')}`);
  }

  console.log('\n================================================================================');
  console.log(`ACCEPTANCE RUN COMPLETED — VERDICT: ${result.verdict}`);
  console.log('================================================================================');
}

main().catch((err) => {
  console.error('Fatal acceptance run error:', err);
  process.exit(1);
});
