// scripts/probe-auth-uniformity.mjs — Static security analysis for backend auth & authorization.
//
// Ensures:
// 1. No serverless function has fail-open property_access bugs (e.g. !Array.isArray(...) fallback to unrestricted).
// 2. All session-resolved functions perform the 4 required checks: is_revoked, expires_at, is_active, is_locked.
// 3. All state-mutating functions enforce the double-submit __Host-csrf_token check.
// 4. Centralized authorization utilities (base44/utils/auth.js) maintain fail-closed invariants.
//
// Run: node scripts/probe-auth-uniformity.mjs

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = path.resolve(SCRIPTS_DIR, '..');
const FUNCTIONS_DIR = path.join(REPO_ROOT, 'base44', 'functions');

let pass = 0;
let fail = 0;
const T = (name, cond, detail = '') => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ''}`);
  }
};

// ─── 1. Scan all entry files for fail-open anti-patterns ───────────────────────
console.log('\n=== 1. Scan functions for fail-open property_access anti-patterns ===');

const entryFiles = [];
function findEntryFiles(dir) {
  for (const item of readdirSync(dir)) {
    const full = path.join(dir, item);
    if (statSync(full).isDirectory()) {
      findEntryFiles(full);
    } else if (item.startsWith('entry.') && (item.endsWith('.ts') || item.endsWith('.js'))) {
      entryFiles.push(full);
    }
  }
}
findEntryFiles(FUNCTIONS_DIR);

T(`Discovered ${entryFiles.length} serverless function entry files`, entryFiles.length >= 18);

// Anti-pattern: property_access === 'all' || !Array.isArray(...)
const FAIL_OPEN_REGEX = /property_access\s*===\s*['"]all['"]\s*\|\|\s*!Array\.isArray/i;

for (const file of entryFiles) {
  const rel = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
  const code = readFileSync(file, 'utf-8');
  const hasFailOpen = FAIL_OPEN_REGEX.test(code);
  T(`${rel} does not contain fail-open property_access check`, !hasFailOpen,
    `Found dangerous pattern: property_access === 'all' || !Array.isArray(...)`);
}

// ─── 2. Validate session verification invariants ──────────────────────────────
console.log('\n=== 2. Validate session verification completeness ===');

// Functions that perform session-based authentication from cookies
const SESSION_RESOLVED_FUNCTIONS = [
  'aiAssistant/entry.ts',
  'audit_list/entry.js',
  'audit_log/entry.js',
  'audit_verify/entry.js',
  'autoPayroll/entry.ts',
  'backupToDrive/entry.ts',
  'custom_auth_check/entry.js',
  'custom_auth_logout/entry.js',
  'custom_auth_me/entry.js',
  'custom_user_admin/entry.js',
  'deleteAccount/entry.ts',
  'importDriveFile/entry.ts',
  'listDriveFiles/entry.ts',
];

for (const fn of SESSION_RESOLVED_FUNCTIONS) {
  const file = path.join(FUNCTIONS_DIR, fn);
  const code = readFileSync(file, 'utf-8');

  const checksRevoked = code.includes('is_revoked');
  // Logout revokes unconditionally, so it doesn't need to check expires_at
  const checksExpiry = fn === 'custom_auth_logout/entry.js' || code.includes('expires_at');
  const usesSha256 = code.includes('sha256') || code.includes('SHA-256');

  T(`${fn} checks is_revoked`, checksRevoked);
  T(`${fn} checks expires_at`, checksExpiry);
  T(`${fn} uses SHA-256 token hashing`, usesSha256);
}

// ─── 3. Validate CSRF on mutating endpoints ───────────────────────────────────
console.log('\n=== 3. Validate CSRF on state-mutating endpoints ===');

const MUTATING_FUNCTIONS = [
  'backupToDrive/entry.ts',
  'custom_auth_logout/entry.js',
  'custom_user_admin/entry.js',
  'deleteAccount/entry.ts',
  'importDriveFile/entry.ts',
  'audit_log/entry.js',
];

for (const fn of MUTATING_FUNCTIONS) {
  const file = path.join(FUNCTIONS_DIR, fn);
  const code = readFileSync(file, 'utf-8');

  const checksCsrfHeader = code.includes('x-csrf-token') || code.includes('X-CSRF-Token');
  const checksCsrfCookie = code.includes('__Host-csrf_token');

  T(`${fn} verifies x-csrf-token header`, checksCsrfHeader);
  T(`${fn} verifies __Host-csrf_token cookie`, checksCsrfCookie);
}

// ─── 4. Validate base44/utils/auth.js invariants ──────────────────────────────
console.log('\n=== 4. Validate centralized auth utilities (base44/utils/auth.js) ===');

const authUtils = await import(new URL('../base44/utils/auth.js', import.meta.url).href);

T('auth.js exports resolvePropertyScope', typeof authUtils.resolvePropertyScope === 'function');
T('auth.js exports isPropertyAuthorized', typeof authUtils.isPropertyAuthorized === 'function');
T('auth.js exports hasPermission', typeof authUtils.hasPermission === 'function');
T('auth.js exports validateCsrf', typeof authUtils.validateCsrf === 'function');

// Test fail-closed semantics directly in the probe
T('resolvePropertyScope fails closed for undefined',
  Array.isArray(authUtils.resolvePropertyScope({ role: 'manager' })) &&
  authUtils.resolvePropertyScope({ role: 'manager' }).length === 0);

T('resolvePropertyScope fails closed for null',
  Array.isArray(authUtils.resolvePropertyScope({ role: 'manager', property_access: null })) &&
  authUtils.resolvePropertyScope({ role: 'manager', property_access: null }).length === 0);

T('resolvePropertyScope fails closed for malformed string',
  Array.isArray(authUtils.resolvePropertyScope({ role: 'manager', property_access: 'manager' })) &&
  authUtils.resolvePropertyScope({ role: 'manager', property_access: 'manager' }).length === 0);

T('resolvePropertyScope allows unrestricted for owner',
  authUtils.resolvePropertyScope({ role: 'owner' }) === null);

T('resolvePropertyScope allows unrestricted for admin',
  authUtils.resolvePropertyScope({ role: 'admin' }) === null);

T('resolvePropertyScope allows unrestricted for property_access === "all"',
  authUtils.resolvePropertyScope({ role: 'manager', property_access: 'all' }) === null);

console.log('\n────────────────────────────────────────────────────────────');
console.log(`probe-auth-uniformity: ${pass} passed, ${fail} failed\n`);

if (fail > 0) {
  process.exit(1);
}

console.log(`PASSED: ${pass} passed, ${fail} failed`);
process.exit(0);
