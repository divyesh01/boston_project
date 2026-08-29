#!/usr/bin/env node
/**
 * Orchestrator CLI Entrypoint
 * ----------------------------
 * Launches tasks through the API-First Active-Active Multi-Agent Swarm Orchestrator.
 * Usage:
 *   node scripts/orchestrator/cli.mjs "Task description" [--target src/path/file.js]
 */

import { Orchestrator } from '../../src/orchestrator/index.js';

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
Usage: node scripts/orchestrator/cli.mjs "<prompt>" [options]

Options:
  --target <file>       Target file(s) to include in deterministic context (repeatable)
  --test <command>      Test command to execute for verification (default: "npx vitest run tests/orchestrator/")
  --no-reviewers        Skip parallel reviewer swarm
  --approved            Grant owner approval for large edits (>50 lines)
    `);
    process.exit(0);
  }

  const targetFiles = [];
  let prompt = '';
  let testCommands = [];
  let isOwnerApproved = false;
  let skipReviewers = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--target' && i + 1 < args.length) {
      targetFiles.push(args[++i]);
    } else if (args[i] === '--test' && i + 1 < args.length) {
      testCommands.push(args[++i]);
    } else if (args[i] === '--approved') {
      isOwnerApproved = true;
    } else if (args[i] === '--no-reviewers') {
      skipReviewers = true;
    } else if (!prompt) {
      prompt = args[i];
    }
  }

  if (!prompt) {
    console.error('Error: Prompt is required.');
    process.exit(1);
  }

  if (testCommands.length === 0) {
    testCommands = ['npx vitest run tests/orchestrator/'];
  }

  console.log('================================================================================');
  console.log('ACTIVE-ACTIVE HIGH-PARALLELISM MULTI-AGENT SWARM ORCHESTRATOR');
  console.log('================================================================================');
  console.log(`Task: ${prompt}`);
  console.log(`Target Files: ${targetFiles.join(', ') || 'Auto-scan'}`);
  console.log(`Verification Commands: ${testCommands.join(', ')}\n`);

  const orchestrator = new Orchestrator();
  const result = await orchestrator.executeTask({
    prompt,
    targetFiles,
    testCommands,
    isOwnerApproved,
    skipReviewers,
  });

  console.log('\n================================================================================');
  console.log(`TASK RESULT: ${result.verdict}`);
  console.log('================================================================================');
  console.log(`Session ID: ${result.sessionId}`);
  console.log(`Duration: ${result.durationSeconds}s`);
  if (result.patch) {
    console.log(`Files Affected: ${result.patch.filesAffected?.join(', ') || 'None'}`);
    console.log(`Lines Added: +${result.patch.linesAdded} / Lines Deleted: -${result.patch.linesDeleted}`);
    console.log(`Patch SHA-256: ${result.patch.patchHash}`);
  }

  console.log('\n' + result.activeActiveBalanceProof);
  console.log('\n' + result.concurrencyProof);
  console.log('\n' + result.providerUsageSummary);
  console.log('\n' + result.swarmExecutionSummary);

  console.log('\nContribution Scorecard:');
  console.table(result.contributionScorecard);

  console.log('\n' + result.accountingReport);
  console.log('\nAgent Receipts:\n' + result.receiptsText);

  if (result.verdict !== 'PASS') {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal CLI Error:', err);
  process.exit(1);
});
