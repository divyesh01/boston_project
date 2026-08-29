#!/usr/bin/env node
/**
 * Active-Active Acceptance Test Runner
 * ------------------------------------
 * Executes a fresh end-to-end multi-agent acceptance task with enforced 2 Tabitoken + 2 GoRouter
 * active-active distribution, zero manual application code repair by Antigravity, and full telemetry.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  Orchestrator,
  defaultActiveRouter,
} from '../../src/orchestrator/index.js';

// Pricing table (per million tokens)
const PRICING_TABLE = {
  'claude-opus-5': { input: 15.00, output: 75.00, source: 'Anthropic Opus standard API list pricing ($15 / $75 per 1M)' },
  'claude-opus-4-8': { input: 15.00, output: 75.00, source: 'Anthropic Opus standard API list pricing ($15 / $75 per 1M)' },
  'claude-3-opus-20240229': { input: 15.00, output: 75.00, source: 'Anthropic Opus standard API list pricing ($15 / $75 per 1M)' },
  'tencent-hy3-free': { input: 0.00, output: 0.00, source: 'Nara Free Tier ($0.00 / 1M)' },
  'laguna-s-2.1': { input: 0.00, output: 0.00, source: 'Nara Free Tier ($0.00 / 1M)' },
  'agnes-2.5-flash': { input: 0.00, output: 0.00, source: 'Nara Free Tier ($0.00 / 1M)' },
  'stepfun-3.7-flash': { input: 0.00, output: 0.00, source: 'Nara Free Tier ($0.00 / 1M)' },
  'mistralai/codestral-2508': { input: 0.30, output: 0.90, source: 'Mistral Codestral API pricing ($0.30 / $0.90 per 1M)' },
  'google/gemini-2.5-flash': { input: 0.075, output: 0.30, source: 'Google AI Studio pricing ($0.075 / $0.30 per 1M)' },
  'meta/llama-3.1-70b-instruct': { input: 0.35, output: 0.40, source: 'NVIDIA NIM pricing ($0.35 / $0.40 per 1M)' },
};

function calculateEstimatedCost(model, inputTokens, outputTokens) {
  const normModel = String(model || '').toLowerCase();
  let pricing = null;
  for (const [k, v] of Object.entries(PRICING_TABLE)) {
    if (normModel.includes(k.toLowerCase()) || k.toLowerCase().includes(normModel)) {
      pricing = v;
      break;
    }
  }
  if (!pricing) {
    if (normModel.includes('opus')) {
      pricing = PRICING_TABLE['claude-opus-5'];
    } else {
      pricing = { input: 1.00, output: 2.00, source: 'Default estimated rate ($1.00 / $2.00 per 1M)' };
    }
  }
  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  const totalCost = inputCost + outputCost;
  return {
    inputCost: `$${inputCost.toFixed(5)}`,
    outputCost: `$${outputCost.toFixed(5)}`,
    totalCost: `$${totalCost.toFixed(5)}`,
    totalCostNum: totalCost,
    pricingSource: pricing.source,
  };
}

async function main() {
  console.log('================================================================================');
  console.log('ACTIVE-ACTIVE ACCEPTANCE TASK: DUAL-CHANNEL CLAUDE OPUS MULTI-AGENT PIPELINE');
  console.log('================================================================================\n');

  // Reset router states cleanly for fresh acceptance run
  defaultActiveRouter.resetMetrics();

  const rootDir = process.cwd();
  const taskId = 'acceptance-task-active-active-002';
  const targetFiles = [
    'src/lib/orchestratorVerificationProbe.js',
    'tests/orchestrator/orchestrator_verification_probe.test.js',
  ];

  const taskPrompt = `TASK: Extend Active-Active Routing Telemetry Invariants & Probe Contract

OBJECTIVE:
1. Update src/lib/orchestratorVerificationProbe.js to export an enhanced diagnostic inspector:
   - export function inspectActiveActiveRoutingHealth() returning:
     {
       status: 'ACTIVE_ACTIVE_OPTIMAL',
       primaryChannels: ['TABITOKEN', 'GOROUTER'],
       balancingPolicy: 'DYNAMIC_LATENCY_AWARE',
       workerAllocation: '2_TABITOKEN_2_GOROUTER',
       circuitBreaker: 'ENABLED',
       timestamp: <ISO string>,
     }
2. Ensure verifyOrchestratorInvariants() and getOrchestratorTelemetryContract() remain intact and compliant.
3. Update tests/orchestrator/orchestrator_verification_probe.test.js to include full unit test coverage for inspectActiveActiveRoutingHealth().

SURGICAL CHANGE INSTRUCTIONS:
- Format your patch strictly with standard file blocks (### FILE: <path> with full replacement code or SEARCH/REPLACE blocks).
- Do not modify unrelated files.`;

  console.log('[Phase 1] Launching multi-agent orchestrator pipeline with 4 Wave-A Opus workers...');
  const orchestrator = new Orchestrator({ rootDir });

  const result = await orchestrator.executeTask({
    taskId,
    prompt: taskPrompt,
    targetFiles,
    testCommands: [
      'npx vitest run tests/orchestrator/orchestrator_verification_probe.test.js',
      'npx vitest run tests/orchestrator/',
      'npm test',
    ],
    isOwnerApproved: true,
    deletionJustification: 'Extending orchestrator verification probe with active-active routing health inspector and test suite',
  });

  console.log('\n================================================================================');
  console.log(`PIPELINE EXECUTION VERDICT: ${result.verdict}`);
  console.log('================================================================================');
  console.log(`Session ID: ${result.sessionId}`);
  console.log(`Duration: ${result.durationSeconds}s`);

  // Build Comprehensive Cost & Token Accounting Breakdown
  console.log('\n==================================================');
  console.log('AGENT USAGE RECEIPTS & COST ACCOUNTING');
  console.log('==================================================');

  let grandTotalInputTokens = 0;
  let grandTotalOutputTokens = 0;
  let grandTotalTokens = 0;
  let grandTotalCostNum = 0.0;

  const agentCalls = result.ledger?.calls || [];
  const activeActiveDistribution = { TABITOKEN: 0, GOROUTER: 0, NARA: 0, OTHER: 0 };

  for (const call of agentCalls) {
    const inTokens = call.usage?.prompt_tokens || 0;
    const outTokens = call.usage?.completion_tokens || 0;
    const totalTok = call.usage?.total_tokens || inTokens + outTokens;
    const costCalc = calculateEstimatedCost(call.modelReturned || call.modelRequested, inTokens, outTokens);

    grandTotalInputTokens += inTokens;
    grandTotalOutputTokens += outTokens;
    grandTotalTokens += totalTok;
    grandTotalCostNum += costCalc.totalCostNum;

    if (call.success) {
      const tp = String(call.transportProvider || '').toUpperCase();
      if (tp.includes('TABITOKEN')) activeActiveDistribution.TABITOKEN++;
      else if (tp.includes('GOROUTER')) activeActiveDistribution.GOROUTER++;
      else if (tp.includes('NARA')) activeActiveDistribution.NARA++;
      else activeActiveDistribution.OTHER++;
    }

    console.log('====================================================');
    console.log('AGENT USAGE RECEIPT');
    console.log('====================================================');
    console.log(`Agent: ${call.role}`);
    console.log(`Role: ${call.role}`);
    console.log(`Task ID: ${call.taskId}`);
    console.log(`Transport Provider: ${call.transportProvider}`);
    console.log(`Actual Provider: ${call.actualProvider}`);
    console.log(`Requested Model: ${call.modelRequested}`);
    console.log(`Returned Model: ${call.modelReturned}`);
    console.log(`Generation / Request ID: ${call.generationId || 'NONE'}`);
    console.log(`Dispatch: ${call.dispatchTimestamp || 'N/A'}`);
    console.log(`Start: ${call.startTimestamp || 'N/A'}`);
    console.log(`Finish: ${call.completionTimestamp || 'N/A'}`);
    console.log(`Input Tokens: ${inTokens}`);
    console.log(`Output Tokens: ${outTokens}`);
    console.log(`Total Tokens: ${totalTok}`);
    console.log(`Estimated Cost: ${costCalc.totalCost} (Input: ${costCalc.inputCost}, Output: ${costCalc.outputCost})`);
    console.log(`Pricing Source: ${costCalc.pricingSource}`);
    console.log(`Latency: ${call.latencySeconds}s`);
    console.log(`HTTP/API Status: ${call.httpStatus}`);
    console.log(`Result: ${call.success ? 'PROVEN' : 'UNPROVEN'}`);
    console.log(`Contribution: ${call.contribution}`);
    if (call.error) console.log(`Error: ${call.error}`);
    console.log('====================================================\n');
  }

  console.log('==================================================');
  console.log('ACTIVE-ACTIVE LOAD DISTRIBUTION VERIFICATION');
  console.log('==================================================');
  console.log(`Tabitoken Successful Calls: ${activeActiveDistribution.TABITOKEN}`);
  console.log(`GoRouter Successful Calls:  ${activeActiveDistribution.GOROUTER}`);
  console.log(`Nara Swarm Successful Calls: ${activeActiveDistribution.NARA}`);
  console.log('==================================================\n');

  console.log('==================================================');
  console.log('TOTAL AI EXECUTION COST');
  console.log('==================================================');
  console.log(`Total Input Tokens: ${grandTotalInputTokens}`);
  console.log(`Total Output Tokens: ${grandTotalOutputTokens}`);
  console.log(`Grand Total Tokens: ${grandTotalTokens}`);
  console.log(`Grand Total Estimated AI Cost: $${grandTotalCostNum.toFixed(5)}`);
  console.log('==================================================\n');

  console.log(result.accountingReport);

  const runDir = path.join(rootDir, '.agent-runs', result.sessionId);
  if (fs.existsSync(runDir)) {
    console.log(`\n[+] Verifiable Session Artifacts Persisted in: ${runDir}`);
    const files = fs.readdirSync(runDir);
    console.log(`    Files: ${files.join(', ')}`);
  }

  console.log('\n================================================================================');
  console.log(`ACCEPTANCE TEST COMPLETE — FINAL VERDICT: ${result.verdict}`);
  console.log('================================================================================');
}

main().catch((err) => {
  console.error('Acceptance task failed:', err);
  process.exit(1);
});
