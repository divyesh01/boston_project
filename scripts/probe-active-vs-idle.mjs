const DAY_MS = 24 * 60 * 60 * 1000;
const THROTTLE_MS = 5 * 60 * 1000;

function simulateUser(isActive) {
  let currentTime = 0;
  const duration = 8 * DAY_MS;
  let sessionExpiry = 7 * DAY_MS;
  let lastTouch = -Infinity;
  let isLoggedOut = false;

  console.log(`\nSimulating ${isActive ? 'Active' : 'Idle'} User for 8 days...`);

  const step = 2 * 60 * 1000;
  while(currentTime <= duration) {
    if (currentTime > sessionExpiry) {
      console.log(`[Day ${currentTime / DAY_MS}] Session expired! User is logged out.`);
      isLoggedOut = true;
      break;
    }

    if (isActive) {
      if (currentTime - lastTouch >= THROTTLE_MS) {
        lastTouch = currentTime;
        const remaining = sessionExpiry - currentTime;
        if (remaining < 3 * DAY_MS) {
          sessionExpiry = currentTime + 7 * DAY_MS;
        }
      }
    }
    currentTime += step;
  }

  if (!isLoggedOut) {
    console.log(`[Day 8] User is still logged in! Session expires at Day ${sessionExpiry / DAY_MS}`);
  }
}

console.log("=== PROBE: ACTIVE VS IDLE ===");
console.log("Scenario A: Active user (touches session every 2 min for 8 days)");
simulateUser(true);

console.log("\nScenario B: Idle user (tab open but no activity)");
simulateUser(false);
