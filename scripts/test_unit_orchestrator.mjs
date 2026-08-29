import assert from 'node:assert';
import {
  DOMAINS,
  CONFIDENCE_THRESHOLD,
  classifyPrompt,
  buildOrchestrationPlan,
} from '../src/lib/autonomousOrchestrator.js';

console.log('Running unit test suite for Autonomous Engineering Orchestrator...');

// 1. Test "Revenue is wrong." -> FINANCIAL_TRUTH
const r1 = classifyPrompt('Revenue is wrong.');
assert.strictEqual(r1.primaryDomain, DOMAINS.FINANCIAL_TRUTH);
assert.ok(r1.confidence >= CONFIDENCE_THRESHOLD);
assert.ok(r1.detectedKeywords.includes('revenue'));
const p1 = buildOrchestrationPlan(r1, 'Revenue is wrong.');
assert.ok(p1.claudeCheckpoints.some(c => c.id === 'CP4'));
assert.ok(p1.claudeCheckpoints.some(c => c.id === 'CP5'));
assert.ok(p1.nvidiaNim !== null);
assert.ok(p1.researchSpecialist !== null);
assert.ok(p1.deterministicProbes.includes('scripts/probe-financial-invariant.mjs'));
console.log('✓ Test 1 Passed: "Revenue is wrong." -> FINANCIAL_TRUTH squad');

// 2. Test "Fix this." -> VAGUE_AUTODETECT
const r2 = classifyPrompt('Fix this.', { recentTopic: 'Room board cross-property leak' });
assert.strictEqual(r2.primaryDomain, DOMAINS.VAGUE_AUTODETECT);
const p2 = buildOrchestrationPlan(r2, 'Fix this.');
assert.ok(p2.claudeCheckpoints.some(c => c.id === 'CP1'));
assert.ok(p2.claudeCheckpoints.some(c => c.id === 'CP5'));
assert.ok(p2.nvidiaNim !== null);
assert.ok(p2.deterministicProbes.includes('scripts/audit-gate.mjs'));
console.log('✓ Test 2 Passed: "Fix this." -> VAGUE_AUTODETECT tribunal');

// 3. Test "Import missed some rows." -> DATA_INGESTION_IMPORT
const r3 = classifyPrompt('Import missed some rows.');
assert.strictEqual(r3.primaryDomain, DOMAINS.DATA_INGESTION_IMPORT);
assert.ok(r3.detectedKeywords.includes('import'));
assert.ok(r3.detectedKeywords.includes('rows'));
const p3 = buildOrchestrationPlan(r3, 'Import missed some rows.');
assert.ok(p3.claudeCheckpoints.some(c => c.id === 'CP1'));
assert.ok(p3.claudeCheckpoints.some(c => c.id === 'CP3'));
assert.ok(p3.researchSpecialist.role.includes('RFC 4180'));
assert.ok(p3.deterministicProbes.includes('scripts/probe-csv-data-loss.mjs'));
console.log('✓ Test 3 Passed: "Import missed some rows." -> DATA_INGESTION_IMPORT squad');

// 4. Test "Property B numbers are showing in Property A." -> PROPERTY_ISOLATION
const r4 = classifyPrompt('Property B numbers are showing in Property A.');
assert.strictEqual(r4.primaryDomain, DOMAINS.PROPERTY_ISOLATION);
const p4 = buildOrchestrationPlan(r4, 'Property B numbers are showing in Property A.');
assert.ok(p4.claudeCheckpoints.some(c => c.id === 'CP1'));
assert.ok(p4.claudeCheckpoints.some(c => c.id === 'CP2'));
assert.ok(p4.claudeCheckpoints.some(c => c.id === 'CP5'));
assert.ok(p4.adversarialSwarm !== null);
assert.ok(p4.deterministicProbes.includes('scripts/probe-property-isolation.mjs'));
console.log('✓ Test 4 Passed: "Property B numbers are showing in Property A." -> PROPERTY_ISOLATION squad');

