import 'fake-indexeddb/auto';

// Mock localStorage
const store = new Map();
globalThis.localStorage = {
  getItem: (key) => store.get(key) || null,
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
  clear: () => store.clear(),
};

import { db } from '../src/api/base44Client.js';
import localDb from '../src/api/localDb.js';
import { secureStore, secureRetrieve } from '../src/lib/securityUtils.js';

async function main() {
  console.log("=== PROBING SESSION ROTATE NO-OP ===");

  const userId = await localDb.User.add({ username: 'testuser', email: 'test@example.com', role: 'admin', is_active: true, property_access: 'all' });
  
  const mockRecord = {
    userId,
    expiresAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString()
  };
  await secureStore('rr_local_session', JSON.stringify(mockRecord));
  
  console.log("Mocked valid session database record:", mockRecord);

  console.log("Calling db.auth.rotateSession()...");
  await db.auth.rotateSession();

  const newRecordStr = await secureRetrieve('rr_local_session');
  if (!newRecordStr) {
    console.error("FAIL: Session was deleted!");
    process.exit(1);
  }
  
  const newRecord = JSON.parse(newRecordStr);
  console.log("Session after rotateSession:", newRecord);

  if (newRecord.expiresAt === mockRecord.expiresAt) {
    console.error("FAIL: rotateSession is a no-op! Expiry was not extended and token was not rotated.");
    process.exit(1);
  }

  console.log("PASS: Session updated successfully.");
}

main().catch(console.error);
