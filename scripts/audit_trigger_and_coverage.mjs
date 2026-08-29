// scripts/audit_trigger_and_coverage.mjs
// Universal Multi-Agent Trigger & Coverage Audit Harness
// Strictly non-invasive: does not modify any production application code.

import { Decimal } from 'decimal.js';

console.log('================================================================');
console.log('🎯 UNIVERSAL MULTI-AGENT TRIGGER & COVERAGE AUDIT HARNESS');
console.log('================================================================\n');

// -------------------------------------------------------------
// 1. RISK & SPECIALIST ROUTING ENGINE
// -------------------------------------------------------------
export function classifyTask(prompt, context = {}) {
  const p = prompt.toLowerCase();
  const fullCtx = (p + ' ' + (context.previousPrompt || '')).toLowerCase();

  let category = 'GENERAL';
  let riskLevel = 'LOW';
  let coreAgents = ['Master Orchestrator', 'Gemini Peer Engineer', 'Claude CP1', 'Claude CP2', 'Controlled Implementation', 'Claude CP3', 'Guardian/Watcher', 'Final Gemini Review', 'Claude CP5 Tribunal'];
  let specialists = [];
  let claudeCheckpoints = ['CP1 (Pre)', 'CP2 (Peer)', 'CP3 (Post)', 'CP5 (Tribunal)'];
  let deterministicGates = ['Linter', 'Typecheck', 'Regression Suite'];

  // Trivial String / Cosmetic (Checked first when user explicitly states button text, typo, label)
  if (/button text|change label|fix typo|rename button|button label/.test(fullCtx)) {
    category = 'COSMETIC_TRIVIAL';
    riskLevel = 'LOW';
    coreAgents = ['Master Orchestrator', 'Gemini Engineer', 'Guardian/Watcher', 'Linter Gate'];
    claudeCheckpoints = ['CP3 (Post-Review)'];
    deterministicGates = ['Linter', 'Visual Snapshot'];
  }
  // Financial
  else if (/revenue|money|adr|revpar|occupancy|refund|profit|cents|pms|ota|commission|tax|cost|price|numbers don't match|numbers/.test(fullCtx)) {
    category = 'FINANCIAL';
    riskLevel = 'CRITICAL';
    specialists.push('Financial Truth Agent', 'Property Isolation Agent', 'Date & Period Truth Agent', 'Regression Agent', 'Mutation Agent');
    claudeCheckpoints.push('CP4 (Financial Review)', 'CP6 (Live Inspector)');
    deterministicGates.push('Integer-Cents Math Verification', 'Golden Dataset', 'Financial Invariant Probes');
  }
  // Property Isolation
  else if (/property|tenant|cross-property|hotel a|hotel b|portfolio/.test(fullCtx)) {
    category = 'PROPERTY_ISOLATION';
    riskLevel = 'CRITICAL_SEV0';
    specialists.push('Property Isolation Agent', 'Security Agent', 'Financial Truth Agent', 'Date Agent', 'Regression Agent', 'Mutation Agent');
    claudeCheckpoints.push('CP4 (Financial & Tenant Review)', 'CP6 (Live Inspector)');
    deterministicGates.push('Multi-Tenant Boundary Probes', 'RLS Assertions');
  }
  // Import / Export / Parser
  else if (/import|export|csv|xlsx|upload|missing rows|parse|stacked|format|report/.test(fullCtx)) {
    category = 'DATA_IMPORT';
    riskLevel = 'HIGH';
    specialists.push('Parser Adversary', 'Data Integrity Agent', 'Duplicate Detection Agent', 'Date Truth Agent', 'Property Isolation Agent', 'Regression Agent');
    claudeCheckpoints.push('CP4 (Data Review)', 'CP6 (Live Inspector)');
    deterministicGates.push('Upload Guard Probes', 'Schema Parity Check', 'Ingestion Fuzzing');
  }
  // Security / Auth
  else if (/login|auth|session|csrf|password|permission|mfa|token|unauthorized/.test(fullCtx)) {
    category = 'SECURITY_AUTH';
    riskLevel = 'CRITICAL_SECURITY';
    specialists.push('Security & Permission Agent', 'RBAC Verifier', 'Session Sliding Auditor', 'Regression Agent');
    claudeCheckpoints.push('CP6 (Live Inspector)');
    deterministicGates.push('Protected Files Guard', 'CSRF Probes', 'Audit Chain Proof');
  }
  // UI / UX / Owner
  else if (/chart|ui|dashboard|owner|easier|layout|visual|card|ux|confusing|simplify/.test(fullCtx)) {
    category = 'UI_UX_OWNER';
    riskLevel = 'MEDIUM';
    specialists.push('Owner Agent #1 (Pre)', 'UI/UX Accessibility Reviewer', 'Owner Agent #2 (Post)');
    deterministicGates.push('Sizer & Layout Probes', 'Accessibility Audit');
  }
  // Performance
  else if (/slow|performance|lag|latency|memory|render|timeout|optimize/.test(fullCtx)) {
    category = 'PERFORMANCE';
    riskLevel = 'MEDIUM_HIGH';
    specialists.push('Performance & Latency Agent', 'Impact Watcher', 'Query Index Verifier', 'Regression Agent');
    deterministicGates.push('Performance Benchmark Probes', 'Bundle Chunk Inspection');
  }

  return {
    prompt,
    category,
    riskLevel,
    coreAgents,
    specialists,
    claudeCheckpoints,
    deterministicGates,
    totalAgentsActivated: coreAgents.length + specialists.length,
  };
}

