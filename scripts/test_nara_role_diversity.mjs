import fs from 'node:fs';
import path from 'node:path';
import { naraPool, NARA_ROLE_CHAINS } from '../src/lib/naraHelperPool.js';
import { classifyPrompt, buildOrchestrationPlan } from '../src/lib/autonomousOrchestrator.js';

console.log('='.repeat(75));
console.log('🚀 NARA ROLE-AWARE SPECIALIZATION & MULTI-MODEL DIVERSITY AUDIT');
console.log('='.repeat(75));

async function main() {
  // 1. Initialize Pool & Discover Models
  console.log('\n[1] Initializing Nara Helper Pool & Leaderboard...');
  await naraPool.initialize();
  const poolStatus = naraPool.getStatus();
  console.log(`    NARA-A Status: ${poolStatus['NARA-A'].status} (Discovered: ${poolStatus['NARA-A'].discoveredModels.length} models)`);

  // 2. Audit 10 Role-Aware Candidate Chains
  console.log('\n[2] Auditing 10 Role-Aware Candidate Chains:');
  const roleEntries = Object.entries(NARA_ROLE_CHAINS);
  for (const [role, chain] of roleEntries) {
    console.log(`    - ${role.padEnd(26)}: [1st: ${chain[0]} -> 2nd: ${chain[1]} -> 3rd: ${chain[2]} -> 4th: ${chain[3]}]`);
  }

  // 3. Execute 6-Agent Heterogeneous Heavy-Duty Squad Live
  console.log('\n[3] Executing 6-Agent Diverse Heavy Squad on Critical Problem...');
  const problem = 'Import missed some rows and multi-property ADR calculation drifted.';
  const synthesis = await naraPool.executeDiverseHeavySquad(problem, 'Boston Project Hotel Dashboard');

  console.log(`    Total Agents Executed: ${synthesis.totalAgentsExecuted}`);
  console.log(`    Successful Executions: ${synthesis.successCount}/${synthesis.totalAgentsExecuted}`);
  console.log(`    Distinct Models Participated: [${synthesis.modelsParticipated.join(', ')}]`);
  console.log('\n    Detailed Multi-Model Findings:');
  for (const f of synthesis.agentFindings) {
    console.log(`    • ${f.agent}:`);
    console.log(`      Model: ${f.modelReturned} | ID: ${f.generationId} | Latency: ${f.latencySeconds}s`);
    console.log(`      Finding: "${f.summary}"`);
  }

  // 4. Verify Automatic Orchestrator Squad Diversity on Short Prompts
  console.log('\n[4] Verifying Automatic Orchestrator Squad Diversity on Short Prompts:');
  
  // Financial Prompt
  const planFinancial = buildOrchestrationPlan(classifyPrompt('Revenue is wrong.'), 'Revenue is wrong.');
  console.log(`    "Revenue is wrong." -> Dispatched ${planFinancial.naraHelpers.length} Diverse Helpers:`);
  for (const h of planFinancial.naraHelpers) {
    console.log(`      • ${h.role} (Role: ${h.roleType}, Preferred: ${h.preferredModel})`);
  }

  // Import Prompt
  const planImport = buildOrchestrationPlan(classifyPrompt('Import missed some rows.'), 'Import missed some rows.');
  console.log(`    "Import missed some rows." -> Dispatched ${planImport.naraHelpers.length} Diverse Helpers:`);
  for (const h of planImport.naraHelpers) {
    console.log(`      • ${h.role} (Role: ${h.roleType}, Preferred: ${h.preferredModel})`);
  }

  // 5. Inspect Empirical Telemetry Leaderboard
  console.log('\n[5] Empirical Telemetry Leaderboard (Measured Boston Project Tasks):');
  const updatedStatus = naraPool.getStatus();
  for (const [model, stats] of Object.entries(updatedStatus.leaderboard)) {
    if (stats.tasksCompleted > 0) {
      console.log(`    Rank ${stats.rank} | ${model.padEnd(20)} | Completed: ${stats.tasksCompleted} | Avg Latency: ${stats.avgLatencySeconds}s | Tokens: ${stats.totalTokens}`);
    }
  }

  // Write Detailed Diversity Ledger
  const ledgerPath = path.resolve(process.cwd(), 'nara_role_diversity_ledger.json');
  fs.writeFileSync(
    ledgerPath,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        roleChains: NARA_ROLE_CHAINS,
        synthesis,
        leaderboard: updatedStatus.leaderboard,
        ledger: naraPool.ledger,
      },
      null,
      2
    ),
    'utf8'
  );

  console.log('\n' + '='.repeat(75));
  console.log('🏁 NARA ROLE DIVERSITY & ANTI-MONOCULTURE AUDIT COMPLETE');
  console.log(`✓ Ledger Saved to: ${ledgerPath}`);
  console.log('='.repeat(75));
}

main().catch((err) => {
  console.error('Fatal error in role diversity audit:', err);
  process.exit(1);
});
