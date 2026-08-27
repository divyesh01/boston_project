import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Mock audit log chain secret
let auditChainSecret = 'test-secret';
let lastAuditHash = '0'.repeat(64);
const auditLogs = [];
let pass = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) pass++;
  else throw new Error(`Assertion failed: ${message}`);
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
    id: auditLogs.length + 1,
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

// Reference mock of the pre-fix entity proxy pattern (simulating pre-fix AuditLog behavior without protections)
function createVulnerableEntityProxy(_tableName) {

  const store = new Map();
  let nextId = 1;
  
  return {
    async filter(query = {}, sortField, limit) {
      let rows = Array.from(store.values());
      // Simple filter simulation
      for (const [key, condition] of Object.entries(query)) {
        if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
          if ('$gte' in condition) rows = rows.filter(r => r[key] >= condition.$gte);
          if ('$lte' in condition) rows = rows.filter(r => r[key] <= condition.$lte);
          if ('$gt' in condition) rows = rows.filter(r => r[key] > condition.$gt);
          if ('$lt' in condition) rows = rows.filter(r => r[key] < condition.$lt);
          if ('$in' in condition) rows = rows.filter(r => condition.$in.includes(r[key]));
          if ('$ne' in condition) rows = rows.filter(r => r[key] !== condition.$ne);
        } else {
          rows = rows.filter(r => r[key] === condition);
        }
      }
      if (sortField) {
        const desc = sortField.startsWith('-');
        const field = desc ? sortField.slice(1) : sortField;
        rows = rows.sort((a, b) => {
          const aVal = a[field] ?? '';
          const bVal = b[field] ?? '';
          return desc ? (aVal < bVal ? 1 : -1) : (aVal > bVal ? 1 : -1);
        });
      }
      if (limit) rows = rows.slice(0, limit);
      return rows;
    },
    
    async create(data) {
      const now = new Date().toISOString();
      const record = { ...data, id: nextId++, created_date: now, updated_date: now };
      store.set(record.id, record);
      return record;
    },
    
    async get(id) {
      return store.get(Number(id) || id);
    },
    
    async update(id, data) {
      const numId = Number(id) || id;
      const now = new Date().toISOString();
      const existing = store.get(numId);
      if (!existing) throw new Error('Record not found');
      const updated = { ...existing, ...data, updated_date: now };
      store.set(numId, updated);
      return updated;
    },
    
    async delete(id) {
      const numId = Number(id) || id;
      store.delete(numId);
      return { success: true };
    },
    
    async bulkCreate(dataArray) {
      const now = new Date().toISOString();
      const records = dataArray.map(d => ({ ...d, id: nextId++, created_date: now, updated_date: now }));
      for (const r of records) store.set(r.id, r);
      return records;
    },
    
    async bulkDelete(ids) {
      const numIds = (Array.isArray(ids) ? ids : [ids]).map((id) => Number(id) || id);
      for (const id of numIds) store.delete(id);
      return { success: true };
    },
    
    async clear() {
      store.clear();
      return { success: true };
    },
  };
}