// -------------------------------------------------------------
// 2. MINIMAL-CONTEXT TEST SUITE (TESTS A - J)
// -------------------------------------------------------------
console.log('[STAGE 1] Testing 10 Minimal-Context User Prompts...');

const minimalPrompts = [
  { id: 'TEST A', prompt: 'Revenue is wrong.', expectedCategory: 'FINANCIAL' },
  { id: 'TEST B', prompt: 'Fix this chart.', expectedCategory: 'UI_UX_OWNER' },
  { id: 'TEST C', prompt: 'Payments total looks strange.', expectedCategory: 'FINANCIAL' },
  { id: 'TEST D', prompt: 'Add an export button.', expectedCategory: 'DATA_IMPORT' },
  { id: 'TEST E', prompt: 'Import is missing rows.', expectedCategory: 'DATA_IMPORT' },
  { id: 'TEST F', prompt: 'Property B data is showing in Property A.', expectedCategory: 'PROPERTY_ISOLATION' },
  { id: 'TEST G', prompt: "Monthly numbers don't match.", expectedCategory: 'FINANCIAL' },
  { id: 'TEST H', prompt: 'Make this page easier for the owner.', expectedCategory: 'UI_UX_OWNER' },
  { id: 'TEST I', prompt: "Login isn't working.", expectedCategory: 'SECURITY_AUTH' },
  { id: 'TEST J', prompt: 'Page is slow.', expectedCategory: 'PERFORMANCE' },
];

let minimalPassed = true;
for (const t of minimalPrompts) {
  const c = classifyTask(t.prompt);
  const match = c.category === t.expectedCategory;
  if (!match) minimalPassed = false;
  console.log(`  • [${t.id}] "${t.prompt}" -> Category: ${c.category} (Risk: ${c.riskLevel}, Agents Activated: ${c.totalAgentsActivated}) [${match ? 'PASS' : 'FAIL'}]`);
}
console.log(`✓ Minimal-Context Classification: ${minimalPassed ? '10/10 PASSED' : 'FAILED'}\n`);

// -------------------------------------------------------------
// 3. TINY-PROMPT & CONTEXT PERSISTENCE TEST
// -------------------------------------------------------------
console.log('[STAGE 2] Testing Context Persistence Across Follow-up Messages...');

