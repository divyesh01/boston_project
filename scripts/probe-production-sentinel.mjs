import { productionSentinel } from '../src/lib/productionSentinel.js';

console.log('================================================================================');
console.log('🛡️ DEEP PRODUCTION SENTINEL USER-FLOW & REGRESSION AUDIT');
console.log('================================================================================');
console.log(`Target URL: ${productionSentinel.baseUrl}\n`);

const results = await productionSentinel.runFullProductionAudit();

console.log('[1] Live HTML Mount & Bundle Integrity:');
console.log(`    Status: ${results.bundleCheck.httpStatus}, Root DOM Mount: ${results.bundleCheck.hasRootDomMount ? 'PRESENT' : 'MISSING'}`);
console.log(`    JS Bundle: ${results.bundleCheck.javascriptBundle} (${results.bundleCheck.bundleStatus}, ${results.bundleCheck.bundleSizeBytes} bytes)`);
console.log(`    CSS Stylesheet: ${results.bundleCheck.cssStylesheet}`);
console.log(`    Verdict: ${results.bundleCheck.verdict}`);

console.log('\n[2] Live SPA Routes & Navigation:');
for (const r of results.routesCheck.details) {
  console.log(`    Route "${r.route.padEnd(16)}" -> HTTP ${r.status} (Renders Root: ${r.rendersRoot}) [${r.status === 200 ? 'PASS ✅' : 'FAIL ❌'}]`);
}
console.log(`    Verdict: ${results.routesCheck.verdict}`);

console.log('\n[3] Live Multi-Property Isolation Contract:');
console.log(`    Composite Keying: ${results.isolationCheck.compositeKeyingVerified}`);
console.log(`    Lateral Leakage Detected: ${results.isolationCheck.lateralLeakageDetected}`);
console.log(`    Single-Property Filter: ${results.isolationCheck.singlePropertyFilteringOk}`);
console.log(`    Verdict: ${results.isolationCheck.verdict}`);

console.log('\n[4] Live Upload Guard Binary Defense:');
console.log(`    DOS/PE Header Blocked: ${results.uploadCheck.dosPeHeaderBlocked}`);
console.log(`    Linux ELF Header Blocked: ${results.uploadCheck.linuxElfHeaderBlocked}`);
console.log(`    Valid CSV Permitted: ${results.uploadCheck.validCsvPermitted}`);
console.log(`    Verdict: ${results.uploadCheck.verdict}`);

console.log('\n[5] Live Financial & Calculation Invariants:');
console.log(`    Sample Revenue: $15,000.00 -> ADR: ${results.financialCheck.adrFormatted}, RevPAR: ${results.financialCheck.revparFormatted}`);
console.log(`    Integer Cents Math Guarantee: ${results.financialCheck.integerCentsGuarantee}`);
console.log(`    Verdict: ${results.financialCheck.verdict}`);

console.log('\n[6] Live Security Headers & Zero Secret Leakage:');
console.log(`    HTTP Status: ${results.securityCheck.httpStatus}, X-Content-Type-Options: ${results.securityCheck.xContentTypeOptions}`);
console.log(`    Zero Plaintext Secret Leaks: ${results.securityCheck.zeroPlaintextSecretLeaks}`);
console.log(`    Verdict: ${results.securityCheck.verdict}`);

console.log('\n================================================================================');
console.log(`🏁 PRODUCTION SENTINEL AUDIT COMPLETE: ${results.overallVerdict} (${results.totalDurationSeconds}s)`);
console.log('================================================================================');

if (!results.overallVerdict.includes('PASS')) {
  process.exit(1);
}
