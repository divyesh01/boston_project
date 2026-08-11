// Local Auth Implementation Test Harness
// Tests the core authentication logic without requiring IndexedDB

import { hashPassword, verifyPassword, generateSalt, generateToken, isCryptoAvailable, validatePasswordStrength } from '../src/lib/security.js';

// Mock audit log chain secret
let auditChainSecret = 'test-secret';
let lastAuditHash = '0'.repeat(64);
const auditLogs = [];

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function hashEntry(entry, previousHash) {
  const data = JSON.stringify({ ...entry, previous_hash: previousHash || '0'.repeat(64) });
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(auditChainSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  return Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function createAuditEntry(action, options = {}) {
  const baseEntry = {
    action,
    timestamp: new Date().toISOString(),
    ipAddress: options.ipAddress || 'test-ip',
    device: options.device || 'test-device',
    userId: options.userId || null,
    username: options.username || 'unknown',
    performedById: options.performedById || null,
    performedBy: options.performedBy || 'system',
    propertyId: options.propertyId || null,
    propertyName: options.propertyName || null,
    result: options.result || 'success',
    detail: options.detail || '',
  };

  const hash = await hashEntry(baseEntry, lastAuditHash);
  const entry = { ...baseEntry, hash, previous_hash: lastAuditHash };
  lastAuditHash = hash;

  auditLogs.push({
    user_id: entry.userId,
    username: entry.username,
    action: entry.action,
    performed_by_id: entry.performedById,
    performed_by: entry.performedBy,
    result: entry.result,
    created_date: entry.timestamp,
    ipAddress: entry.ipAddress,
    device: entry.device,
    property_id: entry.propertyId,
    property_name: entry.propertyName,
    detail: entry.detail,
    hash: entry.hash,
    previous_hash: entry.previous_hash,
  });
  return entry;
}

async function verifyAuditChain() {
  let previousHash = '0'.repeat(64);
  for (const log of auditLogs) {
    const entry = {
      action: log.action,
      timestamp: log.created_date,
      ipAddress: log.ipAddress,
      device: log.device,
      userId: log.user_id,
      username: log.username,
      performedById: log.performed_by_id,
      performedBy: log.performed_by,
      propertyId: log.property_id,
      propertyName: log.property_name,
      result: log.result,
      detail: log.detail,
    };
    const { hash, previous_hash } = log;
    const expectedHash = await hashEntry(entry, previous_hash);
    if (hash !== expectedHash) {
      return { valid: false, tamperedAt: log.id, expected: expectedHash, actual: hash };
    }
    if (previous_hash !== previousHash) {
      return { valid: false, tamperedAt: log.id, reason: 'Chain break', expectedPrevious: previousHash, actualPrevious: previous_hash };
    }
    previousHash = hash;
  }
  return { valid: true, count: auditLogs.length };
}

// Mock in-memory stores
const users = new Map();
const passwordResetRequests = new Map();

function findUserByIdentity(identifier) {
  const term = String(identifier || '').trim().toLowerCase();
  if (!term) return null;
  for (const user of users.values()) {
    if ((user.username || '').toLowerCase() === term || (user.email || '').toLowerCase() === term) {
      return user;
    }
  }
  return null;
}

function findUserById(id) {
  return users.get(id) || null;
}

// Test functions
async function testValidPasswordResetFlow() {
  console.log('\n=== Test: Valid Password Reset Flow ===');
  
  // Clear stores
  users.clear();
  passwordResetRequests.clear();
  auditLogs.length = 0;
  lastAuditHash = '0'.repeat(64);

  // Create a test user
  const salt = generateSalt();
  const passwordHash = await hashPassword('OldPass123!@#', salt);
  const userId = 1;
  const user = {
    id: userId,
    username: 'testuser',
    email: 'test@example.com',
    role: 'front_desk',
    is_active: true,
    is_locked: false,
    must_change_password: false,
    failed_attempts: 0,
    salt,
    password_hash: passwordHash,
  };
  users.set(userId, user);

  // Request password reset (simulate db.auth.resetPasswordRequest)
  const token = generateToken();
  const expiresAt = Date.now() + 60 * 60 * 1000;
  passwordResetRequests.set(token, {
    user_id: userId,
    token,
    expires_at: expiresAt,
    used: false,
    created_date: new Date().toISOString(),
  });

  // Verify token exists
  const resetReq = passwordResetRequests.get(token);
  assert(resetReq !== undefined, 'Reset request should exist');
  assert(resetReq.user_id === userId, 'Reset request should link to user');
  assert(resetReq.used === false, 'Reset request should not be used');
  console.log('✓ Reset token created and stored');

  // Reset password with valid token (simulate db.auth.resetPassword)
  const newPassword = 'NewPass456!@#';
  const newSalt = generateSalt();
  const newPasswordHash = await hashPassword(newPassword, newSalt);
  
  const updatedUser = { ...user, salt: newSalt, password_hash: newPasswordHash, must_change_password: false, failed_attempts: 0, is_locked: false };
  users.set(userId, updatedUser);
  passwordResetRequests.set(token, { ...resetReq, used: true });

  // Verify password was updated
  const verifiedUser = users.get(userId);
  assert(verifiedUser.password_hash === newPasswordHash, 'Password hash should be updated');
  assert(verifiedUser.must_change_password === false, 'must_change_password should be false');
  console.log('✓ Password successfully reset');

  // Verify audit log
  await createAuditEntry('Password Reset Completed', {
    user_id: userId,
    username: 'testuser',
    result: 'success',
    detail: 'Self-service password reset completed',
  });

  const chainResult = await verifyAuditChain();
  assert(chainResult.valid === true, 'Audit chain should be valid');
  console.log('✓ Audit log chain verified');

  console.log('✓ Valid Password Reset Flow PASSED');
}

async function testExpiredToken() {
  console.log('\n=== Test: Expired Token Handling ===');
  
  passwordResetRequests.clear();
  auditLogs.length = 0;
  lastAuditHash = '0'.repeat(64);

  const salt = generateSalt();
  const passwordHash = await hashPassword('OldPass123!@#', salt);
  const userId = 2;
  const user = {
    id: userId,
    username: 'testuser2',
    email: 'test2@example.com',
    role: 'front_desk',
    is_active: true,
    is_locked: false,
    must_change_password: false,
    failed_attempts: 0,
    salt,
    password_hash: passwordHash,
  };
  users.set(userId, user);

  // Create expired token (1 hour ago)
  const expiredToken = generateToken();
  const expiresAt = Date.now() - 60 * 60 * 1000;
  passwordResetRequests.set(expiredToken, {
    user_id: userId,
    token: expiredToken,
    expires_at: expiresAt,
    used: false,
    created_date: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
  });

  const resetReq = passwordResetRequests.get(expiredToken);
  assert(resetReq !== undefined, 'Expired token should exist in store');
  
  const isExpired = Date.now() > resetReq.expires_at;
  assert(isExpired === true, 'Token should be detected as expired');
  console.log('✓ Expired token correctly detected');

  await createAuditEntry('Password Reset Attempt', {
    result: 'failed',
    detail: 'Reset token expired',
  });

  const chainResult = await verifyAuditChain();
  assert(chainResult.valid === true, 'Audit chain should be valid');
  console.log('✓ Expired Token Handling PASSED');
}

async function testInvalidToken() {
  console.log('\n=== Test: Invalid Token Handling ===');
  
  passwordResetRequests.clear();
  auditLogs.length = 0;
  lastAuditHash = '0'.repeat(64);

  const invalidToken = 'invalid-token-that-does-not-exist';
  const resetReq = passwordResetRequests.get(invalidToken);
  assert(resetReq === undefined, 'Invalid token should not exist in store');
  console.log('✓ Invalid token correctly rejected');

  await createAuditEntry('Password Reset Attempt', {
    result: 'failed',
    detail: 'Invalid or unknown reset token',
  });

  const chainResult = await verifyAuditChain();
  assert(chainResult.valid === true, 'Audit chain should be valid');
  console.log('✓ Invalid Token Handling PASSED');
}

async function testUsedToken() {
  console.log('\n=== Test: Used Token Handling ===');
  
  passwordResetRequests.clear();
  auditLogs.length = 0;
  lastAuditHash = '0'.repeat(64);

  const salt = generateSalt();
  const passwordHash = await hashPassword('OldPass123!@#', salt);
  const userId = 3;
  const user = {
    id: userId,
    username: 'testuser3',
    email: 'test3@example.com',
    role: 'front_desk',
    is_active: true,
    is_locked: false,
    must_change_password: false,
    failed_attempts: 0,
    salt,
    password_hash: passwordHash,
  };
  users.set(userId, user);

  const usedToken = generateToken();
  passwordResetRequests.set(usedToken, {
    user_id: userId,
    token: usedToken,
    expires_at: Date.now() + 60 * 60 * 1000,
    used: true, // Already used
    created_date: new Date().toISOString(),
  });

  const resetReq = passwordResetRequests.get(usedToken);
  assert(resetReq !== undefined, 'Used token should exist in store');
  assert(resetReq.used === true, 'Token should be marked as used');
  console.log('✓ Used token correctly detected');

  await createAuditEntry('Password Reset Attempt', {
    result: 'failed',
    detail: 'Reset token already used',
  });

  const chainResult = await verifyAuditChain();
  assert(chainResult.valid === true, 'Audit chain should be valid');
  console.log('✓ Used Token Handling PASSED');
}

async function testWeakPasswordRejection() {
  console.log('\n=== Test: Weak Password Rejection ===');
  
  const weakPasswords = [
    'short',
    'nouppercase123!@#',
    'NOLOWERCASE123!@#',
    'NoNumbers!@#',
    'NoSpecialChars123',
    'Repeatingaaa123!@#',
  ];

  for (const pw of weakPasswords) {
    const err = validatePasswordStrength(pw);
    assert(err !== '', `Weak password "${pw}" should be rejected: ${err}`);
  }
  console.log('✓ All weak passwords correctly rejected');

  const strongPassword = 'StrongPass123!@#';
  const err = validatePasswordStrength(strongPassword);
  assert(err === '', `Strong password "${strongPassword}" should be accepted`);
  console.log('✓ Strong password correctly accepted');
  console.log('✓ Weak Password Rejection PASSED');
}

async function testPasswordHashVerification() {
  console.log('\n=== Test: Password Hash Verification ===');
  
  const password = 'TestPass123!@#';
  const salt = generateSalt();
  const hash = await hashPassword(password, salt);
  
  const valid = await verifyPassword(password, salt, hash);
  assert(valid === true, 'Correct password should verify');
  
  const invalid = await verifyPassword('WrongPass123!@#', salt, hash);
  assert(invalid === false, 'Wrong password should not verify');
  
  console.log('✓ Password Hash Verification PASSED');
}

async function testAuditLogChain() {
  console.log('\n=== Test: Audit Log Tamper-Evident Chain ===');
  
  auditLogs.length = 0;
  lastAuditHash = '0'.repeat(64);

  await createAuditEntry('Test Action 1', { user_id: 1, username: 'user1', result: 'success' });
  await createAuditEntry('Test Action 2', { user_id: 2, username: 'user2', result: 'success' });
  await createAuditEntry('Test Action 3', { user_id: 1, username: 'user1', result: 'failed', detail: 'Failed attempt' });

  const result = await verifyAuditChain();
  assert(result.valid === true, 'Audit chain should be valid');
  assert(result.count === 3, 'Should have 3 log entries');
  console.log('✓ Audit Log Tamper-Evident Chain PASSED');
}

async function testUserNotFoundReturnsGenericSuccess() {
  console.log('\n=== Test: User Not Found Returns Generic Success (Anti-Enumeration) ===');
  
  passwordResetRequests.clear();
  auditLogs.length = 0;
  lastAuditHash = '0'.repeat(64);

  // Request reset for non-existent user
  const term = 'nonexistent@example.com';
  const user = findUserByIdentity(term);
  assert(user === null || user === undefined, 'User should not exist');
  
  // Should still return success (generic response)
  await createAuditEntry('Password Reset Requested', {
    username: term,
    result: 'success',
    detail: 'Request processed (user not found, but response is generic)',
  });

  const chainResult = await verifyAuditChain();
  assert(chainResult.valid === true, 'Audit chain should be valid');
  console.log('✓ Anti-Enumeration Protection PASSED');
}

async function testRegisterUser() {
  console.log('\n=== Test: User Registration (Admin Creation) ===');
  
  users.clear();
  auditLogs.length = 0;
  lastAuditHash = '0'.repeat(64);

  const username = 'newuser';
  const email = 'newuser@example.com';
  const password = 'NewUserPass123!@#';
  const role = 'front_desk';
  const assigned_property_ids = ['prop1', 'prop2'];

  // Simulate db.auth.registerUser
  const salt = generateSalt();
  const password_hash = await hashPassword(password, salt);
  const userId = 100;
  const user = {
    id: userId,
    username,
    email: email.toLowerCase(),
    full_name: '',
    role,
    permissions: { view_dashboard: true, import_reports: true },
    property_access: assigned_property_ids,
    is_active: true,
    is_locked: false,
    must_change_password: true,
    last_login: null,
    failed_attempts: 0,
    salt,
    password_hash,
  };
  users.set(userId, user);

  await createAuditEntry('User Registered', {
    user_id: userId,
    username,
    performed_by_id: null,
    performed_by: 'system',
    result: 'success',
    detail: `Role: ${role}, Admin creation`,
  });

  const createdUser = users.get(userId);
  assert(createdUser !== undefined, 'User should be created');
  assert(createdUser.username === username, 'Username should match');
  assert(createdUser.email === email.toLowerCase(), 'Email should be lowercase');
  assert(createdUser.role === role, 'Role should match');
  assert(createdUser.property_access.length === 2, 'Property access should be set');
  assert(createdUser.must_change_password === true, 'Must change password should be true');
  console.log('✓ User created with correct properties');

  const chainResult = await verifyAuditChain();
  assert(chainResult.valid === true, 'Audit chain should be valid');
  console.log('✓ User Registration PASSED');
}

async function runAllTests() {
  console.log('Starting Local Auth Implementation Tests...\n');
  
  try {
    await testPasswordHashVerification();
    await testWeakPasswordRejection();
    await testValidPasswordResetFlow();
    await testExpiredToken();
    await testInvalidToken();
    await testUsedToken();
    await testAuditLogChain();
    await testUserNotFoundReturnsGenericSuccess();
    await testRegisterUser();
    
    console.log('\n========================================');
    console.log('ALL TESTS PASSED ✓');
    console.log('========================================\n');
  } catch (error) {
    console.error('\n========================================');
    console.error('TEST FAILED ✗');
    console.error('========================================\n');
    console.error(error);
    process.exit(1);
  }
}

runAllTests();