// Scenario: User opens with "Revenue page is showing the wrong total" and follows up with "Fix that."
const initialTurn = classifyTask('Revenue page is showing the wrong total');
const followUpTurn = classifyTask('Fix that.', { previousPrompt: initialTurn.prompt });

const persistenceValid = followUpTurn.category === 'FINANCIAL' && followUpTurn.specialists.includes('Financial Truth Agent');
console.log(`  • Initial: "${initialTurn.prompt}" -> ${initialTurn.category}`);
console.log(`  • Follow-up: "Fix that." with context -> ${followUpTurn.category} (Specialists: ${followUpTurn.specialists.join(', ')})`);
console.log(`✓ Context Persistence Test: ${persistenceValid ? 'PASS' : 'FAIL'}\n`);

// -------------------------------------------------------------
// 4. NO-SHORTCUT ENFORCEMENT & AGENT-DROP DETECTION
// -------------------------------------------------------------
console.log('[STAGE 3] Testing No-Shortcut Enforcement & Agent-Drop Blocker...');

// Shortcut Attempt: Bypass reviews and deploy directly
function evaluateReleaseGate(executedStages) {
  const mandatoryGates = ['Financial Truth Agent', 'Property Isolation Agent', 'Guardian/Watcher', 'Regression Agent'];
  const missing = mandatoryGates.filter((g) => !executedStages[g] || executedStages[g] === 'NOT_RUN' || executedStages[g] === 'FAIL');

  if (missing.length > 0) {
    return { authorized: false, status: 'BLOCKED', missingGates: missing };
  }
  return { authorized: true, status: 'AUTHORIZED', missingGates: [] };
}

// Case 1: Shortcut (only Gemini ran)
const shortcutRun = { 'Gemini Peer Engineer': 'PASS' };
const shortcutRes = evaluateReleaseGate(shortcutRun);
const shortcutBlocked = !shortcutRes.authorized && shortcutRes.status === 'BLOCKED';

// Case 2: Accidental Drop (Financial Truth was NOT_RUN)
const droppedAgentRun = {
  'Gemini Peer Engineer': 'PASS',
  'Property Isolation Agent': 'PASS',
  'Guardian/Watcher': 'PASS',
  'Regression Agent': 'PASS',
  'Financial Truth Agent': 'NOT_RUN', // Dropped!
};
const droppedRes = evaluateReleaseGate(droppedAgentRun);
const dropBlocked = !droppedRes.authorized && droppedRes.missingGates.includes('Financial Truth Agent');

console.log(`  • Shortcut attempt (Direct Gemini -> Deploy): Blocked = ${shortcutBlocked} (${shortcutRes.status})`);
console.log(`  • Dropped agent attempt (Financial Truth NOT_RUN): Blocked = ${dropBlocked} (Missing: ${droppedRes.missingGates.join(', ')})`);
console.log(`✓ No-Shortcut & Agent-Drop Protection: ${shortcutBlocked && dropBlocked ? 'PASS' : 'FAIL'}\n`);

// -------------------------------------------------------------
// 5. COMPLEXITY SCALING TEST
// -------------------------------------------------------------
console.log('[STAGE 4] Testing Risk-Based Agent Count Scaling...');

const trivialTask = classifyTask('Change button text from Upload to Import');
const criticalTask = classifyTask('Revenue across ALL PROPERTIES is wrong after CSV import');

const scalingCorrect = trivialTask.totalAgentsActivated <= 5 && criticalTask.totalAgentsActivated >= 12;

console.log(`  • Trivial Task: "${trivialTask.prompt}" -> ${trivialTask.totalAgentsActivated} Agents (Risk: ${trivialTask.riskLevel})`);
console.log(`  • Critical Task: "${criticalTask.prompt}" -> ${criticalTask.totalAgentsActivated} Agents (Risk: ${criticalTask.riskLevel})`);
console.log(`✓ Complexity Scaling Test: ${scalingCorrect ? 'PASS' : 'FAIL'}\n`);

console.log('================================================================');
console.log('📊 AUDIT STAGES 1-4 COMPLETE');
console.log('================================================================');