// Simulate the FIXED entity proxy pattern from base44Client.js (PROTECTED VERSION)
// This mimics the createEntityProxy function behavior for AuditLog WITH protections
function createProtectedEntityProxy(tableName) {
  const store = new Map();
  let nextId = 1;
  
  const PROTECTED_IMMUTABLE_TABLES = new Set(['AuditLog']);
  const isProtected = PROTECTED_IMMUTABLE_TABLES.has(tableName);
  
  return {
    async filter(query = {}, sortField, limit) {
      let rows = Array.from(store.values());
      // Simple filter simulation
      for (const [key, condition] of Object.entries(query)) {
        if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
          if ('$gte' in condition) rows = rows.filter(r => r[key] >= condition.$gte);
          if ('$lte' in condition) rows = rows.filter(r => r[key] <= condition.$lte);
          if ('$gt' in condition) rows = rows.filter(r => r[key] > condition.$gt);
          if ('$lt' in condition) rows = rows.filter(r => r[key] < condition.$lt);
          if ('$in' in condition) rows = rows.filter(r => condition.$in.includes(r[key]));
          if ('$ne' in condition) rows = rows.filter(r => r[key] !== condition.$ne);
        } else {
          rows = rows.filter(r => r[key] === condition);
        }
      }
      if (sortField) {
        const desc = sortField.startsWith('-');
        const field = desc ? sortField.slice(1) : sortField;
        rows = rows.sort((a, b) => {
          const aVal = a[field] ?? '';
          const bVal = b[field] ?? '';
          return desc ? (aVal < bVal ? 1 : -1) : (aVal > bVal ? 1 : -1);
        });
      }
      if (limit) rows = rows.slice(0, limit);
      return rows;
    },
    
    async create(data) {
      const now = new Date().toISOString();
      const record = { ...data, id: nextId++, created_date: now, updated_date: now };
      store.set(record.id, record);
      return record;
    },
    
    async get(id) {
      return store.get(Number(id) || id);
    },
    
    async update(id, data) {
      if (isProtected) {
        throw new Error('Security Violation: Audit logs are immutable and cannot be modified or deleted.');
      }
      const numId = Number(id) || id;
      const now = new Date().toISOString();
      const existing = store.get(numId);
      if (!existing) throw new Error('Record not found');
      const updated = { ...existing, ...data, updated_date: now };
      store.set(numId, updated);
      return updated;
    },
    
    async delete(id) {
      if (isProtected) {
        throw new Error('Security Violation: Audit logs are immutable and cannot be modified or deleted.');
      }
      const numId = Number(id) || id;
      store.delete(numId);
      return { success: true };
    },
    
    async bulkCreate(dataArray) {
      if (isProtected) {
        throw new Error('Security Violation: Audit logs are immutable and cannot be modified or deleted.');
      }
      const now = new Date().toISOString();
      const records = dataArray.map(d => ({ ...d, id: nextId++, created_date: now, updated_date: now }));
      for (const r of records) store.set(r.id, r);
      return records;
    },
    
    async bulkDelete(ids) {
      if (isProtected) {
        throw new Error('Security Violation: Audit logs are immutable and cannot be modified or deleted.');
      }
      const numIds = (Array.isArray(ids) ? ids : [ids]).map((id) => Number(id) || id);
      for (const id of numIds) store.delete(id);
      return { success: true };
    },
    
    async clear() {
      if (isProtected) {
        throw new Error('Security Violation: Audit logs are immutable and cannot be modified or deleted.');
      }
      store.clear();
      return { success: true };
    },
  };
}

