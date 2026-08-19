import { db } from '../src/api/base44Client.js';

async function main() {
  console.log("=== PROBING SESSION SLIDE ===");
  
  let fetchCallCount = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    fetchCallCount++;
    return realFetch(...args);
  };
  
  console.log("Calling db.auth.touchSession()...");
  await db.auth.touchSession();
  console.log(`Fetch calls made: ${fetchCallCount}`);
  
  console.log("Calling db.auth.rotateSession()...");
  await db.auth.rotateSession();
  console.log(`Fetch calls made: ${fetchCallCount}`);
  
  if (fetchCallCount === 0) {
    console.error("FAIL: touchSession and rotateSession are no-ops! No backend HTTP calls were made.");
    process.exit(1);
  }
  
  console.log("PASS: Session was slid.");
}

main().catch(console.error);
