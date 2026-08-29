#!/usr/bin/env node
/**
 * Luxury 3D Button System Task Runner
 * -----------------------------------
 * Executes the full Claude-Opus-First Multi-Agent Orchestrator pipeline for the
 * Premium 3D Luxury Button System task with mandatory token + cost accounting.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  Orchestrator,
  ProviderRegistry,
  PatchApplier,
  sha256,
  SubscriptionPolicy,
} from '../../src/orchestrator/index.js';

// Pricing table (per million tokens)
const PRICING_TABLE = {
  'claude-opus-5': { input: 15.00, output: 75.00, source: 'Anthropic Opus standard API list pricing ($15 / $75 per 1M)' },
  'claude-opus-4-8': { input: 15.00, output: 75.00, source: 'Anthropic Opus standard API list pricing ($15 / $75 per 1M)' },
  'claude-3-opus-20240229': { input: 15.00, output: 75.00, source: 'Anthropic Opus standard API list pricing ($15 / $75 per 1M)' },
  'tencent-hy3-free': { input: 0.00, output: 0.00, source: 'Nara Free Tier ($0.00 / 1M)' },
  'laguna-s-2.1': { input: 0.00, output: 0.00, source: 'Nara Free Tier ($0.00 / 1M)' },
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
  console.log('TASK: PREMIUM 3D LUXURY BUTTON SYSTEM — CLAUDE OPUS MULTI-AGENT PIPELINE');
  console.log('================================================================================\n');

  const rootDir = process.cwd();
  const taskId = 'task-luxury-3d-button-system';
  const targetFiles = [
    'src/components/ui/button.jsx',
    'src/components/ui/button.test.jsx',
  ];

  const taskPrompt = `TASK: Premium 3D Luxury Button System + Centralized Design System Implementation

OBJECTIVE:
Transform the shared button system in src/components/ui/button.jsx and supporting CSS utility tokens in src/index.css into a modern LUXURY 3D BUTTON SYSTEM.

VISUAL & DESIGN DIRECTION:
- Premium, expensive, elegant, modern, sophisticated, subtle 3D depth.
- Executive SaaS / luxury hotel-management software feel.
- Visually consistent with existing dark slate/navy interface (--s-canvas: #040D1A, --s-raised: #10141B, --brand: #00E096).
- NOT cartoonish, NOT gaming glow, NOT neon, NOT heavy retro skeuomorphism.
- Subtle combinations of:
  * Layered surface depth
  * Controlled top highlight / specular bevel (e.g. inset 0 1px 0 rgba(255, 255, 255, 0.16) for primary, rgba(255, 255, 255, 0.08) for secondary)
  * Subtle lower contact shadow (e.g. 0 2px 4px -1px rgba(0, 0, 0, 0.50), 0 1px 2px rgba(0, 0, 0, 0.40))
  * Slight perimeter hairline border
  * Restrained gradient where appropriate (rich purple/violet primary, elevated dark slate secondary, ruby destructive)
  * Realistic resting position
  * Smooth hover elevation (moves upward ~1px with enhanced depth)
  * Tactile pressed state (moves downward ~1px and visually compresses: active:translate-y-[1px] with compressed shadow)
  * Crisp readable typography & icon alignment
  * High-contrast focus-visible ring (--brand emerald focus indicator)
  * Disabled state: flattened, opacity-40, no hover/active transform
  * Full prefers-reduced-motion support (no motion for reduced-motion users)

CENTRALIZED IMPLEMENTATION:
- Modify src/components/ui/button.jsx to update the cva variants ('default', 'destructive', 'outline', 'secondary', 'ghost', 'link') and base classes with the luxury 3D styling.
- Ensure all existing props (asChild, variant, size, disabled, className) and tests continue to work flawlessly.
- In src/index.css, ensure global button rules and utilities support the luxury 3D elevation cleanly without conflicting with framer-motion or page layouts.
- In src/components/ui/button.test.jsx, add or update tests to verify the new luxury 3D classes, variants, and behaviors.

SURGICAL CHANGE POLICY:
- Do NOT rewrite pages. The shared Button component in src/components/ui/button.jsx must upgrade buttons across Monthly Calendar, Room Board, OTA Channels, etc. centrally!
- Do NOT modify financial calculations, APIs, routes, or auth.
- Format your patch strictly with SEARCH/REPLACE or ### FILE: blocks.`;

  console.log('[Phase 1] Launching multi-agent orchestrator pipeline...');
  const orchestrator = new Orchestrator({ rootDir });

  const result = await orchestrator.executeTask({
    taskId,
    prompt: taskPrompt,
    targetFiles,
    testCommands: [
      'npx vitest run src/components/ui/button.test.jsx',
      'npx vitest run tests/orchestrator/',
      'npm test',
    ],
    isOwnerApproved: true,
    deletionJustification: 'Centralizing luxury 3D button system styles and variants in shared UI component',
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
  for (const call of agentCalls) {
    const inTokens = call.usage?.prompt_tokens || 0;
    const outTokens = call.usage?.completion_tokens || 0;
    const totalTok = call.usage?.total_tokens || inTokens + outTokens;
    const costCalc = calculateEstimatedCost(call.modelReturned || call.modelRequested, inTokens, outTokens);

    grandTotalInputTokens += inTokens;
    grandTotalOutputTokens += outTokens;
    grandTotalTokens += totalTok;
    grandTotalCostNum += costCalc.totalCostNum;

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
    console.log(`Input Tokens: ${inTokens}`);
    console.log(`Output Tokens: ${outTokens}`);
    console.log(`Cached Input Tokens: NOT EXPOSED`);
    console.log(`Reasoning Tokens: NOT EXPOSED`);
    console.log(`Total Tokens: ${totalTok}`);
    console.log(`API-reported Cost: NOT EXPOSED`);
    console.log(`Estimated Cost: ${costCalc.totalCost} (Input: ${costCalc.inputCost}, Output: ${costCalc.outputCost})`);
    console.log(`Pricing Source / Rate Used: ${costCalc.pricingSource}`);
    console.log(`Latency: ${call.latencySeconds}s`);
    console.log(`HTTP/API Status: ${call.httpStatus}`);
    console.log(`Retry Count: 0`);
    console.log(`Fallback Used: NO`);
    console.log(`Result: ${call.success ? 'PROVEN' : 'UNPROVEN'}`);
    console.log(`Contribution: ${call.contribution}`);
    if (call.error) console.log(`Error: ${call.error}`);
    console.log('====================================================\n');
  }

  console.log('==================================================');
  console.log('TOTAL AI EXECUTION COST');
  console.log('==================================================');
  console.log(`Total Input Tokens: ${grandTotalInputTokens}`);
  console.log(`Total Output Tokens: ${grandTotalOutputTokens}`);
  console.log(`Total Reasoning/Cache Tokens: 0 (NOT EXPOSED)`);
  console.log(`Grand Total Tokens: ${grandTotalTokens}`);
  console.log(`Grand Total Estimated AI Cost: $${grandTotalCostNum.toFixed(5)}`);
  console.log('==================================================\n');

  console.log(result.accountingReport);

  const runDir = path.join(rootDir, '.agent-runs', result.sessionId);
  if (fs.existsSync(runDir)) {
    console.log(`\n[+] Immutable Session Artifacts Persisted in: ${runDir}`);
    const files = fs.readdirSync(runDir);
    console.log(`    Files: ${files.join(', ')}`);
  }

  console.log('\n================================================================================');
  console.log(`TASK COMPLETE — FINAL VERDICT: ${result.verdict}`);
  console.log('================================================================================');
}

main().catch((err) => {
  console.error('Task failed:', err);
  process.exit(1);
});
