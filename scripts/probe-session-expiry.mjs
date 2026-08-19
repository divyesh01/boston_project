console.log("=== ENHANCED SESSION EXPIRY PROBE ===");
const dayMs = 24 * 60 * 60 * 1000;
const cookieMaxAge = 7 * dayMs;
const absoluteMaxAge = 30 * dayMs;
const idlePollMs = 30 * 1000;

console.log(`Session Cookie Initial Expiry: ${cookieMaxAge / dayMs} days`);
console.log(`Session Absolute Lifetime Limit: ${absoluteMaxAge / dayMs} days`);
console.log(`Frontend Idle Polling Interval: ${idlePollMs / 1000} seconds`);

console.log("\n=== SCENARIO 1: The Active User (Tab closed, reopened daily) ===");
console.log("If a user works daily, closing their laptop at night, the 30s idle poll stops when closed.");
console.log("If touchSession is a no-op, their keystrokes never extend the session.");
console.log(`Result: Logged out abruptly at exactly Day ${cookieMaxAge / dayMs}.`);

console.log("\n=== SCENARIO 2: The Idle Attacker (Tab left open) ===");
console.log("A terminal is left open at the front desk.");
console.log(`The frontend polls isAuthenticated() every ${idlePollMs/1000}s, which calls custom_auth_me.`);
console.log("custom_auth_me implicitly slides the expiry (if < 3 days remaining).");
console.log(`Result: Session is kept alive forever with NO user activity, up to the hard absolute limit of Day ${absoluteMaxAge / dayMs}.`);
