let invokeCount = 0;
let lastTouchTime = 0;
const THROTTLE_MS = 5 * 60 * 1000;

async function touchSession(now) {
  if (now - lastTouchTime < THROTTLE_MS) return;
  lastTouchTime = now;
  invokeCount++;
}

async function run() {
  console.log("=== PROBE: SESSION SLIDING ===");
  console.log("Simulating user login (creates session cookie, 7-day expiry)...");
  
  let now = Date.now();
  console.log(`\n[Time: 0 min] Calling touchSession() once...`);
  await touchSession(now);
  console.log(`Verify: HTTP calls made = ${invokeCount} (Expected: 1)`);

  console.log(`\n[Time: +6 min] User is active again. Calling touchSession()...`);
  now += 6 * 60 * 1000;
  await touchSession(now);
  console.log(`Verify: HTTP calls made = ${invokeCount} (Expected: 2)`);

  console.log(`\n[Time: +6.1 min] User types rapidly. Calling touchSession() 5 times...`);
  now += 6000;
  for(let i=0; i<5; i++) await touchSession(now);
  console.log(`Verify: HTTP calls made = ${invokeCount} (Expected: 2)`);
}
run();
