// Test Harness: Real-Time Account Status Revocation Verification
//
// Runs the REAL auth stack (base44Client.js + Dexie over fake-indexeddb) to prove
// that a Disabled/Locked account has its active session revoked INSTANTLY on the
// next route navigation — no waiting for the 30s idle poll in AuthContext.
//
// Mirrors the production flow:
//   1. AuthContext.validateCurrentAccountStatus()  -> re-queries live user record
//   2. ProtectedRoute effect                         -> logAuditEvent('Session Revoked')
//                                                   -> logout(false) clears session
//
// Run: node --import ./scripts/_loader-boot.mjs ./scripts/test_realtime_revocation.mjs

import 'fake-indexeddb/auto';
globalThis.crypto ??= (await import('node:crypto')).webcrypto;

const store = new Map();
const storage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
globalThis.localStorage = storage;
globalThis.sessionStorage = storage;
globalThis.window = globalThis;
if (globalThis.navigator === undefined) {
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'revocation-harness', language: 'en-US' }, configurable: true });
}

const { db } = await import('@/api/base44Client');
const localDb = (await import('@/api/localDb')).default;
const { hashPassword, generateSalt } = await import('@/lib/security.js');

let pass = 0;
let fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log(`  PASS  ${msg}`); }
  else { fail++; console.log(`  FAIL  ${msg}`); }
}

// ── Mirror of src/lib/AuthContext.jsx `validateCurrentAccountStatus` ──
async function validateCurrentAccountStatus() {
  try {
    const session = await db.auth.getCurrentSession();
    if (!session) return { valid: false, status: 'revoked' };
    const record = await db.entities.User.get(session.userId);
    if (!record) return { valid: false, status: 'revoked' };
    if (record.is_active === false) return { valid: false, status: 'disabled' };
    if (record.is_locked === true) return { valid: false, status: 'locked' };
    const me = await db.auth.me();
    return { valid: true, user: me || record };
  } catch (e) {
    console.error('validateCurrentAccountStatus error:', e);
    return { valid: false, status: 'revoked' };
  }
}

// ── Mirror of the ProtectedRoute revocation step ──
async function revokeSession(status, user) {
  await db.audit.log({
    user_id: user?.id,
    username: user?.username,
    action: 'Session Revoked',
    result: 'failed',
    detail: `Account status changed to "${status}". Session revoked in real-time.`,
  });
  await db.auth.logout();
}

async function seedUsers() {
  const salt = generateSalt();
  const hash = await hashPassword('S3cure!Pass', salt);
  const ownerId = await localDb.User.add({
    username: 'owner', email: 'owner@x.com', full_name: 'Owner', role: 'owner',
    permissions: 'all', property_access: 'all', is_active: true, is_locked: false,
    failed_attempts: 0, salt, password_hash: hash,
  });
  const targetSalt = generateSalt();
  const targetId = await localDb.User.add({
    username: 'clerk', email: 'clerk@x.com', full_name: 'Clerk', role: 'read_only',
    permissions: ['view:reports'], property_access: ['prop_1'], is_active: true, is_locked: false,
    failed_attempts: 0, salt: targetSalt, password_hash: await hashPassword('S3cure!Pass', targetSalt),
  });
  return { ownerId, targetId };
}

async function run() {
  console.log('Starting Real-Time Account Revocation Tests...\n');

  const { ownerId, targetId } = await seedUsers();
  const ownerActor = { id: ownerId, role: 'owner' };

  // ── Scenario 1: Active session validates OK ──
  console.log('=== Test 1: Active session remains valid ===');
  const login1 = await db.auth.login('clerk', 'S3cure!Pass');
  assert(!!login1?.user, 'Login succeeds for active user');
  assert((await db.auth.isAuthenticated()) === true, 'isAuthenticated() true');
  const valid1 = await validateCurrentAccountStatus();
  assert(valid1.valid === true, 'validateCurrentAccountStatus() -> valid (Active)');
  assert((await db.auth.getCurrentSession()) !== null, 'Session still present for Active user');
  await db.auth.logout();
  assert((await db.auth.getCurrentSession()) === null, 'Explicit logout clears session');

  // ── Scenario 2: Disabled account revoked instantly on next navigation ──
  console.log('\n=== Test 2: Admin disables account -> instant revocation ===');
  const login2 = await db.auth.login('clerk', 'S3cure!Pass');
  assert(!!login2?.user, 'Login succeeds (Active)');
  await db.users.setStatus(ownerActor, targetId, 'disabled'); // Users.jsx real action
  const r2 = await validateCurrentAccountStatus();
  assert(r2.valid === false && r2.status === 'disabled', `validateCurrentAccountStatus() -> invalid (${r2.status})`);
  await revokeSession(r2.status, r2.user);
  assert((await db.auth.getCurrentSession()) === null, 'Session cleared after revocation');
  assert((await db.auth.isAuthenticated()) === false, 'isAuthenticated() false immediately (no 30s wait)');
  assert((await db.auth.me()) === null, 'me() returns null immediately');
  const auditRows = await db.audit.list({ action: 'Session Revoked' });
  assert(auditRows.length >= 1, `'Session Revoked' audit event logged (${auditRows.length})`);

  // ── Scenario 3: Locked account revoked instantly ──
  console.log('\n=== Test 3: Admin locks account -> instant revocation ===');
  await db.users.setStatus(ownerActor, targetId, 'enabled');
  const login3 = await db.auth.login('clerk', 'S3cure!Pass');
  assert(!!login3?.user, 'Login succeeds (Active again)');
  await db.users.setStatus(ownerActor, targetId, 'locked'); // Users.jsx real action
  const r3 = await validateCurrentAccountStatus();
  assert(r3.valid === false && r3.status === 'locked', `validateCurrentAccountStatus() -> invalid (${r3.status})`);
  await revokeSession(r3.status, r3.user);
  assert((await db.auth.getCurrentSession()) === null, 'Session cleared after revocation');
  assert((await db.auth.isAuthenticated()) === false, 'isAuthenticated() false immediately');

  // ── Scenario 4: Deleted user revoked instantly ──
  console.log('\n=== Test 4: Admin deletes user -> instant revocation ===');
  await db.users.setStatus(ownerActor, targetId, 'enabled');
  const login4 = await db.auth.login('clerk', 'S3cure!Pass');
  assert(!!login4?.user, 'Login succeeds (Active again)');
  await localDb.User.delete(targetId);
  const r4 = await validateCurrentAccountStatus();
  assert(r4.valid === false && r4.status === 'revoked', `validateCurrentAccountStatus() -> invalid (${r4.status})`);
  await revokeSession(r4.status, r4.user);
  assert((await db.auth.getCurrentSession()) === null, 'Session cleared after revocation');
  assert((await db.auth.isAuthenticated()) === false, 'isAuthenticated() false immediately');

  console.log('\n========================================');
  console.log(`RESULTS: ${pass} passed, ${fail} failed`);
  console.log('========================================\n');
  if (fail > 0) process.exit(1);
  console.log('✓ ALL REAL-TIME REVOCATION TESTS PASSED\n');
  process.exit(0); // close BroadcastChannel handles held open by the process
}

run().catch((e) => {
  console.error('\nTEST ERROR:', e);
  process.exit(1);
});