// Test functions
async function testVulnerableProxy() {
  console.log('\n=== BASELINE: Testing Reference Mock of Pre-Fix Proxy ===');
  
  auditLogs.length = 0;
  lastAuditHash = '0'.repeat(64);
  
  const auditLogProxy = createVulnerableEntityProxy('AuditLog');
  
  // Create test audit entry via legitimate path
  await createAuditEntry('Test Action', { userId: 1, username: 'testuser', result: 'success' });
  const logs = [...auditLogs];
  assert(logs.length === 1, 'Should have 1 audit log entry');
  // createAuditEntry() reads options.userId (camelCase) and writes it to the row as
  // user_id. Every call site here used to pass `user_id`, which the helper ignored, so
  // every generated entry carried userId: null. That is not cosmetic: hashEntry() signs
  // baseEntry, so with the id always null two entries differing only by user were
  // hash-identical and the chain could not have detected a user-id tamper. This
  // assertion is what makes the key name load-bearing instead of silently droppable.
  assert(logs[0].user_id === 1, 'Supplied userId must reach the generated audit row as user_id');
  const testId = logs[0].id;
  console.log(`✓ Created test audit log entry with ID: ${testId}`);
  
  const results = {};
  
  // Test UPDATE - should succeed in pre-fix reference mock
  try {
    const updated = await auditLogProxy.update(testId, { detail: 'MALICIOUS MODIFICATION' });
    console.log('✓ Reference pre-fix behavior: update() succeeded in pre-fix reference mock');
    console.log(`  Updated detail: ${updated.detail}`);
    results.updateBlocked = false;
  } catch (e) {
    console.log(`✓ update() blocked: ${e.message}`);
    results.updateBlocked = true;
  }
  
  // Test DELETE - should succeed in pre-fix reference mock
  try {
    const _result = await auditLogProxy.delete(testId);
    console.log('✓ Reference pre-fix behavior: delete() succeeded in pre-fix reference mock');
    results.deleteBlocked = false;
  } catch (e) {
    console.log(`✓ delete() blocked: ${e.message}`);
    results.deleteBlocked = true;
  }
  
  // Test BULK DELETE
  try {
    await createAuditEntry('Test Action 2', { userId: 2, username: 'testuser2', result: 'success' });
    const newLogs = [...auditLogs];
    const ids = newLogs.map(l => l.id);
    const _result = await auditLogProxy.bulkDelete(ids);
    console.log('✓ Reference pre-fix behavior: bulkDelete() succeeded in pre-fix reference mock');
    results.bulkDeleteBlocked = false;
  } catch (e) {
    console.log(`✓ bulkDelete() blocked: ${e.message}`);
    results.bulkDeleteBlocked = true;
  }
  
  // Test CLEAR
  try {
    await createAuditEntry('Test Action 3', { userId: 3, username: 'testuser3', result: 'success' });
    const _result = await auditLogProxy.clear();
    console.log('✓ Reference pre-fix behavior: clear() succeeded in pre-fix reference mock');
    results.clearBlocked = false;
  } catch (e) {
    console.log(`✓ clear() blocked: ${e.message}`);
    results.clearBlocked = true;
  }
  
  // Test CREATE still works
  try {
    const created = await auditLogProxy.create({
      user_id: 4,
      username: 'testuser4',
      action: 'Legitimate Create',
      performed_by_id: 4,
      result: 'success',
      created_date: new Date().toISOString(),
    });
    assert(created.id !== undefined, 'Created record should have ID');
    console.log(`✓ create() works - created entry with ID: ${created.id}`);
    results.createWorks = true;
  } catch (e) {
    console.log(`✗ create() failed: ${e.message}`);
    results.createWorks = false;
  }
  
  console.log('\n--- REFERENCE PRE-FIX MOCK RESULTS ---');
  console.log(`update() blocked: ${results.updateBlocked ? 'YES' : 'NO (PRE-FIX MOCK)'}`);
  console.log(`delete() blocked: ${results.deleteBlocked ? 'YES' : 'NO (PRE-FIX MOCK)'}`);
  console.log(`bulkDelete() blocked: ${results.bulkDeleteBlocked ? 'YES' : 'NO (PRE-FIX MOCK)'}`);
  console.log(`clear() blocked: ${results.clearBlocked ? 'YES' : 'NO (PRE-FIX MOCK)'}`);
  console.log(`create() works: ${results.createWorks ? 'YES' : 'NO'}`);
  
  return results;
}


