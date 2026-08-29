/**
 * Live Instrumented Multi-Agent Workflow Runner
 * ----------------------------------------------
 * Executes live multi-agent calls directly through the production code:
 * - universalModelRouter.execute()
 * - dualPillarSolver.executeDualPillar()
 * - naraHelperPool.executeHelperTask()
 * - autonomousOrchestrator.executeAutonomousWorkflow()
 *
 * Each execution emits real spans into Arize Phoenix (http://localhost:6006).
 */

import { universalRouter } from '../src/lib/universalModelRouter.js';
import { dualPillarSolver } from '../src/lib/dualPillarSolver.js';
import { naraPool } from '../src/lib/naraHelperPool.js';
import { executeAutonomousWorkflow } from '../src/lib/autonomousOrchestrator.js';
import { phoenixTracer } from '../src/lib/phoenixTracer.js';

async function main() {
  console.log('=== Executing Real Instrumented Multi-Agent Workflow ===\n');

  const prompt = process.argv[2] || 'Revenue is wrong.';
  console.log(`[1] Executing live Autonomous Workflow for prompt: "${prompt}"...`);
  
  const result = await executeAutonomousWorkflow(prompt);
  console.log(`[+] Workflow execution complete. Domain: ${result.classification.primaryDomain}`);
  console.log(`[+] Dual-Pillar Solvers Executed:`);
  console.log(`    - Gemini Solution A status: ${result.dualPillarResults.solutionA.status} (latency: ${result.dualPillarResults.solutionA.latencySeconds}s)`);
  console.log(`    - Claude Solution B status: ${result.dualPillarResults.solutionB.status} (latency: ${result.dualPillarResults.solutionB.latencySeconds}s)`);
  console.log(`    - Prompt Isolation: ${result.dualPillarResults.independence.promptIsolationDesign}`);
  console.log(`    - Dynamic Synthesis: ${result.dualPillarResults.synthesis.reconciliationStatus}`);

  console.log(`\n[2] Executing live Nara Parallel Helper Pool (3 workers)...`);
  const naraTasks = [
    { name: 'RoomBoard AST Explorer', roleType: 'REPO_ANALYSIS', prompt: 'Analyze RoomBoard.jsx room ID scoping and state boundaries.' },
    { name: 'Financial Invariant Auditor', roleType: 'FINANCIAL_CALCULATION', prompt: 'Verify integer cents and ADR/RevPAR formulas.' },
    { name: 'Multi-Tenant Boundary Fuzzer', roleType: 'ADVERSARIAL_TESTING', prompt: 'Generate 50 adversarial multi-property room IDs.' },
  ];
  const naraResults = await naraPool.executeParallelHelpers(naraTasks, 3);
  console.log(`[+] Nara Helpers Completed: ${naraResults.length} tasks executed.`);
  for (const r of naraResults) {
    console.log(`    - Task "${r.entry.taskName}": ${r.entry.status} (model: ${r.entry.modelReturned || 'none'}, latency: ${r.entry.latencySeconds}s)`);
  }

  console.log(`\n[3] Executing live Universal Router Call...`);
  const routerResult = await universalRouter.execute({
    roleType: 'FAST_CODE_REVIEW',
    prompt: 'Review uploadGuard.js binary header check for security compliance.',
  });
  console.log(`[+] Universal Router Call: success=${routerResult.success}, model=${routerResult.model}, latency=${routerResult.latencySeconds}s`);

  // Wait 1.5s for async spans to flush to Phoenix
  await new Promise((r) => setTimeout(r, 1500));
  console.log(`\n[+] All live spans recorded and exported to Arize Phoenix!`);
}

main().catch((err) => {
  console.error('Execution failed:', err);
  process.exit(1);
});
