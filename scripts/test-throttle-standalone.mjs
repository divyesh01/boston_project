let invokeCount = 0;
let lastTouchTime = 0;
const THROTTLE_MS = 5 * 60 * 1000;

const functions = {
  async invoke(endpoint) {
    if (endpoint === 'custom_auth_me') invokeCount++;
    return {};
  }
};

const auth = {
  async touchSession() {
    const now = Date.now();
    if (now - lastTouchTime < THROTTLE_MS) return;
    lastTouchTime = now;
    try {
      await functions.invoke('custom_auth_me');
    } catch {}
  }
};

async function runTest() {
  console.log("=== THROTTLE TEST SCENARIO ===");
  console.log("Mocking throttle state (lastTouchTime = 0, THROTTLE_MS = 300,000)");
  console.log("Calling touchSession() 10 times rapidly...");
  
  for (let i = 0; i < 10; i++) {
    await auth.touchSession();
  }
  
  console.log(`Total custom_auth_me invocations: ${invokeCount}`);
  if (invokeCount === 1) {
    console.log("PASS: Throttle successfully limited 10 rapid calls to exactly 1 backend request.");
  } else {
    console.log("FAIL: Throttle did not work properly.");
  }
}

runTest();
