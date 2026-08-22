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

const { db, browserHashPassword } = await import('@/api/base44Client');
const localDb = (await import('@/api/localDb')).default;
const { generateSalt } = await import('@/lib/security.js');
const { hasAllPropertyAccess } = await import('@/lib/launchPolicy');

let pass = 0;
let fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log(`  PASS  ${msg}`); }
  else { fail++; console.log(`  FAIL  ${msg}`); }
}

// ── Mirror of src/lib/AuthContext.jsx `validateCurrentAccountStatus` ──
//
// Kept deliberately identical to production: it asks db.auth.me() and judges the
// record that comes back. It used to open with getCurrentSession() +
// db.entities.User.get(session.userId), which production does NOT do — so the
// harness was measuring a control that does not ship.
async function validateCurrentAccountStatus() {
  try {
    const me = await db.auth.me();
    if (!me) return { valid: false, status: 'revoked' };
    if (me.is_active === false) return { valid: false, status: 'disabled' };
    if (me.is_locked === true) return { valid: false, status: 'locked' };
    if (!hasAllPropertyAccess(me)) return { valid: false, status: 'property_restricted' };
    return { valid: true, user: me };
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
  // handleLocalAuthLogin only trusts $pbkdf2$-prefixed hashes produced by
  // browserHashPassword (isBrowserHash). Seeding with hashPassword() from
  // @/lib/security.js produced an unprefixed hash, so the verifier rejected it and
  // fell through to the remote backend — every scenario below died on
  // "Backend authentication required" and this whole suite never ran.
  const salt = generateSalt();
  const hash = '$pbkdf2$' + await browserHashPassword('S3cure!Pass', salt);
  const ownerId = await localDb.User.add({
    username: 'owner', email: 'owner@test.local', full_name: 'Owner', role: 'owner',
    permissions: 'all', property_access: 'all', is_active: true, is_locked: false,
    failed_attempts: 0, salt, password_hash: hash,
  });
  const targetSalt = generateSalt();
  const targetId = await localDb.User.add({
    username: 'clerk', email: 'clerk@test.local', full_name: 'Clerk', role: 'read_only',
    // property_access 'all' because this release only admits all-property
    // accounts (src/lib/launchPolicy.js) and these scenarios need the account to
    // be able to sign in. 'read_only' + 'all' is a real shape — a portfolio-wide
    // auditor. Scenario 4 narrows it on purpose to test the gate itself.
    permissions: ['view:reports'], property_access: 'all', is_active: true, is_locked: false,
    failed_attempts: 0, salt: targetSalt,
    password_hash: '$pbkdf2$' + await browserHashPassword('S3cure!Pass', targetSalt),
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
  // The security property: the session must stop validating. That is what these
  // assert, and it holds.
  //
  // The status is 'revoked', NOT 'disabled'. Both auth backends drop a disabled
  // user before the caller ever sees the record — the local shim in
  // getLocalSessionUser() and the deployed one in
  // base44/functions/custom_auth_me/entry.js, which answers 401 {user:null} on
  // `!user.is_active || user.is_locked`. So me() is null and
  // validateCurrentAccountStatus cannot reach its own 'disabled'/'locked'
  // branches. Consequence is cosmetic-but-real: the user is logged out correctly
  // and told "session revoked" instead of "your account was disabled". Pinned
  // here so that if the server contract ever starts reporting a reason, this
  // fails loudly instead of drifting.
  assert(r2.valid === false, `validateCurrentAccountStatus() -> invalid (${r2.status})`);
  assert(r2.status === 'revoked', `disabled reports as 'revoked' (known label gap), got '${r2.status}'`);
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
  // Same label gap as Scenario 2: locked users are dropped by both backends
  // before the caller sees the record, so this reports 'revoked'.
  assert(r3.valid === false, `validateCurrentAccountStatus() -> invalid (${r3.status})`);
  assert(r3.status === 'revoked', `locked reports as 'revoked' (known label gap), got '${r3.status}'`);
  await revokeSession(r3.status, r3.user);
  assert((await db.auth.getCurrentSession()) === null, 'Session cleared after revocation');
  assert((await db.auth.isAuthenticated()) === false, 'isAuthenticated() false immediately');

  // ── Scenario 4: property_access narrowed -> revoked on next navigation ──
  // The launch gate (src/lib/launchPolicy.js) refuses accounts that are not
  // entitled to every property. Checking it only at login would let a narrowed
  // account keep browsing on a week-old session, so AuthContext re-checks it on
  // every navigation. This is the negative case for that.
  console.log('\n=== Test 4: Owner narrows property access -> instant revocation ===');
  await db.users.setStatus(ownerActor, targetId, 'enabled');
  const login4a = await db.auth.login('clerk', 'S3cure!Pass');
  assert(!!login4a?.user, 'Login succeeds while entitled to all properties');
  await localDb.User.update(targetId, { property_access: ['prop_1'] });
  const r4a = await validateCurrentAccountStatus();
  assert(r4a.valid === false && r4a.status === 'property_restricted',
    `validateCurrentAccountStatus() -> invalid (${r4a.status})`);
  await revokeSession(r4a.status, r4a.user);
  assert((await db.auth.getCurrentSession()) === null, 'Session cleared after revocation');
  let reloginErr = null;
  try { await db.auth.login('clerk', 'S3cure!Pass'); } catch (e) { reloginErr = e; }
  assert(reloginErr !== null, 'The narrowed account cannot sign back in');
  assert(/propert/i.test(reloginErr?.message || ''), 'The refusal names the reason');
  await localDb.User.update(targetId, { property_access: 'all' });

  // ── Scenario 5: Deleted user revoked instantly ──
  console.log('\n=== Test 5: Admin deletes user -> instant revocation ===');
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
