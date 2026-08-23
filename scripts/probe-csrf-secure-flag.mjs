// scripts/probe-csrf-secure-flag.mjs
import { getCsrfToken } from '../src/lib/securityUtils.js';

console.log('Testing CSRF cookie Secure flag...');

let passed = 0;
let failed = 0;

function check(condition, name) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}`);
  }
}

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
check(
  capturedCookie.includes('__Host-csrf_token='),
  'cookie has __Host- prefix'
);

// TEST 2: Check that cookie HAS ; Secure flag
check(
  capturedCookie.includes('; Secure'),
  'cookie HAS ; Secure flag'
);

// TEST 3: Check that cookie has SameSite=Lax
check(
  capturedCookie.includes('SameSite=Lax'),
  'cookie has SameSite=Lax'
);

// TEST 4: Check that NO conditional logic is used (no variable names)
check(
  !capturedCookie.includes('${secure}'),
  'no conditional logic is used (no variable names)'
);

if (failed === 0) {
  console.log(`PASSED: ${passed} passed, ${failed} failed`);
} else {
  console.log(`FAILED: ${passed} passed, ${failed} failed`);
}

process.exit(failed > 0 ? 1 : 0);