async function testProtectedProxy() {
  console.log('\n=== POST-FIX: Testing PROTECTED Proxy (After Fix) ===');
  
  auditLogs.length = 0;
  lastAuditHash = '0'.repeat(64);
  
  const auditLogProxy = createProtectedEntityProxy('AuditLog');
  
  // Create test audit entry via legitimate path
  await createAuditEntry('Test Action', { userId: 1, username: 'testuser', result: 'success' });
  const logs = [...auditLogs];
  assert(logs.length === 1, 'Should have 1 audit log entry');
  // createAuditEntry() reads options.userId (camelCase) and writes it to the row as
  // user_id. Every call site here used to pass `user_id`, which the helper ignored, so
  // every generated entry carried userId: null. That is not cosmetic: hashEntry() signs
  // baseEntry, so with the id always null two entries differing only by user were
  // hash-identical and the chain could not have detected a user-id tamper. This
  // assertion is what makes the key name load-bearing instead of silently droppable.
  assert(logs[0].user_id === 1, 'Supplied userId must reach the generated audit row as user_id');
  const testId = logs[0].id;
  console.log(`✓ Created test audit log entry with ID: ${testId}`);
  
  const results = {};
  
  // Test UPDATE - should be BLOCKED in protected version
  try {
    const _updated = await auditLogProxy.update(testId, { detail: 'MALICIOUS MODIFICATION' });
    console.log('✗ FAIL: update() succeeded - should have been blocked!');
    results.updateBlocked = false;
  } catch (e) {
    if (e.message.includes('Security Violation')) {
      console.log(`✓ update() correctly blocked: ${e.message}`);
      results.updateBlocked = true;
    } else {
      console.log(`✗ FAIL: update() threw wrong error: ${e.message}`);
      results.updateBlocked = false;
    }
  }
  
  // Test DELETE - should be BLOCKED
  try {
    const _result = await auditLogProxy.delete(testId);
    console.log('✗ FAIL: delete() succeeded - should have been blocked!');
    results.deleteBlocked = false;
  } catch (e) {
    if (e.message.includes('Security Violation')) {
      console.log(`✓ delete() correctly blocked: ${e.message}`);
      results.deleteBlocked = true;
    } else {
      console.log(`✗ FAIL: delete() threw wrong error: ${e.message}`);
      results.deleteBlocked = false;
    }
  }
  
  // Test BULK DELETE - should be BLOCKED
  try {
    await createAuditEntry('Test Action 2', { userId: 2, username: 'testuser2', result: 'success' });
    const newLogs = [...auditLogs];
    const ids = newLogs.map(l => l.id);
    const _result = await auditLogProxy.bulkDelete(ids);
    console.log('✗ FAIL: bulkDelete() succeeded - should have been blocked!');
    results.bulkDeleteBlocked = false;
  } catch (e) {
    if (e.message.includes('Security Violation')) {
      console.log(`✓ bulkDelete() correctly blocked: ${e.message}`);
      results.bulkDeleteBlocked = true;
    } else {
      console.log(`✗ FAIL: bulkDelete() threw wrong error: ${e.message}`);
      results.bulkDeleteBlocked = false;
    }
  }
  
  // Test CLEAR - should be BLOCKED
  try {
    await createAuditEntry('Test Action 3', { userId: 3, username: 'testuser3', result: 'success' });
    const _result = await auditLogProxy.clear();
    console.log('✗ FAIL: clear() succeeded - should have been blocked!');
    results.clearBlocked = false;
  } catch (e) {
    if (e.message.includes('Security Violation')) {
      console.log(`✓ clear() correctly blocked: ${e.message}`);
      results.clearBlocked = true;
    } else {
      console.log(`✗ FAIL: clear() threw wrong error: ${e.message}`);
      results.clearBlocked = false;
    }
  }
  
  // Test CREATE still works
  try {
    const created = await auditLogProxy.create({
      user_id: 4,
      username: 'testuser4',
      action: 'Legitimate Create',
      performed_by_id: 4,
      result: 'success',
      created_date: new Date().toISOString(),
    });
    assert(created.id !== undefined, 'Created record should have ID');
    console.log(`✓ create() works - created entry with ID: ${created.id}`);
    
    // Verify audit chain
    const chainResult = await verifyAuditChain();
    assert(chainResult.valid === true, 'Audit chain should be valid after create');
    console.log('✓ Audit chain verified after legitimate create');
    
    results.createWorks = true;
  } catch (e) {
    console.log(`✗ FAIL: create() failed: ${e.message}`);
    results.createWorks = false;
  }
  
  console.log('\n--- PROTECTED PROXY RESULTS ---');
  console.log(`update() blocked: ${results.updateBlocked ? 'YES' : 'NO'}`);
  console.log(`delete() blocked: ${results.deleteBlocked ? 'YES' : 'NO'}`);
  console.log(`bulkDelete() blocked: ${results.bulkDeleteBlocked ? 'YES' : 'NO'}`);
  console.log(`clear() blocked: ${results.clearBlocked ? 'YES' : 'NO'}`);
  console.log(`create() works: ${results.createWorks ? 'YES' : 'NO'}`);
  
  return results;
}

