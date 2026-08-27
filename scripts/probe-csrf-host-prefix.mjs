import { getCsrfToken } from '../src/lib/securityUtils.js';

globalThis.document = { cookie: "" };
globalThis.location = { protocol: "https:" };
if (!globalThis.crypto) {
  globalThis.crypto = (await import("node:crypto")).webcrypto;
}
globalThis.sessionStorage = { getItem: () => null, setItem: () => {} };

getCsrfToken();
console.log("Cookie generated:", document.cookie);

let pass = 0;
let failed = 0;
if (document.cookie.startsWith("__Host-csrf_token=")) {
  pass++;
} else {
  console.error("FAIL: CSRF cookie is missing the __Host- prefix!");
  failed++;
}

console.log(`\n${failed === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${failed} failed`);
// Only claim the invariant holds when it actually held. Printing this line
// unconditionally made a failing run emit "FAILED: 0 passed, 1 failed" and then
// "Probe PASSED" two lines later — a self-contradicting log that a reader
// skimming for the word PASSED would misread as green.
if (failed === 0) console.log("✓ Probe PASSED: CSRF cookie uses __Host- prefix.");
process.exit(failed > 0 ? 1 : 0);
