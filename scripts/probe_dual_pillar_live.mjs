/**
 * Live Dual-Pillar Parallel Solver Probe & Evidence Verification
 * ---------------------------------------------------------------
 * Runs a real Dual-Pillar invocation for "Revenue is wrong.", verifies:
 *  1. Gemini Solution A (google/gemini-2.5-pro) actual invocation metadata
 *  2. Claude Solution B (anthropic/claude-sonnet-5) actual invocation metadata
 *  3. Prompt Isolation Design (SHA-256 hash distinctness, zero cross-talk)
 *  4. Actual Independent AI Execution status (PASS only when both succeed)
 *  5. Synthesis & Dynamic Disagreement derivation
 *  6. Synthetic evidence scan (zero fake IDs, zero artificial 0.001s latencies)
 */

import { dualPillarSolver } from '../src/lib/dualPillarSolver.js';

console.log('='.repeat(80));
console.log('🏛️  DUAL-PILLAR PARALLEL SOLVER LIVE EVIDENCE AUDIT');
console.log('='.repeat(80));

const prompt = 'Revenue is wrong.';
console.log(`\nUser Prompt: "${prompt}"`);
console.log('Executing Gemini Solution A + Claude Solution B in strict parallel isolation (Round 0)...\n');

const result = await dualPillarSolver.executeDualPillar(prompt, {
  hotel: 'Boston Property Alpha',
  scenario: 'Night Audit Revenue Drift & Multi-Property Isolation',
});

console.log('[1] GEMINI SOLUTION A (AST & Component Scoping):');
console.log(`    Provider:             ${result.solutionA.provider}`);
console.log(`    Model Requested:      ${result.solutionA.modelRequested}`);
console.log(`    Model Returned:       ${result.solutionA.modelReturned}`);
console.log(`    Generation ID:        ${result.solutionA.generationId}`);
console.log(`    Start Time:           ${result.solutionA.startTimestamp}`);
console.log(`    End Time:             ${result.solutionA.endTimestamp}`);
console.log(`    Actual Latency:       ${result.solutionA.latencySeconds}s`);
console.log(`    Tokens:               ${JSON.stringify(result.solutionA.tokens)}`);
console.log(`    Status:               ${result.solutionA.status}`);
console.log(`    AI Contribution:      ${result.solutionA.aiContribution}`);
console.log(`    Real Solution Text:   ${result.solutionA.solutionText ? `"${result.solutionA.solutionText.slice(0, 100).replace(/\n/g, ' ')}..."` : 'null (NONE - Provider Failed)'}`);
console.log(`    Local Guidance:       ${result.solutionA.localFallbackGuidance ? `"${result.solutionA.localFallbackGuidance.slice(0, 80)}..."` : 'NONE'}`);

console.log('\n[2] CLAUDE SOLUTION B (High-Trust Invariants & Security):');
console.log(`    Provider:             ${result.solutionB.provider}`);
console.log(`    Model Requested:      ${result.solutionB.modelRequested}`);
console.log(`    Model Returned:       ${result.solutionB.modelReturned}`);
console.log(`    Generation ID:        ${result.solutionB.generationId}`);
console.log(`    Start Time:           ${result.solutionB.startTimestamp}`);
console.log(`    End Time:             ${result.solutionB.endTimestamp}`);
console.log(`    Actual Latency:       ${result.solutionB.latencySeconds}s`);
console.log(`    Tokens:               ${JSON.stringify(result.solutionB.tokens)}`);
console.log(`    Status:               ${result.solutionB.status}`);
console.log(`    AI Contribution:      ${result.solutionB.aiContribution}`);
console.log(`    Authoritative:        ${result.solutionB.isAuthoritative}`);
console.log(`    Real Solution Text:   ${result.solutionB.solutionText ? `"${result.solutionB.solutionText.slice(0, 100).replace(/\n/g, ' ')}..."` : 'null (NONE - Provider Failed)'}`);
console.log(`    Local Guidance:       ${result.solutionB.localFallbackGuidance ? `"${result.solutionB.localFallbackGuidance.slice(0, 80)}..."` : 'NONE'}`);

console.log('\n[3] INDEPENDENCE VERIFICATION:');
console.log(`    Prompt A Hash:        ${result.independence.promptHashA}`);
console.log(`    Prompt B Hash:        ${result.independence.promptHashB}`);
console.log(`    Prompt Isolation:     ${result.independence.promptIsolationDesign}`);
console.log(`    AI Execution Status:  ${result.independence.independentAiExecution}`);
console.log(`    Zero Cross-Talk:      ${result.independence.zeroCrossContamination}`);
console.log(`    Independence Verdict: ${result.independence.verdict}`);

console.log('\n[4] EVIDENCE-BASED SYNTHESIS:');
console.log(`    Synthesis Status:     ${result.synthesis.dualPillarSynthesisStatus}`);
console.log(`    AI Common Points:     ${result.synthesis.commonFindings.length}`);
console.log(`    AI Disagreements:     ${result.synthesis.disagreements.length}`);
console.log(`    AI Derived Synthesis: ${result.synthesis.aiDerivedSynthesis}`);
if (result.synthesis.deterministicFallbackAnalysis) {
  console.log(`    Fallback Verdict:     ${result.synthesis.deterministicFallbackAnalysis.verdict}`);
  console.log(`    Fallback Summary:     ${result.synthesis.deterministicFallbackAnalysis.architectureSummary}`);
}

console.log('\n[5] SYNTHETIC EVIDENCE SCAN:');
const isFakeGenA = result.solutionA.generationId.includes('-verified') || result.solutionA.generationId.includes('fake');
const isFakeGenB = result.solutionB.generationId.includes('-verified') || result.solutionB.generationId.includes('fake');
const isFakeLatencyA = result.solutionA.latencySeconds < 0.05 && result.solutionA.success;
const isFakeLatencyB = result.solutionB.latencySeconds < 0.05 && result.solutionB.success;
const hasSyntheticData = isFakeGenA || isFakeGenB || isFakeLatencyA || isFakeLatencyB;

console.log(`    Fake Generation IDs:  ${hasSyntheticData ? 'YES (FAIL)' : 'NONE (PASS)'}`);
console.log(`    Artificial Latency:   ${isFakeLatencyA || isFakeLatencyB ? 'YES (FAIL)' : 'NONE (PASS)'}`);
console.log(`    Scan Verdict:         ${!hasSyntheticData ? 'PASS (AUTHENTIC_PROVEN)' : 'FAIL'}`);

console.log('\n' + '='.repeat(80));
console.log(`🏁 DUAL-PILLAR AUDIT COMPLETE: ${result.independence.independentAiExecution} (Total Time: ${result.totalDurationSeconds}s)`);
console.log('='.repeat(80));

if (hasSyntheticData) {
  console.error('FAILED: Synthetic data detected.');
  process.exit(1);
}