async function runAllTests() {
  console.log('Starting AuditLog Immutability Tests...\n');
  
  try {
    // Static Assertion: Verify production base44Client.js has immutable protection
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const clientPath = path.resolve(__dirname, '../src/api/base44Client.js');
    const clientSrc = fs.readFileSync(clientPath, 'utf8');

    assert(clientSrc.includes('PROTECTED_IMMUTABLE_TABLES'), 'base44Client.js must declare PROTECTED_IMMUTABLE_TABLES');

    const requiredMethods = ['update', 'delete', 'bulkCreate', 'bulkDelete', 'clear'];
    for (const method of requiredMethods) {
      // `\s*` — NOT `[\s\S]*?`. The lazy-any form matched from the method
      // signature to the first throwIfProtected() ANYWHERE later in the file, so
      // a guard surviving in only the last method (clear, line ~942) satisfied
      // all five assertions. Measured: with only that one call left, the lazy
      // form reported update/delete/bulkCreate/bulkDelete as present. Requiring
      // the guard to be the FIRST statement of the body is both non-vacuous
      // (removing any single call kills exactly its own assertion) and the real
      // invariant — anything executing before the refusal runs unguarded.
      const methodRegex = new RegExp(`async\\s+${method}\\s*\\([^)]*\\)\\s*\\{\\s*throwIfProtected\\(\\);`, 'm');
      assert(methodRegex.test(clientSrc), `throwIfProtected() must be the first statement of ${method}() in src/api/base44Client.js`);
    }
    console.log('✓ Static check PASSED: base44Client.js declares PROTECTED_IMMUTABLE_TABLES and invokes throwIfProtected() in all 5 methods (update, delete, bulkCreate, bulkDelete, clear).\n');

    // Test 1: Reference mock of pre-fix proxy
    const vulnerableResults = await testVulnerableProxy();
    
    // Test 2: Protected proxy (simulating fix)
    const protectedResults = await testProtectedProxy();
    
    console.log('\n========================================');
    console.log('SUMMARY');
    console.log('========================================');
    console.log('REFERENCE MOCK (Pre-fix pattern behavior):');
    console.log(`  update() blocked: ${vulnerableResults.updateBlocked ? 'YES' : 'NO (PRE-FIX MOCK)'}`);
    console.log(`  delete() blocked: ${vulnerableResults.deleteBlocked ? 'YES' : 'NO (PRE-FIX MOCK)'}`);
    console.log(`  bulkDelete() blocked: ${vulnerableResults.bulkDeleteBlocked ? 'YES' : 'NO (PRE-FIX MOCK)'}`);
    console.log(`  clear() blocked: ${vulnerableResults.clearBlocked ? 'YES' : 'NO (PRE-FIX MOCK)'}`);
    console.log(`  create() works: ${vulnerableResults.createWorks ? 'YES' : 'NO'}`);
    console.log('');
    console.log('PROTECTED PROXY (After fix):');
    console.log(`  update() blocked: ${protectedResults.updateBlocked ? 'YES' : 'NO'}`);
    console.log(`  delete() blocked: ${protectedResults.deleteBlocked ? 'YES' : 'NO'}`);
    console.log(`  bulkDelete() blocked: ${protectedResults.bulkDeleteBlocked ? 'YES' : 'NO'}`);
    console.log(`  clear() blocked: ${protectedResults.clearBlocked ? 'YES' : 'NO'}`);
    console.log(`  create() works: ${protectedResults.createWorks ? 'YES' : 'NO'}`);
    console.log('========================================\n');
    
    // Verify the fix works
    const allBlocked = protectedResults.updateBlocked && 
                       protectedResults.deleteBlocked && 
                       protectedResults.bulkDeleteBlocked && 
                       protectedResults.clearBlocked &&
                       protectedResults.createWorks;
    
    if (allBlocked) {
      console.log('✓ ALL PROTECTIONS WORKING - Fix is effective\n');
      console.log(`\n${failed === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${failed} failed`);
      process.exit(failed > 0 ? 1 : 0);
    } else {
      console.log('✗ SOME PROTECTIONS FAILED - Fix needs adjustment\n');
      failed = 1;
      console.log(`\n${failed === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${failed} failed`);
      process.exit(failed > 0 ? 1 : 0);
    }
    
  } catch (error) {
    failed = 1;
    console.error('\n========================================');
    console.error('TEST ERROR');
    console.error('========================================\n');
    console.error(error);
    console.error(`\n${failed === 0 ? "PASSED" : "FAILED"}: ${pass} passed, ${failed} failed`);
    process.exit(1);
  }
}


runAllTests();
