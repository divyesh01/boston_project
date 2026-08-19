import { db } from '../src/api/base44Client.js';
import { functions } from '../src/api/base44Client.js';

let invokeCount = 0;
// Mock the functions.invoke call
functions.invoke = async (endpoint) => {
  if (endpoint === 'custom_auth_me') invokeCount++;
  return {};
};

async function runTest() {
  console.log("=== THROTTLE TEST SCENARIO ===");
  console.log("Calling touchSession() 10 times rapidly...");
  
  for (let i = 0; i < 10; i++) {
    await db.auth.touchSession();
  }
  
  console.log(`Total custom_auth_me invocations: ${invokeCount}`);
  if (invokeCount === 1) {
    console.log("PASS: Throttle successfully limited 10 rapid calls to exactly 1 backend request.");
  } else {
    console.log("FAIL: Throttle did not work properly.");
  }
}

runTest();