// 5. Test "This page is confusing." -> UI_UX_ACCESSIBILITY
const r5 = classifyPrompt('This page is confusing.');
assert.strictEqual(r5.primaryDomain, DOMAINS.UI_UX_ACCESSIBILITY);
const p5 = buildOrchestrationPlan(r5, 'This page is confusing.');
assert.ok(p5.claudeCheckpoints.some(c => c.id === 'CP1'));
assert.ok(p5.researchSpecialist.role.includes('WCAG'));
assert.ok(p5.deterministicProbes.includes('scripts/probe-ui-feedback.mjs'));
console.log('✓ Test 5 Passed: "This page is confusing." -> UI_UX_ACCESSIBILITY squad');

// 6. Test "Malicious user uploaded .exe disguised as report." -> SECURITY_ACCESS
const r6 = classifyPrompt('Malicious user uploaded .exe disguised as report.');
assert.strictEqual(r6.primaryDomain, DOMAINS.SECURITY_ACCESS);
const p6 = buildOrchestrationPlan(r6, 'Malicious user uploaded .exe disguised as report.');
assert.ok(p6.claudeCheckpoints.some(c => c.id === 'CP3'));
assert.ok(p6.claudeCheckpoints.some(c => c.id === 'CP6'));
assert.ok(p6.nvidiaNim.role.includes('Security'));
assert.ok(p6.deterministicProbes.includes('scripts/probe-upload-guard.mjs'));
console.log('✓ Test 6 Passed: "Malicious user uploaded .exe disguised as report." -> SECURITY_ACCESS squad');

// 7. Test "Room board paging gets slow with 5000 rooms." -> PERFORMANCE_SCALE
const r7 = classifyPrompt('Room board paging gets slow with 5000 rooms.');
assert.strictEqual(r7.primaryDomain, DOMAINS.PERFORMANCE_SCALE);
const p7 = buildOrchestrationPlan(r7, 'Room board paging gets slow with 5000 rooms.');
assert.ok(p7.claudeCheckpoints.some(c => c.id === 'CP2'));
assert.ok(p7.nvidiaNim.role.includes('Performance'));
assert.ok(p7.adversarialSwarm !== null);
assert.ok(p7.deterministicProbes.includes('scripts/probe-build-chunks.mjs'));
console.log('✓ Test 7 Passed: "Room board paging gets slow with 5000 rooms." -> PERFORMANCE_SCALE squad');

// 8. Test Novel / Unmatched Input -> UNKNOWN_FAILSAFE
const r8 = classifyPrompt('Quantum teleportation protocol integration for front desk keycards.');
assert.strictEqual(r8.primaryDomain, DOMAINS.UNKNOWN_FAILSAFE);
assert.strictEqual(r8.reclassificationRequired, true);
const p8 = buildOrchestrationPlan(r8, 'Quantum teleportation protocol integration for front desk keycards.');
assert.ok(p8.claudeCheckpoints.some(c => c.id === 'CP1'));
assert.ok(p8.geminiSubagent !== null);
assert.ok(p8.nvidiaNim.role.includes('Guardian'));
assert.ok(p8.deterministicProbes.includes('scripts/audit-gate.mjs'));
assert.ok(p8.deterministicProbes.includes('scripts/verify-all.mjs'));
assert.strictEqual(p8.reclassificationRequired, true);
console.log('✓ Test 8 Passed: Novel / Unmatched Input -> UNKNOWN_FAILSAFE (Guardian + Gemini + Claude CP1 + Master Gate)');

// 9. Test Low-Confidence Input (< 0.70) -> UNKNOWN_FAILSAFE
const r9 = classifyPrompt('something weird happened');
assert.strictEqual(r9.primaryDomain, DOMAINS.UNKNOWN_FAILSAFE);
assert.strictEqual(r9.reclassificationRequired, true);
const p9 = buildOrchestrationPlan(r9, 'something weird happened');
assert.strictEqual(p9.primaryDomain, DOMAINS.UNKNOWN_FAILSAFE);
assert.ok(p9.claudeCheckpoints.some(c => c.id === 'CP1'));
console.log('✓ Test 9 Passed: Low-Confidence Input -> UNKNOWN_FAILSAFE');

console.log('\n================================================================');
console.log('🎉 ALL 9 AUTONOMOUS ORCHESTRATION & FAIL-SAFE UNIT TESTS PASSED (100%)');
console.log('================================================================');
