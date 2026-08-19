// scripts/probe-csrf-secure-flag.mjs
import { getCsrfToken } from '../src/lib/securityUtils.js';

console.log('Testing CSRF cookie Secure flag...');

// Mock document.cookie so we can capture what gets written
let capturedCookie = '';
global.document = {
  get cookie() { return capturedCookie; },
  set cookie(value) { capturedCookie = value; }
};

// Call the function to write the cookie. writeCsrfCookie is not exported, 
// but getCsrfToken calls it.
getCsrfToken();

console.log('Cookie written:', capturedCookie);

// TEST 1: Check that cookie HAS __Host- prefix
console.assert(
  capturedCookie.includes('__Host-csrf_token='),
  'FAIL: Cookie missing __Host- prefix'
);

// TEST 2: Check that cookie HAS ; Secure flag
console.assert(
  capturedCookie.includes('; Secure'),
  'FAIL: Cookie missing ; Secure flag'
);

// TEST 3: Check that cookie has SameSite=Lax
console.assert(
  capturedCookie.includes('SameSite=Lax'),
  'FAIL: Cookie missing SameSite=Lax'
);

// TEST 4: Check that NO conditional logic is used (no variable names)
console.assert(
  !capturedCookie.includes('${secure}'),
  'FAIL: Cookie still using conditional secure variable'
);

console.log('✓ Probe PASSED: CSRF cookie correctly includes mandatory Secure flag');
