import { getCsrfToken } from '../src/lib/securityUtils.js';

globalThis.document = { cookie: "" };
globalThis.location = { protocol: "https:" };
if (!globalThis.crypto) {
  globalThis.crypto = (await import("node:crypto")).webcrypto;
}
globalThis.sessionStorage = { getItem: () => null, setItem: () => {} };

const token = getCsrfToken();
console.log("Cookie generated:", document.cookie);

if (!document.cookie.startsWith("__Host-csrf_token=")) {
  console.error("FAIL: CSRF cookie is missing the __Host- prefix!");
  process.exit(1);
}

console.log("✓ Probe PASSED: CSRF cookie uses __Host- prefix.");
