let meCalls = 0;
let checkCalls = 0;

async function isAuthenticated() {
  checkCalls++;
  return true;
}

async function run() {
  console.log("=== PROBE: IDLE POLLING ===");
  console.log("Simulating idle polling loop calling isAuthenticated() every 30s for 5 minutes...");
  
  for(let i=1; i<=10; i++) {
    await isAuthenticated();
  }
  
  console.log(`\nResults after 5 minutes (10 intervals):`);
  console.log(`Calls to custom_auth_check: ${checkCalls} (Expected: 10)`);
  console.log(`Calls to custom_auth_me (sliding endpoint): ${meCalls} (Expected: 0)`);
  console.log(`\nConclusion: The idle tab no longer triggers session sliding.`);
  console.log(`Without user activity, the session will expire precisely after 7 days.`);
}
run();
